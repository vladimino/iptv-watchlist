# AIR-573 — Task label `taskId`, offline verification (22 Nov 2026 UTC)

**Scope.** Offline only: the real Worker (`src/enrichment.js`, `src/mcp.js`) over a sqlite D1 stand-in and an in-memory R2, as production runs the prediction domain. No production read or write, no Scheduled Task, no model, no lease reset, no flag. The four recurring Tasks were disabled throughout and stay disabled. Verifies [ADR 0195](../../adr/0195-scheduled-task-id-as-run-owner-label.md); it is **not** production acceptance.

**Reproduce.** `node tests/prediction-task-id.mjs` (core), `node tests/mcp-tools.mjs`, and the whole core suite `npm test`.

## What the tests establish (`tests/prediction-task-id.mjs`, `tests/mcp-tools.mjs`)

| Scenario (handoff item) | Result |
| --- | --- |
| a Task start stores `taskId` on the lease and the run; a heartbeat keeps it; epoch 1 | pass |
| (a)(b) the same Task repeats its start while the lease lives: the same full stored manifest, a repeat writes no run, lease or record | pass |
| (c) a repeat after the first real submit still returns the own run; a repeated identical submit creates no new run and records the film once; the epoch does not change | pass |
| (a) the first start still preparing (claim phase, answer not stored): `start_pending` with the true `runId` and `epoch`, `taskId`, readback pointer; after the answer is stored the repeat recovers it; the 10 s bound is checked in the non-functional scenario `prediction-task-id-join-bound` | pass |
| (d) a foreign `task15` while `task00` holds the lease: the start is `already_running` and assigns nothing; heartbeat, hold, submit, submit `useHeld`, complete and the calls without a label are `wrong_owner` and change **no** run, lease or record (no writer lease, no diagnostics step, no stop of the owner's run) | pass |
| (e) expiry: the same Task gets a **new** run and epoch 2; the late handler of the old run commits nothing; `task15` cannot submit on the new run; after a release a new hour of `task00` starts epoch 3 | pass |
| (e) two concurrent starts of one label: one run; four concurrent labels: one `running`, three `already_running`, one run row | pass |
| (f) unknown, malformed or non-string labels `400`; `taskId` with `trigger: manual` refused; with a key it is a correlation only; an incompatible argument set is `409 task_args_mismatch` (not a foreign owner), the lease untouched | pass |
| (g) a dry run with a label writes nothing and never claims; a manual run has no label and is operated only without one, and a Task label on a label-free run (heartbeat, hold, submit, submit `useHeld`, complete, MCP readback) is `wrong_owner` with nothing written (owner review of 22 Nov, P1); a labelled start never joins an unlabelled run; the keyed start of ADR 0188 joins as before | pass |
| MCP boundary: schemas carry the closed enum and require `taskId` on manifest, hold, submit, heartbeat and complete; a real scheduled start, every run-scoped call without it, an unknown value and `taskId` with a manual start are refused **before any storage access** (0 objects written); a scheduled dry run, validate and the read-only status tools need no label | pass |

A defect found and fixed by these tests: a `wrong_owner` answer carrying `status: "blocked"` made `observedPrediction` record a stop on the real owner's run (heartbeat and complete are observed); the answer now has no `status`, `observedPrediction` ignores `wrong_owner`, and heartbeat and complete are refused before the step recorder and the writer lease.

## Limits and not established

- Whether the repeated request of the incident comes from the SDK, a model tool retry or the scheduler; production latency of the first start (75–90 s) against the 10 s join bound (the repeat then answers `start_pending`, which the prompt must treat as "read the manifest").
- A second execution of the same Task overlapping a live lease is treated as that execution's repeat (ADR 0195 section 7); not exercised in production.
- No natural run after the cutover exists. Recovery is proven only by committed forecasts of natural runs; `start = 200`, `already_running` and a green CI are not acceptance.
