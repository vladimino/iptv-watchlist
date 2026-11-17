# AIR-79 legacy R2 runtime retirement audit, 17 November 2026

**Trello:** [AIR-79](https://trello.com/c/485tlGLA). **Code reference:** `main` at `ada9399e4d4871c2ebf183616c5fbca587a48bd0`. **Captured:** 17 November 2026 (UTC).

## Scope and method

Bounded audit of R2 runtime branches for domains that are D1-authoritative: canonical Film/Person, metadata cache, mutable predictions, published EPG/watchlist, Discovery, ratings documents and owner reviews. The method was code reading and `grep` of callers in `src/`, `scripts/` and `tests/`, split into four read-only passes (Film/Person and metadata cache, EPG and Discovery, ratings/predictions/owner reviews and flags, documentation). The author then re-checked the claims marked **verified** below against the code. Rows marked *reported* come from a pass and were not re-read by the author.

**Not done:** no production read or write, no test run for this audit, no Cloudflare binding inventory and no live `feature_flags` call. Marker states are the values the maintained documents record, not live reads, so every conclusion about "the branch is unreachable at `open`" holds for the recorded markers and must be re-confirmed against live markers before a removal is merged. AIR-475 owns `src/worker.js::catalogFilmRoute`, `src/canonical-catalog-reader.js`, `src/enrichment.js::filmHistoryRoute` and `public/app.js`; none of them is changed here.

## Verdict

**No code was removed.** Every remaining legacy-looking R2 branch is one of: a marker-gated arm that tests, the cutover scripts or the revert toolchain still exercise; the held-reader contract; a local or test stand-in; an intentional compatibility mirror or immutable source. Removing the large groups depends on one owner decision that this card cannot take (see [D-1](#deferred-items)). Two paths are **still authoritative on R2 in code** and are the real findings ([F-1](#findings), [F-2](#findings)).

Three candidates that the passes proposed as removable were checked and are **kept**:

| Candidate | Why it stays |
| --- | --- |
| `src/enrichment.js` `saveActualMirror` (**verified**) | Not a dead helper: called by the Letterboxd film fact path and by `PUT /api/enrichment/actual-ratings`. It is a no-op only while `RatingsD1.ratingsReady`; otherwise it writes R2. |
| `src/worker.js` `/api/watchlist` fallback when `epgPin.authority!=='d1'` (**verified**) | Reachable while the published-EPG marker is `held`: held readers stay on the R2 pointer by contract. |
| `src/monitor.js` `authority='r2'` status fallback (**verified**) | It reports an honest `r2` authority when the marker is not ready; removing it hides the state. |

## Findings

| ID | Location | Finding | Evidence | Disposition |
| --- | --- | --- | --- | --- |
| F-1 | `src/discovery.js` `catalogPosterObject`, `catalogPosterApply`, `catalogPosterHydration`; route `POST /api/enrichment/catalog/posters`; `src/admin/posters.js` read model | Poster hydration reads and writes `epg/discovered-films.json` and the generation copy directly through `env.BUCKET` with an etag compare-and-swap. It does not use `DiscoveryAuthority`, so the D1 catalog (`discovery_admission`) never receives the poster. | **Verified** by reading `catalogPosterApply` and its callers. | Behavior change (authority re-route). Needs its own card; not hidden in a cleanup PR. |
| F-2 | `src/worker.js` `setStarted` | Reads the frozen R2 `metadata.json` without a marker gate (`metadata[body.id]`) and falls back to `programme.json`. A Film newer than the frozen mirror resolves only through the programme. | **Verified** by reading the function. | Behavior decision (move the lookup to the D1 catalog reader or accept the programme-only lookup). Needs its own card. |
| F-3 | `docs/reference/feature-flags.md` and raw `env` reads | `OWNER_REVIEW_DB_OPTIONAL` is read by `src/owner-review-d1.js` but documented nowhere. Other raw variables (`PUBLISHED_EPG_DB_OPTIONAL`, `EPG_DIAGNOSTIC_RESOURCE_ID`, `MONITOR_HEARTBEAT_URL`, `MCP_ACCESS_*`, `MIGRATION_EXPORT_*`, `TMDB_REQUEST_INTERVAL_MS`, `FOOTER_SOURCE_TIMEOUT_MS`) are documented only in runbooks or ADRs, not in the flag reference. | *Reported.* | Documentation gap, no flag contract change. A separate documentation card can add them; `MIGRATION_EXPORT_*` looks like legacy-Site code and needs a consumer check first. |
| F-4 | `src/d1-enrichment.js` | Still reads `D1_ENRICHMENT_WRITE`, `D1_ENRICHMENT_WINDOW` and `D1_ENRICHMENT_BULK`, but `d1EnrichmentMode` returns `null` unless the test harness global is set, so production ignores them. The projector still reads the frozen `metadata.json`, `titles.json` and `people.json` as compare-only input. | *Reported.* | Retained as the compare-only projector until its code removal is separately approved; the three Cloudflare variables are already retired and absent and are not touched. |
| F-5 | `src/metadata-cache.js` | `loadMetadataWorkingSet` and `saveMetadataWorkingSet` keep an `r2` arm governed by `metadata_cache_authority`, a marker independent of the Film/Person marker. | *Reported.* The documents record the marker as `d1`; it was not read live here. | Keep until a read-only live check of that marker is recorded. |
| F-6 | Retired flag text | `RATINGS_PIPELINE` survives only in comments and MCP tool descriptions (`src/letterboxd-ratings.js`, `src/worker.js`, `src/mcp.js`); no code reads the binding. | `grep` of `src/`. | Cosmetic; the MCP description text is part of tool contract tests, so it is left unchanged. |

## R2 key family ledger

`removed` is empty. `retained` rows say why; `deferred` rows name the decision.

| Key family or branch | Consumer (examples) | Authority at the recorded marker | Verdict |
| --- | --- | --- | --- |
| `titles.json`, `people.json` reads (`localizedTitleStore`, `ratingsFilmLabels`, `catalogMetadataRead`, admin dictionaries, footer status, admin skew, Letterboxd archive compare, limbo labels) | `src/worker.js`, `src/admin/*`, `src/enrichment.js` | Marker-gated: D1 at `open`, R2 only in `legacy`, `r2` or `prepared` | **Retained.** The `existing` arms are exercised by the vm-scoped tests without the reader, by the pre-open cutover tests and by `CANONICAL_READER_REGISTRY` rows that feed handoff readiness. Removal is a coordinated change to code, registry and four test files; deferred to [D-2](#deferred-items). |
| `titles.json`, `people.json`, `metadata.json` writes through `saveCanonicalMirror` and the `putStoredJson` skip | `src/worker.js` | Frozen: returns false or `canonical_mirror_frozen` | **Retained.** It is the write fence; `canonicalMirrorsWritable` is the single predicate. |
| `metadata.json` (frozen mirror and the metadata cache mirror) | `src/metadata-cache.js`, `src/d1-enrichment.js`, diagnostics export, operator scripts | Mirror; recovery path for the cache marker | **Retained** (F-4, F-5). |
| `epg/published-generation.json`, `epg/generations/<run>/*`, `programme.json`, `watchlist.json` (r2-mode publisher, `persistWatchlist` tail, R2 `loadJSON` branches, `catalogGenerationCopy` tail) | `src/worker.js`, `src/published-epg.js` | `d1`/`open`: unreachable. `held`: the documented held-reader contract | **Deferred** ([D-1](#deferred-items), [D-2](#deferred-items)). Several arms are the held-reader contract and stay regardless. |
| Compatibility mirror writers (`writeMirrors`, `repairMirrors`, `putStable`) and the R2 ledger copy after the D1 write | `src/published-epg.js`, `src/epg-orchestration.js`, `src/worker.js` | Mirror and archive, written by the named writers | **Retained.** |
| `epg/resolver-lease.json`, `epg/resolver-continuation.json`, `epg/discovery-workflow.json`, `epg/discovery-resolution.json` R2 tails and the four R2 decisions-map writers in `src/admin/discovery-recovery.js` | `src/discovery.js`, `src/discovery-workflow.js`, `src/admin/*` | Dead at `d1`/`open` (the `DiscoveryAuthority` handler answers first); enumerated by count in `tests/projector-window-r2-writes.mjs` and `tests/projector-window-r2-inventory.mjs` | **Deferred** to [D-1](#deferred-items). Do not touch the `projector_window` fence. |
| `epg/discovered-films.json` catalog and generation copy | `src/discovery.js`, `src/admin/posters.js`, `src/enrichment.js` | **R2 is authoritative in code** | **Finding F-1.** |
| `PUBLISHED_EPG_DB_OPTIONAL=standin` and the other `*_OPTIONAL` stand-ins | `src/published-epg.js`, `src/owner-review-d1.js`, local dev and tests | Not set in production; asserted absent by tests | **Retained** (harness seam). |
| Ratings documents R2 fall-through when the key is not D1-owned (`letterboxd-ratings.js`, `letterboxd-diary.js`, `letterboxd-facts.js`, `enrichment.js` `mergeStoredJSON`) | Ratings paths and tests | `d1`/`open`: the key is owned, R2 is not touched; D1-only keys and the fence throw instead of falling back | **Retained** with the revert toolchain ([D-1](#deferred-items)). `RATINGS_DB_REQUIRED=on` already fails closed in production. |
| Ratings and removal events, raw Letterboxd inputs, `letterboxd/imports/*`, `letterboxd/admissions/*`, archive receipts | Letterboxd pipeline, admin archive | Immutable or raw by contract | **Retained.** |
| Prediction `r2` claim, queue, lease and profile branches, import, activate and release | `src/prediction-d1.js`, `src/enrichment.js`, `scripts/prediction-domain-*.mjs` | `d1`: refuse on any D1 mismatch; no silent fallback | **Deferred** to [D-1](#deferred-items). `PREDICTION_DB_REQUIRED=on` fails closed. |
| Immutable prediction, fingerprint, profile and assessment version bodies | `src/prediction-d1.js` | Immutable R2 bodies chosen by D1 pointers | **Retained.** |
| Owner-review `r2` commit, read and import/activate/revert branches | `src/owner-review-d1.js`, `src/admin/*-route.js`, `scripts/owner-review-authority.mjs` | `d1`: reachable only under the `r2` marker or the stand-in | **Deferred** to [D-1](#deferred-items). |
| `admin/owner-reviews.json` mirror | `src/owner-review-d1.js` `publishMirror` | Mirror written at `d1`; projector reads D1 | **Retained.** |
| `src/prediction-repository.js`, `scripts/d1-backfill.mjs`, `scripts/offline-import.mjs`, `scripts/snapshot-store.mjs`, `scripts/r2-snapshot-export.mjs`, cutover scripts | Offline tooling | Offline sources | **Retained**; offline-only and outside the Worker. |
| `ratings_storage_migrate` (MCP tool, `POST /api/letterboxd/ratings/migrate`, `migrationState` gate) | `src/letterboxd-ratings.js`, `src/mcp.js`, `src/worker.js` | The migration is recorded complete, but `migrationState()==='complete'` is a hard gate for start and step | **Deferred** to [D-3](#deferred-items); not inert. |

## Feature-flag closure

`src/feature-flags.js` registers the live gates `LIFECYCLE_LOCALIZATION`, `MONITOR` and `MONITOR_TRANSPORT`, and retired names that the reference page documents. No additional migration orphan was found beyond F-3 to F-5. `D1_ENRICHMENT_WRITE`, `D1_ENRICHMENT_WINDOW` and `D1_ENRICHMENT_BULK` are already retired and absent, and `MONITOR` is a permanent emergency gate. No binding was changed by this card.

## Deferred items

These are recorded for the Planner and owner; they are not created as Trello cards by this change.

| ID | Item | Why it is not in this change |
| --- | --- | --- |
| D-1 | Decide whether rolling a marker back to `r2` (published EPG, Discovery, ratings, predictions, owner reviews, metadata cache) stays supported. If it does not, the r2-mode publisher, the `r2` lease, continuation, workflow-state and decisions-map tails, and the import, activate and revert toolchain with its scripts and tests can be removed together. | A new material decision on rollback authority, owner-controlled. Removing the pieces separately would break the cutover and revert tests and the held-reader contract. |
| D-2 | Remove the `existing` arms of the Film/Person marker gate and their `CANONICAL_READER_REGISTRY` rows. | Needs the vm-scoped and pre-open tests migrated first, and must not collide with AIR-475 in `worker.js`, `canonical-catalog-reader.js` and `enrichment.js`. |
| D-3 | Make the ratings migration gate unconditional and retire `ratings_storage_migrate`. | Medium change to MCP tool lists, a route and several tests. |
| D-4 | Re-route poster hydration and the posters admin read model to the D1 catalog ([F-1](#findings)). | Behavior and authority change. |
| D-5 | Decide the `setStarted` metadata lookup ([F-2](#findings)). | Behavior decision. |
| D-6 | Read-only live check of `metadata_cache_authority` and a cross-check of live `feature_flags` against the Cloudflare binding inventory. | Needs an authorized live source; none was used here. |

## Documentation changed by this audit

`docs/architecture/persistence-and-migration.md` (stale future-cutover chain removed from the diagram; authority-per-domain table), `docs/architecture/system-context.md`, `docs/architecture/ui-and-read-models.md`, `docs/architecture/deployment-and-rollback.md`, `docs/runbooks/deployment.md`, `docs/runbooks/d1-backfill.md` (historical note), `docs/runbooks/recovery/README.md`, the new `docs/runbooks/recovery/d1-authority-and-time-travel.md`, `docs/runbooks/README.md`, `docs/reference/domain/admin-read-contract.md`, `docs/reference/scheduled-tasks.md`, `docs/reference/data/README.md` and `docs/reference/data/d1-schema.md`. Accepted ADRs are unchanged.

## Limits

Documentation not yet reconciled (reported, not re-read): `docs/architecture/letterboxd-ingestion.md` sequence participants named "Authoritative R2", the "future migration" heading in `docs/reference/integrations/letterboxd-user-facts.md`, the `authoritative:false` wording in `docs/reference/api/d1-catalog.md`, and the applied-migration and prepared-GO runbook pages (`film-person-0019` to `0023`, `h1-load-package`, `holdpoint-decision-pack`, `d-c-decision-pack`) that are not labelled historical in the runbook index. They are listed for a follow-up documentation card.
