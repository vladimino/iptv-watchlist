# ADR 0210: A proven prediction no-progress verdict is not hidden by a live run, and its clock is the last durable commit

**Status:** Proposed  
**Original decision date:** 2026-11-24 (scope set by the Product Owner on [AIR-596](https://trello.com/c/t9Tx7Yy0))  
**Recorded at:** 2026-11-24  
**Approval source:** not yet decided. The card scope requires an explicit, ADR-specific Product Owner decision before merge; the card itself is not that decision.  
**Related work:** [AIR-596](https://trello.com/c/t9Tx7Yy0); incident [AIR-588](https://trello.com/c/vyxbU1l0) and its [health RCA comment](https://trello.com/c/vyxbU1l0#comment-6b0560f01036576bc55fcc50); [AIR-556](https://trello.com/c/ZjqzW7EB) ([ADR 0182](0182-prediction-progress-policy-shared-by-footer-and-monitor.md)); [AIR-573](https://trello.com/c/4pD66DLd) ([ADR 0193](0193-deferred-batch-start-with-server-issued-key.md) decision 9); parallel monitor work [AIR-592](https://trello.com/c/c0d7VD4P) (not touched)  
**Supersedes:** In part [ADR 0182](0182-prediction-progress-policy-shared-by-footer-and-monitor.md): decision 5 (a live run counts as running before any verdict) and, in decision 3, the moved processed counter as a progress time. Extends [ADR 0193](0193-deferred-batch-start-with-server-issued-key.md) decision 9 (the orphan-start reason) with its priority over a live lease. Every other decision of both ADRs stays in force.  
**Superseded by:** None

## Context

On 23 and 24 November 2026 the four Prediction Tasks kept reaching the Worker every 15 minutes, each `batch_start` answered and took a 12-minute lease, and no run ever submitted or completed (AIR-588). The last productive batch ended 23 Nov 21:28:21.539 Madrid (5 created, 2 recalculated). With 3171 hot and 3798 cold films outstanding, the Footer said «выполняется» at 10:50 Madrid and the Monitor sent `predictions_no_progress` only at the ticks that happened to fall between two runs (23:00, 08:00–10:00 Madrid), nothing from 00:00 to 07:00.

Confirmed in `main` at `79a36c5`:

- `predictionStallAssessment` returned `running` for a live lease with a provable start younger than 60 minutes **before** it looked at the progress clock or the orphan chain, and `predictionCapabilityHealth` (Footer) returned `running` for a live young run before reading any evidence. Every new ownerless run is younger than 60 minutes, so a series of them hid the outage at every tick that met a live lease.
- The progress time came only from the bounded run history (the Footer reads 8 diagnostics, the Monitor 20) and `latest-run.json`. At four starts per hour the last success leaves the Footer's history after about 2 hours and the Monitor's after about 5.
- The Monitor's stored `progressAt` was 23 Nov 22:00:23.490 Madrid, not 21:28:21.539: a moved `metrics.hotProcessedTotal` between two ticks was stamped with the tick time (`now`), although it only says a run completed since the previous tick.
- A tick that cannot read the verdict (an absent or malformed queue, an unknown split) removed the open issue, which the alert planner treats as a recovery.

Verified sources of the last productive commit (code reading of `main`): `queue.lastBatch` is written only by a run's completion, inside the same conditional queue write that settles its films (`enrichmentComplete`, `batch_complete`), or by an empty start check (`runId: null`); every queue rebuild carries it unchanged (`previous?.lastBatch`), so a recount, a reindex or an import does not change it. An abandoned run (lease expired, no `complete`) does not touch it. `metrics.hotProcessedTotal` moves in the same completion write, once per run, by the hot films it created or recalculated.

## Decision

1. **Proven verdict first.** In the one shared assessment (`predictionStallAssessment`, used by the Footer and the Monitor) the two existing verdicts are decided before the live run: the 60-minute rule (ADR 0182 decision 2) and repeated orphan starts (ADR 0193 decision 9: at least three ownerless starts in two hours and at least 20 minutes without progress). A current lease, a start, a manifest read, a heartbeat, `already_running` and a new `runId` are not progress and cannot suppress either. A live run younger than 60 minutes is `running` only while nothing is proven: the last progress is younger than the limit and the orphan chain is short, or there is no progress evidence at all. The thresholds do not change.
2. **Health is separate from the run state, and unknown is never healthy.** The Footer's `predictions` integration shows the verdict (`degraded`, `prediction_no_recent_progress`, «нет подтверждённого прогресса прогнозов», with the last confirmed success as `lastSuccessAt`) while the run line still says «выполняется». A proven orphan chain uses the same code as the 60-minute verdict, as the Monitor already did; two interrupts below the proven threshold keep `prediction_runs_interrupted`. Eligible work is the runner's lane rule; it is zero only when proven (readable lanes with nothing ready, or an empty `pending` list). A split that cannot be read is unknown on both surfaces before any live-run or fresh-success fallback (ADR 0182 decision 4): the Footer shows `unknown` / `no_data` with the last success kept (a proven hard stop stays `prediction_blocked`), the Monitor `delayed` without an incident and the held issue of decision 4 with one.
3. **Durable progress clock.** The last confirmed progress is the latest of:
   - the run history and `latest-run.json` (as before, counts read from `counts`, `added`/`updated` or `results`). A completed run is dated by its completion; any other productive run (still working, interrupted, expired, partial) by its first committed film (`firstSubmitAt`), else by its start as a conservative lower bound, never by its end (for an expired run that is the lease expiry the history projection fills in). The progress fact with the latest valid time is chosen (not the first in run order); unparseable times and times more than 5 minutes in the future are ignored. The Monitor no longer accepts `latest-run.json` `completedAt` with positive counts on its own;
   - `queue.lastBatch` when it names a run that created or recalculated films (its own `finishedAt`), or a completion or empty-queue check that left nothing pending;
   - the Monitor's stored clock (`monitor/state.json` `predictions.progressAt` with `progressBasis: evidence`), which the Footer now also reads from the document it already loads.
   With no progress time at all, both surfaces measure from the Monitor's persisted `unknownSince` (the first tick that observed eligible work); the Footer falls back to its own oldest recorded attempt only when the Monitor has none, and only then can the two differ (different bounded histories).
   Nothing new is written by any writer of the prediction pipeline. A moved `hotProcessedTotal`, a queue recount, a reindex, an import, the end of an unproductive run and any read are not progress times. A stored clock is a past event time, so an old value can only make the verdict stricter.
4. **Open incident is held, recovery names its reason.** While `predictions_no_progress` is open (its alert entry exists), a tick that cannot read or decide the verdict keeps the issue open with a typed reason in `metrics.held` (`queue_unreadable`, `queue_absent`, `split_unknown`, `progress_unknown`, `progress_unconfirmed`) and the last measured metrics under their original `metricsAt` (the alert planner keeps an issue's own `metricsAt` when it supplies one; confirmation, reminders and caps are unchanged). It recovers only on a progress time newer than the incident's own baseline, or on proven zero eligible work. The baseline is the last progress time its last proven stalled observation measured (`metrics.lastProgressAt` of the open alert entry, unchanged through held ticks), never the stored clock, which a held tick may already have advanced past a genuine commit; an entry without a measurement (written before ADR 0206, or such an entry later held, which carries only the `held` reason) falls back to the previous tick's clock through any number of held ticks, which can only hold it longer; a measured stall whose progress time was unknown has no baseline, so any valid progress recovers it; the one recovery message names which: confirmed progress (with its time), no eligible work, or all remaining work waiting for its retry time (`recoveryReason`, a «Причина: …» line in the Telegram text).
5. **Alert text.** The alert and reminders keep the one key and state how long there has been no confirmed progress, the time of the last confirmed progress, the number of ownerless starts since it (bounded to the last two hours, and labelled so) when there are any, and that a run holding the lease is not progress (`metrics.activeRun`). A held reminder shows the held reason and the last measured stall under its own time, never the last counts as current. They never name a ChatGPT-side cause.

Not decided and not changed: the 60-minute and orphan thresholds, the hourly Cron, alert confirmation, cooldown, reminders, daily cap and outbox (ADR 0095, and their AIR-592 revision), the scheduler, the lease TTL, the batch protocol, Tasks, retries, the Events journal writers, any auto-recovery, any production write.

## Alternatives considered

- **Stamp a new durable field (`metrics.lastProductiveAt`) in the submit and completion writes.** It would also date productive runs that are abandoned before their completion without the history. Rejected for this card: it changes the prediction writers that AIR-588 is changing at the same time and adds a field to the batch commit path; the history (`firstSubmitAt`), `queue.lastBatch` and the stored Monitor clock already cover the incident without a writer change.
- **Read `max(prediction_pointer.updated_at)` in D1.** Rejected: it is a full scan without an index, and pointer rows are also rewritten by imports and migrations, which must not count as commits.
- **Keep the moved counter, dated by the previous tick.** Rejected: it adds no fact that the history (20 runs, about 5 hours) and `queue.lastBatch` do not already give with an exact time, and an import of an older queue could move it without a commit.

## Consequences

- With the AIR-588 series the Monitor alerts at the first tick 60 minutes after the last commit (or earlier on the orphan chain), whether or not a run holds the lease at that tick, then sends the ordinary reminders and no recovery until progress or a proven empty queue. Offline: `tests/prediction-no-progress-series.mjs` fails on `79a36c5` at the 22:00:23 UTC tick (`healthy`/`running`) and passes here.
- The Footer and the Monitor keep the last success after the history evicts it. If the Monitor is off and the queue's last batch is overwritten by an unproductive completion, the Footer falls back to the history as before.
- A young run that starts while the last progress is older than 60 minutes is now `degraded` (with the run line «выполняется»), not `running`. A genuinely productive run is dated by its first commit, so a working run that has committed is not degraded.
- A transient unreadable tick no longer sends a recovery and a new alert; the reminder cadence is unchanged.
- A queue whose lanes cannot be read is no longer shown healthy by the Footer: it is `unknown` («нет данных», attention), with the last success kept.

## Recovery and migration boundary

Code only; no data migration, no new persisted field, no flag. Rollback is a reviewed revert and the standard deploy. The stored `progressAt` written by the previous build (stamped by a moved counter at most one tick late) is carried as it is and replaced by the next evidence; the alert history (`firstSeenAt`, `sendCount`, `lastSentAt`) is kept. A rolled-back build reads the same documents and may again hide the verdict behind a live run, as before.

## Evidence

- **Original decision:** [AIR-596](https://trello.com/c/t9Tx7Yy0)
- **Implementation:** the AIR-596 pull request
- **Dated verification:** offline, deterministic: `tests/prediction-no-progress-series.mjs` (13 hours of 15-minute starts with a 12-minute lease and zero commits through the real Footer route and `Monitor.run`; recovery reasons; rollout over the persisted state of 24 Nov 11:00 Madrid; real batch start, submit and complete over the D1 stand-in with the auxiliary state in D1), with the updated `tests/prediction-orphan-start-signal.mjs`, `tests/monitor-runtime.mjs`, `tests/prediction-footer-health.mjs`. Production readback is recorded on the card after deploy.
- **Uncertainty:** why the Tasks abandon their runs is not observable in the Worker (AIR-588). A productive run abandoned before completion and evicted from the history before any Monitor tick saw it would not be remembered; at four starts per hour the Monitor's 20-run history spans about five hourly ticks.

## Follow-ups

None required by this ADR.
