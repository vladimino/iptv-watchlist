# Scheduled Task drift monitor: triage and owner gates

> Operator runbook. The monitor and this page authorize no production write and no task change. Enabling, disabling, editing or running any Scheduled Task, and any EPG, discovery, ratings or prediction writer call, needs a separate action-specific owner approval.

The expected configuration and checks of the `IPTV Scheduled Task Drift` automation are in the [Scheduled Task contract](../reference/scheduled-tasks.md#read-only-drift-monitor): daily at 17:45 Europe/Madrid, read-only, reporting only anomalies of the daily programme update and the hourly predictions tasks. The live ChatGPT Scheduled Tasks registry, not this page, says what is configured now.

## Recovery cost and alert triage

A delayed Task, stale footer, or one transient failure is not an outage requiring a full EPG replay, immediate schedule edit or multi-tool forensic audit. First compare the task's last run with the single relevant Worker status; if the ordinary next scheduled execution can replay the missing work without harmful side effects, record the delay and observe that next execution. Escalate when the source repeatedly fails, the EPG publication is genuinely stale past the accepted window, or pending work cannot make progress. This is an operations triage rule, **not** permission to invoke a Task, skip its required validation, or change its schedule. [Risk-proportional policy](../process/agent-workflow.md#risk-proportional-operational-safeguards).

## Reading a notification

Re-read the live evidence before acting; a notification is the monitor's observation at its run time, and the state can have changed since.

1. **Registry.** Read the live entries of the two production tasks: `is_enabled`, recurrence (`DTSTART;TZID=…` and `RRULE`), `default_timezone`, the prompt and `run_details.last_run`. Compare them with the [contract on `main`](../reference/scheduled-tasks.md), not with a conversation summary or an older evidence report.
2. **Worker.** Read `epg_status` through the connected owner-only IPTV MCP. It is a read tool and returns `stage`, `runId`, `updatedAt`, `ratingsPending`, `ratingAttempt` and `ratingError`. Do not use an HTTP route as a substitute probe: some GET routes write ([side-effect tests](../../tests/get-side-effects.mjs)).
3. **Day.** Work in Europe/Madrid civil time. The daily EPG task triggers nominally at 17:00 and the scheduler can run late, so a missing publication is an anomaly only after the run window, and there is no success SLA.

## Distinguishing real anomalies from false positives

| Observation | Meaning |
| --- | --- |
| A production task has `is_enabled=false` | Real anomaly. Report it; do not re-enable it. The owner decides, and the cause (owner, platform or another actor) is not visible from the registry alone. |
| The latest run of a task failed | Real anomaly. Correlate the run time with `epg_status.runId` and `updatedAt` before concluding which stage failed. |
| `epg_status.stage` is not `complete` for today after the run window | EPG not published today. Distinguish no task run, an interrupted commit (`stage` still `epg`) and a Worker failure before suggesting anything. |
| `stage` is `complete`, but `ratingAttempt` ended `error` or `unknown`, or `ratingError` is set | A ratings or Diary problem on a published programme, not an EPG failure. A Worker memory-limit kill in the ratings stage and a published `complete` can coexist. See [Diary history](letterboxd-diary-history.md). |
| An enabled task shows `next_run_time: null` or a lagging `last_run_time` | Not by itself a missed run. Use `run_details.last_run` and the Worker's `updatedAt`. |
| The staged Ratings Task is disabled | Expected. The monitor does not watch it. |
| The prompt or recurrence differs from the contract | Drift. Report the exact difference; the registry may be right and the contract stale, or the reverse. Either way an owner decision is needed. |

## What the operator may and may not do

- **May:** re-read the registry entries and `epg_status`, and read Workers Observability events when that read is separately authorized.
- **May not without a separate owner approval:** `run_now`, enable or disable a task, edit a prompt or schedule, call `epg_sync_start` or `epg_sync_step`, reset a lease, start predictions or ratings, or change flags, Access, R2 or D1.

Report to the owner the task identity, observed fields, `runId`, `stage`, `updatedAt` and times in Europe/Madrid (UTC where logs need it), what could not be verified, and the recommended manual check.

## Limits of the monitor

The monitor runs on the same automation platform as the tasks it watches. It can be late, fail or be disabled without notice, so a quiet day does not prove health. If its expected run is missing, the owner can inspect its registry entry directly; restarting or reconfiguring it is a task change and needs approval. Reverting this documentation does not change any live schedule.

When the staged Ratings Task is activated, the monitor's scope changes too: a third producer task and a ratings freshness check separate from EPG publication. That needs its own owner decision and an update of the [contract](../reference/scheduled-tasks.md#staged-ratings-task-disabled) and this page.
