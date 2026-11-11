# ADR 0116: An hour whose Discovery report cannot be completed is reported by a compact notice, never by unknowns, and delivered by an independent bounded path

**Status:** Proposed (the owner rejected the first version of this ADR on 11 November 2026; this revision implements the owner's required behavior and awaits independent review and owner acceptance)  
**Original decision date:** 2026-11-11  
**Recorded at:** 2026-11-11  
**Approval source:** the Product Owner's scope of [AIR-439](https://trello.com/c/8bt41F8s) and the owner's product decision on [PR #523](https://github.com/vladimino/iptv-watchlist/pull/523) of 11 November 2026: every real scheduled hourly cron must produce a user-visible Discovery event with a truthful status, including when the report close fails; a missing event must not mean either a Discovery failure or a report failure; no three unknown values, no invented zeros; accumulated deltas and exactly-once attribution preserved; a failed compare-and-swap cannot persist its own failure, so an independent bounded idempotent fallback path with one stable identity per generation and hour is required, with eventual durable recovery when the journal is unavailable  
**Related work:** [AIR-439](https://trello.com/c/8bt41F8s), [AIR-440](https://trello.com/c/cZJHgZeI) (one-time cleanup of the four stored events, a separate owner-gated operation), [ADR 0111](0111-discovery-hourly-reports.md), [RCA of 11 Nov 2026](../evidence/discovery/air-439-incomplete-hourly-reports-rca-2026-11-11.md), [events reference](../reference/domain/events.md)  
**Supersedes:** [ADR 0111](0111-discovery-hourly-reports.md), the part of Decision 4 that writes an `incomplete` event with every number `null` when a close cannot be persisted, and the consequence "an incomplete event occupies its hour key". Everything else in ADR 0111 stands  
**Superseded by:** None

## Context

ADR 0111 gives every real scheduled hourly cron one report. When the close could not be persisted (a held projector window, lost compare-and-swaps, an unreadable record, an outbox at its limit, no record) it wrote an `incomplete` event whose counters and remainder were all `null`. The Events Log then showed «Отчёт за час неполный» with three «неизвестно», which says nothing, repeats, and crowds the «Находки» filter. On 11 Nov 2026 four such events were stored. Two things were wrong with them: the three unknowns (content-free), and the same fallback treating an unreadable **queue** as an unreadable **period**. The first revision of this ADR removed the event altogether; the owner rejected that, because an hour without a line cannot be told from a Discovery failure.

## Decision

1. **Every scheduled hour has a line with a truthful meaning.** A close that is persisted writes the normal report (real counters, queue status). An hour whose close cannot be persisted writes one **notice**: kind `report_failed`, «Отчёт за час не удалось сформировать. Накопленные данные войдут в следующий успешный отчёт.» It carries only `id`, `at`, `generation`, a typed `reason` (`no_record`, `state_unreadable`, `outbox_full`, `projector_window`, `write_conflict`) and `status`. It has **no counter, no queue fact, no `from`**: there is nothing to show as a number, an unknown or a zero.
2. **Discovery is named only when confirmed.** `status` is `failed`, `waiting` or `blocked` only when the reconcile of that firing answered so, and the card then adds the fixed sentence of that state; `running`, `idle` and every other value are stored as `null` and the card says nothing about Discovery. A report failure never implies a Discovery failure.
3. **Unread queue beside real deltas.** A persisted close whose queue reading is unavailable keeps its real counters, with `remaining` `null`, `queueEmpty` `false`, `incomplete` `false` and `queueUnreadable` `true`; the card shows the numbers and «не удалось прочитать» for the remainder.
4. **The notice does not travel through the record that failed.** A failed compare-and-swap, a held window or an unreadable record cannot persist their own failure, so the notice is not stored in the executor record. It has one stable identity `discovery-hour-<12 characters of the generation>-<UTC hour>-report-failed` and is put **create-only straight into the journal** (`events/items/`): a repeat, a replay or a concurrent firing of the same hour finds the key and keeps the first. A normal report of the same hour (a later duplicate firing that does succeed) has its own id and is never dropped by the notice.
5. **Eventual durable recovery when the journal refuses the notice.** The notice then waits in a separate **ledger**, one small R2 object `events/discovery-report-faults.json` with its own etag and compare-and-swap, bounded to 48 entries (the oldest leave first and `dropped` counts them). Every later scheduled firing drains the ledger **before** it closes its own hour: an entry leaves only after a confirmed create-only put, and a lost ledger compare-and-swap is retried a bounded number of times. The log line says `delivered`, `queued` or `lost`; availability is **eventual** during an outage, never claimed as instant. If both the journal and the ledger refuse (a storage outage in the one bucket) nothing can be persisted: the hour has only the log line (`lost`), and the next successful report reaches back through its `from`.
6. **Exactly-once attribution is unchanged.** A failed close never touches the accumulator (`report`, `seen`, `lastClosedHour`) and never moves a chunk into an outbox, so the next successful report carries the deltas once; a prolonged failure produces one notice per hour and the accumulator keeps growing. Empty stays strict: numeric zeros, no error and a `complete` continuation of the same generation.
7. **Nothing else changes.** One report per scheduled firing, deltas by commit time, the bounded outbox and its idempotent delivery, UTC hour identity, generation handoff, DST, no lease, no Discovery step, no TMDB call. Events stored before this decision, including `incomplete` ones, stay readable with their card; removing the four existing ones is [AIR-440](https://trello.com/c/cZJHgZeI).

## Alternatives considered

- **No event for a failed close (the first revision).** Rejected by the owner: a missing line is ambiguous between Discovery and reporting failures.
- **Keep the all-null `incomplete` event.** Rejected: three unknowns say nothing and look like a Discovery fault.
- **Store the notice in the executor record's outbox.** Rejected: it is the write that failed.
- **A column or table in D1 for the ledger.** Adds a second authority surface and a migration; the journal and the ledger live in the same R2 bucket the Events Log already uses, with the create-only and compare-and-swap primitives the Worker already relies on.

## Consequences

- A bad hour has one compact, honest line; the Events Log never shows unknowns, zeros or a fake Discovery failure.
- One more small R2 object exists, written only when the journal refuses a notice, bounded at 48 entries.
- During a journal outage the notices are delayed, not instant; during a total storage outage the hour has only a log line.
- Rollback of the code does not remove stored events, the ledger or the `queueUnreadable` field; old code ignores them (a notice of an unknown kind is drawn by the generic Discovery card of the older code).

## Recovery and migration boundary

Code, tests and documents only. No production run, flag, schedule, lease, R2 or D1 write by an operator or event deletion is authorized; the cleanup of existing events needs its own owner GO.

## Evidence

[RCA of 11 Nov 2026](../evidence/discovery/air-439-incomplete-hourly-reports-rca-2026-11-11.md); `tests/discovery-events.mjs` (a held window, an unreadable record, a lost compare-and-swap, no record, an outbox at its limit; one stable notice per hour, a replay and a duplicate; a confirmed Discovery state named or not; a prolonged failure and the later successful report that carries every delta once and reaches back; the journal refusing the notice, the ledger drained by the next firing, a bounded ledger and a double refusal logged as `lost`) and `tests/activity-ui.mjs`.

## Follow-ups

[AIR-440](https://trello.com/c/cZJHgZeI): remove the four stored events after this change is deployed.
