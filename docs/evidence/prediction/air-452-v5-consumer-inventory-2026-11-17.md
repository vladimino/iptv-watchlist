# Prediction runner v5: consumer inventory and retirement (17 November 2026)

**Scope.** Every consumer of the one-film prediction runner v5 on `main` at `2ff86710ba9699d77a709862ef03818ff8c65ed3` (17 Nov 2026), classified `v5-only`, `shared-with-v2`, `required-by-other-client` or `historical`, with the keep or remove disposition delivered by [AIR-452](https://trello.com/c/bHuKy3eF) under [ADR 0162](../../adr/0162-retire-prediction-runner-v5.md).

**Method.** Repository search for the tool names, the HTTP paths and the implementing functions (`src/`, `public/`, `scripts/`, `tests/`, `docs/`); a reference-graph pass over the top-level declarations of the concatenated Worker sources, repeated until no declaration lost its last reference; reading the batch v2 start to compare its repair duties with the v5 start. No production call, Scheduled Task registry read, flag, D1 or R2 operation was made. The live registry state is taken from the AIR-451 readback and the installed batch v2 prompt in the repository.

## Contract surface

| Consumer | Contract | Class | Disposition |
| --- | --- | --- | --- |
| MCP `prediction_start` | `POST /api/enrichment/start` (`watchlist_all`, `queued`) | v5-only | Removed. Only caller was the legacy v5 Scheduled Task (disabled at the AIR-451 cutover); the v2 prompt forbids it. |
| MCP `prediction_next` | `POST /api/enrichment/next` (`batchSize: 1`) | v5-only | Removed. |
| MCP `prediction_submit` | `POST /api/enrichment/submit` (one item) | v5-only | Removed. |
| MCP `prediction_validate` | pure validators, no route | v5-only in practice | Removed (owner decision). The v2 prompt forbids it; `prediction_batch_validate` with one item runs the same validators through `mcpCandidateReport`. |
| `POST /api/enrichment/start` | `diagnosedStart` → `enrichmentStart` (also `legacy` mode, `watchlist_available` scope) | v5-only | Removed; the route now falls through to `404 Not found`. |
| `POST /api/enrichment/next` | `enrichmentNext` (adaptive one-film delivery) | v5-only | Removed. |
| `POST /api/enrichment/submit` | `enrichmentSubmit` (one to ten items) | v5-only | Removed. |
| Admin UI (`public/`, `src/admin/`) | — | none | No call to any v5 route or tool was found. |
| Worker cron, Workflows, other routes | — | none | No internal call; the MCP tools were the only callers of the routes. |
| `scripts/prediction-start-heap-profile.mjs`, `scripts/prediction-batch-profile.mjs`, `tests/prediction-batch-profile.mjs` | v5 start/next/submit in R2 mode | v5-only (measurement) | Deleted; batch v2 has its own timing line and budget tests. |
| Test suite (39 files) | v5 routes used as the harness of shared behaviour | shared-with-v2 / v5-only | Shared behaviour ported to batch v2 in D1 mode; v5-only assertions dropped (see Tests). |
| `GET /api/enrichment/runner`, MCP `enrichment_runner` | runner contract published v5 steps | shared | Kept, rewritten v2-only: `protocol`, `retiredProtocols: ["v5"]`, `batchRunner` with `start`, `submit`, `hold`. |
| `prediction_heartbeat`, `prediction_complete`, `/api/enrichment/heartbeat`, `/api/enrichment/complete` | shared runner tools | shared-with-v2 | Kept unchanged. |
| Batch v2 tools and routes, validators, queue, lease, epoch, submit gate, retry records, Events, D1 mutable state, R2 immutable versions, diagnostics and read-only APIs, MCP Access | — | shared-with-v2 | Kept unchanged. |
| Legacy v5 Scheduled Task prompt (`hourly-predictions-only.md`) and dated evidence | — | historical | Kept as history, marked retired; no longer a working rollback path. |

## Repair duties of the v5 start

`AGENTS.md` named `prediction_start` as the writer that repairs expired runs and undelivered run Events. The batch v2 start does both inside its writer lease: it calls `deliverPendingEvents` and settles the run named by `recoveredRunId` (an expired lease holder) before it opens its own run. No repair duty is lost.

## Stored v5 runs

Run records written by v5 carry no `protocol` (or `"v5"`). They are not migrated or deleted. Batch v2 refuses them on submit, hold and manifest with `409 wrong_protocol`; a live lease they hold turns a batch start away with `already_running`; an expired one is settled by the next batch start; heartbeat, complete, diagnostics, history and Events still read them. Tests plant such a run directly (the routes that created them are gone) and assert each of these answers.

## Code removed beyond the routes

The reference-graph pass found these declarations without a caller once the v5 functions were gone; each was removed:

| Declaration | Former role |
| --- | --- |
| `timedPredictionStep` | step timer and request scope of `next` and `submit` |
| `MAX_PREDICTION_BATCH`, `pickBatchWithFilms`, `MISSING_ADMISSION_ROUNDS`, `queueChangedResponse`, `V5_ITEM_KEYS` | v5 selection, refusal and item-key checks |
| `restoreFingerprint`, `fingerprintGenerations` | ADR 0035 section 7 pointer restoration, called only by `next` |
| `REQUEST_SCOPE`, `createRequestScope`, `requestScopeOf`, `requestScopeRead`, `requestScopeLearn`, `requestScopeForget`, `requestScopeUnchanged`, `noteQueueCounts`, the hooks in `loadJSON` and `saveJSON` | AIR-442 per-request object scope; only `next` and `submit` created a scope, so every branch was inert |

Kept although close to v5: `adaptivePredictionBatch` (the batch start's idle plan), `startIdle`, `runnerStarted`, `runContractChanged`, `wrongProtocolResponse`, `PredictionD1.scopeRequest` (the authority-marker scope the batch steps use), and the pure rule `fingerprintRestoreCandidate` with its ADR 0035 specification fixtures (no runtime caller; follow-up decision in ADR 0162).

## Consequences recorded

- With v5 gone, no runner writes predictions while `prediction_domain_authority.mode` is `r2` (`batch_runner_requires_d1`). The owner confirmed that D1 stays and no rollback to R2 is planned.
- No runner restores a fingerprint pointer after a schema or prompt rollback; such a film is regenerated by v2.
- The rollback "disable the v2 Tasks, re-enable the v5 Task" needs a code rollback first.

## Tests

Before the change the core suite passed on the same checkout (`npm test`, exit 0). After the `src/` change 39 files failed, all through the removed routes or tools. Each was ported or narrowed; the per-file disposition is in the AIR-452 pull request. New regression checks: the four retired tools are absent from `tools/list` and answer `-32602 Unknown tool` with no storage call; the three retired routes answer `404` with no storage call; `enrichment_runner` is v2-only; a stored legacy run is handled as above.

## Limits

- The live Scheduled Task registry was not read; the legacy v5 Task's current ID and state are not verified here. Registry changes are outside this delivery.
- A natural batch v2 Scheduled Task run after the deploy is the remaining acceptance evidence.
