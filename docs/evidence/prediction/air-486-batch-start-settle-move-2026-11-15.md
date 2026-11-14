# AIR-486: move historic diagnostic settlement off `batch_start` (offline)

**Capture:** 15 November 2026 (UTC). Offline: the real Worker over a sqlite D1 stand-in and an in-memory R2 (`tests/prediction-batch-start-budget.mjs`, `tests/expired-diagnostics-settle.mjs`). No production read or write, no Scheduled Task.
**Scope:** [AIR-486](https://trello.com/c/rmLnAabx) owner design GO (15 Nov 2026, Europe/Madrid) on the same card as the [RCA](air-486-repeat-start-after-471-2026-11-14.md).
**Verdict:** Offline PASS of the bounded move. Production latency after deploy is not measured here.

## What changed

`settleExpiredDiagnostics` is no longer awaited on `prediction_batch_start` or v5 `prediction_start`. Those starts still recover the single `recoveredRunId`, write this run’s diagnostics, deliver the bounded event outbox, and return. Historic `enrichment/run-diagnostics/` settlement runs inside `prediction_complete` under the existing `predictionWriter`: **10 keys** per successful complete (including an idempotent complete of an already finished run), same cursor object, try/catch so list/get/put failure does not fail the complete, wrap-around when the last page stores `cursor: null`. Before mutating a `running` diagnostic, the writer reads the current runner lease and leaves the row unchanged when that run is still the live holder, so a delayed diagnostic checkpoint after heartbeat cannot be interrupted by another run’s complete.

No new scheduler, Task, flag or `waitUntil`. `already_running` still names the holder and does not adopt. `deliverPendingEvents` stays on start (capped outbox, no prefix list).

## Offline checks

- Current-queue `manifestSize=5` with **492** planted diagnostic objects: `r2:diagnostics` stays checkpoint-scale (not O(history)); total R2 within +8 of the empty-history start.
- Start writes no settle cursor and does not rewrite a historic expired run.
- Complete of 10-row pages eventually settles an expired row past the first page; already-settled rows are not rewritten.
- List or get failure during complete: HTTP 200, cursor unchanged, retry on the next complete.
- After the last page, `cursor: null`; the next settle lists from the start of the prefix.
- Existing `already_running`, `queue_changed`, `manifestSize` 5/100, and `manifest_spent` tests still pass.

## Not claimed

Production `wallMs`, disappearance of the 214-op persist class on live Task A, or a client-side cause of the ~60 s second start. Those remain natural-run observations after an authorized merge and deploy ([AIR-451](https://trello.com/c/NN3N6kRp) for p95).
