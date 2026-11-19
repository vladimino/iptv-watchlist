# ADR 0175: The EPG-priority Discovery pause stays closed until the post-pointer `finalize` units are complete

**Status:** Proposed  
**Original decision date:** unknown (awaiting owner decision)  
**Recorded at:** 2026-11-19  
**Approval source:** not documented. [AIR-539](https://trello.com/c/2eYDrWBS) requires an owner gate on the architecture before any implementation.  
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

**Not measured in this record:** per-step lease hold time, the number of Discovery `busy` collisions and the wait they caused on 19 Nov. The seal `sleep` reason and the `acquire` outcome are not logged today, and no production read was made for this proposal. The incident therefore proves the possibility and one observed `holder_kind=discovery` collision, not its cost. The first deliverable of the implementation is the bounded telemetry in decision 5.

## Decision (proposed)

**Option A is proposed: keep refusing *new* Discovery admission until the EPG publication's post-pointer units are durably complete.** Option B is rejected for this delivery.

1. **Hold point.** The pause for the owed day lifts only when a durable, D1-readable proof says that the run that published the pointer finished its mandatory post-pointer units. Which units are mandatory is part of the decision for the owner: **proposed `handover`, `watchlist`, `scan`, `events` (the whole `finalize` phase)**. `queue` is **not** proposed as mandatory. It refreshes the prediction queue, does not touch the watchlist, and its failure is already recorded without holding the run. `mirrors` and `copy` are repaired by the hourly `ensure` and are not mandatory either; `intent` queues Discovery work that the pause itself keeps from running, so it must stay before the proof.
2. **Durable proof.** One new nullable column on the existing `published_epg_authority` row (proposed name `finalized_run_id`, a programme run id). It is written by one fenced D1 statement at the end of `finalize`: `UPDATE ... SET finalized_run_id=? WHERE id=1 AND mode='d1' AND cutover='open' AND programme_run_id=? AND madrid_run_key IS ?`, bound to the exact generation, so a stale or replayed step cannot certify another run. The write is idempotent. `sync.json` is R2 and unfenced, so it is **not** the proof. This needs a schema migration, which is a separate owner GO and is not applied by this record.
3. **Predicate.** `PRIORITY_PUBLISHED_SQL`, `PRIORITY_PUBLISHED_ANY_SQL` and `PAUSE_CLEAR_SQL` add `e.finalized_run_id=e.programme_run_id`. The pointer batch no longer clears the pause: it keeps the row `paused` for the owed day. The proof statement is followed in the same batch by the row clear, so row and proof move together; a crash between them is repaired by the existing replay branch and the next acquire, as in ADR 0135. A published pointer whose proof is missing is treated as `epg_priority` (`wait`), never as `evidence_unreadable`.
3a. **Current holder.** An in-flight Discovery holder keeps `renewLease` and may finish its chunk or let the 90 s TTL expire. Only *new* admission is refused, exactly as ADR 0135 decision 1. No lease is taken from the holder and no lease is reset.
4. **Unchanged:** lease TTL 90 s, `role: 'epg'` exemption, CAS/fences of `acquireLease`, the projector window, the `stale_generation` rule, the owner override (clearing a stuck pause is the owner override, not a TTL). The override continues to admit only the programme id the pointer already names.
5. **Telemetry (no secrets, no Film data).** `busyKind`, `holderKind`, `holdExpiry`, `waitMs`, `sealPhase` on the EPG busy and sleep paths, so EPG-held and Discovery-held leases are distinguishable and the real cost of a collision becomes measurable. The `epg_priority` refusal gains a reason value `awaiting_finalize` for the new interval, so the dashboard and Discovery `waiting` health separate it from the pre-pointer wait.
6. **No false completion.** `publishedAt`, the pointer semantics and the success clock do not change. The proof is not `complete`: a run whose `queue` phase fails still lifts the pause once `finalize` is proven.
7. **Rollback.** A code rollback to a Worker that does not know `finalized_run_id` keeps working: the column is nullable and ignored, the old predicate admits at the pointer (ADR 0135 behavior). The reverse (new Worker, column absent) must be fail-closed to **today's** behavior, as ADR 0135 did for the absent table: a verified absence of the column keeps the current predicate, an unreadable answer admits nothing.

## Alternatives considered

- **B. Drop the shared lease for part of `finalize`.** Retention is idempotent (same request id, receipts, per-Film `canonical_revision`, monotonic `observed_at` per ADR 0173), so Film D1 is not what blocks this. What blocks it is `sync.json`: an unconditional `put` with the cursor and intent, and today's single-flight is the lease. B is acceptable only with a proven replacement (conditional put/CAS on the run record, safe replay of a crashed step, a fence for two concurrent seal steps) and a rewrite of every Workflow replay path. That is a larger change to a protocol that has just survived an incident, it does not follow from Film idempotence, and **it is not chosen**. It stays open as a later ADR if A proves too costly.
- **C. Do nothing, rely on AIR-532/533 making `finalize` short.** Shorter holds reduce the collision window but do not remove starvation, and the measurement that would justify waiting does not exist yet. Not chosen as the whole answer, but it is complementary: A and AIR-532/533 are independent.
- **Time-boxed pause (a TTL after the pointer).** Rejected for the same reason as in ADR 0135: a business TTL resumes Discovery under a live EPG run.
- **Interrupt or steal the Discovery lease for `finalize`.** Rejected: contradicts ADR 0135 decision 1 and the lease CAS.

## Consequences

- EPG `finalize` cannot be starved by **new** Discovery chunks after the pointer. At most the one in-flight chunk (≤ 90 s TTL) delays one step.
- **Material trade-off for the owner:** Discovery on the new generation starts later, after `finalize` instead of at the pointer. The delay is the `finalize` tail (on 18 Nov `seal_finalize_scan` alone was 44m02s, before the AIR-532 optimization). A stalled or quarantined `finalize` keeps Discovery closed until recovery or an owner override, exactly as a failed publication does today. Discovery is downstream of the published generation, so no candidate is lost, only delayed.
- New complexity: one migration, one more clause in three SQL predicates, and a second way for a pause to remain open. The stuck case must be visible: the existing EPG `late`/`stalled` health and the new `awaiting_finalize` reason are the escalation.
- Tests required before acceptance of the implementation (from the card): pointer already moved with `finalize` incomplete; live Discovery lease; renew versus expiry; EPG busy then takeover; cross-day owed key and adopted seal; Workflow replay and lost response; crash between pointer and proof; two concurrent seal steps; unknown D1/R2 result; stale generation; projector window; quarantine and recovery; migration absent/present; old Worker against the new column.

## Recovery and migration boundary

Nothing is activated by this record. The implementation card carries the migration file (not applied), the code, the tests and the docs. Applying the migration is a separate owner GO with preflight and readback. Code rollback does not revert the column, the row or any D1/R2 data. This ADR authorizes no manual EPG or Discovery run, Workflow restart or rollover, lease reset, pause override, flag, Scheduled Task or D1/R2 write.

## Evidence

- **Original decision:** not recorded; [AIR-539](https://trello.com/c/2eYDrWBS) scope and owner statements of 19 Nov 2026.
- **Implementation:** none.
- **Dated verification:** code reading of `main` at 99ecc3a on 2026-11-19 (`src/worker.js` `sealStep`, `sealPublishStep`, `sealFinalizeStep`; `src/published-epg.js` `commitPublish`, `PAUSE_CLEAR_SQL`; `src/discovery-authority.js` `PRIORITY_*` predicates, `acquireLease`; `src/domain/epg-priority-pause.js`). The 19 Nov timings are quoted from the card, not re-measured.
- **Uncertainty:** lease hold per step and collision count (not logged); how much of the 95m11s is lease wait; whether `queue` must be mandatory; how the Mermaid flows in `docs/architecture/scheduling-and-orchestration.md`, `epg-and-availability.md` and `discovery-and-resolution.md` change (updated with the implementation, with rendered QA).

## Follow-ups

The implementation card, the migration GO and the natural-run verification are created only after the owner accepts or amends this record. Acceptance also updates `docs/reference/orchestration-reliability.md`, `docs/runbooks/monitoring.md`, `docs/runbooks/deployment.md` and the three architecture pages.
