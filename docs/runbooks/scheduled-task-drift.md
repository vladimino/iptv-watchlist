# Scheduled Task registry drift: read-only triage

The `IPTV Scheduled Task Drift` automation is a registry-only check. It runs daily at 18:15 Europe/Madrid and examines the two active ChatGPT Scheduled Tasks, not the health of their production streams. Its [expected configuration and stable IDs](../reference/scheduled-tasks.md#read-only-drift-monitor) are maintained in the Scheduled Task contract; the **live registry** is the source of actual settings and execution records.

The independent Cloudflare-native monitor watches EPG, Discovery, Ratings and Predictions progress and sends operational alerts. See the [production monitor runbook](monitoring.md). Do not diagnose EPG freshness, prediction backlog or Ratings Workflow progress from a registry drift notification.

## When the drift monitor reports an anomaly

1. Read `Automations.peek` for the reported Daily EPG or Hourly Predictions Task by its exact stable ID. Compare `is_enabled`, `timing_mode`, `schedule` (including IANA timezone), `default_timezone` and the relevant prompt permission boundaries with the [maintained contract](../reference/scheduled-tasks.md). A semantic disagreement may mean the **documentation** is stale, not the live Task.
2. Inspect `run_details.last_run`: `recorded_status`, `scheduled_for`, `started_at`, `completed_at` and the saved result if present. `last_run_time` and `next_run_time` are not reliable proof of execution. A `no_update` result, scheduler delay or isolated missing saved result is not automatically a failure.
3. Report a confirmed disabled Task, incorrect recurrence/timezone, unsafe prompt permissions, explicit failed run, repeated evidenced failure or unavailable registry. Include the exact field, expected/actual value, Task ID, Europe/Madrid time and the recommended safe investigation. For actual stream progress, use the separate Cloudflare monitor's incident procedure, not this audit.

A disabled legacy Ratings Task is intentional and is **not** checked by the registry-only drift automation. Its Cloudflare Workflow is observed by the Worker monitor.

## Safety and operations

Only read the two Tasks using `Automations.peek` and compare them with GitHub `main` documentation. Never call IPTV MCP, Worker status, production APIs, or write-capable GET from this automation. Never start, retry, enable, disable, create, modify or reschedule any Task, nor start or repair EPG, Discovery, Predictions, Ratings, Cloudflare, Access, R2 or D1. Any Scheduled Task change or out-of-plan production operation needs a separate owner authorization under the [authorization policy](../process/authorization-and-escalation.md).

This monitor shares the same ChatGPT scheduler as the two Tasks. It may itself run late, fail or be disabled silently. No notification does not prove healthy execution or availability. The live registry, not the saved documentation or a prior chat, defines the actual Task state.

If the owner authorizes rollback of the **monitor's prompt alone**, restore the prior prompt in the existing Task and record a new live readback. Do not infer permission to re-enable legacy Ratings, to create a replacement Scheduled Task or to change the Daily/Hourly producers. Reverting these documentation files does not change the live Scheduled Task.
