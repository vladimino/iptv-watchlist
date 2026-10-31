# Scheduled Task drift monitor: triage and owner gates

> Operator runbook. The monitor and this page authorize no production write and no task change. Enabling, disabling, editing or running any Scheduled Task, and any EPG, discovery, ratings or prediction writer call, needs a separate action-specific owner approval.

The expected configuration and checks of the `IPTV Scheduled Task Drift` automation are in the [Scheduled Task contract](../reference/scheduled-tasks.md#read-only-drift-monitor): daily at 18:15 Europe/Madrid, DTSTART 2026-10-31, read-only. It reads the daily programme task, the hourly task and the Ratings Task, plus `epg_status` and read-only `ratings_sync_status`, and reports only anomalies. The live ChatGPT Scheduled Tasks registry, not this page, says what is configured now. This page does not edit the task.

## Reading a notification

Re-read the live evidence before acting; a notification is the monitor's observation at its run time, and the state can have changed since.

1. **Registry.** Read the live entries of the daily EPG task, the hourly task and the Ratings Task: `is_enabled`, recurrence (`DTSTART;TZID=…` and `RRULE`), `default_timezone`, the prompt and `run_details.last_run`. Compare them with the [contract on `main`](../reference/scheduled-tasks.md), not with a conversation summary or an older evidence report.
2. **Worker.** Read `epg_status` and `ratings_sync_status` through the connected owner-only IPTV MCP. Both are read tools. `epg_status` returns `stage`, `runId`, `updatedAt`, `ratingsPending`, `ratingAttempt` and `ratingError`. `ratings_sync_status` returns the ratings pipeline and writes nothing, including no recovery. Do not use an HTTP route as a substitute probe: some GET routes write ([side-effect tests](../../tests/get-side-effects.mjs)). Do not call `ratings_sync_start` or `ratings_sync_step`.
3. **Day.** Work in Europe/Madrid civil time. The daily EPG task triggers nominally at 17:00 and the scheduler can run late, so a missing publication is an anomaly only after the run window, and there is no success SLA.

## Distinguishing real anomalies from false positives

| Observation | Meaning |
| --- | --- |
| A production task has `is_enabled=false` | Real anomaly. Report it; do not re-enable it. The owner decides, and the cause (owner, platform or another actor) is not visible from the registry alone. |
| The latest run of a task failed | Real anomaly. Correlate the run time with `epg_status.runId` and `updatedAt` before concluding which stage failed. |
| `epg_status.stage` is not `complete` for today after the run window | EPG not published today. Distinguish no task run, an interrupted commit (`stage` still `epg`) and a Worker failure before suggesting anything. |
| `stage` is `complete`, but `ratingAttempt` ended `error` or `unknown`, or `ratingError` is set | A ratings or Diary problem on a published programme, not an EPG failure. A Worker memory-limit kill in the ratings stage and a published `complete` can coexist. See [Diary history](letterboxd-diary-history.md). |
| An enabled task shows `next_run_time: null` or a lagging `last_run_time` | Not by itself a missed run. Use `run_details.last_run` and the Worker's `updatedAt`. |
| The Ratings Task is disabled, or its latest run failed | Anomaly. Report it. Do not enable the task, clear an isolation or start a ratings run. |
| The prompt or recurrence differs from the contract | Drift. Report the exact difference; the registry may be right and the contract stale, or the reverse. Either way an owner decision is needed. |

## What the operator may and may not do

- **May:** re-read the registry entries and `epg_status`, and read Workers Observability events when that read is separately authorized.
- **May not without a separate owner approval:** `run_now`, enable or disable a task, edit a prompt or schedule, call `epg_sync_start` or `epg_sync_step`, reset a lease, start predictions or ratings, or change flags, Access, R2 or D1.

Report to the owner the task identity, observed fields, `runId`, `stage`, `updatedAt` and times in Europe/Madrid (UTC where logs need it), what could not be verified, and the recommended manual check.

## Limits of the monitor

The monitor runs on the same automation platform as the tasks it watches. It can be late, fail or be disabled without notice, so a quiet day does not prove health. If its expected run is missing, the owner can inspect its registry entry directly; restarting or reconfiguring it is a task change and needs approval. Reverting this documentation does not change any live schedule.

The Ratings Task is enabled (live read-only check on 2026-10-31). This monitor's expected scope, after the owner-approved registry change the same day, includes that task and read-only `ratings_sync_status`. A disabled or failed Ratings Task is an anomaly. Reading the status does not authorize a ratings start, a step, or clearing an isolation.
