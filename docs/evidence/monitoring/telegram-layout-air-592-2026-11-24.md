# Monitor Telegram text in short blocks: rendered samples and offline bubble QA (AIR-592 follow-up)

Captured 2026-11-24 (UTC) from the repository only, for [ADR 0206](../../adr/0206-monitor-four-states-one-reminder-interval.md) decision 9 and the layout kept in the monitor reference per [ADR 0212](../../adr/0212-monitor-telegram-text-in-short-blocks.md) (Proposed at capture). The samples illustrate the layout; they are not ADR constraints. **No production read or write, no Telegram call, no test alert and no network call was made.** The trigger is the [owner's visual FAIL](https://trello.com/c/c0d7VD4P#comment-6b05997439ebd35630d770b2) of the first natural production message (24 Nov 2026, 14:00:23 Madrid). That message is reproduced below in the new layout from its stated facts. The owner's screenshot is not stored anywhere.

## Method

- **Samples.** Each sample is the exact output of the real renderer `src/domain/monitor-message.js`, produced by `IPTV_PRINT_SAMPLES=1 node tests/monitor-message.mjs`. Where a sample says "owner example", the issue comes from the real `MonitorPolicy`. The same test asserts the layout invariants on every sample:
  - one empty line between blocks;
  - no `• ` pseudo-list;
  - content lines of at most 60 characters, except the bounded legacy detail, `Подробно:` and `Причина:`;
  - no long parenthesised repeat;
  - the time line, then the whole `Ref`, close the message.
- **Outbound body.** `tests/monitor-telegram.mjs` checks the actual Bot API body produced by `Monitor.run`: literal `\n` newlines, an empty line after the header, the typed `Причина:` line, Madrid time and `Ref` last, and no `parse_mode`.
- **Offline bubble QA.** A local script loads each sample into a Telegram-like bubble in headless Chromium (Playwright). The bubble uses `white-space: pre-wrap`, `overflow-wrap: anywhere`, padding 6/10 px and a 12 px radius, with the system UI font. It is rendered at three sizes:
  - mobile 320: viewport 320, text width 262 px, 15 px font, line height 1.3125;
  - mobile 390: viewport 390, text width 318 px, 15 px;
  - desktop: text width 480 px, 14 px.

  For each line, the script counts the visual rows it takes. No screenshot was created or saved.

  This is a simulation, not Telegram. The headless font has no colour emoji, the widths approximate the Telegram iOS, Android and desktop bubbles, and the real client may use another font size. The final acceptance is the owner's look at a natural production message.

## Bubble QA result (25 samples)

Columns: configuration; samples; horizontal overflow; samples whose `Ref` wraps; wrapped content lines, excluding `Ref` and the deliberately unsafe sample; the owner's production message; which content lines wrap.

| Configuration | Samples | Overflow | `Ref` wraps | Wrapped content lines | Owner message | Wrapped lines |
| --- | --- | --- | --- | --- | --- | --- |
| mobile 320 | 25 | 0 | 22 | 28 | 19 rows, 386 px | `Predictions recovery: Последнее наблюдение: 22.11 13:00`<br>`Recovery without evidence of progress: Последнее наблюдение: 22.11 13:00`<br>`Discovery alert: Исполнитель (Workflow) остановился`<br>`Discovery recovery while another issue is still open: Исполнитель (Workflow) остановился`<br>`Discovery stalled: ⏱ Без разрешённого прогресса: 3 ч 31 мин`<br>`Canonical Producer critical alert: Причина: producer_budget_infeasible`<br>`Canonical Producer escalation: ⛔ Ухудшение · Обогащение каталога`<br>`Canonical Producer escalation: Причина: producer_budget_infeasible`<br>`Test: Проверочное сообщение, инцидента нет`<br>`EPG stale: Программа не опубликована вовремя`<br>`Catalog posters failed: Недельный повтор завершился сбоем`<br>`Letterboxd events backlog: События слотов Letterboxd ждут доставки`<br>`Delayed escalation across UTC midnight: ⛔ Ухудшение · Обогащение каталога`<br>`Delayed escalation across UTC midnight: Причина: producer_identity_unresolved`<br>`Legacy pending needs_owner reminder: Детали: The Ratings run is quarantined (budget_exhaus`<br>`Canonical Producer without confirmed progress: ⚠️ Проблема · Обогащение каталога`<br>`Canonical Producer without confirmed progress: ⏱ Прогресс не подтверждён: 3 ч 30 мин`<br>`Canonical Producer without confirmed progress: Последний прогресс: не было в этом окне`<br>`Letterboxd Watchlist stale for 24 h: Подробно: нет полного скана больше 24 ч`<br>`Ratings stalled: Подробно: ни дня, ни прогресса к 19:00 (срок 17:00)`<br>`Held prediction reminder: Сейчас: число доступных не читается`<br>`Held prediction reminder: Последнее наблюдение: 23.11 23:28`<br>`Prediction alert with a live lease and ownerless starts: Lease держит запуск, это не прогр`<br>`Prediction alert with a live lease and ownerless starts: ⏱ Прогресс не подтверждён: 1 ч 1 `<br>`Prediction recovery by confirmed progress: Причина: прогресс снова подтверждён`<br>`Prediction recovery by confirmed progress: Последнее наблюдение: 23.11 23:28`<br>`Prediction recovery without eligible work: Очередь пуста или повторы исчерпаны`<br>`Prediction recovery without eligible work: Последнее наблюдение: 23.11 23:28` |
| mobile 390 | 25 | 0 | 18 | 3 | 19 rows, 386 px | `Discovery stalled: ⏱ Без разрешённого прогресса: 3 ч 31 мин`<br>`Legacy pending needs_owner reminder: Детали: The Ratings run is quarantined (budget_exhaus`<br>`Ratings stalled: Подробно: ни дня, ни прогресса к 19:00 (срок 17:00)` |
| desktop | 25 | 0 | 1 | 0 | 17 rows, 324 px | none |

**Reading.** At 390 px, every content line of every real kind fits on one row except three:
- the Discovery `⏱ Без разрешённого прогресса: …` diagnostic, kept for precision;
- a legacy English `Детали:` line;
- the Ratings `Подробно:` detail.

The full `Ref` (about 60 characters) wraps on phones because it is one unbroken token. The owner asked to keep it whole, in the technical block, and it is the last line. At 320 px, the longer titles and the `Последнее наблюдение:` and `Последний прогресс:` lines take two rows. On the desktop width only the deliberately unsafe sample wraps. No configuration overflows. The owner's production message takes 19 rows on a phone and 17 on the desktop, in six blocks, instead of one solid block.

## Samples

### Predictions alert (owner example)

```text
⚠️ Проблема · Прогнозы
Нет подтверждённого прогресса
🟠 Подтверждённая деградация

Доступно: 3 533
В очереди: 3 600
Запусков без фильма (за 2 ч): 11

⏱ Прогресс не подтверждён: 15 ч
Последний прогресс: 21.11 18:00

🕒 Инцидент: меньше минуты
Открыт: 22.11 09:00

🌐 В целом: есть проблемы

22.11 09:00:30 · Мадрид
Ref: predictions_no_progress|alert|2026-11-22T08:00:23.000Z
```

### Predictions recovery (owner example; progress landed at 12:10 UTC, between the last observation and the noticing tick)

```text
✅ Проблема снята · Прогнозы
Нет подтверждённого прогресса
Больше не наблюдается

⏱ Прогресс не подтверждён
Не меньше: 19 ч
Последнее наблюдение: 22.11 13:00

🕒 Инцидент: 5 ч
Открыт: 22.11 09:00
Снят: 22.11 14:00

🌐 В целом: всё в порядке

22.11 14:00:30 · Мадрид
Ref: predictions_no_progress|recovery|2026-11-22T13:00:23.000Z
```

### Recovery without evidence of progress (the issue only disappeared)

```text
✅ Проблема снята · Прогнозы
Нет подтверждённого прогресса
Больше не наблюдается

⏱ Прогресс не подтверждён
Не меньше: 19 ч
Последнее наблюдение: 22.11 13:00

🕒 Инцидент: 5 ч
Открыт: 22.11 09:00
Снят: 22.11 14:00

🌐 В целом: есть задержки

22.11 14:00:30 · Мадрид
Ref: predictions_no_progress|recovery|x
```

### Discovery alert (owner example; first seen one tick before the confirmation)

```text
⚠️ Проблема · Находки
Исполнитель (Workflow) остановился
🟠 Подтверждённая деградация

Осталось чанков: 12
Исполнитель: workflow

⏱ Без нового чанка: 41 мин
Последний чанк: 12.11 04:20

🕒 Инцидент: 1 ч
Открыт: 12.11 04:00

🌐 В целом: есть проблемы

12.11 05:00:50 · Мадрид
Ref: discovery_executor_stalled|alert|2026-11-12T04:00:42.000Z
```

### Discovery recovery while another issue is still open (owner example)

```text
✅ Проблема снята · Находки
Исполнитель (Workflow) остановился
Больше не наблюдается

🕒 Инцидент: 2 ч
Открыт: 12.11 04:00
Снят: 12.11 06:00

🌐 Остаются другие проблемы

12.11 06:00:50 · Мадрид
Ref: discovery_executor_stalled|recovery|2026-11-12T05:00:42.000Z
```

### Discovery stalled (no allowed progress)

```text
⚠️ Проблема · Находки
Очередь Находок стоит
🟠 Подтверждённая деградация

Осталось чанков: 7
Исполнитель: workflow

⏱ Без разрешённого прогресса: 3 ч 31 мин
Шаг разрешён с: 12.11 01:30
Последний чанк: 12.11 01:00

🕒 Инцидент: 1 ч
Открыт: 12.11 04:00

🌐 В целом: есть проблемы

12.11 05:00:50 · Мадрид
Ref: discovery_stalled|alert|x
```

### Canonical Producer critical alert (hard stop)

```text
🚨 Сбой · Обогащение каталога
Остановлено
🔴 Критичный сбой

Поколение: r1:5
Причина: producer_budget_infeasible
Автоматически не возобновится

🕒 Инцидент: 1 ч
Открыт: 24.11 03:00

🌐 В целом: есть проблемы

24.11 04:00:10 · Мадрид
Ref: canonical_producer_failed|alert|2026-11-24T03:00:00.000Z
```

### Canonical Producer escalation

```text
⛔ Ухудшение · Обогащение каталога
Остановлено
🔴 Критичный сбой

Поколение: r1:5
Причина: producer_budget_infeasible
Автоматически не возобновится

🕒 Инцидент: 1 ч
Открыт: 24.11 03:00

🌐 В целом: есть проблемы

24.11 04:00:10 · Мадрид
Ref: canonical_producer_failed|escalation|2026-11-24T03:00:00.000Z
```

### Reminder (critical Ratings quarantine)

```text
🔁 Напоминание · Оценки
Оценки в карантине
🔴 Критичный сбой

Причина: budget_exhausted

🕒 Инцидент: 12 ч
Открыт: 23.11 21:00

🌐 В целом: есть проблемы

24.11 09:00:05 · Мадрид
Ref: ratings_quarantined|reminder|2026-11-24T08:00:00.000Z
```

### Test

```text
🧪 Тест · Монитор
Проверочное сообщение, инцидента нет

24.11 10:00:00 · Мадрид
Ref: monitor_test|2026-11-24T09:00:00.000Z
```

### EPG stale

```text
⚠️ Проблема · Программа
Программа не опубликована вовремя
🟠 Подтверждённая деградация

⏱ Опоздание: 6 ч 30 мин
Ожидалась: 06.11 17:00
Последняя публикация: 04.11 17:10

🕒 Инцидент: 1 ч
Открыт: 06.11 22:30

🌐 В целом: есть проблемы

06.11 23:30:05 · Мадрид
Ref: epg_stale|alert|2026-11-06T22:30:00.000Z
```

### Catalog posters failed (critical)

```text
🚨 Сбой · Постеры
Недельный повтор завершился сбоем
🔴 Критичный сбой

Причина: retry_exhausted
Последняя активность: 22.11 04:24

🕒 Инцидент: меньше минуты
Открыт: 22.11 05:00

🌐 В целом: есть проблемы

22.11 05:00:03 · Мадрид
Ref: catalog_posters_failed|alert|2026-11-22T04:00:00.000Z
```

### Letterboxd events backlog

```text
⚠️ Проблема · Letterboxd Sync
События слотов Letterboxd ждут доставки
🟠 Подтверждённая деградация

Событий ждёт доставки: 9

🕒 Инцидент: 1 ч
Открыт: 06.11 22:30

🌐 В целом: есть проблемы

06.11 23:30:05 · Мадрид
Ref: letterboxd_events_backlog|alert|x
```

### Delayed escalation across UTC midnight

```text
⛔ Ухудшение · Обогащение каталога
Остановлено
🔴 Критичный сбой

Причина: producer_identity_unresolved
Автоматически не возобновится

🕒 Инцидент: 2 ч
Открыт: 06.11 22:30

🌐 В целом: есть проблемы

📨 Отправлено с задержкой
Обнаружено: 07.11 00:30
07.11 02:00:00 · Мадрид
Ref: canonical_producer_failed|escalation|2026-11-06T23:30:00.000Z
```

### Unknown timing

```text
⚠️ Проблема · Прогнозы
Нет подтверждённого прогресса
🟠 Подтверждённая деградация

🕒 Инцидент: неизвестно
Открыт: неизвестно

🌐 В целом: есть проблемы

24.11 11:00:00 · Мадрид
Ref: predictions_no_progress|alert|x
```

### Legacy pending needs_owner reminder

```text
🔁 Напоминание · Оценки
Оценки в карантине
🔴 Критичный сбой

Детали: The Ratings run is quarantined (budget_exhausted)

🕒 Инцидент: 2 ч
Открыт: 24.11 06:00

🌐 В целом: есть проблемы

📨 Отправлено с задержкой
Обнаружено: 24.11 08:00
24.11 09:00:00 · Мадрид
Ref: ratings_quarantined|reminder|2026-11-24T07:00:00.000Z
```

### Long and unsafe input (sanitized)

```text
⚠️ Проблема · x
Проблема unknown_bkey
🟠 Подтверждённая деградация

Детали: <b>x</b> zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz

🕒 Инцидент: неизвестно
Открыт: 24.11 06:00

🌐 В целом: есть проблемы

24.11 07:00:00 · Мадрид
Ref: id|qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq
```

### Canonical Producer without confirmed progress (window counted from the publication)

```text
⚠️ Проблема · Обогащение каталога
Нет подтверждённого прогресса
🟠 Подтверждённая деградация

Поколение: r9:3
Цепочка: active
Проход: active

⏱ Прогресс не подтверждён: 3 ч 30 мин
Отсчёт с: 24.11 07:30
Последний прогресс: не было в этом окне

🕒 Инцидент: меньше минуты
Открыт: 24.11 11:00

🌐 В целом: есть проблемы

24.11 11:00:05 · Мадрид
Ref: canonical_producer_no_progress|alert|x
```

### Letterboxd Watchlist stale for 24 h

```text
⚠️ Проблема · Letterboxd Sync
Watchlist давно не сканировался
🟠 Подтверждённая деградация

Подробно: нет полного скана больше 24 ч

🕒 Инцидент: 1 ч
Открыт: 24.11 10:00

🌐 В целом: есть проблемы

24.11 11:00:05 · Мадрид
Ref: letterboxd_watchlist_stale|alert|x
```

### Ratings stalled

```text
⚠️ Проблема · Оценки
Нет завершённого дня (срок + 2 ч)
🟠 Подтверждённая деградация

Подробно: ни дня, ни прогресса к 19:00 (срок 17:00)

🕒 Инцидент: 1 ч
Открыт: 24.11 10:00

🌐 В целом: есть проблемы

24.11 11:00:05 · Мадрид
Ref: ratings_stalled|alert|x
```

### Held prediction reminder (AIR-596)

```text
🔁 Напоминание · Прогнозы
Нет подтверждённого прогресса
🟠 Подтверждённая деградация

Сейчас: число доступных не читается
Инцидент остаётся открытым

⏱ Прогресс не подтверждён
Не меньше: 2 ч
Последнее наблюдение: 23.11 23:28

🕒 Инцидент: 6 ч
Открыт: 23.11 23:28

🌐 В целом: есть проблемы

24.11 05:28:05 · Мадрид
Ref: predictions_no_progress|reminder|2026-11-24T04:28:00.000Z
```

### Prediction alert with a live lease and ownerless starts (AIR-596)

```text
⚠️ Проблема · Прогнозы
Нет подтверждённого прогресса
🟠 Подтверждённая деградация

Доступно: 6 969
В очереди: 7 000
Запусков без фильма (за 2 ч): 8
Lease держит запуск, это не прогресс

⏱ Прогресс не подтверждён: 1 ч 1 мин
Последний прогресс: 23.11 22:27

🕒 Инцидент: меньше минуты
Открыт: 23.11 23:28

🌐 В целом: есть проблемы

23.11 23:28:05 · Мадрид
Ref: predictions_no_progress|alert|2026-11-23T22:28:00.000Z
```

### Prediction recovery by confirmed progress (AIR-596)

```text
✅ Проблема снята · Прогнозы
Нет подтверждённого прогресса
Больше не наблюдается

Причина: прогресс снова подтверждён
Последний прогресс: 24.11 06:13

⏱ Прогресс не подтверждён
Не меньше: 2 ч
Последнее наблюдение: 23.11 23:28

🕒 Инцидент: 7 ч
Открыт: 23.11 23:28
Снят: 24.11 06:28

🌐 В целом: всё в порядке

24.11 06:28:05 · Мадрид
Ref: predictions_no_progress|recovery|2026-11-24T05:28:00.000Z
```

### Prediction recovery without eligible work (AIR-596)

```text
✅ Проблема снята · Прогнозы
Нет подтверждённого прогресса
Больше не наблюдается

Причина: нечего прогнозировать
Очередь пуста или повторы исчерпаны
Это не подтверждённый прогресс

⏱ Прогресс не подтверждён
Не меньше: 2 ч
Последнее наблюдение: 23.11 23:28

🕒 Инцидент: 7 ч
Открыт: 23.11 23:28
Снят: 24.11 06:28

🌐 В целом: всё в порядке

24.11 06:28:05 · Мадрид
Ref: predictions_no_progress|recovery|2026-11-24T05:28:00.000Z
```

### Owner production reminder of 24 Nov 2026 in the new layout

```text
🔁 Напоминание · Прогнозы
Нет подтверждённого прогресса
🟠 Подтверждённая деградация

Доступно: 3 078
В очереди: 3 083

⏱ Прогресс не подтверждён: 16 ч
Последний прогресс: 23.11 22:00

🕒 Инцидент: 6 ч
Открыт: 24.11 08:00

🌐 В целом: есть проблемы

24.11 14:00:23 · Мадрид
Ref: predictions_no_progress|reminder|2026-11-24T13:00:23.490Z
```

## Limitations

- The bubble is a simulation; Telegram's real font, emoji widths and bubble width are not observed.
- No production message was sent for this evidence. Acceptance is the owner's visual check of the next natural message after deploy.
- The AIR-596 lines ([PR #979](https://github.com/vladimino/iptv-watchlist/pull/979), merged into `main` first) are included above: a held reminder, a live lease with the 2-hour orphan bound, and the recovery reasons.
