# ADR 0195: The four standing Prediction Tasks carry a fixed `taskId`; a run, its lease and every run-scoped call are correlated by it beside `runId` and `epoch`

**Status:** Proposed (the architecture is approved by the Product Owner on [AIR-573](https://trello.com/c/4pD66DLd), 22 Nov 2026 Europe/Madrid; this record and its implementation await independent review and acceptance)  
**Original decision date:** 2026-11-22  
**Recorded at:** 2026-11-22  
**Approval source:** The Product Owner's decision at the top of the [AIR-573](https://trello.com/c/4pD66DLd) description and the executor handoff comment [6b02ad14](https://trello.com/c/4pD66DLd#comment-6b02ad144c1f6e546133dd5c), 22 Nov 2026.  
**Related work:** [AIR-573](https://trello.com/c/4pD66DLd) (P0 incident); [ADR 0188](0188-idempotent-keyed-batch-start-and-early-start-claim.md), [ADR 0193](0193-deferred-batch-start-with-server-issued-key.md), [PR #854](https://github.com/vladimino/iptv-watchlist/pull/854), [PR #872](https://github.com/vladimino/iptv-watchlist/pull/872), [PR #878](https://github.com/vladimino/iptv-watchlist/pull/878) (the earlier experiments); the health contract of [AIR-556](https://trello.com/c/ZjqzW7EB) is reused, not duplicated; [AIR-560](https://trello.com/c/NZ70Dzom) is not touched.  
**Supersedes:** In part [ADR 0193](0193-deferred-batch-start-with-server-issued-key.md) and [ADR 0188](0188-idempotent-keyed-batch-start-and-early-start-claim.md), only as the **recommended protocol of the standing Tasks**: the per-invocation `invocationKey` (caller-composed in 0188, server-issued in 0193) and the deferred Workflow start are no longer the target for the four Tasks. Their code, tests, fencing, claim and join mechanics stay in force and are reused; the keyed and deferred paths remain available and unchanged.  
**Superseded by:** None

## Context

Confirmed on the AIR-573 card (all times Europe/Madrid, 21–22 Nov 2026):

- A synchronous `prediction_batch_start` takes 75–90 s. About 60.6 s after the first request a second HTTP `batch_start` arrives, is answered `already_running` (the first request still owns the lease) and the Task ends; its own run is left in a live lease and expires with no submit. After the rollback to the synchronous S5 prompt the natural `:15` run behaved the same, so the outage was not caused by the S7 batch size.
- ADR 0188 (a per-invocation key) and ADR 0193 (a server-issued key plus a deferred Workflow start) did not restore predictions: no Task invocation id, scheduled time or other source reaches the model, a model cannot be trusted to keep or reproduce a random key, and the experiments did not remove the cause.
- In an owner-approved isolated real S1 canary on 22 Nov at `:36` a single Task sent two overlapping synchronous `batch_start` calls: the first created an owned run, the second received `already_running`, and no submit followed. The four recurring Tasks were verified disabled at that time and **remain disabled** until a separate owner-approved cutover.

**Not established:** which component issues the repeated request (SDK, a model tool retry or the scheduler). This ADR does not depend on the answer.

## Decision

1. **A fixed owner label.** Each of the four standing Tasks has a constant `taskId` in its installed prompt: `task00`, `task15`, `task30`, `task45`. The set is exactly these four values (a closed enum in the MCP schemas and in the Worker). The prompts differ only by this value. It is **not a secret and not a security identity**: Cloudflare Access, the Managed OAuth and the JWT checks are unchanged. It is a logical owner label of a run and its lease. No new entity, scheduler id or Task is introduced.
2. **Stored with, never instead of, the existing fencing.** A scheduled start by a Task stores `taskId` on the runner lease (it survives every renewal, heartbeat, gate write and conversion, and is dropped only by a release, like the other correlation fields of ADR 0188 section 3) and on the run record. `runId`, the ownership `epoch` and the compare-and-swap of the lease, the submit gate and the commit guard decide every write exactly as before.
3. **The start.** `prediction_batch_start({trigger:'scheduled', taskId, …})` claims the lease **before** the heavy preflights (the existing early claim of ADR 0188, same epoch and renewals) and then:
   - the lease is live and belongs to **another** `taskId`, or to a run without a label: `already_running`, the run is not adopted and nothing is assigned;
   - the lease is live, carries **this** `taskId` and the same start arguments (`scope`, `mode`, `trigger`, resolved `manifestSize`, `capacity`) and the same epoch: the start does not create a run. If the first start has stored its manifest it returns **the same full stored manifest** (run id, epoch, hash, films, profile, contract), **also after the first client submit**, for as long as that lease is live. If the first start is still preparing it, the repeat waits at most the existing join bound (10 s) and then answers `start_pending` with the true `runId` and `epoch`, `taskId`, `retryAfterMs` and the readback pointer (`prediction_batch_manifest`, whose `manifest_pending` means "keep reading"). A Task never receives `already_running` from its own live lease;
   - the same `taskId` with **different** start arguments: `409 task_args_mismatch` (an explicit argument conflict, not a foreign owner, no write);
   - no live lease (released, or expired): a **new** run and a new epoch. The earlier run is never restored; its unsubmitted films stay in the queue, and a run left by an expired lease is interrupted by the existing recovery.
   A lost answer of the first start is recovered by the repeat (the stored manifest) or by `prediction_batch_manifest`, which reads a start that is still preparing as `manifest_pending` for its own Task only.
4. **Every run-scoped call checks the label.** `prediction_batch_manifest`, `prediction_heartbeat`, `prediction_batch_hold`, `prediction_batch_submit` (a real submit; a dry run is a read-only check) and `prediction_complete` carry `taskId`, and the Worker compares it with the label of the run (and, for a start still preparing, of the claim) **before any write, step record or writer lease**. A mismatch, including a run without a label and a caller without one, answers `409 wrong_owner` with no payload of the run and no write; the answer deliberately has no `status: "blocked"` and never records a stop of the real owner's run. An unknown `taskId` value is `400 invalid_task_id`. `prediction_batch_validate` accepts the label as a parameter of the Task workflow; it is read-only and does **not** confirm ownership. The read-only `enrichment_runner`, `enrichment_status` and `enrichment_queue` accept an optional `taskId` and ignore it: they never require ownership and never start failing.
5. **Fail closed at the MCP boundary.** At the MCP tool, a real scheduled start (`trigger: "scheduled"`, no `dryRun`, no `invocationKey`) **without** `taskId` is refused before any storage access, and so are the run-scoped mutations and the manifest readback without it. The old production prompt (no `taskId`) therefore cannot silently enter the new mode: it fails visibly. At the HTTP layer, `taskId` is accepted only with `trigger: "scheduled"` and never together with `invocationKey` or `deferred` (`400`); a start without it keeps today's behaviour for owner-run diagnostics (HTTP is owner-only behind Access), and a run without a label is still operated only by callers without one. Manual, `dryRun`, keyless, keyed (ADR 0188) and deferred (ADR 0193) starts are unchanged and cannot take or join a labelled run (a manual start of an already-held slot is `already_running`).
6. **Submit repeats stay on the existing idempotency.** A repeated, confirmed submit after a partially processed one is handled by the server-side idempotency per film, run and `inputDigest`; it creates no new run and bypasses neither validation nor fencing. The label does not weaken or replace any of it.
7. **The label is a correlation, not an invocation id.** Two executions of `task00` can theoretically overlap. The Worker therefore never lets a label adopt a run beyond its **live** lease and its **real** run and epoch: a late handler of an expired run still fails on `lease_lost` or `epoch_mismatch`, a new hour of the same Task after release or expiry starts a new run, and a label never reuses an old epoch. Accepted residual: a second execution of the same Task that starts while the first execution's lease is still live is treated as that execution's repeat (it receives the same manifest and a second model may then work the same films); the server-side idempotency per film makes a duplicate submit a no-op, and the hourly cadence (15-minute lease) makes this reachable only by a hang of a single Task.
8. **Observability.** The start step records `keyed: 1`, `taskRepeat: 1` for a repeat, `joined: 1` and `startPending: 1` as for ADR 0188, `keyArgsMismatch: 1` for `task_args_mismatch`. The AIR-556 verdict and the repeated-orphan-start reason of ADR 0193 section 9 are unchanged; an `already_running`, a `start_pending` or a `200` start is never progress.
9. **Compatibility and rollback.** No schema change, no migration, no feature flag, no new Worker binding. The change is backward compatible at the HTTP and storage level: a lease or run without a label behaves exactly as before. Rollback is the previous prompt (a prompt without `taskId` fails closed at MCP, so it must be restored together with, or after, a Worker revert) plus an optional code revert; a stored label is ignored by the reverted code.

**Not decided here:** the production cutover. Enabling the four Tasks, installing the four prompts with their IDs, any manual start, lease reset, flag, D1 or R2 change remain separate owner-approved operations. This ADR authorizes none of them.

## Alternatives considered

- **A per-invocation key** (ADR 0188 caller-composed, ADR 0193 server-issued): rejected as the protocol of the Tasks, because the model cannot be relied on to keep a random value across repeats and the scheduler exposes no invocation id; the experiments did not restore predictions. Kept only as the unchanged dormant paths.
- **A deferred Workflow start** (ADR 0193): not repeated; it adds a Cloudflare resource and a readiness protocol and did not address the observed second request.
- **Another random or composed key:** explicitly excluded by the owner.
- **A label required at the HTTP layer for every scheduled start:** rejected for this change; the production caller is the MCP, which is strict, and the HTTP route is owner-only for diagnostics. A run that has a label is nevertheless operated only with it.
- **Treating `taskId` as authorization:** rejected; it is a public constant and adds no security.

## Consequences

- A repeat of the same Task's start within its live lease is answered with the same manifest or a `start_pending`, so a retried or duplicated request no longer turns the Task away from its own run.
- A foreign Task, a manual caller or a caller without a label cannot heartbeat, hold, submit, complete or read back a labelled run; a foreign call writes nothing (it leaves no step, no writer lease and no stop).
- Each run-scoped heartbeat and complete reads the run once more before the writer (one extra read), the price of refusing a foreign call without any write.
- Four prompts now differ by one constant; the "identical prompt" statements of the registry readbacks are historical, not the current norm.
- A second execution of the same Task that overlaps a live lease can share its manifest (section 7).

## Recovery and migration boundary

Code, schema and documentation only. No stored data changes, no migration and no flag. The deployment does not enable or edit any Scheduled Task. A rollback of the code does not roll back prompts or Task states. The cutover of the four Tasks (paused → enabled, four different prompts installed in one controlled transition) and its production verification are owner/Controller operations described in [the prompt delta](../reference/scheduled-task-prompts/hourly-predictions-batch-v2-task-id-delta.md); they are not performed by the code delivery.

## Evidence

- **Original decision:** the [AIR-573](https://trello.com/c/4pD66DLd) description and handoff (see Approval source).
- **Implementation:** the pull request that carries this ADR (`src/enrichment.js`, `src/mcp.js`, `tests/prediction-task-id.mjs`).
- **Dated verification:** offline only, [the evidence note](../evidence/prediction/air-573-task-id-offline-2026-11-22.md).
- **Uncertainty:** the source of the repeated request; the join wait (10 s) against a first start that takes 75–90 s (the repeat then answers `start_pending`, which the prompt must treat as "read the manifest", not as a failure); the natural runs after the cutover are the only proof of recovery. `start = 200`, `already_running` and a green CI are not acceptance.

## Follow-ups

- Controller: the controlled four-Task cutover and the production verification by committed forecasts ([AIR-573](https://trello.com/c/4pD66DLd)).
- Independent review of the real pull request HEAD.
