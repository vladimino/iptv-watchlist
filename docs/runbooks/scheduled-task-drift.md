# Daily Scheduled Task drift: read-only audit and owner triage

> Operator runbook. Monitoring and this document authorize no production writes or task changes.

## Scope and live contract

The owner-approved existing `IPTV Scheduled Task Drift` automation (`6ade65245de481919b816c5f5026c121`) runs daily at **17:45 Europe/Madrid** as of 30 October 2026 (previously Monday 09:00). Its live schedule has `RRULE:FREQ=DAILY;BYHOUR=17;BYMINUTE=45`, `DTSTART;TZID=Europe/Madrid:20261030T174500`, `default_timezone=Europe/Madrid` and was read back `is_enabled=true`. The maintained contract is [Scheduled Tasks](../reference/scheduled-tasks.md#owner-approved-daily-read-only-drift-audit). The audit is a third automation but only observes the two production tasks; it is not an EPG or prediction scheduler.

## Read-only checks

1. Read the **live** Automation records for EPG `Automation_5d50308ce72c8191a50242fa604836b2` and predictions `Automation_25293680bdb08191818ee2db30438f49`, including `is_enabled`, iCalendar recurrence, `default_timezone`, `run_details.last_run` and `latest_result`. Fetch the current `docs/reference/scheduled-tasks.md` from GitHub `main` and compare substantive prompt/tool/permission/stop rules. Do not use a cached conversation summary.
2. Use only the connected owner-only read-only IPTV MCP `epg_status` to verify today's **published** EPG stage, `updatedAt` and `runId`. Distinguish core EPG publication from `ratingAttempt`/Diary outcome and the independent discovery continuation. When `stage=complete`, a stale ratings result is not evidence that EPG publication failed. Some HTTP GET routes mutate storage; do not use them as an alternate probe.
3. Correlate local Madrid date and scheduled nominal 17:00 trigger with the latest task run and EPG. An enabled task with `next_run_time:null` or a lagging `last_run_time` is not by itself evidence of a missed run; use `run_details.last_run` and the Worker published timestamp. The external scheduler may execute late; do not invent a success SLA.
4. Notify the owner **only** on a disabled production task, failed execution, material prompt/schedule drift, unavailable live evidence, or missing today's EPG after the run window. Include the exact observed IDs, stage, timestamps (Europe/Madrid and UTC where needed), gaps and recommended manual check. On normal readings, remain silent.

## If the audit flags an incident

Read the two Task records and current EPG status again. If a task is disabled, describe the observed state and ask the owner whether to enable it. If EPG is missing, distinguish no task run, incomplete sync and worker publication failure. Check Workers Observability Events read-only if separately authorized; `Worker exceeded memory limit` and an EPG published `complete` can coexist when a later ratings stage dies. See [AIR-292](https://trello.com/c/CTxq4Khy) and the independent Diary rollout [AIR-288](https://trello.com/c/bpXgN1nV). Do not automatically `run_now`, re-enable, reset a lease, repeat an EPG or change production flags/R2/D1.

## Limits and recovery

The monitoring task itself runs on the same ChatGPT automation platform and can silently pause or fail. Its absence of notifications does not prove health. An owner may inspect the live task state directly if its expected daily signal is missing; any restart or configuration change needs explicit permission. A separate operational fix to the platform defect is outside the repository. The only rollback of this documentation is a docs revert; changing the live monitor back to weekly requires a **new** owner decision.

Historical readback and authorization: [dated evidence](../evidence/scheduled-task-drift-daily-2026-10-30.md).