# ADR 0175: The EPG-priority Discovery pause stays closed until the EPG run is durably `stage=complete`

**Status:** Proposed  
**Original decision date:** unknown (awaiting owner decision)  
**Recorded at:** 2026-11-19  
**Approval source:** owner design review of [PR 789](https://github.com/vladimino/iptv-watchlist/pull/789) (19 November 2026, review 5980875662): Option A approved **with one material change** (hold until durable `stage=complete`, not only `finalize`); Option B out of scope. The record stays Proposed until the revised text is re-reviewed. It authorizes no implementation and no production operation.  
**Related work:** [AIR-539](https://trello.com/c/2eYDrWBS); incident context [AIR-532](https://trello.com/c/mGPwomMX), [AIR-420](https://trello.com/c/J0dit94i); parallel optimization [AIR-533](https://trello.com/c/FyU4Qqud); [ADR 0135](0135-epg-priority-discovery-pause.md); [ADR 0092](0092-resumable-bounded-ledger-seal.md) (resumable seal); [ADR 0144](0144-epg-seal-successor-workflow-instance.md) and [ADR 0145](0145-epg-seal-publication-only-staging.md) (seal handoff and staging); [ADR 0173](0173-watchlist-retention-observed-at-is-state-start.md); [seal lease analysis 18 Nov](../evidence/orchestration/air-532-seal-lease-analysis-2026-11-18.md)  
**Supersedes:** None. If accepted it **qualifies** decision 3 of ADR 0135 ("how long it lasts"): the pause no longer lifts in the pointer batch. ADR 0135 stays Accepted for everything else.  
**Superseded by:** None

## Context

Confirmed from code on `main` (99ecc3a):

1. `sealStep` (`src/worker.js`) takes the shared `discovery_lease` with `role: 'epg'` for **every** seal phase (`ledger`, `catalog`, `publish`, `finalize`, `queue`) and releases it in `finally`. The lease is held only during a step. Between steps (Workflow handoff, sleeps) it is free.
2. `publish` runs four units: `pointer` (the one atomic D1 pointer batch, `commitPublish`), `mirrors`, `copy`, `intent`. `finalize` then runs `handover`, `watchlist`, `scan` (`persistScan`, watchlist retention), `events`. `queue` refreshes the prediction queue and the run reaches `stage=complete`.
3. ADR 0135 closes new Discovery admission at 16:55 Madrid. The pause lifts **inside the pointer batch**: `PAUSE_CLEAR_SQL` runs in `commitPublish` right after `madrid_run_key` is written, and the admission predicate (`PRIORITY_PUBLISHED_SQL`) admits whenever the pointer, the Discovery pin and `madrid_run_key` agree for the owed day, whatever the row says.
4. Therefore from the pointer to `complete` a new Discovery chunk is admitted. It takes the lease between EPG steps and EPG's next `acquireLease` returns busy (`sealBusyResponse`) until the chunk ends or its 90 s TTL expires. Nothing bounds how many chunks follow each other.
5. On 19 Nov 2026 the pointer was published before the run finished: `sync.json` stayed `stage=seal, sealPhase=finalize`, EPG received `busy` from `discovery_lease` with `holder_kind=discovery` and `discovery_epg_priority=clear`, and the run completed at 18:35:23 with `publishedAt` 18:35:11 (95m11s end to end, target ≤15m) per the card. That run also had an unrelated `ReferenceError` (AIR-532), so the 95 minutes are **not** all lease contention.
6. `publishedAt` is `report.updatedAt` of the programme report. It marks when the programme was generated and the pointer moved. It does not prove that the watchlist, retention, events or queue are complete, so it is not the SLA clock for "EPG and watchlist updated".
7. Retention, watchlist and events units do not read or assert the Discovery lease (analysis of 18 Nov, point 2 and 3). What the lease protects in `finalize` is single-flight of seal steps on `sync.json`, which is saved with an unconditional `put` (`saveJSON`), including the `persistScan` cursor and the rated-admission intent.

**Not measured in this record:** per-step lease hold time, the number of Discovery `busy` collisions and the wait they caused on 19 Nov. The seal `sleep` reason and the `acquire` outcome are not logged today, and no production read was made for this proposal. The incident therefore proves the possibility and one observed `holder_kind=discovery` collision, not its cost. The first deliverable of the implementation is the bounded telemetry in decision 8.

8. `sealQueueStep` also runs under `sealStep`, so `queue` and the completion write re-take the same `discovery_lease`. Lifting the pause after `finalize` would only move the starvation to `queue` and to completion. `refreshPredictionQueue` errors are already caught and recorded as `enrichmentQueueError`; they do not stop the run.
9. `persistScan` returns `ok` without applying any observation when the watchlist is incomplete (`films.length !== watchlistCount`) or `watchlistObservedAt` is missing, and the facts-only path runs when the canonical writer is not open. `ok` from the unit therefore does not mean retention was applied.
10. `published_epg_authority.generation` also moves on later replace-commits (`commitReplace`, the watchlist), so a generation captured at the pointer is **not** a fence for a write after `finalize`. The step fence is `epgFenceStatements(stage.epgFence)` (the step lease checked by `EpgOrchestration.assertStep`, `epgStepGuard` on every `saveJSON`).

## Decision (proposed)

**Option A, as approved by the owner with one change: keep refusing *new* Discovery admission until the EPG run is durably `stage=complete`.** Option B is rejected for this delivery.

1. **Release point.** The pause for the owed day lifts only after the run that published the pointer is certified complete. Complete means: `ledger`/`catalog`/`publish`/`finalize` units reached a terminal outcome, `queue` was **attempted**, and `sync.json` holds `stage=complete`. Success of `refreshPredictionQueue` is **not** required: its errors stay best-effort and recorded in `enrichmentQueueError`; the run still finishes and the pause lifts. `mirrors` and `copy` stay repairable by the hourly `ensure` and do not gate completion beyond today's `degraded` marker.
2. **What the certificate means.** It certifies **protocol completion of this run**: no further seal step will take the lease for it. It does **not** certify that watchlist retention was applied (decision of context 9), and it is **not** the owner's end-to-end SLA clock. The run records `scanOutcome` (`applied`, `skipped_incomplete_watchlist`, `skipped_no_observation`, `facts_only`) next to the certificate; the SLA is read from `completedAt`, the per-unit outcomes and `scanOutcome`, never from the pause release or from `publishedAt`. A skipped scan is visible, not silently counted as a complete EPG-and-watchlist update.
3. **Durable proof.** Two nullable columns on the existing `published_epg_authority` row: `finalized_run_id` (a programme run id) and `finalized_at` (telemetry). An R2 cursor or `sync.json` alone is never the proof, because `sync.json` is unfenced.
4. **Cross-store ordering (crash-safe).** The order is fixed:
   1. `queue` attempted; `prepareEpgCompletion`; events flushed (today's order).
   2. `sync.json` saved with `stage=complete` (R2, under `epgStepGuard`).
   3. **One fenced D1 batch** certifies and clears: `epgFenceStatements(stage.epgFence)` first, then `UPDATE published_epg_authority SET finalized_run_id=?, finalized_at=? WHERE id=1 AND mode='d1' AND cutover='open' AND programme_run_id=? AND madrid_run_key IS ? AND (finalized_run_id IS NULL OR finalized_run_id=?)`, then the pause-row clear with the ADR 0135 predicate extended by `e.finalized_run_id=e.programme_run_id`. Both statements are in the same batch, so proof and clear are atomic; a failed fence statement aborts the batch.
   The inverse order (D1 first) is **rejected**: a certificate before `sync.json` is complete is a false certificate and reopens Discovery while the run can still take the lease.
5. **Failure matrix.**

   | Situation | Result |
   | --- | --- |
   | Crash or error after `sync.json` complete, before the D1 batch | Pause stays (fail closed). The run is complete but uncertified. A repair certifies it: any later EPG step or Workflow replay that sees `stage=complete`, pointer = run, `finalized_run_id` not set, runs the same batch; the hourly `ensure` does the same as the named writer. Discovery waits as `awaiting_complete` meanwhile. |
   | Crash after the D1 batch, before the step returns | Replay finds `finalized_run_id = run`; the batch is a no-op (CAS accepts the same value). |
   | D1 result unknown / lost response | Read back the row. `finalized_run_id = run` means done; otherwise repeat the identical batch. Never assume success, never blind-write. |
   | D1 certificate with `sync.json` not complete | Cannot happen by ordering. A repair never certifies from D1 state alone: it first reads `sync.json` and requires `stage=complete` and the same `runId`. |
   | Stale or duplicate step (older Workflow attempt, step lease expired) | The step fence statement fails, nothing is written. |
   | Two concurrent seal steps | Serialized by the shared lease and the step guard as today; a second certify is idempotent by the CAS. A step for a different run cannot match `programme_run_id`. |
   | Workflow rollover, successor instance | The successor drives the same `sync.json` run; `queue` and the certify batch are idempotent. |
   | Adopted seal after Madrid midnight | The certificate is bound to the run's frozen `madrid_run_key` (as the pointer). The pause clear still requires `madrid_run_key` to equal the owed or overridden day, so today's pause is not cleared by yesterday's certificate and today's pause opens only at 16:55 today. |
   | Run never completes (quarantine, stall) | Pause stays; no TTL. Escalation is the existing EPG `late`/`stalled`/quarantine health, the `awaiting_complete` reason, and the owner override (admits only the programme id the pointer names). |
   | Completed under an old Worker (no certificate written) | The repair above certifies it from `sync.json`; the owner override is the backstop. |
6. **Admission predicate.** `PRIORITY_PUBLISHED_SQL`, `PRIORITY_PUBLISHED_ANY_SQL` and `PAUSE_CLEAR_SQL` add `e.finalized_run_id=e.programme_run_id`. The pointer batch (`commitPublish`) no longer clears the pause. A published pointer without the certificate is `epg_priority` / `awaiting_complete` (`wait`), never `evidence_unreadable`.
7. **Unchanged:** 90 s lease TTL; non-preemptive holder renewal (an in-flight chunk finishes or expires, only *new* admission is refused); `role: 'epg'` exemption; `acquireLease` CAS; owner override; projector window; `stale_generation`; honest `publishedAt` and pointer semantics; best-effort queue errors. No lease reset, no force release.
8. **Telemetry (no secrets, no Film data).** `busyKind`, `holderKind`, `holdExpiry`, `waitMs`, `sealPhase` on EPG busy/sleep paths and on the `epg_priority` answer; new reason value `awaiting_complete` for the interval between pointer and certificate, separating EPG-held from Discovery-held leases and the new wait from the pre-pointer wait.
9. **Mixed-version safety and holdpoints.** A Worker that ignores the columns is schema-compatible but **not behavior-compatible**: it lifts the pause at the pointer and never certifies, so the invariant is silently lost. Therefore:
   - *Absent vs unreadable.* A **verified absent** column (introspection answers no such column) keeps today's behavior: pause lifts at the pointer, no certificate. An **unreadable** answer (error, null) fails closed: no new Discovery admission; EPG is exempt.
   - *Deploy order.* (a) Deploy code that is dormant while the column is absent. (b) Separate owner GO applies the migration (preflight, one apply, readback); until then nothing changes. (c) After the apply, a read-only preflight confirms the deployed version is the new code and no gradual rollout or older instance is live. Only then is the invariant considered active, and the first natural run is observed for the `awaiting_complete` interval and the certificate.
   - *Rollback.* Code rollback to a Worker without the columns is allowed only as an owner-approved step, recorded as "pause lifts at pointer again; starvation risk returns; no data risk". It does not remove the columns or any row. Roll-forward certifies a run left uncertified by the old Worker via the repair of decision 5.
   - *Detection.* A read-only check "pointer published, pause row `clear`, `finalized_run_id` not equal to the pointer" is added to the runbook as the signature of an old Worker.
   Applying the production schema needs its own explicit owner GO; this record does not give it.

## Alternatives considered

- **Lift the pause after `finalize` (the first version of this ADR).** Rejected by the owner: `queue` and completion take the same lease, so starvation moves there.
- **Make `queue` success mandatory.** Rejected: a best-effort refresh failure would keep the run incomplete and Discovery closed forever.
- **B. Drop the shared lease for part of the seal.** Retention is idempotent (request id, receipts, per-Film `canonical_revision`, monotonic `observed_at`, ADR 0173), but `sync.json` is an unconditional `put` whose single-flight is the lease. B needs a proven replacement fence (conditional put/CAS, safe replay, concurrent-step handling) and is out of scope; Film idempotence alone does not justify it.
- **Do nothing, rely on AIR-532/533.** Shorter holds shrink the window but do not remove starvation, and the cost is unmeasured. Complementary, not a substitute.
- **Time-boxed pause after the pointer, or interrupting/stealing the lease.** Rejected as in ADR 0135.

## Consequences

- **Material trade-off:** Discovery on the new generation starts after the run is complete, not at the pointer. The delay is the post-pointer tail (on 18 Nov `seal_finalize_scan` alone was 44m02s, before AIR-532). A stalled run, or a D1 outage during the certify batch, keeps Discovery closed until repair or an owner override. No candidate is lost, only delayed.
- EPG `finalize`, `queue` and completion cannot be starved by new Discovery chunks; at most the one in-flight chunk (≤ 90 s TTL) delays one step.
- New complexity: one migration (two columns), a cross-store ordering with a repair path, a clause in three predicates, and a second way for a pause to stay open.
- Acceptance matrix for the implementation card (deterministic tests): pointer moved and `finalize` incomplete; `queue` under a live Discovery lease; crash after `sync.json` complete before certify; crash after certify before return; unknown D1 result with readback; lost response and Workflow replay; successor and adopted seal across midnight; stale step fence; two concurrent seal steps; renew vs expiry; EPG busy then takeover; stale generation; projector window; quarantine and recovery; `queue` error still completes; `scanOutcome` for each skipped path; column absent, present and unreadable; old Worker against the new columns and the repair on roll-forward; no D1 migration apply in tests.

## Recovery and migration boundary

Nothing is activated by this record. The implementation card carries the migration file (not applied), code, tests and docs. The apply is a separate owner GO with preflight and readback. Code rollback does not revert columns, rows or D1/R2 data. This ADR authorizes no manual EPG or Discovery run, Workflow restart or rollover, lease reset, pause override, flag, Scheduled Task or D1/R2 write.

## Evidence

- **Original decision:** owner review of [PR 789](https://github.com/vladimino/iptv-watchlist/pull/789), 19 Nov 2026; scope of [AIR-539](https://trello.com/c/2eYDrWBS).
- **Implementation:** none.
- **Dated verification:** code reading of `main` at 99ecc3a on 2026-11-19 (`src/worker.js` `sealStep`, `sealPublishStep`, `sealFinalizeStep`, `sealQueueStep`, `persistScan`, `epgStepGuard`; `src/published-epg.js` `commitPublish`, `commitReplace`, `PAUSE_CLEAR_SQL`; `src/discovery-authority.js` `PRIORITY_*`, `acquireLease`; `src/domain/epg-priority-pause.js`). The 19 Nov timings are quoted from the card, not re-measured.
- **Uncertainty:** lease hold per step and collision count (not logged); how much of the 95m11s is lease wait; the exact shape of `epgFence` to reuse (the implementation card confirms it); how the Mermaid flows change (updated with the implementation, with rendered QA).

## Follow-ups

The implementation card, the migration GO and the natural-run verification are created only after the owner accepts this record. Acceptance also updates `docs/reference/orchestration-reliability.md`, `docs/runbooks/monitoring.md`, `docs/runbooks/deployment.md` and the three architecture pages.
