# Scheduled Task Drift: registry-only scope activation

**Captured:** 2026-11-07 (Europe/Madrid). **Source:** owner-approved chat decision on 2026-11-07, live `Automations.peek` and `Automations.update` readback. **Scope:** an existing read-only ChatGPT automation's prompt only. No new automation, producer changes, schedule changes, Cloudflare calls, GitHub production mutations or manual Task execution.

## Decision and reason

The active Cloudflare-native production monitor independently watches actual EPG, Discovery, Ratings and Predictions progress and delivers Telegram alerts with an external dead-man heartbeat. The former `IPTV Scheduled Task Drift` prompt duplicated stream health checks and the Cloudflare Ratings status audit. It is narrowed to a distinct responsibility: audit configuration and recorded executions of the **two remaining active ChatGPT Tasks** in their live registry. Stream health and queue progress are explicitly excluded.

## Live registry before and after

| Field | Observed value after update |
| --- | --- |
| Existing Task | `IPTV Scheduled Task Drift` |
| Task ID | `6ade65245de481919b816c5f5026c121` |
| Enabled | `true` (unchanged) |
| Recurrence | `DTSTART;TZID=Europe/Madrid:20261031T181500`, `FREQ=DAILY;BYHOUR=18;BYMINUTE=15` (unchanged) |
| Timezone | `Europe/Madrid` (unchanged) |
| Prompt update | `Automations.update` returned `success=true`; subsequent `Automations.peek` returned the new 3,370-character prompt |
| Production streams | No MCP, Worker or Cloudflare read in the updated prompt |

The prompt names only the stable Task IDs `Automation_5d50308ce72c8191a50242fa604836b2` (Daily EPG) and `Automation_25293680bdb08191818ee2db30438f49` (Hourly Predictions). The retired Ratings Task is no longer audited. The prompt checks enabled state, recurrence/timezone, prompt safety boundaries and last recorded execution using `Automations.peek`. It reads the scheduled-task contract on GitHub `main` only to compare expected semantics. It must not infer actual EPG publication or prediction progress from a registry entry, and explicitly rejects false positives from `no_update` or `next_run_time=null`.

## Acceptance, uncertainty and rollback

**Verified:** existing automation saved the prompt and remained enabled without schedule/timezone modification. There is no claim that the first naturally scheduled execution of the new prompt has occurred or that it produced a correct notification. No manual `run_now` was requested or performed. No change was made to either active producer Task.

**Rollback:** a separate owner-approved update to the *same existing automation's prompt*, followed by readback; reverting the GitHub docs alone cannot change the live automation. Do not recreate or duplicate the Task. A re-expansion of scope would duplicate the independent Worker monitor and needs a fresh owner decision.

**Used by:** maintained [Scheduled Task contract](../../reference/scheduled-tasks.md#read-only-drift-monitor), [operations runbook](../../runbooks/scheduled-task-drift.md), and [scheduling diagram](../../architecture/scheduling-and-orchestration.md). **Uncertainty:** ChatGPT task scheduling reliability, future execution outcomes and notification delivery were not tested at activation.
