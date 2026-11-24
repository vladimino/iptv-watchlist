# ADR 0212: The exact layout of the monitor's Telegram text is maintained in the monitor reference, not in ADR 0206

**Status:** Proposed  
**Original decision date:** 2026-11-24 (the owner rejected the visual result of the first production message and returned AIR-592 for a new layout)  
**Recorded at:** 2026-11-24  
**Approval source:** not yet decided. The owner's [visual acceptance FAIL and handoff of 24 Nov 2026](https://trello.com/c/c0d7VD4P#comment-6b05997439ebd35630d770b2) asks for the follow-up and proposes a layout "as a proposal, not an approved mock-up"; it is not acceptance of this ADR. The [independent review of PR #983](https://github.com/vladimino/iptv-watchlist/pull/983#pullrequestreview-6041472920) recommends this short, one-time clarification.  
**Related work:** [AIR-592](https://trello.com/c/c0d7VD4P); [ADR 0206](0206-monitor-four-states-one-reminder-interval.md) decision 9; [ADR 0210](0210-prediction-no-progress-verdict-survives-live-runs.md); [PR #974](https://github.com/vladimino/iptv-watchlist/pull/974), [PR #983](https://github.com/vladimino/iptv-watchlist/pull/983)  
**Supersedes:** [ADR 0206](0206-monitor-four-states-one-reminder-interval.md) decision 9 in part: only the concrete line layout it prescribes (the `• label: value` statistics, the one-line `⏱ …` / `🕒 Инцидент открыт … · идёт …` / `📨 Отправлено с задержкой` forms, the severity wording, `🌐 В целом …` and `Время: … · Мадрид (Europe/Madrid)`).  
**Superseded by:** None

## Context

ADR 0206 decision 9 (accepted on 24 Nov 2026) set the content of the monitor's Telegram text. It also prescribed a concrete line layout. That layout is the bulleted single block in which the first natural production message was sent (24 Nov 2026, 14:00:23 Madrid). The owner rejected it visually: «куча сплошного текста без отступов, список неправильно форматируется, длинные предложения разрываются даже на большом экране».

Changing the spacing is not an architectural decision. A record is needed only because an accepted ADR spells out the old line layout. Without this clarification, every later spacing or wording adjustment would also become an ADR change.

## Decision

1. **What stays normative (from ADR 0206 decision 9 and ADR 0210).**
   - The text is plain, with no markup mode: sanitized, printable, at most 1800 characters.
   - Typed evidence only. The English `message` is never parsed, and unknown values read as unknown, never 0.
   - The domain's stall stays separate from the monitor's observed incident lifetime. The stall says what it is counted from, and confirmed progress is never implied by a mere absence.
   - A recovery is reported as an issue no longer seen, with a duration frozen at detection and the last measured stall as a lower bound.
   - Critical, confirmed and held states stay distinct. So do a late send and a recovery while other problems remain.
   - Times are shown in Madrid, labelled.
   - The stable `Ref` is kept whole.
2. **What is delegated.** The exact wording, spacing, line order and line splitting of the text are maintained in the [monitor reference](../reference/api/monitor.md#telegram-text) and judged by the owner's visual acceptance of natural production messages. Samples in tests and evidence are illustrations, not ADR constraints. A later adjustment within point 1 needs no ADR.
3. **The current layout,** recorded in the reference, is short blocks separated by one empty line:
   - header;
   - for a prediction recovery, its reason;
   - statistics as `Метка: значение`;
   - the domain stall, with its duration and date on separate lines;
   - the incident;
   - the overall state;
   - a technical footer with the late-send note, the Madrid time and the `Ref`.

Not decided here: an HTML `parse_mode`. It would change the plain-text safety contract and needs its own decision.

## Alternatives considered

- **Amend ADR 0206 decision 9 in place.** Rejected: it would rewrite accepted history.
- **Record every layout as an ADR.** Rejected by the review: spacing and wording are not architecture.
- **HTML `parse_mode`.** Not chosen: it changes the safety contract, and the owner's handoff prefers plain text.

## Consequences

- One reference page owns the layout. The owner's visual acceptance is the acceptance criterion for it.
- The webhook, alert policy, outbox, cooldown, identities and reads are unchanged.

## Recovery and migration boundary

Code-only. A revert restores the previous text, from the same message fields. No stored state, webhook field, policy, schedule or production write is involved. This ADR authorizes no test message, secret, channel, flag or Task change.

## Evidence

- **Original decision:** [owner visual FAIL and handoff](https://trello.com/c/c0d7VD4P#comment-6b05997439ebd35630d770b2); ADR decision pending
- **Implementation:** [PR #983](https://github.com/vladimino/iptv-watchlist/pull/983)
- **Dated verification:** [rendered samples and offline bubble QA](../evidence/monitoring/telegram-layout-air-592-2026-11-24.md). This is a simulation, not Telegram; acceptance is the owner's look at a natural production message after deploy.
- **Uncertainty:** the real Telegram rendering is observed only after deploy.

## Follow-ups

None planned.
