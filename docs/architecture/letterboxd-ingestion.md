# Letterboxd ingestion and last-good ratings

This sequence distinguishes the routine watchlist/EPG synchronization from the separately gated ratings refresh. **A Letterboxd HTTP 403 is an observed upstream failure, not a reason to bypass the challenge.** Sources: [Letterboxd ratings contract](../reference/integrations/letterboxd-ratings.md), [last-good ADR](../adr/0018-letterboxd-last-good-ratings.md), [Worker sources](../../src/sources.js), [enrichment API](../reference/api/enrichment.md).

```mermaid
sequenceDiagram
    autonumber
    actor Owner
    participant Sync as Worker sync pipeline
    participant LB as Letterboxd
    participant R2 as Authoritative R2
    participant Refresh as Optional ratings refresh
    Owner->>Sync: Authorized EPG/watchlist sync
    Sync->>LB: Fetch watchlist and films ratings
    alt Films list available
        LB-->>Sync: Watchlist and ratings snapshot
        Sync->>R2: Commit eligible watchlist and ratings projections
    else Films list HTTP 403 / incomplete
        LB-->>Sync: 403 or incomplete data
        Sync->>R2: Preserve last valid rating observations
        Note over Sync,R2: A ratings failure is not an EPG failure
    end
    opt Owner authorizes RATINGS_REFRESH=on and refresh
        Owner->>Refresh: Single explicit ratings refresh
        Refresh->>LB: Request complete films list
        alt Complete valid list
            LB-->>Refresh: Full ratings scan
            Refresh->>R2: Store immutable ratings generation
            Refresh->>R2: Project view index with ETag retries
            Refresh->>R2: Advance published rating pointer
        else 403 or interrupted scan
            LB-->>Refresh: 403 / incomplete
            Refresh->>R2: Keep previous published generation
            Note over Refresh,R2: Retry backoff applies — anti-bot bypass is prohibited
        end
    end
```

The **separately flagged** `POST /api/enrichment/ratings/refresh` is not automatically scheduled. The pending generation and last-success pointer allow a safe continuation of an interrupted projection without repeating Letterboxd reads. Its lease and ETag retry protect concurrent writers to `enrichment/view-index.json`. A per-film repair is distinct from a complete scan; it does not move `lastSuccessAt`.

For operational truth, check the current `RATINGS_REFRESH` binding before claiming that manual refresh is enabled; the source default is not evidence of current production configuration. No retrieval, bypass, ratings repair, or refresh is performed by this documentation change.

## Watched, rating and watchlist as separate facts (behind `LETTERBOXD_FACTS`)

**Accepted ([ADR-0023](../adr/0023-letterboxd-user-facts.md), [ADR-0024](../adr/0024-letterboxd-scan-summary.md)); the routine writers and the baseline importer are implemented behind `LETTERBOXD_FACTS` and `LETTERBOXD_BASELINE_IMPORT`, off by default; finds exclude watched and rated films by TMDB identity with either value of the gate ([catalog API](../reference/api/catalog.md#watched-and-rated-films)); a separate display-only title exclusion ([ADR-0028](../adr/0028-finds-display-only-watched-exclusion.md); namesake guards by list tag in [ADR-0033](../adr/0033-finds-exclusion-namesake-relaxation.md)) is implemented behind `FINDS_TITLE_EXCLUSION`, off by default.** With the gate off, the films-list scan still writes `actualRating` straight into the view index and assigns `null` to watchlist films it does not see. With it on, every source writes observations into one fact record per film, only a greater observation (by time, then source rank, then observation id) replaces a value, a complete scan is stored once as a summary observation, and the view index is rebuilt from the records. Contract: [Letterboxd user facts](../reference/integrations/letterboxd-user-facts.md).

```mermaid
flowchart TD
    subgraph sources["Observations"]
        export["Owner's account export<br/>accepted identities to the merge"]
        films["Complete public films list"]
        watchlist["Complete watchlist"]
        page["Per-film page lookup"]
        owner["Owner edit"]
    end
    gaps["403, partial scan,<br/>film absent from list"]
    merge{"Greater than the stored<br/>observation (time, source, id)?"}
    facts[("R2 fact record per film:<br/>watched, rating, watchlist,<br/>provenance")]
    keep["Keep stored value"]
    index[("view-index.json: actualRating, watched<br/>under lid and tmdb_n")]
    finds["Finds: exclude watched or rated;<br/>actual rating over prediction"]
    builder["Offline builder: watched films<br/>without accepted identity,<br/>unique name and year"]
    list[("R2 display-exclusion list<br/>private, placed by the owner")]
    sources --> merge
    merge -->|yes: compare-and-swap| facts
    merge -->|no| keep
    gaps -.->|not an observation| keep
    facts -->|projection| index
    index --> finds
    export -.->|no accepted identity| builder
    builder --> list
    list -.->|"FINDS_TITLE_EXCLUSION=on:<br/>hide only, never a fact"| finds
```

A fact record also carries `ratingHistory`, the append-only list of the film's rating changes, written in the same compare-and-swap as the rating; the projection does not read it ([ADR 0038](../adr/0038-durable-rating-and-prediction-lineage.md), [user facts contract](../reference/integrations/letterboxd-user-facts.md)). Unresolved export rows (no accepted identity) never reach the merge; they stay in the importer's private report until a separate identity verification. The dashed path is display-only: the offline builder writes their normalized names and years to a private list, and with the switch on Finds hide a catalog film whose original title and year match it uniquely. Finds read that list without writing anything, and the match never becomes a fact, a rating or an identity link ([catalog API](../reference/api/catalog.md#display-only-title-exclusion), [runbook](../runbooks/finds-display-exclusion.md)).
