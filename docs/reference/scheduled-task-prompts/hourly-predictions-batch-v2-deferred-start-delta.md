# Prompt delta — deferred start of the Predictions batch v2 Tasks (ADR 0193)

**Status: superseded on 22 Nov 2026 by [the task-id delta](hourly-predictions-batch-v2-task-id-delta.md) ([ADR 0195](../../adr/0195-scheduled-task-id-as-run-owner-label.md)); kept as history, do not install.** Earlier status: proposal for the Controller, not an installed prompt. The installed prompt of the four enabled Tasks (`:00/:15/:30/:45`) is the one snapshotted in [`hourly-predictions-batch-v2.md`](hourly-predictions-batch-v2.md); it is unchanged by the Worker delivery. This note is the **smallest change** of that prompt that moves a Task from the synchronous start to the deferred start of [ADR 0193](../../adr/0193-deferred-batch-start-with-server-issued-key.md). It does not touch the research protocol, the scoring rules, `manifestSize=5`, `generationSize=1`, `submitBatchSize=5`, the schedule, the timezone or the enabled state. The executor of the Worker change does not edit Tasks; the owner and the Controller do, after delivery and after reading the real tool schema.

Before any edit, the Controller reads the live tool list (`prediction_batch_key` and `prediction_batch_start.deferred` must be present), the registry prompts of all four Tasks, and removes the temporary `:15` probe. The four Tasks move together.

## The replacement of execution-playbook steps 1 and 2

1. `enrichment_runner`: unchanged (require the `batchRunner` block and `requires.predictionAuthority: "d1"`, else stop `batch_runner_unavailable`).
2. **Issue the key once.** Call `prediction_batch_key` (no arguments). Keep the returned `invocationKey` in the working context and use that exact string for every call of step 3 in this execution. Never compose, edit or regenerate it, and never derive it from the time, the Task name or the slot. If the call fails, stop (nothing exists on the server).
3. **Start.** Call `prediction_batch_start({trigger:'scheduled', manifestSize:5, deferred:true, invocationKey})`.

| Answer | Task action |
| --- | --- |
| `accepted`, `phase: "preparing"` or `"ready"` | keep `runId` and `epoch`; go to step 4 |
| `accepted`, `phase: "accepting"` (`next: "repeat_start"`) | the first request has claimed but not yet written its attempt marker: wait `retryAfterMs` (1 s) and send the **same** start again (at most 5 times) |
| `already_running` | success (another Task holds the slot): do not adopt the `runId`, no `prediction_complete`, end. Do **not** call `prediction_batch_key` again to retry |
| `start_refused`, `start_failed` (HTTP 409, `outcomeCode`) | this invocation's attempt already ended (a retry of a start whose answer was lost): no run exists; report the code, end |
| `start_finished` (HTTP 409) | this invocation's run already finished or its lease expired; end, no `prediction_complete` |
| `deferred_start_ambiguous` (HTTP 503) | the platform could not confirm the dispatch: send the **same** start again after `retryAfterMs` (at most 3 times), then end |
| `deferred_start_unavailable` (HTTP 503) | not accepted; the invocation is one-shot (a retry of a possibly dispatched key is the typed `start_failed`): report the `code` and end, the next execution takes a fresh key |
| `invalid_deferred_key`, `deferred_not_dry_run` (HTTP 400) | a prompt defect; report the `code`, end |
| transport error or no answer | send the **same** `prediction_batch_start` again with the **same** `invocationKey` (at most 3 attempts, 5 s apart); the answer is the same receipt or the typed result, never a second run. After 3 attempts, end and report |

4. **Read the manifest.** Call `prediction_batch_manifest({runId})` (the envelope) and repeat it every `retryAfterMs` (5 s) while the answer is `manifest_pending`, for at most 3 minutes (about 36 calls; if the scheduler cannot make that many calls, end the execution: the run expires by itself within 180 s and nothing else is needed). Do not start again, and do not call `prediction_batch_key`.

| Answer | Task action |
| --- | --- |
| the envelope (`kind: "envelope"`) | the manifest is ready: go to step 5 |
| `manifest_pending` (the underlying read is HTTP 409; the MCP tool reports it as a **successful** result `{httpStatus: 200, kind: "pending", code: "manifest_pending", retryAfterMs}`, never as `isError`) | a normal wait, not a failure: wait `retryAfterMs`, ask again (bounded) |
| `start_refused` (`outcomeCode`: `noop`, `quota`, `retry_backoff`, `manifest_too_large`, `prediction_catalog_held`, …) | no run exists; report the code, end (the same outcomes the synchronous table lists) |
| `start_failed` (`outcomeCode`: `start_claim_lost`, `storage_error`, `start_lost`) | no run exists or it was abandoned; report the code, end, no `prediction_complete` |
| `unknown_run`, `lease_lost` | the run is no longer ours; end, no `prediction_complete` |

5. **Heartbeat immediately after the envelope and before reading the remaining parts**: `prediction_heartbeat({runId})`, and check that it succeeded. The preparation holds a short 180 s lease until the first heartbeat; a Task that waits longer loses the run. If the answer is `busy` (`prediction_writer_busy`: the preparation is finishing), repeat it after 2 s (at most 5 times); if it answers `lease_lost`, end. Then read `profile`, `contract` and each `film` part (the v2 prompt already does this after a truncated start). Everything after this point (generation, `prediction_batch_validate`, hold, `prediction_batch_submit` with `lease.epoch`, further heartbeats, `prediction_complete`) is unchanged; `lease.epoch` is the `epoch` of the receipt and of the envelope.

## What the Controller must check

- The four prompts differ only by this delta and stay byte-identical to each other; record the new length and SHA-256 in the snapshot note when installed.
- `tests/scheduled-task-prompt-v2.mjs` pins the *installed* snapshot; it changes only when the snapshot file is replaced after a verified install.
- The temporary probe and any one-Task pilot are not used; the entry `:48` stays disabled.
- The installed MCP instructions, the tool descriptions and the runner contract say that a deferred start answers a receipt and that the manifest is read with `prediction_batch_manifest`; read the live `tools/list` before the edit.
- Rollback is the previous prompt text (synchronous start); the Worker supports both until the Tasks are moved.
