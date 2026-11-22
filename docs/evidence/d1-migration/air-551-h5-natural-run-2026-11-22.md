# AIR-551 H5: the first natural EPG run on the D1 checkpoint

Date: 22 Nov 2026, run 16:00:37-16:06:55 UTC (17:00:37-17:06:55 Madrid, UTC+01:00). Read-only observation, no production write by this record. The functional acceptance of H5 is the Controller's, recorded in the AIR-551 card comment of 22 Nov 2026 16:19 UTC; the executor re-read the same state independently at 16:36 UTC (below). This is **not** the H6 decision: it authorizes no change of R2, no binding, flag, Task or run.

## What ran

Natural EPG run, run key `2026-11-22`, run id `bf89ba90-07eb-46ac-9723-15d309517830`, Workflow instance `epg_20261122_1` (finished). The checkpoint marker was `d1` / `open` / generation 2 (activated and released on 21 Nov 2026, [cutover evidence](air-551-checkpoint-cutover-2026-11-21.md)). Nothing was started by hand.

- Start `2026-11-22T16:00:37.550Z`, complete `2026-11-22T16:06:55.111Z`: **377.56 s (6 min 17.6 s)**; publication latency from the due time 16:00:00 UTC: 401.85 s (6 min 41.9 s), under the 15-minute target.
- The Controller's reads: `epg_status` phase `done`, stage `complete`, remaining 0, no failures, health healthy; `epg_pipeline_status` shows the published programme run equal to this run and Discovery continuing normally.

## Read-back by the executor (16:36 UTC, SELECT only, `rows_written` 0)

- Operator `status`: schema 33, marker `d1` / `open` / generation 2, fence `cas` 1; orchestration `cloudflare`, phase `done`, lease released.
- `epg_checkpoint_run`: the run id above, stage `complete`, **revision 78**, one body chunk of **3,471 characters**, body SHA-256 `e2ddeefbfa371d85c23df697db786549173f1427772ef300d5b24f5f9ac98ea2`, `queue_attempted` 1, `has_error` 0, `watchlist_present` 0 and 0 rows in `epg_checkpoint_film` (the film rows are removed at completion, so this is the expected final shape, **not** a measure of the peak).
- `epg_checkpoint_receipt`: 16 rows, maximum revision 78. `epg_ingest_status`: last success 16:00:37.550Z, no failure, `consecutive_failures` 0, revision 2.
- `published_epg_authority`: `d1` / `open`, generation 517; `programme_run_id` equals `finalized_run_id` equals the new run; `finalized_at` 16:06:55.344Z. `discovery_epg_priority`: `clear`, no owed day.
- **R2 frozen image unchanged**: `sync.json` ETag `a4f27097ce9c159b855c19fcd3837a9b` (3,530 bytes) and `watchlist-ingest.json` ETag `77a2d6f7ab36ec6d6de3de2931bb1c89` (78 bytes), the exact ETags recorded at the cutover. The checkpoint objects were not written by the run.

## Result

**H5 functional acceptance holds: the natural run created, advanced, completed and certified a D1 checkpoint run, released the lease, cleared the Discovery pause, produced one EPG and one watchlist event, and wrote nothing to the frozen R2 checkpoint objects.**

## Not measured (do not read as passed)

- Worker CPU time and memory **per invocation**, from the Cloudflare telemetry the session could read: not available to this account's tokens.
- The **peak** film entry and the peak film row count during the metadata stage: the final table is empty by design, and no sample of the running table was taken.
- D1 round trips and rows written **per step**: only the final state and the per-run totals above were read.
- Behaviour of a run that fails or is interrupted mid-run on the D1 path: not exercised by a clean natural run.

These remain the residual risk the owner accepted at the cutover; the next natural runs on 23 Nov and later add observations but are not a formal gate.
