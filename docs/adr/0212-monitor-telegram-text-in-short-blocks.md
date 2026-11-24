# ADR 0212: The monitor's Telegram text is laid out as short blocks separated by empty lines

**Status:** Proposed  
**Original decision date:** 2026-11-24 (the owner rejected the visual result of the first production message and returned AIR-592 for this layout)  
**Recorded at:** 2026-11-24  
**Approval source:** not yet decided. The owner's [visual acceptance FAIL and handoff of 24 Nov 2026](https://trello.com/c/c0d7VD4P#comment-6b05997439ebd35630d770b2) asks for this follow-up and proposes a layout "as a proposal, not an approved new mock-up"; it is not acceptance of this ADR.  
**Related work:** [AIR-592](https://trello.com/c/c0d7VD4P); [ADR 0206](0206-monitor-four-states-one-reminder-interval.md) decision 9; [PR #974](https://github.com/vladimino/iptv-watchlist/pull/974); [AIR-596](https://trello.com/c/t9Tx7Yy0) ([PR #979](https://github.com/vladimino/iptv-watchlist/pull/979)) changes the same renderer  
**Supersedes:** [ADR 0206](0206-monitor-four-states-one-reminder-interval.md) decision 9 in part: the concrete line layout it quotes (the `• label: value` statistics, the one-line `⏱ …`, `🕒 Инцидент открыт … · идёт …` and `📨 Отправлено с задержкой` forms, the severity line wording, `🌐 В целом …` and `Время: … · Мадрид (Europe/Madrid)`). Every other part of decision 9 stands.  
**Superseded by:** None

## Context

ADR 0206 decision 9 (accepted 24 Nov 2026) gave the monitor a Russian Telegram text with kind markers, typed statistics, separate domain and incident durations, a recovery that only reports the issue as no longer seen, Madrid times and the stable `Ref`. The first natural production message after the deploy of PR #974 (24 Nov 2026, 14:00:23 Madrid, `predictions_no_progress|reminder|2026-11-24T13:00:23.490Z`) confirmed delivery and the Russian text, but failed the owner's visual acceptance. The owner's words: «на ваших макетах выглядело более привлекательно, в реальности все равно куча сплошного текста без отступов, список неправильно форматируется, длинные предложения разрываются даже на большом экране».

The causes are in the layout, not in the facts:
- every line follows the previous one with no empty line;
- `• ` is plain text, not a list, so a wrapped item continues under the bullet;
- one line carries a duration together with a parenthesised date;
- the severity line repeats an explanation;
- the footer packs the zone name twice.

## Decision

1. **Blocks.** The text is a few blocks separated by exactly one empty line, in this order. Empty blocks are left out. A prediction recovery's reason (ADR 0210) is its own block right after the header.
   1. Header: marker, kind and subsystem; the problem title; then either the severity (`🔴 Критичный сбой` or `🟠 Подтверждённая деградация`) or, on a recovery, `Больше не наблюдается` (with `· была критичной` when it was).
   2. Statistics.
   3. Domain stall.
   4. Monitor incident.
   5. Overall state.
   6. Technical footer.
2. **Statistics.** One `Метка: значение` per line, without any bullet. Counts use a non-breaking thousands separator (`3 078`). The labels are short (`Доступно`, `В очереди`, `Запусков без фильма`, `Причина`, `Поколение`, `Подробно`). An unknown value is still left out, never shown as 0. A recovery still shows no statistics.
3. **Durations and their dates on separate lines.** The duration line comes first, then its date on the next line:
   - predictions: `⏱ Без прогресса: 16 ч`, then `Последний прогресс: 23.11 22:00`;
   - Discovery: `⏱ Без разрешённого прогресса` with `Шаг разрешён с:` and `Последний чанк:`;
   - the Producer: `⏱ Без прогресса` with `Отсчёт с:` and `Последний прогресс:` (or `не было в этом окне`);
   - EPG: `⏱ Опоздание` with `Ожидалась:` and `Последняя публикация:`;
   - the incident: `🕒 Инцидент: 6 ч`, then `Открыт: 24.11 08:00`, and on a recovery `Снят: …`;
   - a recovery's stall: `⏱ Без прогресса: не меньше 19 ч` (rounded down), then `Последнее наблюдение: …`.
4. **Overall.** `🌐 В целом: есть проблемы` (or `всё в порядке`, `есть задержки`, `ожидание по расписанию`). A recovery while the site is still degraded says `🌐 Остаются другие проблемы`.
5. **Technical footer.** The block holds, in order:
   - `📨 Доставлено с задержкой` and `Обнаружено: …`, only when the send is more than 15 minutes late;
   - the send time `24.11 14:00:23 · Мадрид`;
   - the full `Ref: <stable id>`, never shortened and kept by the length bound as the last line.
6. **Shorter titles.** A title no longer repeats the subsystem of the header. For example, `Нет подтверждённого прогресса` under `Прогнозы`, and `Остановлено` under `Обогащение каталога`. The diagnostic details keep their meaning in a shorter wording (`Подробно: ни дня, ни прогресса к 19:00 (срок 17:00)`).
7. **Unchanged.** The following are unchanged:
   - plain text without a markup mode; the safety rules and the 1800-character bound;
   - the facts and the typed metrics;
   - every semantic distinction of decision 9 (critical or confirmed, observed incident or domain stall, baseline or confirmed progress, a recovery as "no longer seen", late delivery, unknown times);
   - the webhook, the alert policy, the outbox, the cooldown, the identities and every read.

Not decided here: an HTML `parse_mode` for a bold header or a monospace `Ref`. That would change the accepted plain-text safety contract and needs its own decision, covering escaping, limits, a fallback, legacy messages and Telegram API compatibility.

## Alternatives considered

- **Keep the bulleted single-block text (ADR 0206 decision 9 as delivered).** The owner rejected it on the real production message.
- **HTML `parse_mode` (bold header, `<code>` Ref).** It would look closer to a card. It changes the plain-text safety contract, so escaping, limits and a fallback would need their own approval. The owner's handoff prefers a minimal plain-text layout within decision 9. Not chosen here.
- **Shorten or drop the `Ref`.** Rejected by the handoff: the stable id must stay whole, in the technical block.

## Consequences

- **Taller, easier to read.** The message is taller (about 17 rows for the owner's example on a desktop-wide bubble), but every line is short. In the offline bubble QA every content line fits a 390 px-wide phone bubble, except:
  - the full `Ref`;
  - the bounded legacy detail;
  - one Discovery diagnostic, `⏱ Без разрешённого прогресса: …`.
- **AIR-596 lines.** AIR-596 ([PR #979](https://github.com/vladimino/iptv-watchlist/pull/979), merged first) added held, recovery-reason, lease and orphan lines to the same renderer. In this layout:
  - the held reason (`Сейчас: …`, `Инцидент остаётся открытым`), the lease note and the 2-hour orphan bound are statistics lines;
  - a held reminder's stall is the last measured one, as in a recovery;
  - a prediction recovery's reason is its own block right after the header.

  No metric is lost.

## Recovery and migration boundary

Code-only. A revert restores the previous single-block text, and both read the same message fields. No stored state, webhook field, policy, schedule or production write is involved. This ADR authorizes no test message, secret, channel, flag or Task change.

## Evidence

- **Original decision:** [owner visual FAIL and handoff](https://trello.com/c/c0d7VD4P#comment-6b05997439ebd35630d770b2); ADR decision pending
- **Implementation:** the AIR-592 follow-up pull request
- **Dated verification:** [rendered samples and offline bubble QA](../evidence/monitoring/telegram-layout-air-592-2026-11-24.md); the final acceptance is the owner's visual check of a natural production message after deploy
- **Uncertainty:** the offline bubble approximates Telegram's font, emoji width and bubble width; it is not Telegram.

## Follow-ups

None planned. An HTML-formatted text would be its own decision.
