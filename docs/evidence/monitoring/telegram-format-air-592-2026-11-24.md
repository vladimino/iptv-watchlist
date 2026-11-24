# Monitor Telegram text: rendered offline samples (AIR-592)

Captured 2026-11-24 (UTC) from the repository only, for decision 9 of [ADR 0206](../../adr/0206-monitor-four-states-one-reminder-interval.md) (proposed; the owner's review is pending). **No production read or write, no Telegram call and no network call was made.** Every sample below is the exact output of the real renderer `src/domain/monitor-message.js`, produced by `IPTV_PRINT_SAMPLES=1 node tests/monitor-message.mjs`; the same test asserts these texts or their key lines. Where a sample says "owner example", the issue and its metrics come from the real `MonitorPolicy` over the facts of the owner's example, not from a hand-written message.

What the samples show:

- one marker per kind (`🚨` critical alert, `⚠️` ordinary alert, `🔁` reminder, `⛔` escalation, `✅` recovery, `🧪` test) and Russian names of the subsystem and the problem;
- typed statistics as `•` lines, never parsed from the English message;
- `⏱ Без прогресса` (the domain's own no-progress period and its onset) separate from `🕒 Инцидент открыт … · идёт …` (the monitor's observed lifetime from its first snapshot);
- the recovery's `🕒 Длительность инцидента`, frozen at detection;
- a recovery of one issue while other problems remain;
- delayed delivery across UTC midnight;
- unknown times shown as unknown;
- a legacy `needs_owner` message written before ADR 0206;
- unsafe input reduced to bounded ASCII, with the `Ref` line kept.

Times are Europe/Madrid (UTC+1 on these dates); the `Ref` id keeps UTC. The owner's Predictions example: last confirmed progress 21.11 17:00:23 UTC is 18:00 Madrid, and the alert at 08:00:23 UTC is 09:00 Madrid.

### Predictions alert (owner example)

```text
⚠️ Проблема · Прогнозы
Нет подтверждённого прогресса прогнозов
Серьёзность: 🟠 деградация (подтверждена)
• Доступно к прогнозу сейчас: 3533
• В очереди всего: 3600
• Запусков без фильма с последнего прогресса: 11
⏱ Без прогресса: 15 ч (последний подтверждённый прогресс 21.11 18:00)
🕒 Инцидент открыт: 22.11 09:00 · идёт меньше минуты
🌐 В целом: ⚠️ есть проблемы
Время: 22.11 09:00:30 · Мадрид (Europe/Madrid)
Ref: predictions_no_progress|alert|2026-11-22T08:00:23.000Z
```

### Predictions recovery (owner example)

```text
✅ Восстановлено · Прогнозы
Решено: Нет подтверждённого прогресса прогнозов
⏱ Без прогресса было: 20 ч (с 21.11 18:00)
🕒 Длительность инцидента: 5 ч (22.11 09:00 → 22.11 14:00)
🌐 В целом сейчас: ✅ всё в порядке
Время: 22.11 14:00:30 · Мадрид (Europe/Madrid)
Ref: predictions_no_progress|recovery|2026-11-22T13:00:23.000Z
```

### Discovery alert (owner example; first seen one tick before the confirmation)

```text
⚠️ Проблема · Находки
Исполнитель Находок (Workflow) остановился
Серьёзность: 🟠 деградация (подтверждена)
• Осталось чанков: 12
• Исполнитель: workflow
⏱ Без прогресса: 41 мин (последний подтверждённый прогресс 12.11 04:20)
🕒 Инцидент открыт: 12.11 04:00 · идёт 1 ч
🌐 В целом: ⚠️ есть проблемы
Время: 12.11 05:00:50 · Мадрид (Europe/Madrid)
Ref: discovery_executor_stalled|alert|2026-11-12T04:00:42.000Z
```

### Discovery recovery while another issue is still open (owner example)

```text
✅ Восстановлено · Находки
Решено: Исполнитель Находок (Workflow) остановился
⏱ Без прогресса было: 1 ч 41 мин (с 12.11 04:20)
🕒 Длительность инцидента: 2 ч (12.11 04:00 → 12.11 06:00)
🌐 В целом сейчас: ⚠️ остаются другие проблемы (восстановлена только эта)
Время: 12.11 06:00:50 · Мадрид (Europe/Madrid)
Ref: discovery_executor_stalled|recovery|2026-11-12T05:00:42.000Z
```

### Canonical Producer critical alert (hard stop)

```text
🚨 Сбой · Обогащение каталога
Обогащение каталога остановлено
Серьёзность: 🔴 критично (доказанный сбой, без ожидания подтверждения)
• Поколение: r1:5
• Причина остановки: producer_budget_infeasible
• Автоматически не возобновится
🕒 Инцидент открыт: 24.11 03:00 · идёт 1 ч
🌐 В целом: ⚠️ есть проблемы
Время: 24.11 04:00:10 · Мадрид (Europe/Madrid)
Ref: canonical_producer_failed|alert|2026-11-24T03:00:00.000Z
```

### Canonical Producer escalation

```text
⛔ Ухудшение · Обогащение каталога
Обогащение каталога остановлено
Серьёзность: 🔴 критично (доказанный сбой, без ожидания подтверждения)
• Поколение: r1:5
• Причина остановки: producer_budget_infeasible
• Автоматически не возобновится
🕒 Инцидент открыт: 24.11 03:00 · идёт 1 ч
🌐 В целом: ⚠️ есть проблемы
Время: 24.11 04:00:10 · Мадрид (Europe/Madrid)
Ref: canonical_producer_failed|escalation|2026-11-24T03:00:00.000Z
```

### Reminder (critical Ratings quarantine)

```text
🔁 Напоминание · Оценки
Оценки в карантине
Серьёзность: 🔴 критично (доказанный сбой, без ожидания подтверждения)
• Причина: budget_exhausted
🕒 Инцидент открыт: 23.11 21:00 · идёт 12 ч
🌐 В целом: ⚠️ есть проблемы
Время: 24.11 09:00:05 · Мадрид (Europe/Madrid)
Ref: ratings_quarantined|reminder|2026-11-24T08:00:00.000Z
```

### Test

```text
🧪 Тест · Монитор
Проверочное сообщение монитора. Инцидента нет.
Время: 24.11 10:00:00 · Мадрид (Europe/Madrid)
Ref: monitor_test|2026-11-24T09:00:00.000Z
```

### EPG stale

```text
⚠️ Проблема · Программа
Программа не опубликована вовремя
Серьёзность: 🟠 деградация (подтверждена)
• Ожидалась к: 06.11 17:00
• Последняя публикация: 04.11 17:10
⏱ Опоздание: 6 ч 30 мин
🕒 Инцидент открыт: 06.11 22:30 · идёт 1 ч
🌐 В целом: ⚠️ есть проблемы
Время: 06.11 23:30:05 · Мадрид (Europe/Madrid)
Ref: epg_stale|alert|2026-11-06T22:30:00.000Z
```

### Catalog posters failed (critical)

```text
🚨 Сбой · Постеры
Недельный повтор постеров завершился сбоем
Серьёзность: 🔴 критично (доказанный сбой, без ожидания подтверждения)
• Причина: retry_exhausted
• Последняя активность: 22.11 04:24
🕒 Инцидент открыт: 22.11 05:00 · идёт меньше минуты
🌐 В целом: ⚠️ есть проблемы
Время: 22.11 05:00:03 · Мадрид (Europe/Madrid)
Ref: catalog_posters_failed|alert|2026-11-22T04:00:00.000Z
```

### Letterboxd events backlog

```text
⚠️ Проблема · Letterboxd Sync
События слотов Letterboxd ждут доставки
Серьёзность: 🟠 деградация (подтверждена)
• Событий ждёт доставки: 9
🕒 Инцидент открыт: 06.11 22:30 · идёт 1 ч
🌐 В целом: ⚠️ есть проблемы
Время: 06.11 23:30:05 · Мадрид (Europe/Madrid)
Ref: letterboxd_events_backlog|alert|x
```

### Delayed escalation across UTC midnight

```text
⛔ Ухудшение · Обогащение каталога
Обогащение каталога остановлено
Серьёзность: 🔴 критично (доказанный сбой, без ожидания подтверждения)
• Причина остановки: producer_identity_unresolved
• Автоматически не возобновится
🕒 Инцидент открыт: 06.11 22:30 · идёт 2 ч
📨 Отправлено с задержкой: обнаружено 07.11 00:30, отправлено 07.11 02:00
🌐 В целом: ⚠️ есть проблемы
Время: 07.11 02:00:00 · Мадрид (Europe/Madrid)
Ref: canonical_producer_failed|escalation|2026-11-06T23:30:00.000Z
```

### Unknown timing

```text
⚠️ Проблема · Прогнозы
Нет подтверждённого прогресса прогнозов
Серьёзность: 🟠 деградация (подтверждена)
🕒 Инцидент открыт: неизвестно
🌐 В целом: ⚠️ есть проблемы
Время: 24.11 11:00:00 · Мадрид (Europe/Madrid)
Ref: predictions_no_progress|alert|x
```

### Legacy pending needs_owner reminder

```text
🔁 Напоминание · Оценки
Оценки в карантине
Серьёзность: 🔴 критично (доказанный сбой, без ожидания подтверждения)
🕒 Инцидент открыт: 24.11 06:00 · идёт 2 ч
Детали: The Ratings run is quarantined (budget_exhausted)
📨 Отправлено с задержкой: обнаружено 24.11 08:00, отправлено 24.11 09:00
🌐 В целом: ⚠️ есть проблемы
Время: 24.11 09:00:00 · Мадрид (Europe/Madrid)
Ref: ratings_quarantined|reminder|2026-11-24T07:00:00.000Z
```

### Long and unsafe input (sanitized)

```text
⚠️ Проблема · x
Проблема unknown_bkey
Серьёзность: 🟠 деградация (подтверждена)
🕒 Инцидент открыт: 24.11 06:00
Детали: <b>x</b> zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz
🌐 В целом: ⚠️ есть проблемы
Время: 24.11 07:00:00 · Мадрид (Europe/Madrid)
Ref: id|qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq
```

Limitations: the real Telegram client rendering of the emoji and line wrapping on the owner's phone is not observed here. No production test message is sent (out of scope; a test message needs its own approval). The 15-minute threshold for the delay note and the Russian wording are proposals for the owner's review.
