# Separate Ratings Scheduled Task: owner-approved staging (31 October 2026)

## Authorized intent

The owner rejected the prior architecture of invoking ratings as a post-commit step from the EPG Scheduled Task. The requested architecture is an **independent daily Ratings Scheduled Task**, with the EPG Scheduled Task prompt clarifying that it does not explicitly invoke the ratings pipeline. This authorization covered safe task creation and EPG prompt change, **not** activation of the new ratings writer or a manual production sync. Design review is in [AIR-296](https://trello.com/c/6lFnWkr8), code delivery in [AIR-294](https://trello.com/c/IzWiVABa) and independent activation in [AIR-295](https://trello.com/c/VtFZ6cci).

## Live registry change and readback

- New task title: `Обновление рейтингов «В эфире»`, ID `6ae52289ae9481919a68eec9310f5d8c`.
- Created with `timing_mode=flexible_schedule`, `default_timezone=Europe/Madrid`, `DTSTART;TZID=Europe/Madrid:20261101T180000`, `RRULE:FREQ=DAILY;BYHOUR=18;BYMINUTE=0`. The ~18:00 local time is a provisional preference, not an SLA or owner's confirmed exact time.
- Create response: `success=true`, initial enabled state `true`. A separate explicit update set `is_enabled=false`; success and a subsequent private registry readback independently confirmed `is_enabled=false`, task identity and schedule.
- Task's saved prompt explicitly fails closed if the deployed owner-only MCP lacks a dedicated ratings contract; it may not use an EPG sync tool or change task/flag/storage settings. No first run or ratings write was requested.
- EPG Task ID `Automation_5d50308ce72c8191a50242fa604836b2` retained `is_enabled=true` and its original `17:00 Europe/Madrid` recurrence. Its prompt was **augmented**, preserving the existing numbered EPG/discovery duties and adding the ownership boundary: no explicit ratings-sync tool invocation, and ratings are planned for the separate task. Independent `automations.peek` confirmed both unchanged recurrence and changed prompt content.
- Hourly predictions Task `Automation_25293680bdb08191818ee2db30438f49` and Drift Task `6ade65245de481919b816c5f5026c121` were not edited.

## What this does not prove

The deployed Worker still calls `completeWithRatings()` inside `epgSync()`, so the prompt change alone **does not remove Diary or its OOM risk from today's EPG commit**. The new task is paused. `ratings_sync_status` and `ratings_sync_step` are design candidates, not live MCP tools. A separate RFC/ADR with state, fencing and checkpoint contract will precede code changes; further task activation or manual runs need a distinct owner gate.

Documentation impact: docs/reference/scheduled-tasks.md, docs/runbooks/scheduled-task-drift.md, docs/evidence/README.md and this report; the Mermaid diagram of the current producer pipeline is unchanged in this staging record because no new active producer exists. Architecture impact: none to the currently deployed behavior. Research evidence: yes, live task registry readback and explicit owner decision.