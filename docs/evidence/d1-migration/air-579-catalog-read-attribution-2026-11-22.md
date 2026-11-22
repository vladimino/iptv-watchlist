# AIR-579: attribution of the repeated whole-catalog reads of `discovery_admission` (22 Nov 2026)

Offline code census plus read-only D1 analytics already taken for the [RCA](air-579-d1-overload-rca-2026-11-22.md) (its figures are history and are not rewritten here). No production read beyond that, no write, no migration, no flag, Task, Workflow, cron or R2 operation. This page **narrows the attribution; it does not fix it, and it makes no claim about production benefit**.

## The statement

`SELECT film_id, payload_json, canonical_identity, tmdb_id, media_kind FROM discovery_admission WHERE state='current' ORDER BY film_id` (`readCatalog`, `src/discovery-authority.js`). Observed in the RCA window 16:00-19:00 UTC: 422 executions, 5.1 M rows, 166 s of query time; 120 executions of about 400 ms and 12 k rows each between 18:05 and 18:12.

## Offline census: reads per entry point (`tests/discovery-catalog-read-census.mjs`)

The real Worker runs in a vm over a D1 stand-in at the real schema; every statement is seen. The numbers are an inventory, asserted so a later change is deliberate.

| Entry point | Whole-catalog reads per call |
| --- | --- |
| `loadPredictionDiagnosticSnapshot`, shared by the MCP tools `prediction_queue_overview`, `prediction_pending`, `prediction_film_diagnostics` (and two admin recovery pages) | 1 |
| `GET /api/enrichment/view` | 1 |
| `GET /api/catalog/available` | 1 |
| `GET /api/enrichment/pipeline/status` | 1 |
| `POST /api/enrichment/queue/reconcile` | 1 |
| reconcile followed by `prediction_batch_start` | 2 in total |
| heartbeat, batch manifest part, one batch submit, complete | 0 |
| `GET /api/programme`, `/api/status`, `/api/enrichment/status`, `/api/enrichment/queue/status`, `/api/enrichment/runner` | 0 |

A Predictions Task run therefore reads the catalog at most about twice in a whole run (its start), and every later step of the run reads it by id or not at all.

## What the numbers rule out and what they leave

The coordinator's read-only aggregate for 18:05-18:12:30 UTC (52 `POST /mcp`, 7 `GET /api/catalog/available`, 7 `GET /api/programme`, 6 `GET /api/enrichment/view`, 4 cron invocations, 2 Discovery Workflow triggers) gives an upper bound for those request classes: at most 52 + 7 + 6 = **65 reads**, and only if every MCP call were a catalog-reading diagnostic, while the window held **120**. The named request classes alone cannot account for the observed reads. The remainder has to come from a structural per-chunk reader.

By code, both Discovery chunk variants load the whole catalog once per chunk to build the title alias index: `resolveDiscoveryChunk` (`src/discovery.js:1369`, `let films=await loadJSON(pinned,'epg/discovered-films.json')`) and `resolvePagedDiscoveryChunk` (`src/discovery.js:904`). The Workflow runs one bounded chunk per step ([ADR 0083](../../adr/0083-durable-discovery-continuation.md) family, `src/discovery-workflow.js`). Supporting observation (analytics, RCA data): in the 18:05-18:12 window the catalog read ran 120 times against 56 executions of the active-observation select that every chunk page issues, and over the whole 16:00-19:00 span 422 against 223, a ratio of about two reads per chunk page. That is **consistent with the per-chunk read being the dominant caller; it is not a per-request attribution** (no log names the request, and the second read per page is not identified).

Hypotheses, ranked by what supports them: (1) Discovery chunk alias-index load, once or twice per chunk, the dominant share; (2) MCP diagnostics (the coordinator's new hypothesis), a real but bounded share (at most one read per call, 52 calls in the window); (3) `GET` views, a small share (13 in the window). Not a cause: batch metadata (`readFilmsById` reads by id), heartbeat, manifest, submit.

## What a fix needs (decisions, none taken here)

- **The chunk alias index** needs every film's title aliases, so a bounded read by id does not serve it, and no column carries a normalized title (`discovery_admission` holds `payload_json` and keys only; the unique index is `(media_kind, tmdb_id)`). A cache of the index would need an O(1) catalog version to invalidate on. None exists: every admission writer moves `discovery_authority.generation`, but so does every decision and status write, so a generation key would almost never hit; the table's own `generation` column needs a scan to aggregate. Options: (a) a `catalog_revision` signal (schema change, blocked behind `0034` and an owner GO); (b) title-keyed lookups with a new indexed column (schema change as well); (c) fewer chunks or a lower cadence (a Workflow or cron change, owner GO); (d) an isolate cache keyed by `COUNT(*), MAX(generation)` of the current rows, which still reads every row key but not the payload and is only worth it if elapsed time, not rows read, is the limit. The choice is material and the owner's.
- **The diagnostics** (hypothesis 2) can be made bounded in code: `prediction_film_diagnostics` needs one film and `prediction_pending` the films of the outstanding ids (the `index_ahead_of_queue` check); only `prediction_queue_overview` needs the whole catalog for its coverage counts. This changes the snapshot shape (the `catalog` status and the `policyExcludedPresentedFilm` filter) and needs its own parity tests; it is the code-only next step, worth taking only if the share of hypothesis 2 is confirmed.

## Not established

The per-request caller of the 120 reads (no log names it), the exact second read per chunk page, and the real chunk cadence in the window. Reading the Worker logs for the Discovery chunk endpoint around 18:05-18:12 UTC, aggregated, would close this and is the first step before any fix.
