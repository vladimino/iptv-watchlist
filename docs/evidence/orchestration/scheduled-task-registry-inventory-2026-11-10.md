# ChatGPT Scheduled Task registry: inventory of the 14 disabled Tasks (10 November 2026)

**Captured:** 2026-11-10 (Europe/Madrid), by the Coordinator with a read-only `Automations.peek` of every Task by its exact ID, recorded on the [AIR-406](https://trello.com/c/PPe2fFcu) card. The Executor did not read the registry. **Scope:** the registry baseline of 16 Tasks (2 enabled, 14 disabled) and a decision table for the disabled ones. Nothing was created, edited, enabled, disabled, deleted or run, and no production system was read or written. This is a snapshot, not the live registry: the registry wins.
**Verdict:** the two enabled Tasks are the only ones that matter to production and are **not to be touched** by this record. All 14 disabled Tasks are **retirement candidates**; **none is approved for deletion**. A retirement candidate is not permission to delete: each deletion needs a separate, explicit owner GO naming the exact IDs and the operation.
**Used by:** [Scheduled Task contract](../../reference/scheduled-tasks.md), [drift runbook](../../runbooks/scheduled-task-drift.md), [AIR-406](https://trello.com/c/PPe2fFcu).

## Enabled (not touched)

| ID | Task | Schedule | Role |
| --- | --- | --- | --- |
| `Automation_25293680bdb08191818ee2db30438f49` | Почасовые прогнозы «В эфире» | hourly, nominally :20 Europe/Madrid; live prompt 11,372 characters | The only ChatGPT-dependent producer: personal Predictions (Stage B only) |
| `6ade65245de481919b816c5f5026c121` | IPTV Scheduled Task Drift | daily 18:15 Europe/Madrid; live prompt 3,370 characters | Registry-only check; its prompt is to be narrowed in place to the Hourly Task ([proposed text](../../reference/scheduled-task-prompts/drift-hourly-only.md)) |

## Disabled: decision table

The purpose column is inferred from the Task's name; the Executor did not read these prompts. Replacement names what now does the job, where there is one.

| ID | Task (name as in the registry) | Purpose (from the name) | Replacement | Decision |
| --- | --- | --- | --- | --- |
| `Automation_5d50308ce72c8191a50242fa604836b2` | Обновление программы «В эфире» | The former daily EPG publication | Cloudflare EPG Workflow ([AIR-348](https://trello.com/c/PUrlzMuH)); disabled with the owner's GO | Retirement candidate. Keep until the rollback window of the EPG cutover is closed by the owner: its prompt is the rollback material |
| `6ae52289ae9481919a68eec9310f5d8c` | Обновление рейтингов «В эфире» | The former Letterboxd ratings run | Cloudflare Ratings Workflow ([AIR-347](https://trello.com/c/j2Ua76yv)); disabled 2026-11-06 | Retirement candidate. Same rollback consideration |
| `6ae63720903081918f4efc9cacf2b9d5` | Диагностика Flexible Schedule | One-off diagnostic of the flexible timing mode | None needed | Retirement candidate |
| `6ae636caf23c8191b55a6d18d0f96939` | Диагностика Exact Schedule | One-off diagnostic of the exact timing mode | None needed | Retirement candidate |
| `6ae1f8ac3c6081919c0ba785e34b78f7` | AIR-210: проверка immutable fingerprints | One-off check for AIR-210 | None needed | Retirement candidate |
| `6adf07a2bbf481918aae3e77df8e2313` | AIR-69 автономная проверка | One-off autonomous probe for AIR-69 | None needed | Retirement candidate |
| `6adb91ba6d408191a9968438ce29523f` | Проверка инцидента AIR-87 | One-off incident check for AIR-87 | None needed | Retirement candidate |
| `6ad6a0f66d8481918a2b58f7e37c54fd` | IPTV MCP — автономная проверка | Early autonomous probe of the MCP connection | None needed | Retirement candidate |
| `6ad691e2a9f481918d6a843a0cf58000` | PR #9 — новый коммит | A notification for new commits of PR #9 | None needed | Retirement candidate |
| `Automation_0f81810ec0288191858e77b6778a602d` | Прогнозы фильмов «В эфире» | A former predictions producer | The hourly Predictions Task | Retirement candidate |
| `Automation_0bbd19f3948c8191a017c6b23d820051` | Продолжение прогнозов «В эфире» | A former predictions continuation | The hourly Predictions Task | Retirement candidate |
| `Automation_574fd7effb488191a249cad229d5d789` | Прогнозы фильмов «В эфире» | A second former predictions producer (same name as above) | The hourly Predictions Task | Retirement candidate |
| `6ac252009f2c8191b47595102e397c16` | Опубликовать taste profile v1 | One-off publication of the first taste profile | None needed | Retirement candidate |
| `6a6e50b5cf1c81918fac9dba986304c8` | IPTV Watchlist Brief | A former brief of the watchlist | None recorded | Retirement candidate; the owner decides whether the brief is still wanted |

## What is not decided here

- No Task is deleted, edited or enabled by this record. A deletion, or any edit, needs the owner's explicit GO on the exact IDs and the operation, and a registry readback afterwards (no new Task appears, the two enabled Tasks keep their settings).
- The Drift Task's own prompt is changed only by the owner-approved in-place update described in the [proposed text](../../reference/scheduled-task-prompts/drift-hourly-only.md); the Hourly Task's prompt is not changed.
- A disabled Task can be re-enabled by mistake. The Worker refuses the write paths of the retired EPG and Ratings Tasks (`external_writer_fenced` while their modes are `cloudflare`), which is why the Drift monitor does not need to watch them.
