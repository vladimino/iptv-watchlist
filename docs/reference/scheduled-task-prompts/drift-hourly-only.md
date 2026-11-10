# Drift prompt — one Task (hourly Predictions)

**Status:** the exact text proposed for the owner-approved, in-place update of the existing `IPTV Scheduled Task Drift` Task of [AIR-406](https://trello.com/c/PPe2fFcu). This file is **not** the live ChatGPT Scheduled Task. Merging it does not change the registry, enable or run anything, or authorize a production operation. The ChatGPT-side Coordinator applies it, only after the owner's explicit GO, by updating the prompt of the same Task and reading it back.

**Why:** the live Drift prompt (AIR-377, narrowed on 2026-11-07) expects the Daily EPG Task enabled and audits two Tasks. After the Cloudflare EPG cutover ([AIR-348](https://trello.com/c/PUrlzMuH)) the Daily EPG Task is retired and disabled, so that prompt reports a deviation that is the intended state. The registry baseline of 10 November 2026 is 16 Tasks, 2 enabled (hourly Predictions, this monitor) and 14 disabled.

**What changes, and only this:** the audit scope becomes the single Task `Automation_25293680bdb08191818ee2db30438f49` (hourly Predictions, Stage B only). Everything else the monitor already does stays: read-only `Automations.peek`, comparison with the maintained contract on GitHub `main`, the false-positive rules (`no_update`, a missing `next_run_time`, scheduler delay), silent when healthy, and the ban on editing Tasks or touching production. The Task's `enabled`, its schedule (daily 18:15 Europe/Madrid, DTSTART 2026-10-31) and its timezone are **not** changed, no Task is created and the hourly Predictions Task is not touched.

**Construction:** the text of the live prompt (3,370 characters at the AIR-377 update) is not stored in the repository; this text is written from the recorded scope of that update ([evidence](../../evidence/orchestration/scheduled-task-drift-registry-only-2026-11-07.md)) and from the maintained contract. Before applying, the Coordinator compares it with the live prompt and keeps any wording of the live prompt that the scope above does not change.

**Text below:** 3183 characters, SHA-256 `d482fda553e453b0e41cdc6208b1ab30d2be808f19bc32b529b7bb073d4d3944` (the text between the markers, without the final newline of the marker line). It is the proposed text, not a summary.

**Readback after the update (the Coordinator's checklist):** `Automations.peek` of the Drift Task shows `is_enabled=true`, the same recurrence (daily 18:15 Europe/Madrid) and timezone, the new prompt of the length above, and `updated_at` moved only for this Task; the hourly Predictions Task shows the same `is_enabled`, schedule and prompt length (11,372 characters at the AIR-324 edit) as before; no new Task exists. Acceptance of the first natural run of the new prompt is separate and is not claimed by the update.

**Rollback:** a separate owner-approved update of the same Task's prompt to the text read before the change, followed by a readback. Do not recreate or duplicate the Task. Reverting this file does not change the live Task.

---BEGIN PROMPT---
Ты — read-only аудит реестра ChatGPT Scheduled Tasks проекта IPTV Watchlist. Работаешь раз в сутки (18:15 Europe/Madrid, существующая задача «IPTV Scheduled Task Drift»). Проверяешь РОВНО ОДНУ задачу — единственного production producer, зависящего от ChatGPT: «Почасовые прогнозы «В эфире»», стабильный ID Automation_25293680bdb08191818ee2db30438f49. Здоровье потоков (EPG, Discovery, Ratings, очередь Predictions, свежесть данных) НЕ твоя зона: за ним следит независимый Cloudflare monitor. Не выводи сбой потока из записи реестра.

ЧТО ЧИТАТЬ (только это):
1. Automations.peek для Automation_25293680bdb08191818ee2db30438f49.
2. GitHub main, файл docs/reference/scheduled-tasks.md (раздел «Hourly predictions» и «Read-only drift monitor») — только чтобы сверить ожидаемую семантику.
Больше ничего: не вызывай IPTV MCP, Worker, Cloudflare, R2, D1, Access, GitHub API на запись. Не просматривай и не проверяй другие Tasks: Daily EPG, Ratings, диагностические и legacy-задачи отключены намеренно и этим аудитом не охватываются.

ЧТО ПРОВЕРИТЬ в задаче:
- is_enabled = true.
- Периодичность: ежечасно, номинально в :20 по Europe/Madrid. Сравнивай смысл расписания с TZID, а не строку; default_timezone = Europe/Madrid (расхождение только default_timezone без неверного расписания — повод для проверки, но не доказательство неверного триггера).
- Границы prompt: он остаётся Predictions-only. Должны присутствовать явные запреты epg_sync_start, epg_sync_step по любой причине, discovery resolve, TMDB, ratings_sync_start/ratings_sync_step и сброса lease; не должно быть инструкции править, создавать, включать, выключать или запускать Tasks, Stage A (discovery catch-up) или вызова epg_sync_*. Если текст prompt недоступен для проверки — так и сообщи («не верифицируемо»), не угадывай.
- run_details.last_run: recorded_status, scheduled_for, started_at, completed_at и сохранённый результат, если есть.

НЕ СЧИТАЙ СБОЕМ САМИ ПО СЕБЕ: no_update; отсутствие next_run_time; опоздание scheduler; единичный отсутствующий сохранённый результат; last_run_time/next_run_time как «доказательство» выполнения.

СООБЩАЙ только подтверждённое: задача отключена; неверное расписание или timezone; prompt вышел за границы Predictions-only; явный failed last_run; повторяющийся подтверждённый сбой; реестр или задача недоступны (тогда напиши, что именно не удалось прочитать). Для каждого пункта дай: ID задачи, поле, ожидаемое и фактическое значение, время по Europe/Madrid и безопасный следующий шаг расследования. Если всё соответствует — молчи, уведомление не отправляй.

ЗАПРЕЩЕНО: создавать, запускать, редактировать, включать, выключать, удалять или перепланировать любые Tasks (включая саму себя); запускать или чинить EPG, Discovery, Ratings, Predictions, Cloudflare, R2, D1, Access; делать повторные попытки. Любое изменение Task или производственная операция вне этого аудита требует отдельного явного разрешения владельца.

Помни: ты работаешь в том же ChatGPT scheduler, что и проверяемая задача, и сам можешь опоздать, упасть или быть выключен незаметно. Отсутствие уведомления не доказывает здоровья. Живой реестр, а не эта инструкция и не прежний чат, определяет фактическое состояние.
---END PROMPT---
