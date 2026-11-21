# ADR 0188: A repeated `batch_start` of the same invocation joins its own run (keyed idempotent start), and the runner lease is claimed before the heavy start work

**Status:** Proposed  
**Original decision date:** 2026-11-21 (direction approved by the Product Owner as "A+B"; the ADR text is awaiting independent review)  
**Recorded at:** 2026-11-21  
**Approval source:** The Product Owner's design GO on [AIR-573](https://trello.com/c/4pD66DLd) of 2026-11-21 (Europe/Madrid): variants A and B together, ADR first, no change to Task prompts by the Executor (the owner and the Controller change them).  
**Related work:** [AIR-573](https://trello.com/c/4pD66DLd) (P0 incident); predecessors [AIR-468](../evidence/prediction/air-468-batch-start-rca-2026-11-14.md) and [AIR-486](https://trello.com/c/rmLnAabx) ([evidence](../evidence/prediction/air-486-batch-start-settle-move-2026-11-15.md)); health contract [AIR-556](https://trello.com/c/ZjqzW7EB); [AIR-560](https://trello.com/c/NZ70Dzom) stays open and independent.  
**Supersedes:** None. It refines the "an overlapping start never adopts a foreign run" rule of [ADR 0122](0122-prediction-batch-runner-v2-dual-protocol.md): that rule stays for every caller without the key and for every other key.  
**Superseded by:** None

## Context

Confirmed from read-only traces recorded on AIR-573 (21 Nov 2026) and from the repeated pattern of AIR-468 (14 Nov): a v2 Task's `prediction_batch_start` is answered after 75–90 s, and a **second** HTTP `batch_start` arrives about 60.6 s after the first, while the first is still working. On the S5 slot of 13:15 Madrid the second arrived about 2 s after the first had taken the lease, and was answered `already_running`. The Task prompt treats `already_running` as a lost slot and ends without `prediction_complete`; the run it actually owns then sits in a live lease without a heartbeat for 15 minutes and also turns away the next slots. No committed prediction since 11:50 Madrid.

Established from the code (not measured per stage): `batchStartWork` runs two heavy `batchPreflight` passes before it takes the lease, so the client waits about a minute before the lease exists at all. The lease acquire (`runnerLease(..., 'acquire')`) already carries an epoch and a compare-and-swap.

**Not established:** who issues the second request (a client timeout retry, a re-issued tool call of the same invocation, or something else). No Task invocation id is correlated with a Worker `requestId`. This ADR is built to be correct under every one of those causes.

## Decision

1. **Keyed idempotent start (A).** `prediction_batch_start` accepts an optional `invocationKey` (a string of 16–128 characters from `[A-Za-z0-9._:-]`, invalid input is HTTP 400). The key names one Task invocation or slot and is chosen by the caller. The Worker stores only its SHA-256 on the lease and on the run, never the key, and never logs it.
2. **Join rule.** A start with a key that matches the hash of the **live** lease holder (claim or owned run), and whose run has not yet recorded a first submit, **joins** that run: it returns the run's stored start answer (the same manifest, `runId` and `epoch`), after a bounded wait while the owner request is still persisting it. A join writes no lease, no run, no queue and no film, extends no TTL and mints no epoch. Anything else is unchanged: no key, a different key, an expired lease, a run that already submitted, or a holder without a key answers `already_running` naming the holder, exactly as today.
3. **Early start claim (B).** After the cheap guards (body validation, D1 requirement, the live-lease check) and **before** the two heavy preflights, the start takes the runner lease through the existing acquire (epoch plus compare-and-swap) as a **claim** with a short TTL and the key hash. When the run is created, the claim becomes the run's lease with the normal TTL under the **same epoch**. Every path that ends the start without a run (idle `noop`, `quota`, `queue_changed`, size refusal, catalog held, an error) releases the claim through the existing release operation, so an idle hourly tick does not hold the lease. An expired claim is recovered like any expired lease.
4. **No foreign adoption, ever.** The key is a correlation token, not a credential (the endpoint is already owner-only behind Access and the signed JWT). A join needs the exact hash on a live lease; a key shared by two Tasks is the caller's collision, so the key must be unique per Task and slot. Epoch and fencing of heartbeat, submit and complete are untouched: a joiner never gets ownership the owner request did not already hold, and a duplicate commit still fails closed under the existing guards.
5. **The Worker works without the key.** A caller that sends no key behaves exactly as before. **The fix therefore stays dormant for production until the Task prompts send a unique `invocationKey`.** Changing the prompts is outside the Executor's scope (owner and Controller). Deploying this code does not by itself recover Predictions.
6. **Observability.** The step-timing line carries counters only: whether a key was present, joined or refused, the claim age, and the start's stage times. A new health signal reports **absence of progress**: an owned or expired run with no committed film while the queue is eligible, and a repeated `already_running` in the same slot. `already_running` is never counted as healthy. Details live in the monitoring reference and stay consistent with the [AIR-556](https://trello.com/c/ZjqzW7EB) contract.

Not decided here: any Task edit, schedule or `run_now`, any lease reset, flag or model change, the manifest size, or the speed-up of the preflight itself.

## Alternatives considered

- **C. Only make `batch_start` faster** (AIR-471, AIR-486 direction). Already tried; the start still takes 75–90 s on S5 and the second request still arrives. It also leaves every caller exposed to any later slowness. Kept as ongoing work, not as the fix.
- **Keyless idempotent start by body hash or by trigger.** Rejected in AIR-468: `:00`, `:15`, `:30` and `:45` Tasks send equal bodies, so a foreign invocation could adopt a live run.
- **Prompt-only retry after `already_running`.** Rejected: the first run's lease stays live for 15 minutes, so the retry cannot succeed.
- **A (key) without B.** Works only if the repeat arrives after the lease; a repeat that arrives earlier runs a second heavy start and loses the lease race. B makes the claim visible within seconds.
- **B without A.** Without a key the repeat is still a foreign start, so it still gets `already_running`. B alone does not repair the incident.

## Consequences

- A repeated start of the same invocation, whatever its cause, continues the run instead of abandoning it. No change of research quality.
- New state on the lease and run (key hash, claim phase) and one more outcome path (join). A claim that is not released or converted blocks the lease for its short TTL, which is shorter than today's worst case of a lost owner.
- Starts that find nothing to do now touch the lease (claim and release); the claim must be proven cheap in the offline budget tests and must not starve a real start.
- A caller bug that reuses one key across Tasks defeats the isolation of item 4; the contract states it and the Controller owns the key format.

## Recovery and migration boundary

Code only; no schema or data migration and no flag. Without the key the behaviour is the current one, so reverting the PR or simply not sending the key restores today's contract. Existing leases without a key hash are read as before. This ADR authorizes no production operation: Task prompt edits, recovery of the currently expired or live lease, and any run remain owner-gated.

## Evidence

- **Original decision:** [AIR-573](https://trello.com/c/4pD66DLd) owner design GO, 2026-11-21.
- **Implementation:** pending (the PR that follows this ADR).
- **Dated verification:** the live traces are on the AIR-573 card (21 Nov 2026, Madrid); no new production read was made for this ADR.
- **Uncertainty:** the cause of the repeated request; the exact per-stage share of the ~60 s before the lease; whether a join wait of the owner's persist time is always below the caller's own timeout.

## Follow-ups

- Implementation and offline regression PR for this ADR (AIR-573).
- Task prompt change to send `invocationKey` (owner and Controller).
- Natural-run acceptance and the owner's acceptance on AIR-573.
