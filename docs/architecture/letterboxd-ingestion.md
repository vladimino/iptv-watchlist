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
