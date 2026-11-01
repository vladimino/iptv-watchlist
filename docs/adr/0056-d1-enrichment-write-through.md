# ADR 0056: The first phase 2 step keeps R2 authoritative and projects the enrichment domain into D1 from a cron trigger

**Status:** Accepted  
**Original decision date:** 2026-10-30  
**Recorded at:** 2026-10-30  
**Approval source:** Owner decisions in the AIR-275 working session on 2026-10-30: write-through instead of an immediate write flip, recorded by the coordinator on [AIR-275](https://trello.com/c/4x7hH0gI) together with the review invariants; and, after the first review of [PR #249](https://github.com/vladimino/iptv-watchlist/pull/249), a Worker cron trigger rather than an MCP tool called by the hourly Task or a run after the R2 commit. ADR 0056 was explicitly accepted by the owner in the AIR-275 PR #249 conversation on 2026-10-30; the same approval visually accepted all three Mermaid diagrams (runtime topology, persistence/migration, scheduling/orchestration) and separately authorized deployment with the Cloudflare cron registered at `37 * * * *` while `D1_ENRICHMENT_WRITE` remains off. No D1 schema migration, reload, AIR-286 replay, or `dry`/`on` activation was authorized.  
**Related work:** [AIR-275](https://trello.com/c/4x7hH0gI), [AIR-286](https://trello.com/c/EswNQuv8), [ADR 0051](0051-d1-domain-r2-blobs.md)  
**Supersedes:** [ADR 0051](0051-d1-domain-r2-blobs.md) in part, for the enrichment domain only: decision 2's first step, in which the writer makes D1 the truth at once and keeps the R2 JSON as a cache. For enrichment, an R2-authoritative projection into D1 from a Worker cron trigger comes first, and the write flip follows later. The rest of 0051 stands: the D1/R2 split, phase 1, the person evidence rule, the dropped shadow stages and G-gates, and the per-domain flips of the other domains.  
**Superseded by:** [ADR 0073](0073-metadata-cache-d1-authority.md) (Accepted 2026-11-01) in part, and only while the metadata cache marker is `d1`: the projector sources metadata cache records from D1, while R2 remains authoritative for the rest of the enrichment flow. All other decisions remain.

## Context

[ADR 0051](0051-d1-domain-r2-blobs.md) makes D1 the home of the relational domain and plans a write flip per domain, enrichment first (Films, Persons, credits, metadata). In R2 these are not stored as entities. The lifecycle reader (`src/domain/film-person-reader.js`) derives them from several JSON objects with three different writers:

- `metadataSync` writes `metadata.json`, `people.json` and `titles.json`;
- `finishSync` writes `watchlist.json`;
- discovery writes `epg/discovered-films.json`.

Each of these steps reads its own JSON back as working state on the next step. A real flip ("D1 is the truth, R2 the cache") would therefore move those steps' own reads to D1. That is phase 3 work, and it would change the hourly EPG cycle.

Two further facts shape the design:

- **Linking is global.** Whether a catalog record becomes its own Film or joins a watchlist Film depends on the whole view (the Letterboxd ↔ TMDB link). One discovery step can therefore change Films it did not touch.
- **D1 already holds facts R2 does not.** [AIR-286](https://trello.com/c/EswNQuv8) added TMDB credits to the 394 watchlist Films in D1 only.

On the 2026-10-29 snapshot, one full lifecycle view took about 40 s of CPU. The reader's per-Film lookups scanned the whole discovery resolution and catalog each time.

## Decision

1. **Write-through projection, R2 stays authoritative.** A projector (`src/d1-enrichment.js`) reads the enrichment records from R2. It builds the whole Film/Person view with the same reader and the same derivation (`src/enrichment-projection.js`) as the offline import. It then writes to D1 every Film and Person whose content changed. The R2 writers are not changed.

   **The inputs fail closed.** Every object the view needs (`watchlist.json`, `metadata.json`, `titles.json`, `people.json`, `epg/discovery-resolution.json`) must be present and of its shape. The programme and the catalog are read only from the copies of the one generation `epg/published-generation.json` names as `published`, never from the root copies. A missing, malformed or unpublished input stops the run before any D1 write (`input_missing`, `input_invalid`, `generation_unpublished`). A present, empty object is a real empty dataset. Only the Letterboxd diary may be absent, because its own switch can be off.

   **The read is one consistent cut.** A run does not start while a writer of these objects is at work: a live discovery lease (`epg/resolver-lease.json`), or a sync in its metadata or EPG stage updated within 15 minutes. After every read, each object, the pointer included, is checked again by its R2 etag, and the writer checks are repeated. The published generation's catalog and the resolution are updated in place, so an unchanged `programmeRunId` does not prove unchanged content. A change or a writer defers the run before any D1 write (`deferred`, with `writer_active` or `input_changed` and the key); the next hourly run reads again.
2. **Change keys in D1, written atomically with the rows.** `projection_state` (schema v4, `migrations/0004_projection_state.sql`) holds a change key per Film and Person. The key is written in the same `db.batch` as the rows it describes, so a key never claims a write that did not commit. Time Travel and a reload bring the keys back with the rows. The key ignores values equal to the run's own clock, so an unchanged view converges to zero writes.

   **Metadata checksum.** The projector writes `film_metadata.content_sha256` as NULL. A projected row comes from a live read, not from a pinned object version, and the whole-file checksum of `metadata.json` would otherwise change with every Film. A row the reload wrote and the projector has not rewritten keeps the snapshot object's checksum, which stays true of that row.
3. **Ownership in the repository.** `canonical-repository.js` gains `projectFilm`, `projectLink`, `projectPerson` and `releaseFilm` with these rules:
   - **What the projector owns:** the Film row, its external ids and aliases, the identity and metadata dimensions, `film_metadata`, the watchlist membership, the Person rows, and the credits R2 supplies.
   - **What it never writes:** the fingerprint and prediction dimensions.
   - **D1-only credits:** a TMDB credit on a watchlist Film that only D1 holds (AIR-286) survives every rewrite. In the same batch it is renumbered after the R2 credits of its role, unless the R2 roster lists the same person in that role.
   - **Catalog Films:** all credits follow R2.
4. **Absent entities.** A Film or Person the view no longer has counts as a change:
   - its key becomes `absent`;
   - a Film also loses its watchlist membership.

   The Film row, its credits and its history stay, because they remain true of the Film. Re-canonicalization goes through the existing redirect path (`projectLink`).

   **Guards against well-formed but incomplete input.** Both are absolute, so the size of the projection never widens them, and a run past either writes nothing:
   - `absent_guard`: more than 25 absent Films or 250 absent Persons in one run;
   - `membership_guard`: more watchlist memberships lost than the larger of 5 and 2 % of the current members (8 at 394). This guard compares `watchlist_film` with the view, so it also counts Films that stay in the view but drop off the watchlist, as an empty or truncated `watchlist.json` would make them.

   A routine sync removes far fewer. An intended mass removal goes through a reload, not through the projector.
5. **Separate cron trigger, flag-gated.** The projector runs from a Worker cron trigger (`37 * * * *`), never from a sync or discovery step. The owner chose this over an MCP tool called by the hourly Task and over a run after the R2 commit. The deploy registers the trigger in Cloudflare even while the flag is off. `D1_ENRICHMENT_WRITE` controls it:
   - `off` (the default) reads nothing;
   - `dry` reads R2 and the D1 keys and logs the diff;
   - `on` writes.
6. **Lease and fence.** `projection_run` holds one lease per projector, on the wall clock. Every write batch starts with an insert into `projection_fence` whose `CHECK (held=1)` passes only while this run holds a live lease. A run that lost its lease therefore fails the batch whole and stops. An older run cannot overwrite a newer one.
7. **Bounded runs.** Each run has a query budget (800) and a wall budget (60 s). Persons go 25 per batch, retried one by one when a batch fails, and Films one per batch. What a run does not reach, the next run writes. All R2 records and the view are dropped before the write phase starts.
8. **Reload seeds the keys.** After an offline import, `scripts/d1-projection-seed.mjs` writes the snapshot's keys for every Film and Person the database holds. The first projector run after a reload then writes only what R2 changed since the snapshot. Until a real write flip, every D1-only write must be a reproducible script step, replayed after a reload (AIR-286 now, AIR-44 links later).
9. **The reader is bundled.** The reader, the projection module and the repository enter the Worker bundle in their own scopes (`scripts/bundle-scope.mjs`). Two reader changes come with this:
   - lookup indexes that return what the linear scans returned (one view on the snapshot dropped from about 40 s to about 1.2 s, output byte-identical);
   - an `entitiesOnly` option that skips the sidecars and legacy parity, which the projector does not need.

Not decided here: the real write flip of the enrichment writers, the person link model (AIR-44), and deleting any R2 JSON. A Film row is never deleted by this projector.

## Alternatives considered

- **Re-project only the ids a step touched.** Rejected: the global link can change Films a step did not touch.
- **Flip the enrichment writers now (D1 truth, R2 cache).** Deferred: it requires moving `metadataSync` and discovery to read their state from D1, which is phase 3 work inside the hourly EPG cycle.
- **Change keys in an R2 object.** Rejected: they could not be written atomically with the D1 rows, and a Time Travel restore would not bring them back.
- **Run the projector at the end of `metadataSync` or discovery.** Rejected: it would add a full view build to steps that already carry the memory-heavy part of the R2 pipeline.
- **An MCP tool the hourly ChatGPT Task calls.** Rejected by the owner: it changes the Task's prompt (its own approval) and ties the projector to the Task running.

## Consequences

- **Freshness.** D1 follows R2 within about an hour of an enrichment change, without a delta-backfill tool.
- **Cost.** Each run loads about 11 MB of JSON and builds the whole view. On the 2026-10-29 snapshot this retained about 57 MB of heap at the peak and used about 1.5 s of view CPU ([evidence](../evidence/d1-migration/air-275-enrichment-projector-2026-10-30.md)). The Worker's isolate limit is 128 MB, and an isolate can also be serving a sync request, so `dry` comes first in production.
- **Approximate ownership.** The D1-only credit rule distinguishes by person source and watchlist membership only. A TMDB credit that R2 once supplied for a watchlist Film and later dropped would stay as if D1-only. This is acceptable until credits carry provenance.
- **Bigger bundle.** The Worker carries the reader and the repository. Their tests now assert the scoped bundle copy instead of their absence.

## Recovery and migration boundary

Code deploy is inert: with `D1_ENRICHMENT_WRITE` unset, the cron trigger returns at once. Each of these needs its own explicit owner approval:

- applying migration 0004 to D1 `iptv`;
- seeding the keys with a reload;
- setting `dry`;
- setting `on`.

Rollback of `on` means unsetting the flag. The rows it wrote stay until a Time Travel restore to a bookmark taken before enabling it. R2 is never written by the projector.

## Evidence

- **Original decision:** owner decision on 2026-10-30, recorded on [AIR-275](https://trello.com/c/4x7hH0gI)
- **Implementation:** the AIR-275 phase 2 PR (this ADR's PR)
- **Dated verification:** [projector measurements on the 2026-10-29 snapshot](../evidence/d1-migration/air-275-enrichment-projector-2026-10-30.md), local, plus the production rollout of 30 October 2026 (section 7)
- **Uncertainty:** the cost figures above are Node measurements. In production (evidence section 7) the runs took 1.8–5.8 s of Worker CPU and 5.6–17.5 s of wall time when complete, and the first `on` run stopped at the 60 s wall budget. Cloudflare does not report the Worker's peak heap, so that stays unmeasured; every invocation ended `ok`.

## Follow-ups

- The write flip of each enrichment writer (phase 2 continued). [ADR 0073](0073-metadata-cache-d1-authority.md) accepts that future flip for the metadata cache alone, gated by `metadata_cache_authority.mode`; production schema `0006`, import and activation each still require separate owner authorization.
- [AIR-44](https://trello.com/c/ojtZjVc9) person links, written as a reproducible step.
- Credit provenance, if the approximate ownership rule ever bites.
