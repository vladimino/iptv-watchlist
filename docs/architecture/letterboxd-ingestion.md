# Letterboxd ingestion and last-good ratings

This sequence distinguishes the routine watchlist/EPG synchronization from the retired ratings-only refresh route. **A Letterboxd HTTP 403 is an observed upstream failure, not a reason to bypass the challenge.** Sources: [Letterboxd ratings contract](../reference/integrations/letterboxd-ratings.md), [last-good ADR](../adr/0018-letterboxd-last-good-ratings.md), [retirement ADR](../adr/0040-retire-ratings-only-refresh.md), [removal lookup ADR](../adr/0043-removal-rating-lookup-queue.md), [diary history ADR](../adr/0049-letterboxd-diary-viewing-history.md), [Diary-first ratings ADR](../adr/0054-diary-first-epg-ratings.md), [recent-window ADR](../adr/0064-diary-recent-window.md), [Worker sources](../../src/sources.js), [enrichment API](../reference/api/enrichment.md).

```mermaid
sequenceDiagram
    autonumber
    actor Owner
    participant Sync as Worker sync pipeline
    participant LB as Letterboxd
    participant R2 as Authoritative R2
    participant Retired as Retired ratings refresh route
    Owner->>Sync: Authorized EPG/watchlist sync
    Sync->>LB: Fetch watchlist
    LB-->>Sync: Complete watchlist
    Sync->>R2: Commit EPG generation, watchlist and its events
    opt LETTERBOXD_DIARY_HISTORY=on
        Sync->>LB: Diary page 1 only
        alt Page read
            LB-->>Sync: Diary rows (lid, watched date, rating at entry)
            Sync->>R2: Viewing history entries for the page
            Sync->>R2: Watched and proved rating facts, view index
        else 403, 429 or unrecognized page
            LB-->>Sync: Challenge or error
            Sync->>R2: Run state blocked or failed, facts kept
        end
        Sync->>R2: Diary run state, removal events with proved ratings
    end
    opt REMOVAL_RATING_LOOKUP=on and removed films without a diary rating
        Sync->>R2: Queue those films, record the attempt
        Sync->>LB: Member page of each due film, at most 5
        alt Rating found
            LB-->>Sync: Owner's rating
            Sync->>R2: Rating fact, view index, removal event
        else 403 or 429
            LB-->>Sync: Challenge or rate limit
            Sync->>R2: Pause the whole queue for 6 hours
        end
    end
    Note over Sync,LB: The public films list is not requested
    Note over Sync,R2: A ratings failure is not an EPG failure
    Owner->>Retired: POST /api/enrichment/ratings/refresh
    Retired-->>Owner: 410 Gone, whatever RATINGS_REFRESH holds
    Note over Retired,R2: No Letterboxd request, no R2 read or write
```

The ratings after a commit are **Diary-first** ([ADR 0054](../adr/0054-diary-first-epg-ratings.md)). The first optional block is the **Diary viewing history** of [ADR 0049](../adr/0049-letterboxd-diary-viewing-history.md), off by default, and it reads the first diary page only ([ADR 0064](../adr/0064-diary-recent-window.md)). After that page's history commit, every film on it becomes a watched fact, and a rating fact where the page shows a rating: the first visible rated row of the film's latest day on that page, observed at that watched date, so a newer observation from any source wins ([contract](../reference/integrations/letterboxd-diary-history.md#rating-facts)). The read does not claim the rest of the diary. More than 50 new viewings between runs can miss this page; an archive import is a separate path and is not started here.

The second optional block is the **removal lookup** of [ADR 0043](../adr/0043-removal-rating-lookup-queue.md), off by default. It now runs after the diary, and only for films the watchlist diff removed that the diary gave no rating. They are looked up on their own member pages through a bounded queue in `enrichment/removal-rating-lookups.json`, and it never fails the commit ([contract](../reference/integrations/letterboxd-ratings.md#removed-films)). The 31-page public films list is no longer scanned after a commit.

The diagram shows the default `RATINGS_PIPELINE=inline`. With `separate` after the owner-approved storage migration, both blocks leave the commit: it only adds the removed films to the queue as references to their removal event, and a separate leased ratings run reads the Diary and makes the lookups ([scheduling](scheduling-and-orchestration.md#the-separate-ratings-pipeline-deployed-inactive-by-default), [contract](../reference/integrations/letterboxd-ratings.md#separate-ratings-pipeline)).

The owner-triggered `POST /api/enrichment/ratings/refresh` of AIR-64 is **retired** ([ADR 0040](../adr/0040-retire-ratings-only-refresh.md)): it answers `410 Gone` before it parses the body, so no value of `RATINGS_REFRESH` opens it, and it neither calls Letterboxd nor touches R2. Ratings reach the view index through the EPG commit shown above, the per-film lookup and the owner edit. The objects the refresh wrote under `enrichment/ratings/` stay in R2 untouched, and `GET /api/enrichment/ratings/status` still reads them; `enabled` is always `false`. Writers of `enrichment/view-index.json` keep their ETag retries.

## Watched, rating and watchlist as separate facts

**Accepted ([ADR-0023](../adr/0023-letterboxd-user-facts.md), [ADR-0024](../adr/0024-letterboxd-scan-summary.md)); the routine writers always record facts, with no switch: `LETTERBOXD_FACTS` is retired ([ADR 0055](../adr/0055-retire-letterboxd-facts-switch.md)); the baseline importer is a permanent owner-only maintenance route with no switch ([ADR 0053](../adr/0053-permanent-letterboxd-baseline-import-route.md)); finds exclude watched and rated films by TMDB identity ([catalog API](../reference/api/catalog.md#watched-and-rated-films)); a separate display-only title exclusion ([ADR-0028](../adr/0028-finds-display-only-watched-exclusion.md); namesake guards by list tag in [ADR-0033](../adr/0033-finds-exclusion-namesake-relaxation.md)) runs on every request without a switch; `FINDS_TITLE_EXCLUSION` is retired ([ADR-0041](../adr/0041-retire-finds-title-exclusion-switch.md)).** The EPG commit no longer scans the films list ([ADR 0054](../adr/0054-diary-first-epg-ratings.md)); a stored films-list summary still acts as the floor of every later observation. Every source writes observations into one fact record per film, only a greater observation (by time, then source rank, then observation id) replaces a value, a complete scan is stored once as a summary observation, and the view index is rebuilt from the records. Contract: [Letterboxd user facts](../reference/integrations/letterboxd-user-facts.md).

```mermaid
flowchart TD
    subgraph sources["Observations"]
        export["Owner's account export<br/>accepted identities to the merge"]
        diary["Diary entry, at its watched date"]
        films["Complete public films list<br/>(no longer scanned after a commit)"]
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
    list -.->|"read on every request:<br/>hide only, never a fact"| finds
```

A fact record also carries `ratingHistory`, the append-only list of the film's rating changes, written in the same compare-and-swap as the rating; the projection does not read it ([ADR 0038](../adr/0038-durable-rating-and-prediction-lineage.md), [user facts contract](../reference/integrations/letterboxd-user-facts.md)). Unresolved export rows (no accepted identity) never reach the merge; they stay in the importer's private report until a separate identity verification. The dashed path is display-only: the offline builder writes their normalized names and years to a private list, and Finds hide a catalog film whose original title and year match it uniquely, on every request and without a switch ([ADR-0041](../adr/0041-retire-finds-title-exclusion-switch.md)). Finds read that list without writing anything, and the match never becomes a fact, a rating or an identity link ([catalog API](../reference/api/catalog.md#display-only-title-exclusion), [runbook](../runbooks/finds-display-exclusion.md)).
