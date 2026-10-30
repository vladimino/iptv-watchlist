# Daily Task Drift monitoring: owner authorization and live readback (30 October 2026)

Task: `IPTV Scheduled Task Drift`, `6ade65245de481919b816c5f5026c121`. Trello: [AIR-292](https://trello.com/c/CTxq4Khy) (inconclusive platform RCA closed by owner), [AIR-293](https://trello.com/c/pUgAE8HU) (documentation delivery). This is a dated operation record, not authority for future task edits.

Owner authorization: explicit approval in the coordinating conversation on 30 October 2026 to make the **existing** weekly drift audit a daily 17:45 Europe/Madrid read-only monitor. The owner declined an OpenAI Support escalation for this one-off incident and approved closure of the analytical RCA as inconclusive.

Live before: enabled `true`; `DTSTART;TZID=Europe/Madrid:20261026T090000`, `RRULE:FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0`; default timezone Europe/Madrid. Prompt compared the two production tasks to the maintained GitHub contract but did not read EPG publication status.

Mutation made through the owner-authorized Automations update: same task ID/title, retained `enabled=true`, `DTSTART;TZID=Europe/Madrid:20261030T174500`, `RRULE:FREQ=DAILY;BYHOUR=17;BYMINUTE=45`, default timezone Europe/Madrid. The new prompt compares exactly the two production task registry entries (enabled, recurrence, prompt, latest run status) with the current GitHub contract and reads *only* `epg_status` via the owner-connected IPTV MCP to check real daily EPG publication. On anomalies, it notifies the owner; otherwise silent. No self-healing, writes, task restarts or task changes.

Tool result: `success=true`. Independent Automations registry readback: `is_enabled=true`, recurrence and default timezone match the requested fields, prompt contained EPG status read, `updated_at=2026-10-30T17:55:12.616396+00:00`. Readback is not proof the next execution will occur or notify. No `run_now` was issued. The two production scheduled tasks were not modified.

Incident prompting mitigation: the 30 October daily EPG task returned `recorded_status=failed`, while the Worker programme was published `stage=complete`; Diary failed with confirmed Worker memory limit and the EPG Task was subsequently observed disabled. Actor and reason for the Task `is_enabled=false` mutation remain unproven; a similar public Codex issue exists. The owner manually restored it. The separate monitoring automation is subject to the same platform reliability risk.

Documentation impact: docs/reference/scheduled-tasks.md, docs/architecture/scheduling-and-orchestration.md, docs/runbooks/scheduled-task-drift.md, docs/runbooks/README.md, docs/evidence/README.md. Architecture impact: none (describes an existing monitoring Task's owner-approved cadence and reads, no authority or topology change). Research evidence: yes.

Future work: verify the first actual daily audit run from the live registry; no new production EPG or Task execution was initiated for this documentation. Workers deployment or CI success cannot prove Scheduled Task run success.