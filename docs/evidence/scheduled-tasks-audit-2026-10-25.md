# External Scheduled Task configuration audit — 2026-10-25

**Captured at:** 2026-10-25, approximately 20:14–20:23 UTC; timezone metadata rechecked after owner-approved correction at 20:40 UTC. **Scope:** precisely two active production ChatGPT Scheduled Tasks; no Worker / R2 / Cloudflare runtime inspection or writes. **Source:** read-only ChatGPT Scheduled Tasks registry inspection in the owner's session. The automation registry is external to GitHub; no pinned Git SHA can represent its configuration. Documentation source: GitHub main files read during the audit; subsequent proposed corrections are in the AIR-155 PR.

| Task | Enabled | Observed recurrence | default_timezone | Observed prompt behavior |
| --- | --- | --- | --- | --- |
| Обновление программы «В эфире» | true | Daily 17:00, DTSTART TZID=Europe/Madrid | Europe/Madrid¹ | EPG preflight, one epg_sync_start, sequential metadata/publish/discovery steps; not predictions |
| Почасовые прогнозы «В эфире» | true | Hourly, DTSTART TZID=Europe/Madrid | Europe/Madrid | Safe published-generation discovery continuation BEFORE queued predictions; mandatory fail-closed prediction_validate before every submit |

**Finding:** the maintained scheduling Mermaid represented discovery only in the EPG path and did not show the hourly catch-up; the prediction runbook described adoption of validator preflight as a possible future prompt edit despite its presence in the live hourly prompt. Both require documentation repair. The daily EPG task's timezone metadata now agrees with its explicit recurrence timezone (see footnote ¹). An enabled schedule or recorded last-run time does not prove EPG publication, full discovery, or completed predictions.

**Method/limits:** inspected effective task prompts, enabled values and iCalendar definitions via Scheduled Tasks registry; compared semantics with main architecture and runbook. No execution histories, individual run result traces or production state were audited. This is a dated configuration audit with the later timezone correction reflected directly in the table, **not current runtime authority**. At most the two configured tasks are covered; inactive historical tasks are out of scope.

**Original verdict:** documentation drift confirmed; live runtime failure not established. **Lifecycle:** evidence retained. **Used by:** [AIR-155](https://trello.com/c/bDN8nLeE). **Superseded by:** none recorded. Any further task modification needs separate owner approval.

¹ **Timezone correction (2026-10-25 20:40 UTC):** The initial registry inspection reported `default_timezone: Europe/Oslo` for the daily EPG task. After the owner-approved save of its existing 17:00 Europe/Madrid schedule, the registry returned `default_timezone: Europe/Madrid`, as shown in the table. The task remained enabled; its prompt was unchanged, and no task execution was initiated. This verifies configuration, not successful execution.
