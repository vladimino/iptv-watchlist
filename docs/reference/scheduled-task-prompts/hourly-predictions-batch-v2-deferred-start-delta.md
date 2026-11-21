# Prompt delta — deferred start of the Predictions batch v2 Tasks (ADR 0191)

**Status: proposal for the Controller, not an installed prompt.** The installed prompt of the four enabled Tasks (`:00/:15/:30/:45`) is the one snapshotted in [`hourly-predictions-batch-v2.md`](hourly-predictions-batch-v2.md); it is unchanged by the Worker delivery. This note is the **smallest change** of that prompt that moves a Task from the synchronous start to the deferred start of [ADR 0191](../../adr/0191-deferred-batch-start-with-server-issued-key.md). It does not touch the research protocol, the scoring rules, `manifestSize=5`, `generationSize=1`, `submitBatchSize=5`, the schedule, the timezone or the enabled state. The executor of the Worker change does not edit Tasks; the owner and the Controller do, after delivery and after reading the real tool schema.

Before any edit, the Controller reads the live tool list (`prediction_batch_key` and `prediction_batch_start.deferred` must be present), the registry prompts of all four Tasks, and removes the temporary `:15` probe. The four Tasks move together.

## The replacement of execution-playbook steps 1 and 2

1. `enrichment_runner`: unchanged (require the `batchRunner` block and `requires.predictionAuthority: "d1"`, else stop `batch_runner_unavailable`).
2. **Issue the key once.** Call `prediction_batch_key` (no arguments). Keep the returned `invocationKey` in the working context and use that exact string for every call of step 3 in this execution. Never compose, edit or regenerate it, and never derive it from the time, the Task name or the slot. If the call fails, stop (nothing exists on the server).
3. **Start.** Call `prediction_batch_start({trigger:'scheduled', manifestSize:5, deferred:true, invocationKey})`.

| Answer | Task action |
| --- | --- |
| `accepted` (`phase: "preparing"` or `"ready"`) | keep `runId` and `epoch`; go to step 4 |
| `already_running` | success (another Task holds the slot): do not adopt the `runId`, no `prediction_complete`, end. Do **not** call `prediction_batch_key` again to retry |
| `deferred_start_unavailable` (HTTP 503) | nothing was accepted; report the `code`, end |
| `invalid_deferred_key`, `deferred_not_dry_run` (HTTP 400) | a prompt defect; report the `code`, end |
| transport error or no answer | send the **same** `prediction_batch_start` again with the **same** `invocationKey` (at most 3 attempts, 5 s apart); the answer is the same receipt, never a second run. After 3 attempts, end and report |

4. **Read the manifest.** Call `prediction_batch_manifest({runId})` (the envelope), and repeat it after the answer's `retryAfterMs` (2 s) while the answer is `manifest_pending`, for at most 3 minutes. Do not start again, and do not call `prediction_batch_key`.

| Answer | Task action |
| --- | --- |
| the envelope (`kind: "envelope"`) | the manifest is ready: read `profile`, `contract` and each `film` part as before (the v2 prompt already does this after a truncated start), then go to step 5 |
| `manifest_pending` | wait `retryAfterMs`, ask again (bounded) |
| `start_refused` (`outcomeCode`: `noop`, `quota`, `retry_backoff`, `manifest_too_large`, `prediction_catalog_held`, …) | no run exists; report the code, end (the same outcomes the synchronous table lists) |
| `start_failed` (`outcomeCode`: `start_claim_lost`, `storage_error`) | no run exists or it was abandoned; report the code, end, no `prediction_complete` |
| `unknown_run`, `lease_lost` | the run is no longer ours; end, no `prediction_complete` |

5. **Heartbeat immediately** after the envelope: `prediction_heartbeat({runId})`. A prepared run holds a short 180 s lease until its first heartbeat or submit; a Task that waits longer loses the run. Everything after this point (generation, `prediction_batch_validate`, hold, `prediction_batch_submit` with `lease.epoch`, further heartbeats, `prediction_complete`) is unchanged; `lease.epoch` is the `epoch` of the receipt and of the envelope.

## What the Controller must check

- The four prompts differ only by this delta and stay byte-identical to each other; record the new length and SHA-256 in the snapshot note when installed.
- `tests/scheduled-task-prompt-v2.mjs` pins the *installed* snapshot; it changes only when the snapshot file is replaced after a verified install.
- The temporary probe and any one-Task pilot are not used; the entry `:48` stays disabled.
- Rollback is the previous prompt text (synchronous start); the Worker supports both until the Tasks are moved.
