# ADR 0204: Ordering drift of the same generation leaves the synchronous `batch_start`; one named hourly writer rebuilds it

**Status:** Accepted  
**Original decision date:** 2026-11-24 (Europe/Madrid)  
**Recorded at:** 2026-11-24  
**Approval source:** The Product Owner's implementation GO on [AIR-588](https://trello.com/c/vyxbU1l0#comment-6b04c96acb544ab06006a57d), 24 Nov 2026 Madrid: "RCA принят, A1 + A2 + C утверждены", with the A2 scope recorded at the top of the card description ("вынести из синхронного start только доказанный ordering drift (same-generation signature/window transition) в явно названный bounded writer с гарантией eventual refresh. Advance-gate failures, stale/settled films, unreadable signatures — как сейчас, refresh или fail closed; никакого ослабления correctness"). The GO covers code delivery, not any production operation.  
**Related work:** [AIR-588](https://trello.com/c/vyxbU1l0); RCA [PR 960](https://github.com/vladimino/iptv-watchlist/pull/960) and its [evidence](../evidence/prediction/air-588-predictions-stop-rca-2026-11-23.md); AIR-529 (the same-generation rebuild, owner decision of 18 Nov 2026, [runbook section](../runbooks/prediction-operations.md#hotcold-priority-after-discovery-assignments-in-the-same-generation-air-529)); AIR-542 (the accepted priority lag at the lease boundary); [ADR 0188](0188-idempotent-keyed-batch-start-and-early-start-claim.md); [ADR 0195](0195-scheduled-task-id-as-run-owner-label.md)  
**Supersedes:** None. It **amends** the AIR-529 owner decision of 18 November 2026 (recorded in code and the runbook, not in an ADR) that a changed shows signature is rebuilt immediately by the next `batch_start`: that rebuild moves to the writer below. The 15-minute rate cap of window transitions and the AIR-542 lag acceptance are unchanged.  
**Superseded by:** None

## Context

Since AIR-529 (18 Nov 2026 ~21:20 UTC) a `batch_start` rebuilds the Prediction queue when Discovery has assigned shows inside the published EPG generation (`shows_signature_changed`) or a hot/cold window edge was reached past its 15-minute cap (`window_transition`). While Discovery assigns continuously this happened on about two in three Task starts and added 15–45 s of `queue_refresh` and 5–17 s of a second preflight to a synchronous call that already took 35–65 s to persist ([RCA](../evidence/prediction/air-588-predictions-stop-rca-2026-11-23.md), section 4). The ChatGPT MCP client abandons a tool call after about 60 s in some runs; from 23 Nov 2026 20:30 UTC every run stopped after such a long start. The RCA does not prove that latency alone caused the stop, but a start of 90–180 s makes every run depend on how the client handles a long call.

## Decision

1. **What is deferred.** In a real (not dry-run) `batch_start`, a `priorityDue` whose cause is **ordering drift of the same completed generation**, `shows_signature_changed` or `window_transition` (`ORDERING_DRIFT_CAUSES`), no longer rebuilds the queue, provided all of these hold:
   - the stored queue passes the advance gate (profile, contract, registry, recovery revision) and is ranked on the published generation (`priorityBasis: completed`, same `programmeRunId`);
   - it stores a verified signature (`showsSignature` is a non-empty string; a queue ranked while the signature was unreadable stores none and is rebuilt as before);
   - the preflight selected at least one film to deliver (an idle queue still reconciles before `noop`, AIR-529);
   - its last rebuild (`refreshedAt`) is younger than `ORDERING_MAX_LAG_MS` = 90 minutes.

   The start then delivers from the stored queue: the accepted lag that AIR-542 already accepts after one rebuild. Films found already current or without an admission are still settled in the same start (the refresh path runs without forcing a rebuild). The step timing line records `orderingDeferred: 1` (and `orderingDeferredWindow: 1` for a window edge).
2. **What is not deferred** (unchanged): a queue that fails the advance gate (`stale`), an unreadable signature (`shows_signature_unreadable`), a new or carried generation (`priorityOpen`), a queue without a stored signature, an idle queue, a queue older than the lag bound, and every refusal of the post-lease revalidation (`queue_changed` for anything that is not a proven re-rank). The dry run still reports `priorityDue` and `priorityCause` exactly as before.
3. **The writer.** `reconcilePredictionOrdering` runs on the existing hourly cron tick (`0 * * * *`), beside `EpgOrchestration.ensure` and `Monitor.run`; no cron trigger is added. Per tick it: reads the prediction authority (only `d1` proceeds), the profile, the programme and the stored queue; skips unless the queue passes the advance gate, is ranked on this completed generation and stores a verified signature; computes the same cause as the preflight (`sameGenerationPriority`); does nothing unless the cause is ordering drift; waits up to 5 minutes (checking every 15 s) while a start (`phase: claim`) or a gated commit (a live `submitGate`) holds the runner lease. Then **every rebuild attempt** (the first and each retry after a lost compare-and-swap, at most the queue writers' usual five) reads the queue head, the profile and the programme afresh and decides the admission again on that snapshot (advance gate, same completed generation, verified signature, ordering drift): a drift another writer already repaired ends the tick as `current`, a moved generation or basis as `skipped`. It builds the candidate with the ordinary queue builder (trigger `ordering_reconcile`) from those inputs and refuses to write a candidate that is not again a current, verified ranking of the same generation (`candidate_unverified` when the signature read failed during the build, `candidate_basis_changed`, `candidate_not_current`); it checks the lease again and writes against the head it admitted, with the domain-generation compare-and-swap of every queue writer. A research-phase run (lease live, no gate) does not block it: its submits settle through the guarded settlement on whatever queue is stored, as they already do across EPG rebuilds. At most one rebuild per tick; one sanitized log line `prediction_ordering_reconcile` with `outcome` (`rebuilt`, `current`, `skipped`, `failed`), a `reason` or `cause` code, `attempts` after a retry, and `ms`. A refused candidate is never published and never logged as `rebuilt`.
4. **The guarantee.** A drift is rebuilt by the first hourly tick that finds no start or commit in flight; if the writer cannot run (a failed tick, a lease never free), the start itself rebuilds once the queue is older than 90 minutes. The ranking is therefore never more than about 90 minutes behind its own generation's assignments, against "the next start" before.

## Alternatives considered

- **Keep the rebuild in the start** (status quo): rejected by the owner GO; it is the largest avoidable part of the start's latency.
- **A deferred start (ADR 0193)**: removes the long call but keeps the client's readback polling, which the RCA shows the client also abandons; out of scope (option B of the RCA).
- **A new cron trigger or the Discovery fast cron** (`1-59/2`): a new trigger changes the live schedule and the fast cron is Discovery-only by [ADR 0174](0174-discovery-only-fast-recovery-cron.md); the hourly tick plus the 90-minute bound gives the guarantee without either.
- **A re-rank-only writer** (no new films): would leave newly admitted films out of the queue until a new generation; rejected for a full rebuild through the ordinary refresh.

## Consequences

- A Task start no longer pays the rebuild for ordering drift (offline on the built bundle: D1 calls of an S7 start with drift 203 → 131 with A1, see [evidence](../evidence/prediction/air-588-start-latency-offline-2026-11-24.md)).
- Hot/cold order may lag Discovery assignments of the same generation by up to one hourly tick (bounded by 90 minutes), where it lagged by at most one start before. Films that became hot inside that window may sit behind cold picks; nothing is lost or skipped.
- The hourly tick does one extra queue read per hour and, when drift is due, one rebuild off the Task's path.
- A start whose preflight straddles the writer's write keeps the AIR-542 outcome (a proven re-rank continues, anything else is `queue_changed`); the writer's lease check before the write makes that overlap rare.

## Recovery and migration boundary

Code only: no schema, marker, flag, Task or schedule change. Rollback is a revert and deploy; the queue documents written by the writer are ordinary queue documents. The writer starts acting on the first hourly tick after deploy, writing only through the ordinary queue refresh; no other production operation is authorized by this ADR.

## Evidence

- **Original decision:** [AIR-588 owner GO](https://trello.com/c/vyxbU1l0#comment-6b04c96acb544ab06006a57d), 24 Nov 2026.
- **Implementation:** the AIR-588 implementation pull request (see the card).
- **Dated verification:** offline only: `tests/prediction-air-588-ordering.mjs` (including the review regressions: a signature failure during the build, a drift repaired or a generation moved while waiting, a compare-and-swap retry on a changed head), `tests/prediction-hot-reconcile-same-generation.mjs` and the [offline measurement](../evidence/prediction/air-588-start-latency-offline-2026-11-24.md). Production behaviour is proven only by natural runs after deploy.
- **Uncertainty:** whether a faster start restores the client's delivery is not established ([RCA](../evidence/prediction/air-588-predictions-stop-rca-2026-11-23.md)).

## Follow-ups

Post-deploy verification of AIR-588 (natural submits and durable commits; the writer's log lines).
