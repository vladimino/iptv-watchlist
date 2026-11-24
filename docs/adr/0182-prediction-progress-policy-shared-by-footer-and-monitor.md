# ADR 0182: One confirmed-progress policy for Predictions, shared by the Footer and the Cloudflare Monitor, alerts within about two hours

**Status:** Accepted  
**Original decision date:** 2026-11-20 (owner goal on [AIR-556](https://trello.com/c/ZjqzW7EB))  
**Recorded at:** 2026-11-20  
**Approval source:** [AIR-556, explicit Product Owner approval of ADR 0182, its 60-minute threshold, single-snapshot Monitor alert, Footer wording and expected per-film failure behavior, 20 November 2026 (Europe/Madrid)](https://trello.com/c/ZjqzW7EB)  
**Related work:** [AIR-556](https://trello.com/c/ZjqzW7EB); [AIR-349](https://trello.com/c/VUyampoh); [AIR-389](https://trello.com/c/DKDuJnkk); [AIR-548](https://trello.com/c/lv04pDu2); [ADR 0095](0095-cloudflare-native-production-monitor.md)  
**Supersedes:** None. It **amends** [ADR 0095](0095-cloudflare-native-production-monitor.md) decisions 4 and 5 for the `predictions` stream only (the 3-hour delayed and 6-hour degraded limits, and two-snapshot confirmation for that one issue key). ADR 0095 stays Accepted for every other stream.  
**Superseded by:** In part [ADR 0210](0210-prediction-no-progress-verdict-survives-live-runs.md) (**Proposed**, [AIR-596](https://trello.com/c/t9Tx7Yy0)): decision 5 (a live run before any verdict) and the moved processed counter of decision 3; the other decisions stay in force

## Context

Four external ChatGPT Scheduled Tasks run Predictions (nominally :00/:15/:30/:45 Europe/Madrid, about +-7 minutes of scheduler drift). The Worker does not own their registry and sees a Task only when its request reaches the Worker. On 20 November 2026 the Footer showed «работает · успех 04:54» at 09:46 while about 3740 films were eligible and no batch had run for 4 h 52 min. Two causes were confirmed in `main`:

- The Footer treated a past success as healthy for 6 hours (`PREDICTION_PROGRESS_STALE_MS`), and the Monitor degraded at 6 hours and needed two hourly snapshots, so a real alert could arrive after 8 hours.
- `monitor.js::predictionFacts` stamped `now` as the last progress when it had no evidence (a lost or fresh monitor document), which made silence look fresh, and it computed eligible work with its own formula (hot and cold lanes united, a hard-coded retry budget) instead of the batch runner's lane rule.

## Decision

1. **One threshold, one predicate.** `PREDICTION_NO_PROGRESS_MS = 60 minutes` and `predictionStallAssessment` live in `src/enrichment.js`. The Footer (`predictionCapabilityHealth`) and the Monitor (`predictionFacts` through `predictionProgressFacts`) both use them; the pure Monitor policy holds no prediction threshold and receives the verdict in `facts.stall`.
2. **Why 60 minutes.** Two consecutive Task starts are at most about 29 minutes apart (15 minutes plus 2 x 7 minutes of drift), so a healthy hour contains several chances for a productive batch. An hour with eligible work and none is four missed slots, which is abnormal, while the limit stays above ordinary batch duration and a single already-running skip.
3. **What is progress.** A productive batch (films created or recalculated), a drained run whose completion proved there was no ready film (`queue_empty` or `eligible_queue_empty` only), or a moved processed counter. `manifest_spent` (the selected manifest was settled, possibly only with `already_current`), `retry_backoff`, a heartbeat, `already_running`, a noop wake-up, a failed-only run, a queue recount and a lost monitor document are not progress. A run seen both as a diagnostic checkpoint and as `latest-run.json` is merged by run id (larger counts win), so recalculations missing from an older checkpoint are not lost; checkpoints now persist `updated`. An unknown time is `unknown`, never "now": with no evidence at all the clock starts at the first tick that **observed eligible work** (`unknownSince`, persisted) and is reset by any tick with no eligible work or an unreadable split, so work that becomes eligible is measured from the tick that first saw it. A stored `progressAt` is trusted only when it was written from evidence (`progressBasis: evidence`).
4. **What counts as eligible work.** `eligibleNow` of `predictionQueueSlices` (the batch runner's lane rule and retry budget). `eligibleNow = 0` (drained, all deferred, or only retry-exhausted work) is never a stall. A queue whose eligible and deferred parts cannot be read is `delayed` in the Monitor (visible, no alert) and never healthy.
5. **Live run.** A run whose lease is live counts as running for at most 60 minutes **from a provable start** (its own run record, else its diagnostic checkpoint). A lease whose run record is missing, unreadable or belongs to another run has no provable start and is never treated as running; an older lease is not evidence of progress either.
6. **Alerting.** One issue key `predictions_no_progress` (replacing `predictions_stale` and `predictions_backlog_growing`), confirmed by **one** snapshot because the verdict comes from stored run times, not from a transient read. All other degraded issues keep two snapshots. With the hourly Cron tick the alert follows the last confirmed progress by 60 minutes at best and about 120 minutes at worst (the limit is crossed just after a tick), plus Cron start jitter and Telegram latency. Cooldown, daily cap, one recovery message and the outbox are unchanged, so four Task slots never produce four alerts.
7. **Footer wording.** Eligible work and no confirmed progress shows «нет подтверждённого прогресса прогнозов» as attention (not failure) and the last success time as history. Neither surface claims `api_error`, an expired MCP authorization or a number of missed Tasks, because a request that never reached the Worker leaves no record here.
8. **Item failures are not pipeline health.** A completed batch with some failed films (parse, validation, retry) is an expected outcome. The former `prediction_partial` degradation is removed: the failures stay in `lastRun.failed` and the item diagnostics, and the Footer aggregate does not change for them. A mixed batch (some saved, some failed) is progress; a failed-only batch is neither progress nor an outage by its failure count, so the 60-minute rule decides (with no progress anywhere in the history, the oldest recorded attempt bounds how long there has been none, and a history younger than 60 minutes is `unknown`). Hard stops (`api_error`, `quota`, `model_unavailable`, `storage_error`, `format_error_storm`) and repeated interruptions keep their degradation (`prediction_blocked`, `prediction_runs_interrupted`). The Monitor already ignored item failures, so both surfaces agree.

Not decided and not changed: Task schedules, MCP/OAuth/Access, feature flags, `MONITOR` secrets, publishing Task-side errors to Events, any production write.

## Alternatives considered

- Keep two snapshots and a 30-minute limit: rejected because it fires on a single slow batch or a skipped slot and still alerts only after about 90 to 150 minutes.
- Keep two snapshots and a 60-minute limit: rejected because the worst case becomes about 180 minutes, above the owner's roughly two-hour goal.
- Re-read the Task registry to learn the real schedule: not possible, the Worker does not own it (ADR 0095).

## Consequences

- The incident above would have alerted at the 06:00 tick (66 minutes after 04:54) and the Footer would have left «работает» at 05:55.
- Retry-exhausted work alone no longer raises a stall alert; it stays visible through the Footer counters and the Admin recovery surfaces.
- The Monitor reads up to 20 run-diagnostic objects and one lease object per hourly tick (bounded, read-only, no GET writes).
- A failed Cron or Telegram delivery has no absolute SLA; the outbox retries on the next tick.

## Recovery and migration boundary

Code only; no data migration. Rollback is a reviewed revert and the standard deploy. `monitor/state.json` is not cleaned automatically, old Telegram messages are not recalled, and a stored `progressAt` written by the previous build is ignored until the next tick rewrites it from evidence.

## Evidence

- **Original decision:** [AIR-556](https://trello.com/c/ZjqzW7EB)
- **Implementation:** the AIR-556 pull request
- **Dated verification:** deterministic fake-clock tests `tests/monitor-policy.mjs`, `tests/monitor-runtime.mjs`, `tests/prediction-footer-health.mjs`; production readback is recorded on the card
- **Uncertainty:** the real causes of missing Task starts (for example an expired MCP authorization) are not observable in the Worker

## Follow-ups

Publishing Task-side `api_error` as an Event needs its own owner decision and card.
