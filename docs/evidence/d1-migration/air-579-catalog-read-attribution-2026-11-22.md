# AIR-579: whole-catalog reads of `discovery_admission`: inventory, one code-only reduction, open attribution (22 Nov 2026)

Offline tests plus the read-only D1 analytics already taken for the [RCA](air-579-d1-overload-rca-2026-11-22.md) (its figures are history and are not rewritten here). No production read beyond that, no write, no migration, no flag, Task, Workflow, cron or R2 operation. The production effect of the reduction below is **not measured**: it needs a deploy and a natural run. The caller that dominates the 120 reads is **still unattributed**; everything about it here is a hypothesis.

## The statement

`SELECT film_id, payload_json, canonical_identity, tmdb_id, media_kind FROM discovery_admission WHERE state='current' ORDER BY film_id` (`readCatalog`, `src/discovery-authority.js`). Observed in the RCA window 16:00-19:00 UTC: 422 executions, 5.1 M rows, 166 s of query time; 120 executions of about 400 ms and 12 k rows each between 18:05 and 18:12.

## Inventory: whole-catalog reads per measured call (`tests/discovery-catalog-read-census.mjs`)

The real Worker runs in a vm over a D1 stand-in at the real schema; every statement is seen. The numbers are the behaviour **at the time of this change**, asserted so a later change is deliberate. The census calls the shared diagnostic loader and the Worker routes below; it does **not** call the MCP route itself, a Discovery chunk, the admin readers or a Task run end to end.

| Measured call | Whole-catalog reads per call |
| --- | --- |
| `loadPredictionDiagnosticSnapshot` (the helper of `prediction_queue_overview`, `prediction_film_diagnostics` and two admin recovery pages) | 1 |
| `loadPredictionQueueSnapshot` (new, used by `prediction_pending`) | **0** (was 1) |
| `GET /api/enrichment/view`, `GET /api/catalog/available`, `GET /api/enrichment/pipeline/status`, `POST /api/enrichment/queue/reconcile` | 1 each |
| `queue/reconcile` followed by `batch/start` (this one measured flow) | 2 in total |
| heartbeat, batch manifest part, one batch submit, complete (in that flow) | 0 |
| `GET /api/programme`, `/api/status`, `/api/enrichment/status`, `/api/enrichment/queue/status`, `/api/enrichment/runner` | 0 |

This bounds only the measured flow. It says nothing about a whole scheduled Task run that also calls MCP diagnostics, recovery endpoints or repeats a step.

## The code-only reduction in this change: `prediction_pending` reads the stored queue only

`predictionPendingPage` takes only `queue` and `queueStatus` of a snapshot; every helper it calls is a function of the queue and the clock. The route nevertheless built the full diagnostic snapshot, so each `prediction_pending` call read the profile, the view index, the programme, the published generation and **the whole catalog** and then ignored them. The route now uses `loadPredictionQueueSnapshot` (`src/prediction-diagnostics.js`, `src/mcp.js`), which reads the queue exactly as the full snapshot does (same pin, same key, same `recorded` / `not_recorded` / `unavailable` status).

Measured offline (30 admitted films, real schema, D1 stand-in; `tests/prediction-pending-queue-only.mjs`):

| | D1 statements | whole-catalog reads |
| --- | --- | --- |
| Before (full snapshot) | 22 | 1 |
| After (queue snapshot) | 4 | 0 |

In production each avoided catalog read is the 12 k-row, about 400 ms statement above, plus the other five reads. The share of `prediction_pending` among the 52 MCP calls of the window is **not known**; if every one had been a pending call the saving would be at most 52 catalog reads of the 120. The expected gain is therefore an upper bound that must be checked on a natural run.

Parity and negative cases, all asserted: the page is deep-equal to the former one for every filter (`all`, `eligible`, `deferred`, `exhausted`), a limit, the full cursor chain and a bad cursor; a Proxy that throws on any snapshot property other than `queue` and `queueStatus` proves the page reads nothing else; an unreadable catalog and a superseded admission set change the full snapshot's catalog status (`unavailable`) and leave the pending page identical; a queue that cannot be read is `unavailable` and one never stored is `not_recorded` in both snapshots with the same page; `src/mcp.js` still uses the full snapshot for `prediction_queue_overview` and `prediction_film_diagnostics`. The Discovery generation fence is not involved: the new path issues no catalog statement, so there is no read to fence. The only behavioural difference is in a failure of an unrelated source: a throw while reading the profile or index used to turn `prediction_pending` into "Prediction diagnostics unavailable"; it now answers from the queue.

## What is still unattributed

The coordinator's read-only aggregate for 18:05-18:12:30 UTC (52 `POST /mcp`, 7 `GET /api/catalog/available`, 7 `GET /api/programme`, 6 `GET /api/enrichment/view`, 4 cron invocations, 2 Discovery Workflow triggers) lists some request classes. 52 + 7 + 6 = 65 is an upper bound **for those selected classes only**; it is not an exhaustive account of the Worker and Workflow invocations of the window (it omits other endpoints that read the catalog, such as `pipeline/status` and `queue/reconcile` and the admin readers, repeated calls within one Task run, and any Workflow step or chunk). The remaining reads are **unattributed**; they are not shown to come from a chunk.

Hypothesis (not established): the Discovery chunk. The paged chunk (`resolvePagedDiscoveryChunk`, `src/discovery.js:904`) loads `epg/discovered-films.json` **once** per chunk to build the title alias index; the non-paged `resolveDiscoveryChunk` (`:1369`) is a separate path with its own single read, not a second read in the same chunk. The two ratios seen in analytics (120 catalog reads against 56 executions of the active-observation select in the window, 422 against 223 over three hours) compare two unrelated SQL signatures and are **not a chunk count**: neither denominator is a proven number of chunks, and the "second" read of the ratio is not identified. No test here invokes a Discovery chunk. Direct chunk-level counting (a chunk counter in the Worker logs for the endpoint, or the aggregated per-path counts of the window) would settle the denominator and is the first step before any change on that path.

## What a fix of the chunk reader would need (decisions, none taken)

The alias index needs every film's title aliases, so a read by id does not serve it, and no column carries a normalized title (`discovery_admission` holds `payload_json` and keys; the unique index is `(media_kind, tmdb_id)`). A cache would need an O(1) catalog version to invalidate on; every admission writer moves `discovery_authority.generation`, but so does every decision and status write, so that key would rarely hit, and the table's own `generation` column needs a scan to aggregate. Options: (a) a `catalog_revision` signal or (b) an indexed title column, both schema changes behind `0034` and an owner GO; (c) fewer chunks, a Workflow or cron change with an owner GO; (d) a payload-free isolate cache keyed by `COUNT(*), MAX(generation)` of the current rows, which still reads every row key and only helps elapsed time, not rows read. The choice is material and the owner's, and its measured gain depends on the unproven chunk share.

## Next safe code-only step

`prediction_film_diagnostics` needs one film plus the films of the outstanding ids that have an indexed prediction (the `index_ahead_of_queue` check), and must keep `allEnrichmentFilms` de-duplication by TMDB identity and the `policyExcludedPresentedFilm` filter; a bounded reader changes the snapshot shape and needs its own parity tests. `prediction_queue_overview` needs the whole catalog for its coverage counts.
