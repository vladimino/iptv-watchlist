# Prediction expired-lease settlement

A prediction run whose runner lease has expired is **shown** by `GET /api/enrichment/status`, `GET /api/enrichment/runs` and MCP `enrichment_status` as `interrupted` / `lease_expired`. Those reads compute that from the diagnostic row and the clock. They do not rewrite the run, the diagnostic object or the journal ([ADR 0107](../../adr/0107-get-head-read-side-effect-boundary.md), [AIR-415](https://trello.com/c/NHyIKM6z)).

Durable settlement belongs to the existing Predictions writer: `POST /api/enrichment/start` / MCP `prediction_start` marks the previous lease holder interrupted and settles at most one R2 list page of `enrichment/run-diagnostics/` (100 keys) per start, resuming from `enrichment/run-diagnostics-settle.json`. GET still projects an expired row that the cursor has not reached yet. A list or get error does not block the new run; the next start retries the same page. Already-settled rows are no-ops. The hourly Predictions Scheduled Task is that writer. `prediction_complete` ends the run that still holds the lease; it is not a GET repair. No extra cron or Task.

Do not probe production status or runs to “heal” a stall. Do not invent a new cron, Task or owner command for this. Event delivery of an undelivered stop record is still triggered by `GET /api/events` until [AIR-416](https://trello.com/c/f7FX4Elk); that is a different repair.

Rollback of the Worker code restores GET-triggered settlement; it does not un-write a run that `prediction_start` already persisted.
