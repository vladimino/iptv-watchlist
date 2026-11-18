# AIR-79 final retirement audit and closeout ledger, 18 November 2026

**Trello:** [AIR-79](https://trello.com/c/485tlGLA). **Decision:** [ADR 0162](../../adr/0162-d1-only-authority-retire-rollback-toolchain.md). **Captured:** 18 November 2026 (UTC) on `main` `fc47af96`. Read-only static audit after the seven per-domain slices; no production read or write, no migration, marker, flag, Task, binding or Access change, and no test of production behaviour. Claims are from reading the import graph (`build.mjs`, `src/worker.js`, `src/mcp.js`, `wrangler.jsonc`), the code and the dated evidence files; nothing was executed against production.

## Verdict

**AIR-79 cannot close yet.** The seven serving-reader slices are delivered and no Film/Person, owner-review, metadata-cache, ratings, prediction, published-EPG or Discovery reader falls back to R2 when D1 refuses. What remains is not runtime authority but retained tooling and unreachable code, plus two items that still touch R2 as an authority. Each needs its own atomic, owner-approved card (proposals below); none is started here.

## Corrections to earlier records

- **F-2 (`setStarted` reads the frozen `metadata.json`) is already closed.** `setStarted` in `src/worker.js` reads the canonical D1 Film through `CanonicalCatalogReader.catalogStartedFilm` and refuses (`503`, no R2 write) when D1 does not serve; `tests/started.mjs` asserts it ([AIR-516](https://trello.com/c/03h5WhiT)). The "Deferred" row in the [11-17 closeout](air-79-d2-closeout-and-d1-preparation-2026-11-17.md) predates that change.
- The seventh-slice evidence listed the Film/Person cutover tooling as one retained group; the import graph below separates what the production Worker still exposes (one MCP tool) from offline scripts.

## Closeout ledger

`Reach` is the proven reachability today (production marker `d1`/`open`, generation 2).

### Film/Person cutover tooling

| Code path | Existing caller | Reach and live authority | Recommendation | Risk and tests |
| --- | --- | --- | --- | --- |
| `src/film-person-open-handoff.js` and MCP tool `film_person_open_handoff` (`src/mcp.js` registration and dispatch, `MCP_INSTRUCTIONS`, `build.mjs` bundle) | Owner-only MCP client | **The only production-exposed item.** Its flip is fenced on marker `prepared` and Discovery `d1`/`open`; at `d1`/`open` preflight blocks and apply answers `flip_precondition` or `unknown_committed`. Cannot flip today. | **Defer, then remove** in its own card | Low runtime risk. Removal changes the MCP tool list (connected clients rediscover); edits `src/mcp.js`, `build.mjs`, `tests/mcp*.mjs`, `tests/mcp-tools.mjs`, MCP reference and the runbook. |
| `scripts/film-person-open-handoff.mjs` | Nobody (CLI) | Its REST `apply` is refused by design; dry-run only. | Remove with the MCP tool | Test `tests/film-person-open-handoff.mjs`. |
| `transitionAuthority`, `readMarker` in `src/film-person-authority.js` | `scripts/film-person-connector-run.mjs`, handoff, baseline | `transitionAuthority` is a fenced marker update; at `d1`/`open` only `open` to `held` is a legal move. Never called by the Worker. | **Retain** | It is the `open`/`held` state machine mirrored by the SQL triggers; keep it when the offline set goes. |
| `src/film-person-baseline.js`, `-cutover-accepted.js`, `-cutover-minimum.js` | Offline scripts and tests only; not in the bundle | Baseline writers require marker `r2`/`open` and now refuse. | Remove with the offline set | Tests and mutation tests; entries in `scripts/run-tests.mjs` and `scripts/test-classification.mjs`. |
| `scripts/film-person-connector-run.mjs`, `film-person-cutover-run.mjs`, `film-person-capture.mjs`, `film-person-prepared-loader.mjs`, `film-person-h1-verify.mjs` | Nobody (CLIs) | Read-only against production or emit SQL for an owner to apply; no valid state to record against. | Remove as one offline-set card | No Worker impact; update the two test registries. |
| `scripts/film-person-0019-preflight.mjs`, `0020-preflight.mjs`, `film-person-e6-measure.mjs` | Nobody; `0019` is imported by `h1-verify`, `e6-measure` by `epg-producer-m2b` | Read-only. | **Defer** (decide separately) | Tied to migration runbooks. |

### Projector and dormant producer arms

| Code path | Reach | Recommendation | Risk and tests |
| --- | --- | --- | --- |
| `runD1EnrichmentProjection` and its `legacy`/`r2`/`prepared` write arms (`src/d1-enrichment.js`), `PROJECTOR_MARKER_GUARD`, `projectorExpectation`, `projectorHolds` | No production caller: the cron no longer calls it ([ADR 0155](../../adr/0155-retire-enrichment-projector-cron.md)), there is no Workflow or MCP route, and the mode is `null` outside a vm test harness. At `d1`/`open` `projectorExpectation` refuses, so nothing is written. | **Remove as a staged follow-up** | Medium. Keep `d1EnrichmentStatus` (used by `catalog-d1`) and `d1EnrichmentStore` (used by capture); keep the `projector_window` table and its read paths (Discovery, `canonicalMirrorsWritable`, the handoff). About 20 projector-family tests and the per-file tables in `scripts/run-tests.mjs` and `scripts/test-classification.mjs`. |
| Dormant producer skips: `producerRouteOpen` false returns, `route.writer!=='canonical'`, the `routeSkipMs` cache, `routeOf` `{open:false}`, `SKIPPED`, the `r2Allowed` branch of `writerRoute` and `readSource` | Reachable only through the explicit `FILM_PERSON_DB_OPTIONAL` stand-in. | **Defer until the stand-in is decided**, then remove together | Many tests rely on the stand-in. |
| `canonicalMirrorsWritable` | One caller (`src/worker.js`); true only while the marker is not `d1` (never in production). | Retain | Part of the write fence for the frozen mirrors. |

### Discovery ledger tools and the shared S3 client

| Code path | Reach | Recommendation | Risk and tests |
| --- | --- | --- | --- |
| `scripts/discovery-ledger-install.mjs` `--apply --approved-production-writes` | The only script that can write production R2 (`PutObject` with `If-Match`/`If-None-Match`, the resolver lease). **It never reads `discovery_authority`**, so it is fenced only by the R2 pointer, the sync stage and the R2 lease, whatever the D1 marker says. Dry-run is GET/HEAD only. | **Defer; guard or remove the apply path** in its own card with an owner GO. Never run. | Highest hazard of the remaining items. `tests/discovery-ledger-install.mjs`, the discovery ledger runbook (stage 2), ADR 0034. |
| `createS3Store`, `readInstallCredentials` (defined in `discovery-ledger-install.mjs`) | Imported by `scripts/prediction-domain-production.mjs` and the install test. | **Retain**; move to a neutral module (for example `scripts/r2-s3-store.mjs`) before any removal | Deleting the install script without the move breaks prediction tooling. |
| `discovery-ledger-split.mjs`, `-offline.mjs`, `-benchmark.mjs` | Offline overlay store; no R2, no D1, no network. | Retain (historical analysis) | Removal needs their tests and runbook sections. |

### Remaining R2 consumers and legacy authority paths

| R2 key family | Class | Reach |
| --- | --- | --- |
| `epg/discovered-films.json` and its generation copy (poster hydration in `src/discovery.js`, `src/admin/posters.js`) | **Legacy authority path** | **Reachable.** Written with an etag CAS, outside `DiscoveryAuthority` for the poster path, so D1 `discovery_admission` does not receive the posters. Tracked as F-1 / [AIR-515](https://trello.com/c/FMWcvvWI) (behaviour change; needs its own card). |
| `epg/resolver-lease.json`, `resolver-continuation.json`, `discovery-workflow.json`, the R2 decisions-map writers and the four admin recovery writers | Legacy authority path | Dead at `d1`/`open`; tails to retire with the Discovery rollback toolchain (D-1, owner gate). |
| Published EPG pointer, generation documents, `programme.json`, `watchlist.json` | Compatibility mirror and held-reader contract | Read from R2 only while the published-EPG marker is `held`; reconciled hourly by the EPG ensure. Retain. |
| `titles.json`, `people.json`, `metadata.json` | Frozen Film/Person legacy copy | Never served: the readers refuse non-`open` markers; only the local stand-in reads them. Retain as frozen mirrors (not a fallback or restore source). |
| `metadata.json` cache mirror in `src/metadata-cache.js` (the `r2` arm) | Compatibility mirror | The `metadata_cache_authority` marker is not read live on that arm (F-5); verify before removal. |
| Ratings documents, `saveActualMirror`, owner-review mirror, `monitor` state, immutable prediction/fingerprint/profile/assessment bodies, Letterboxd imports and admissions, archive receipts, observation segments | Immutable body, raw input, receipt, archive, mirror or operational state | Live and legitimate. Retain; nothing here is a legacy authority. |
| `filter-presets`, enrichment profiles | Not classified in earlier audits | Live; classify in the follow-up that owns R2 inventory. |

### Runtime flags (read-only; no binding was read)

| Flag | Where read | Status |
| --- | --- | --- |
| `D1_ENRICHMENT_WRITE`, `D1_ENRICHMENT_WINDOW`, `D1_ENRICHMENT_BULK` | Retired registry rows; `D1_ENRICHMENT_WRITE` and `D1_ENRICHMENT_BULK` still named in `src/d1-enrichment.js` behind the vm harness gate | Already cleaned up by [AIR-308](https://trello.com/c/ul5CRroM) and [AIR-512](https://trello.com/c/w0m6VfaL); do not repeat. Remove the code references with the projector. |
| `DISCOVERY_EXECUTOR`, `DISCOVERY_LEDGER_MODE` | Registry only; `DISCOVERY_LEDGER_MODE` read by the EPG canary | Retained registry rows. |
| `MONITOR`, `MONITOR_TRANSPORT`, `LIFECYCLE_LOCALIZATION`, `PREDICTION_DB_REQUIRED`, `RATINGS_DB_REQUIRED` | Live | Retain. |
| `PUBLISHED_EPG_DB_OPTIONAL`, `OWNER_REVIEW_DB_OPTIONAL`, `METADATA_CACHE_DB_OPTIONAL`, `DISCOVERY_DB_OPTIONAL`, `FILM_PERSON_DB_OPTIONAL` | Local stand-ins; absent from `wrangler.jsonc` | Retain; documented in the recovery runbook and the per-slice evidence. |
| `FOOTER_SOURCE_TIMEOUT_MS`, `TMDB_REQUEST_INTERVAL_MS` | Optional tuning, test-only | Document or remove in a docs card. |

## Documentation fixed in this pass

The maintained references that still described `legacy`/`r2`/`prepared` as serving now state the D1-only contract: `docs/reference/api/{admin,catalog,d1-catalog,read-side-effects}.md` and `docs/reference/data/producer-run-store.md`. Accepted ADRs, dated evidence and the Mermaid diagram in `docs/architecture/film-person-lifecycle.md` (which still draws the historical `legacy / r2 / prepared` box, labelled historical in the text above it) were not rewritten; changing that diagram needs rendered QA and is proposed below.

**Not done here:** the same stale wording remains in comments of nine source files (`src/admin/read.js`, `src/catalog-d1.js`, `src/worker.js`, `src/film-admission.js`, `src/canonical-film-writers.js`, `src/canonical-catalog-reader.js`, `src/film-person-authority.js`, `src/canonical-producers.js`, `src/canonical-read-model.js`). A comment-only change to `src/` runs the full pre-push suite, and `tests/catalog-film.mjs` was red on `main` `fc47af96` when this audit ran (its AIR-531 document-status fixture predates the strict Film/Person reader; the AIR-531 executor owns that fix). The comment cleanup is proposed as the first item below, after that fix lands.

## Proposed atomic cards (owner approval needed before any work)

0. **Source-comment cleanup** (comment-only, nine files above) once `tests/catalog-film.mjs` is green on `main`.
1. **Guard or remove the `discovery-ledger-install` apply path**, after moving `createS3Store` to a neutral module. Depends on nothing; rollback is a revert (the install has no live caller). Highest value: removes the only R2 writer that ignores the D1 marker.
2. **AIR-515 poster hydration** to D1 (existing card; behaviour change, needs an owner decision on the poster source).
3. **Remove the offline Film/Person cutover set** (baseline, cutover-accepted/minimum, connector-run, cutover-run, capture, prepared-loader, h1-verify and their tests). No Worker impact; keep `transitionAuthority` and `readMarker`.
4. **Remove the `film_person_open_handoff` MCP tool and CLI.** Depends on card 3 for `readMarker` consumers; changes the MCP tool list.
5. **Remove the enrichment projector write arms and tests**, keeping `d1EnrichmentStatus`, `d1EnrichmentStore` and the `projector_window` read paths; then drop the `D1_ENRICHMENT_*` code references.
6. **Decide the Film/Person local stand-in**, then remove the dormant producer skips, `routeSkipMs`, `routeOf` `{open:false}` and the `r2Allowed` branches together.
7. **Discovery R2 tails and the D-1 rollback toolchain** (lease, continuation, workflow state, decisions-map writers, four admin recovery writers) once the owner settles D-1.
8. **Docs card**: redraw the lifecycle diagram without the retired `legacy / r2 / prepared` box (rendered Mermaid QA required); document `FOOTER_SOURCE_TIMEOUT_MS` and `TMDB_REQUEST_INTERVAL_MS` or remove them.

## Limits

Static reading only: no test or production run supports the reachability claims beyond what the cited tests already assert. The Cloudflare bindings and the owner-only `feature_flags` readout were not queried.
