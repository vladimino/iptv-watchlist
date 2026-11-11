# ADR 0116: An hour whose Discovery report cannot be persisted writes no event; an unread queue is said beside real deltas

**Status:** Proposed (changes one decision of the Accepted ADR 0111 and so needs the Product Owner's confirmation of the trade-off in Decision 1; the owner's card scope asks for exactly this, see Approval source)  
**Original decision date:** 2026-11-11  
**Recorded at:** 2026-11-11  
**Approval source:** the scope of [AIR-439](https://trello.com/c/8bt41F8s) written by the Product Owner on 11 November 2026 (no event of unknowns; real `added` and `checked` when only the queue is unreadable; a new ADR superseding 0111 if "an event in every hour at any cost" conflicts with honest events). Acceptance of this ADR is pending  
**Related work:** [AIR-439](https://trello.com/c/8bt41F8s), [AIR-440](https://trello.com/c/cZJHgZeI) (one-time cleanup of the four stored events, a separate owner-gated operation), [ADR 0111](0111-discovery-hourly-reports.md), [RCA of 11 Nov 2026](../evidence/discovery/air-439-incomplete-hourly-reports-rca-2026-11-11.md), [events reference](../reference/domain/events.md)  
**Supersedes:** [ADR 0111](0111-discovery-hourly-reports.md), the part of Decision 4 that writes an `incomplete` event with every number `null` when a close cannot be persisted, and the consequence "an incomplete event occupies its hour key". Everything else in ADR 0111 stands  
**Superseded by:** None

## Context

ADR 0111 gives every real scheduled hourly cron one report. When the close could not be persisted (a held projector window, lost compare-and-swaps, an unreadable record, an outbox at its limit, no record) it wrote an `incomplete` event whose counters and remainder were all `null`. The Events Log then showed «Отчёт за час неполный» with three «неизвестно», which says nothing, repeats, and crowds the new «Находки» filter. On 11 Nov 2026 four such events were stored (06:00, 10:00, 11:00 and 12:00 Madrid) beside normal reports at 07:00 to 09:00. The same fallback also made an unreadable **queue** look like an unreadable **period**, although the deltas of the period were known.

## Decision

1. **No event of unknowns.** An hour whose close cannot be persisted writes **nothing** to the Events Log. The accumulator keeps its deltas (as before), so the next successful report carries them once and its `from` shows how far back it reaches. The failure is one bounded typed log line `discovery_hour_close_failed` (`reason` one of `no_record`, `state_unreadable`, `outbox_full`, `projector_window`, `write_conflict`; `hourKey`; the 12-character generation), never an event and never a zero. **Trade-off, for the owner:** "one event per scheduled hour" now holds only when its facts are saved; an hour that failed has no line of its own, and a gap is visible in the next report's period and in the log, not as a placeholder.
2. **An unread queue beside real deltas.** When the close is persisted and only the queue reading is unavailable, the event keeps its real counters and `chunks`, has `remaining` `null`, `queueEmpty` `false`, `incomplete` `false` and the new `queueUnreadable` `true`. The card shows the real numbers, «не удалось прочитать» for the remainder and one note, and never «Отчёт за час неполный».
3. **Empty stays strict.** «Очередь Discovery пуста» still needs proven numeric zeros of `remaining` and the cheap-pass remainder, no error, and a `complete` continuation of the same generation. Absence of a record is not a zero.
4. **Nothing else changes.** One report per scheduled firing when it can be saved, deltas by commit time, the bounded outbox and its idempotent create-only delivery, hour identity in UTC, generation handoff, DST, no lease, no Discovery step, no TMDB call. Stored events written before this decision, including `incomplete` ones, stay readable and keep their card; removing the four existing ones is [AIR-440](https://trello.com/c/cZJHgZeI).

## Alternatives considered

- **Keep the incomplete event and only hide it in the UI.** The journal would still hold them and the filter would still count them. Rejected.
- **Write a placeholder for every hour regardless.** Contradicts the owner's request that nothing content-free be published.
- **Persist a failure counter in the record.** The write that failed is the one that would carry it; adds a second writer for a diagnostic. Not adopted; the log line is the bounded signal.

## Consequences

- The Events Log has fewer lines in a bad hour and none of unknowns; the next report is larger and says where it starts.
- A persistent failure of the close is now visible only in the Worker logs and in the executor record staying at an old `lastClosedHour` / `report.since`, not in the journal.
- The new event field `queueUnreadable` is additive; readers that ignore it show «неизвестно» for the remainder as before.
- Rollback of the code does not remove stored events or the field.

## Recovery and migration boundary

Code, tests and documents only. No production run, flag, schedule, lease, R2 or D1 write or event deletion is authorized; the cleanup of existing events needs its own owner GO.

## Evidence

[RCA of 11 Nov 2026](../evidence/discovery/air-439-incomplete-hourly-reports-rca-2026-11-11.md); `tests/discovery-events.mjs` (a held window, an unreadable state, a lost compare-and-swap, no record, an outbox at its limit, an unread queue beside real deltas, a failed hour between two reports) and `tests/activity-ui.mjs`.

## Follow-ups

[AIR-440](https://trello.com/c/cZJHgZeI): remove the four stored events after this change is deployed.
