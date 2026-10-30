# Worker runtime topology

**Scope:** request routing and trusted storage boundary of the current deployed Worker. Sources: [`src/worker.js`](../../src/worker.js), [`src/mcp.js`](../../src/mcp.js), [`src/continuation.js`](../../src/continuation.js), [`src/d1-enrichment.js`](../../src/d1-enrichment.js), [Wrangler settings](../../wrangler.jsonc) and [runtime runbook](../runbooks/deployment.md).

```mermaid
flowchart TB
    web["Browser: UI and API"]
    mcpClient["ChatGPT MCP client"]
    webAccess["Access: All Workers"]
    mcpAccess["Access: IPTV MCP"]
    cron["Cloudflare cron trigger: 37 * * * *"]
    subgraph worker["Single Worker: iptv"]
        route["src/worker.js HTTP router"]
        mcp["src/mcp.js: JWT and MCP protocol"]
        sync["Sync and EPG handlers"]
        prediction["Prediction runner handlers"]
        discovery["One discovery chunk per explicit request"]
        catalogD1["src/catalog-d1.js: read-only relational views"]
        projector["src/d1-enrichment.js: enrichment projector, D1_ENRICHMENT_WRITE off by default"]
        route --> sync
        route -->|GET /api/d1/*| catalogD1
        route --> prediction
        route -->|exact /mcp| mcp
        mcp -->|allowlisted tool call| sync
        mcp -->|allowlisted tool call| prediction
        sync -->|explicit step after EPG commit| discovery
    end
    store[("R2 BUCKET: iptv")]
    d1[("D1 DB: iptv, follows R2")]
    web --> webAccess --> route
    mcpClient --> mcpAccess --> route
    sync <--> store
    prediction <--> store
    discovery <--> store
    catalogD1 -->|SELECT only| d1
    cron -->|scheduled event| projector
    store -->|reads enrichment objects| projector
    projector -.->|on: changed Films and Persons| d1
    classDef current fill:#edf8ef,stroke:#579266,color:#15361e
    classDef gated fill:#fff3de,stroke:#a56c2b,color:#42300e
    class store,d1 current
    class projector gated
```

The **one-chunk continuation** is executed inside the explicit step/request that asks for it. `DiscoveryContinuation` is an internal entrypoint, not an unauthenticated public endpoint, a second Worker, a cross-isolate guarantee, or a self-fetch with credentials. Only authorized operations invoke write handlers. Route names such as GET/status cannot universally be assumed read-only: consult [deployment safety notes](../runbooks/deployment.md).

`wrangler.jsonc` binds `BUCKET` to R2 `iptv` and `DB` to the D1 database `iptv`. R2 stays authoritative for every existing page and writer. Pages read D1 only through the [D1 catalog views](../reference/api/d1-catalog.md) under `/api/d1/`, behind the same Access policy as the rest of `/api/`. The D1 data is the backfilled copy of R2 ([D1 backfill runbook](../runbooks/d1-backfill.md)).

The one Worker cron trigger runs only the [enrichment projector](../adr/0056-d1-enrichment-write-through.md), never a sync, EPG, discovery or prediction step. With `D1_ENRICHMENT_WRITE` unset it returns at once.

- With `dry`, it reads the enrichment objects from R2 and the change keys from D1, and logs the diff.
- With `on`, it also writes the changed Films and Persons to D1 under its lease. That dashed arrow is the Worker's only D1 write path, and it never writes R2.

Runtime mode and configured Cloudflare Access policies must be rechecked for live-state claims.

See [one-chunk ADR](../adr/0006-one-chunk-discovery.md), [MCP security contract](../reference/api/mcp.md) and [D1 schema boundary](../reference/data/d1-schema.md).
