# Persistence authority and staged migration

**Production today:** R2 bucket `iptv` is authoritative. The D1 database `iptv` carries schema v4 and a backfilled copy of the R2 domain (Films, Persons, credits, candidates, decisions, predictions and fingerprint pointers). The Worker is bound to it and pages read it only through the read-only [D1 catalog views](../reference/api/d1-catalog.md). The [enrichment projector](../adr/0056-d1-enrichment-write-through.md) is deployed and enabled in production (`D1_ENRICHMENT_WRITE=on`); it keeps D1's Films, Persons, credits and metadata following authoritative R2. The flag's absent/off default shown in the diagram is a deployment safeguard, not the current production setting. See [D1 contract](../reference/data/d1-schema.md), [ADR-0001](../adr/0001-d1-schema-v1.md), [migration ADR](../adr/0017-staged-d1-migration.md) and [offline evidence](../evidence/d1-migration/air-73-offline-run.md).

```mermaid
flowchart TD
    worker["Production Worker"]
    r2[("R2: authoritative objects")]
    archive["Historical snapshot (offline)"]
    importer["Offline importer and parity"]
    local[("Local SQLite / D1-compatible schema")]
    gate["Owner approval and live evidence gates"]
    snapshot["Fenced R2 snapshot (read-only export)"]
    reload["Offline executor build, loaded by D1 Import API"]
    d1[("D1 iptv: backfilled domain copy")]
    projector["Enrichment projector: cron, D1_ENRICHMENT_WRITE off by default"]
    flipWrite["Future write flips, per domain"]
    flipRead["Future page reads on SQL"]
    retire["Future cleanup: R2 keeps blobs only"]
    worker <--> r2
    worker -->|read-only /api/d1| d1
    archive --> importer --> local
    local -.-> gate
    r2 -->|one-off export| snapshot --> reload -->|one-off load, no live flow| d1
    r2 -->|reads enrichment objects| projector -.->|on: changed Films and Persons| d1
    gate -.-> flipWrite -.->|future: Worker writes D1| d1
    flipWrite --> flipRead --> retire
    classDef future fill:#fff3de,stroke:#a56c2b,color:#42300e
    classDef gated fill:#fff3de,stroke:#a56c2b,color:#42300e,stroke-dasharray:4 3
    class gate,flipWrite,flipRead,retire future
    class projector gated
```

The historical archive is not live production. Offline import receipts, schema compatibility and replay parity are evidence, not authorization. An incomplete or conflicting import must report gaps; it must not invent Film identities or silently omit unportable data. No R2/D1 shared transaction exists, so read/write migration must be staged with separate acceptance and recovery boundaries. Inside the future live backfill, the one large unit (a programme generation) is written to D1 staging tables in bounded chunks and published by one commit request ([ADR-0021](../adr/0021-staged-atomic-generation-import.md)); this changes no node or arrow above, and the staging tables are read by no runtime path.

The prediction family is portable only when every prediction record links an immutable version object. Records written before that rule were linked by a one-time, separately approved materialization inside the Worker (planned from a fenced snapshot, written under the prediction writer lease) that stayed within `worker <--> r2`; see [ADR-0026](../adr/0026-historical-prediction-version-materialization.md). It ran on 28 October 2026, before the backfill and not as part of it, and its route is retired ([ADR 0050](../adr/0050-retire-prediction-materialization-route.md)).

A fingerprint or prediction bundle stored under a retired Film id, whose survivor holds its own newer payload, is not imported: the importer records it as superseded by the canonical payload and leaves the object in R2 ([ADR-0029](../adr/0029-superseded-redirect-payloads.md)). This is a ledger rule inside the offline import and changes no node or arrow above.

Two R2 families stay R2-only and add no row ([ADR 0061](../adr/0061-discovery-observation-index-and-reconsider.md)):

- The discovery observation index under `epg/generations/<run>/discovery-observations/` is a derived projection of the ledger and the decisions and falls under the generation archive family.
- The guarded owner action records under `admin/actions/` are run records.

Both stay within `worker <--> r2` and change no node or arrow above.

The catalog poster negative index `epg/catalog-poster-negatives.json` ([ADR 0063](../adr/0063-catalog-poster-negative-index.md)) is the same kind of object: one R2 JSON the poster maintenance route reads and writes under its existing lease, classified with the other runtime coordination keys and not imported. It changes no node or arrow above.

The immutable fingerprint body and generation record ([ADR-0035](../adr/0035-selective-fingerprint-transition-compatibility.md) section 2) that the current `fingerprint.json` names are mapped through it and add no row; older generations stay in R2 as unreferenced history. This is also a ledger rule inside the offline import and changes no node or arrow above.

The D1 data came through a one-off path, not a live flow: a fenced read-only snapshot of R2, a local build by the backfill executor, and one load through the D1 Import API ([runbook](../runbooks/d1-backfill.md)). Between reloads, the active enrichment projector keeps D1 following R2: R2 stays the truth, and D1 Films, Persons, credits and metadata may trail it by up to an hour. Other domains (candidates, decisions, predictions, ratings) follow R2 only through a reload until their own step. A reload seeds the projector's change keys and replays the D1-only steps ([runbook](../runbooks/d1-backfill.md#reload-with-the-enrichment-projector-air-275-phase-2)). The projector's enrichment objects include the optional owner-approved `identity/tmdb-retirements.json` ([ADR 0057](../adr/0057-tmdb-tv-identity-and-retired-movie-ids.md)): when it exists, the projection applies it and D1 follows the corrected identity like any other R2 change; the snapshot loader, the offline import and the seed read it the same way. This changes no node or arrow above.

The metadata step's roster read is the same kind of edge: one bounded select for films that step is already localizing, used only when the row matches that film's snapshot and typed identity. It does not choose fresher metadata, skip the Letterboxd fetch, rewrite a reviewed name, or decide what the R2 cache commits. This changes no node or arrow above.

`GET /api/d1/persons/<role>/<key>/identity` is a read-only D1 catalog read. It loads one person's neighborhood and calls the derived Person reference ([ADR 0062](../adr/0062-d1-person-identity-read.md)). The Finds actor and director filter is the one page reader of that GET ([ADR 0065](../adr/0065-finds-person-filter-d1-read.md)): it requests only a selected person, and it keeps a film only from an unbounded verified coCredit whose `film:tmdb:<n>` is the published catalog row's typed movie id. The watchlist grid still matches the stored role id. R2 stays the authority. This changes no node or arrow above.

**Not deployed:** a write flip (any writer that treats D1 as the truth) and a general page cutover onto SQL. The Finds person filter above is a reader of one GET, not that cutover. The remaining steps are the phases of [AIR-275](https://trello.com/c/4x7hH0gI): per-domain write flips (D1 becomes the truth, the R2 JSON stays a cache for pages not yet moved), page reads on SQL, then a cleanup that leaves R2 holding blobs only. The earlier shadow-write and shadow-read stages were dropped by the owner as disproportionate for this project. Each orange node is a planned step, not a claim that it is done or an instruction to perform it.
