# Scheduled Task registry drift: read-only triage

The `IPTV Scheduled Task Drift` automation is a registry-only check. It runs daily at 18:15 Europe/Madrid and examines the one ChatGPT Scheduled Task that still produces anything, the hourly Predictions Task (`Automation_25293680bdb08191818ee2db30438f49`), not the health of its production stream. Since the Cloudflare EPG cutover ([AIR-348](https://trello.com/c/PUrlzMuH)), the Discovery Workflow and the Ratings Workflow, no other ChatGPT Task is a producer; the retired Daily EPG and Ratings Tasks are disabled by design. Its [expected configuration and stable IDs](../reference/scheduled-tasks.md#read-only-drift-monitor) are maintained in the Scheduled Task contract; the **live registry** is the source of actual settings and execution records.

The independent Cloudflare-native monitor watches EPG, Discovery, Ratings and Predictions progress and sends operational alerts. See the [production monitor runbook](monitoring.md). Do not diagnose EPG freshness, prediction backlog or Ratings Workflow progress from a registry drift notification.

## When the drift monitor reports an anomaly

1. Read `Automations.peek` for the reported Task by its exact stable ID (normally the hourly Predictions Task). Compare `is_enabled`, `timing_mode`, `schedule` (including IANA timezone), `default_timezone` and the relevant prompt permission boundaries with the [maintained contract](../reference/scheduled-tasks.md). A semantic disagreement may mean the **documentation** is stale, not the live Task.
2. Inspect `run_details.last_run`: `recorded_status`, `scheduled_for`, `started_at`, `completed_at` and the saved result if present. `last_run_time` and `next_run_time` are not reliable proof of execution. A `no_update` result, scheduler delay or isolated missing saved result is not automatically a failure.
3. Report a confirmed disabled Task, incorrect recurrence/timezone, unsafe prompt permissions, explicit failed run, repeated evidenced failure or unavailable registry. Include the exact field, expected/actual value, Task ID, Europe/Madrid time and the recommended safe investigation. For actual stream progress, use the separate Cloudflare monitor's incident procedure, not this audit.

The retired Daily EPG Task and the retired Ratings Task are disabled on purpose and are **not** checked by the registry-only drift automation: finding them disabled is the expected state, and the Worker refuses their write paths (`external_writer_fenced`). The Cloudflare EPG, Discovery and Ratings Workflows are observed by the Worker monitor.

The 14 disabled Tasks are listed with a decision for each (all retirement candidates, none approved for deletion) in the [registry inventory](../evidence/orchestration/scheduled-task-registry-inventory-2026-11-10.md).

The proposed prompt for the single-Task scope is [drift-hourly-only](../reference/scheduled-task-prompts/drift-hourly-only.md). The live prompt changes only by the owner-approved in-place update of the same Task, followed by a registry readback; this runbook and that file never change the live registry.

## Safety and operations

Only read the hourly Predictions Task using `Automations.peek` and compare it with GitHub `main` documentation. Never call IPTV MCP, Worker status, production APIs, or write-capable GET from this automation. Never start, retry, enable, disable, create, modify or reschedule any Task, nor start or repair EPG, Discovery, Predictions, Ratings, Cloudflare, Access, R2 or D1. Any Scheduled Task change or out-of-plan production operation needs a separate owner authorization under the [authorization policy](../process/authorization-and-escalation.md).

This monitor shares the same ChatGPT scheduler as the hourly Predictions Task. It may itself run late, fail or be disabled silently. No notification does not prove healthy execution or availability. The live registry, not the saved documentation or a prior chat, defines the actual Task state.

If the owner authorizes rollback of the **monitor's prompt alone**, restore the prior prompt in the existing Task and record a new live readback. Do not infer permission to re-enable the retired Daily EPG or Ratings Tasks, to create a replacement Scheduled Task or to change the hourly Predictions producer. Reverting these documentation files does not change the live Scheduled Task.
