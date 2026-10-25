# External Scheduled Task configuration audit — 2026-10-25

**Captured at:** 2026-10-25, approximately 20:14–20:23 UTC. **Scope:** precisely two active production ChatGPT Scheduled Tasks; no Worker / R2 / Cloudflare runtime inspection or writes. **Source:** read-only ChatGPT Scheduled Tasks registry inspection in the owner's session. The automation registry is external to GitHub; no pinned Git SHA can represent its configuration. Documentation source: GitHub main files read during the audit; subsequent proposed corrections are in the AIR-155 PR.

| Task | Enabled | Observed recurrence | default_timezone | Observed prompt behavior |
| --- | --- | --- | --- | --- |
| Обновление программы «В эфире» | true | Daily 17:00, DTSTART TZID=Europe/Madrid | Europe/Oslo | EPG preflight, one epg_sync_start, sequential metadata/publish/discovery steps; not predictions |
| Почасовые прогнозы «В эфире» | true | Hourly, DTSTART TZID=Europe/Madrid | Europe/Madrid | Safe published-generation discovery continuation BEFORE queued predictions; mandatory fail-closed prediction_validate before every submit |

**Finding:** the maintained scheduling Mermaid represented discovery only in the EPG path and did not show the hourly catch-up; the prediction runbook described adoption of validator preflight as a possible future prompt edit despite its presence in the live hourly prompt. Both require documentation repair. The daily EPG task has different timezone metadata from its explicit recurrence timezone; investigate observed execution times before claiming an actual schedule error. An enabled schedule or recorded last-run time does not prove EPG publication, full discovery, or completed predictions.

**Method/limits:** inspected effective task prompts, enabled values and iCalendar definitions via Scheduled Tasks registry; compared semantics with main architecture and runbook. No execution histories, individual run result traces or production state were audited. This is a dated configuration snapshot, **not current runtime authority**. At most the two configured tasks are covered; inactive historical tasks are out of scope.

**Original verdict:** documentation drift confirmed; live runtime failure not established. **Lifecycle:** evidence retained. **Used by:** [AIR-155](https://trello.com/c/bDN8nLeE). **Superseded by:** none recorded. Any further task modification needs separate owner approval.

## Owner-approved timezone metadata correction — 2026-10-25 20:40 UTC

The daily EPG Task retained its existing daily 17:00 Europe/Madrid recurrence and remained enabled. Its timezone-qualified schedule was saved again through the task registry; the registry now reports `default_timezone: Europe/Madrid` rather than `Europe/Oslo`. The hourly prediction Task already reported Europe/Madrid. No Task prompt or execution was initiated as part of the correction. The original table above intentionally preserves the earlier snapshot, rather than rewriting historical evidence. These observations establish scheduler configuration only, not run success.
