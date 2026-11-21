# ADR 0188: A repeated `batch_start` of the same invocation joins its own run (keyed idempotent start), and the runner lease is claimed before the heavy start work

**Status:** Accepted (design; the implementation is a separate PR and the Task prompt change is gated)  
**Original decision date:** 2026-11-21 (direction approved by the Product Owner as "A+B"; text revised through three independent reviews, the last a PASS on HEAD `3e57d17`)  
**Recorded at:** 2026-11-21  
**Approval source:** The Product Owner accepted ADR 0188 on 2026-11-21 (Europe/Madrid) in the AIR-573 session and asked for the implementation; the earlier design GO on [AIR-573](https://trello.com/c/4pD66DLd) of 2026-11-21 (Europe/Madrid): variants A and B together, ADR first, no change to Task prompts by the Executor (the owner and the Controller change them).  
**Related work:** [AIR-573](https://trello.com/c/4pD66DLd) (P0 incident); predecessors [AIR-468](../evidence/prediction/air-468-batch-start-rca-2026-11-14.md) and [AIR-486](https://trello.com/c/rmLnAabx) ([evidence](../evidence/prediction/air-486-batch-start-settle-move-2026-11-15.md)); health contract [AIR-556](https://trello.com/c/ZjqzW7EB); [AIR-560](https://trello.com/c/NZ70Dzom) stays open and independent.  
**Supersedes:** None. It refines the "an overlapping start never adopts a foreign run" rule of [ADR 0122](0122-prediction-batch-runner-v2-dual-protocol.md): that rule stays for every caller without the key and for every other key.  
**Superseded by:** In part [ADR 0191](0191-deferred-batch-start-with-server-issued-key.md) (the caller-composed key and its validation gate, and the synchronous join as the Tasks' protocol); the claim, fencing and join rules stay

## Context

Confirmed from read-only traces recorded on AIR-573 (21 Nov 2026) and from the repeated pattern of AIR-468 (14 Nov): a v2 Task's `prediction_batch_start` is answered after 75–90 s, and a **second** HTTP `batch_start` arrives about 60.6 s after the first, while the first is still working. On the S5 slot of 13:15 Madrid the lease was taken about 13:16:46, the second request arrived at 13:16:48 and was answered `already_running` at 13:17:04.444 (about 16 s after it arrived), the Task ended at 13:17:07, only about 2.6 s after that answer, and the original start answered only at 13:17:17. The Task had survived the first call pending for about 77 s; what ended it was the `already_running` answer. The Task prompt treats `already_running` as a lost slot and ends without `prediction_complete`; the run it owns then sits in a live lease without a heartbeat for 15 minutes and turns away the next slots. No committed prediction since 11:50 Madrid.

Established from the code (`src/enrichment.js`, not measured per stage):

- `batchStartWork` runs two heavy `batchPreflight` passes before the lease is taken (`runnerLease(..., 'acquire')`, which already carries an epoch and a compare-and-swap).
- After the lease, `batchPersistRun` runs a third preflight, then, inside `predictionWriter`, saves sources, the run, `runnerStarted`, optionally **drains staged predictions** (`drainBatchStage`, which calls `batchSubmitItem` and can set `run.firstSubmitAt`), and only then saves the start answer (`batch-manifest/<runId>.json`) and returns it. On the 13:15 trace this post-lease part took about 31 s.
- A refusal path of a real start (`noop`, `quota`, `queue_changed`, size refusal, catalog held) creates no run, Event, diagnostics row or `latest-run` and takes no lease today (ADR 0122). It is not free of queue effects: `batchRefreshQueue` can already have made a guarded queue settle (its own compare-and-swap) before a later idle or size refusal; that pre-existing effect is unchanged by this ADR.

**Not established:** who issues the second request (client timeout retry, re-issued tool call of the same invocation, something else), and the platform's own cutoff of a Task. No Task invocation id is correlated with a Worker `requestId`. This ADR must be correct under every cause, and it does **not** claim that a wait on the original response is enough: the observed Task ended 10 s before that response.

## Decision

### 1. Key, canonical arguments and scope

`prediction_batch_start` accepts an optional `invocationKey` (16–128 characters from `[A-Za-z0-9._:-]`; invalid input is HTTP 400). The Worker stores only `SHA-256(key)` and `argsHash` on the lease and the run, never the key, and never logs either.

- **`argsHash`** is the SHA-256 of the canonical start arguments: `scope`, `mode`, `trigger`, the resolved manifest size, and `capacity` (canonical JSON, sorted keys). A repeat is a **match** only when both hashes equal the holder's. A key with different arguments is a caller bug and is refused (`already_running` with reason `key_args_mismatch`), never joined.
- **Stable keys are the caller's contract.** The key must be deterministic per Task and scheduled slot (for example the Task identifier plus the slot's start time in UTC), so a transport retry and a model re-issue inside one invocation produce the same key, and `:00`, `:15`, `:30`, `:45` Tasks and different slots never share one. A key the model generates freshly on each call is not allowed. The key is a correlation token, not a credential (the endpoint is already owner-only behind Access and the signed JWT).
- **Keyed real starts only.** The early claim (3) and the join (2) apply only to a **real** start (`dryRun` not `true`) that carries a key. A start **without** a key behaves exactly as before, including the no-lease guarantees of ADR 0122. `dryRun:true` stays strictly write-free, never claims or joins, ignores the key and runs beside a live lease.

### 2. Join, and what it returns inside the caller's lifetime

A keyed start whose `keyHash` and `argsHash` match the **live** holder (claim or owned run) is a **join**. A join writes no lease, run, queue or film, extends no TTL and mints no epoch.

- **Manifest already stored** (`batch-manifest/<runId>.json` exists): the join returns that stored answer (the same manifest, `runId`, `epoch` and `drained` block), HTTP 200.
- **Manifest not stored yet:** the join waits at most `JOIN_WAIT_MS` (10 s, polling the stored answer once per second) and then returns immediately **HTTP 200 `{status:'start_pending', runId, epoch, retryAfterMs}`** without starting anything. The caller then reads the manifest with the existing read-only `prediction_batch_manifest` (`envelope`, then the parts), which answers `manifest_pending` until the answer is stored, and either re-sends the **same keyed** `batch_start` (a join again) or reads the parts. It never needs a different key and never runs another start. The `start_pending` / `manifest_pending` handling is a prompt change and belongs to the owner and the Controller.
- **Bound:** the Worker's join answer comes within `JOIN_WAIT_MS` plus one preflight-free read. The trace does **not** prove that 10 s is safe: it shows only that a Task survived a first call pending for about 77 s and ended about 2.6 s after an `already_running` answer. `JOIN_WAIT_MS` is therefore a tunable constant, the offline regression asserts the time bound, and the natural runs after deploy are the only proof.
- **Eligibility:** the run has had no **client-driven** submit. The internal drain of staged items is not one: `batchSubmitItem` calls from `drainBatchStage` do not set the new run field `clientSubmitAt`, and the join condition reads `clientSubmitAt`, never `firstSubmitAt`. It is a single monotonic marker, set once and never cleared, written under CAS with the expected epoch at the moment a genuine external `batch_submit` passes its ownership and fencing checks and **begins** to commit (the conservative "started" point: from then a film may be committed by the client path). `prediction_heartbeat`, lease renewals and the internal drain never set it, so a Task that heartbeats to protect its lease before it has the manifest can still join. Once the marker is set, a repeat start gets today's `already_running`.

### 3. Early start claim, fenced end to end (keyed real starts)

After the cheap guards (body validation, D1 requirement) and **before** the heavy preflights, a keyed real start takes the runner lease through the existing acquire (epoch plus compare-and-swap) as a **claim**: `phase:'claim'`, the future `runId`, `keyHash`, `argsHash`.

- **TTL and renewal.** The claim TTL is `START_CLAIM_TTL_MS` = 180 s, about twice the slowest observed start (104 s). The owner renews it at every stage boundary (after each preflight and the queue refresh, before persist) through the existing renew, which keeps the epoch and returns `lease_lost` when the holder or epoch differs. A renewal answered `lease_lost` aborts the start **before any side effect**: the preflights and the queue refresh write nothing but the queue's own guarded settle, which keeps its own compare-and-swap.
- **Conversion under the same epoch.** Immediately before the first persist side effect (sources, run record, `runnerStarted`, drain, stored answer) the claim is converted to the owned lease (`phase:'run'`, normal 15 min TTL) by one compare-and-swap write that keeps `epoch`, and an ownership check (`lease.runId`, `epoch`, live) is repeated before `savePredictionRun` and before the drain. A superseded handler therefore stops with `lease_lost` and never publishes a live run, diagnostics row, Event or manifest. Expiry after conversion is not possible within a 15 min lease.
- **Every lease mutation preserves or intentionally transitions the correlation fields.** Today's `runnerLease` rebuilds the value from `owner`, `runId`, `heartbeatAt`, `expiresAt`, `epoch` and optional `submitGate` only, so a renewal would silently drop `phase`, `keyHash` and `argsHash`. The implementation must therefore not rely on it as is: claim renewal, ordinary heartbeat, conversion, gated writes (`submitGate`) and release each build the new value from the old one by an explicit field-preserving merge, under compare-and-swap and the expected epoch. Renewal, heartbeat and gated writes keep `phase`, `keyHash`, `argsHash`; conversion is the only transition `claim` to `run` and keeps both hashes (the owned run is joinable); release ends the lease and drops them by intent.
- **Fenced cleanup.** Every no-run exit (idle `noop`, `quota`, `queue_changed`, size refusal, catalog held, error) releases the claim through the existing release operation, which only succeeds for the same `runId` and epoch; a claim already taken over is left alone.
- **Changed contract for keyed real starts, stated explicitly.** On a no-run exit they still create no run, Event, diagnostics row, queue write or `latest-run`, but the lease record is written twice (claim, release) and its epoch advances. ADR 0122's "no lease" wording is narrowed accordingly for keyed real starts only; `docs/reference/api/mcp.md` and `docs/reference/api/enrichment.md` say so in the implementation PR. A no-run exit of a keyed start may still have made the pre-existing guarded queue-refresh settle (see Context); only the lease, run, Event and diagnostics effects are claimed to be absent. Readers of the lease (monitor, `enrichment_status`, queue overview) treat `phase:'claim'` as a start in progress, never as a run.

### 4. No foreign adoption, ever

A join needs the exact `keyHash` and `argsHash` on a live holder. No key, a different key, a different argument set, an expired holder, a run with `clientSubmitAt`, or a holder without a key answers `already_running` naming the holder, as today. Epoch and fencing of heartbeat, submit and complete are untouched; a joiner never gets ownership the owner request did not hold.

### 5. Dormant until the prompts send the key, and the key-source gate

A caller that sends no key behaves as before. **The fix therefore stays dormant in production until the Task prompts send a deterministic `invocationKey` and handle `start_pending`.** That prompt change is outside the Executor's scope (owner and Controller). Deploying this code does not by itself recover Predictions.

**Validation gate before any prompt rollout.** "Task identifier plus scheduled UTC slot" is an example, not a demonstrated caller API. Before the prompts are changed, the owner and the Controller must show a deterministic per-Task and per-slot key source that stays identical across a transport retry and a model re-issue despite scheduler drift (a slot start a few minutes off its nominal time, as seen on 14 Nov), and never depends on a fresh model-generated time or random value. Until that is shown, the key must not be sent, and this ADR's acceptance does not imply it.

### 6. Observability

The step-timing line carries counters only: key present, joined, pending, mismatch, claim age, claim renewals, and stage times. A new health signal reports **absence of progress**: an owned or expired run with no committed film while the queue is eligible, and a repeated `already_running` in one slot. `already_running` is never counted as healthy; the signal stays consistent with the [AIR-556](https://trello.com/c/ZjqzW7EB) contract.

### Required offline regression (implementation PR)

Claim expiry and takeover during each stage (preflight 1, queue refresh, preflight 2, persist entry, run save, drain) with the original handler publishing nothing; an expired or superseded claim can neither be released nor converted by the old handler; `phase`, `keyHash` and `argsHash` survive several renewals including an interleaved heartbeat and a gated write; conversion under the same epoch; pending, then heartbeat, then same-key join, then manifest recovery; an actual external `batch_submit`, then a same-key repeat (`already_running`); the internal drain excluded from `clientSubmitAt`; the +60.6 s same-key retry before and after the lease, with the stored answer present and absent (`start_pending` within `JOIN_WAIT_MS`); the drain setting `firstSubmitAt` without `clientSubmitAt` while a same-key retry still joins; a client submit then a repeat (`already_running`); key with different `argsHash`; foreign key; keyless and `dryRun` starts unchanged and write-free beside a live lease; release only by the same epoch; unknown ack; previous generation.

Not decided here: any Task edit, schedule or `run_now`, any lease reset, flag or model change, the manifest size, or the speed-up of the preflight itself.

## Alternatives considered

- **C. Only make `batch_start` faster** (AIR-471, AIR-486 direction). Already tried; the start still takes 75–90 s on S5 and the second request still arrives. It also leaves every caller exposed to any later slowness. Kept as ongoing work, not as the fix.
- **Keyless idempotent start by body hash or by trigger.** Rejected in AIR-468: `:00`, `:15`, `:30` and `:45` Tasks send equal bodies, so a foreign invocation could adopt a live run.
- **Prompt-only retry after `already_running`.** Rejected: the first run's lease stays live for 15 minutes, so the retry cannot succeed.
- **A (key) without B.** Works only if the repeat arrives after the lease; a repeat that arrives earlier runs a second heavy start and loses the lease race. B makes the claim visible within seconds.
- **A plain bounded wait for the original response** (first draft of this ADR). Rejected in review: the observed Task ended 10 s before the original response, so a wait alone does not prove recovery; hence `start_pending` and the read-only manifest resume.
- **Early claim for every real start, keyed or not.** Rejected in review: it would change the no-lease guarantees of ADR 0122 for callers that did not ask for it.
- **B without A.** Without a key the repeat is still a foreign start, so it still gets `already_running`. B alone does not repair the incident.

## Consequences

- A repeated start of the same invocation, whatever its cause, continues the run instead of abandoning it. No change of research quality.
- New state on the lease and run (`keyHash`, `argsHash`, claim phase, `clientSubmitAt`) and two more outcome paths (join, `start_pending`). A claim that is not released or converted blocks the lease for at most 180 s, shorter than today's worst case of a lost owner (15 min).
- Keyed starts that find nothing to do now touch the lease (claim and release); the claim must be proven cheap in the offline budget tests and must not starve a real start.
- A caller bug that reuses one key across Tasks defeats the isolation of item 4; the contract states it and the Controller owns the key format.

## Recovery and migration boundary

Code only; no schema or data migration and no flag. Without the key the behaviour is the current one, so reverting the PR or simply not sending the key restores today's contract. Existing leases without a key hash are read as before. This ADR authorizes no production operation: Task prompt edits, recovery of the currently expired or live lease, and any run remain owner-gated.

## Evidence

- **Original decision:** [AIR-573](https://trello.com/c/4pD66DLd) owner design GO, 2026-11-21.
- **Implementation:** pending (the PR that follows this ADR).
- **Dated verification:** the live traces are on the AIR-573 card (21 Nov 2026, Madrid); no new production read was made for this ADR.
- **Uncertainty:** the cause of the repeated request; the exact per-stage share of the ~60 s before the lease; the platform's own cutoff of a Task, which `start_pending` is designed not to depend on; the natural runs after deploy are the proof.

## Follow-ups

- Implementation and offline regression PR for this ADR (AIR-573).
- Task prompt change to send `invocationKey` (owner and Controller).
- Natural-run acceptance and the owner's acceptance on AIR-573.
