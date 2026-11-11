# Incomplete hourly Discovery reports, 11 November 2026

[AIR-439](https://trello.com/c/8bt41F8s). Method: reading of the code at `main` and offline tests, plus a **read-only** query of the Worker's own structured logs (Workers Observability query, no write, no Worker, flag, schedule or data change). No production event object, R2 key, D1 row or Discovery run was read or started. All times UTC unless marked Madrid.

## What was observed

The owner's Events Log of 11 Nov 2026 held four events titled «Отчёт за час неполный» with three «неизвестно» at 06:00, 10:00, 11:00 and 12:00 Madrid (05:00, 09:00, 10:00 and 11:00 UTC), beside normal reports at 07:00 to 09:00 Madrid (06:00 to 08:00 UTC); the 09:00 Madrid one said «Очередь Discovery пуста» with numeric facts.

## What the logs prove (`discovery_workflow_reconcile`, 04:30 to 11:30 UTC)

| UTC hour | Scheduled firings logged | Reconcile answered | Report in the Events Log (owner's observation) |
| --- | --- | --- | --- |
| 05:00 | one, attempt 1 | `in_progress` (a chain running) | incomplete, three unknowns |
| 06:00 | one, attempt 1 | `in_progress` | normal |
| 07:00 | one, attempt 1 | `in_progress` | normal |
| 08:00 | one, attempt 1 | `stopped` | normal, empty queue with facts |
| 09:00 | one, attempt 1 | `stopped` | incomplete, three unknowns |
| 10:00 | one, attempt 1 | `stopped` | incomplete, three unknowns |
| 11:00 | one, attempt 1 | `stopped` | incomplete, three unknowns |

- Every hour had exactly one scheduled firing and no second attempt, so **no hour was missed** and no `projector_window` wait loop ran at the reconcile.
- The reconcile of the incomplete hours answered the same way as that of normal ones (`in_progress` at 05:00 as at 06:00 and 07:00; `stopped` at 09:00 to 11:00 as at 08:00). The reconcile outcome therefore does not decide which hours failed: the failure is inside the close that follows it.
- The close itself logged nothing before this change, so its typed reason for the four hours **is not in the logs**.

## What the code proves

`closeHourlyDiscoveryReport` ended every path that could not persist the close in the **same** event: `incomplete` with every counter, `chunks`, `from` and `remaining` set to `null`, written straight to `events/items/` (not through the outbox), with `reason` one of `no_record`, `state_unreadable`, `outbox_full`, `projector_window` or `write_conflict`. All five produce what the owner saw. A successful close with an unreadable **queue** produced an `incomplete` event too (real counters, flagged incomplete), and the card drew the whole template as unknown for any `incomplete` flag.

## What is not proven

Which of the five reasons each of the four stored events carries. The reason is stored in the event's own `reason` field, which the card never prints, and the event journal is behind Cloudflare Access: it was not read in this investigation. Candidates that fit the logs: a lost compare-and-swap against a running chain at 05:00 (the chain writes the same record), and for 09:00 to 11:00 a persistent refusal of the record write after the chain stopped. The fix does not depend on which one: all five paths now behave the same way (nothing is written, one typed log line, the accumulator keeps its deltas). To close the question for the stored events, read their `reason` field (a read-only `GET /api/events?type=discovery` with an Access login) before [AIR-440](https://trello.com/c/cZJHgZeI) removes them.

## Separation requested by the card

- **Empty queue:** the 08:00 UTC report is a confirmed empty queue (numeric zeros and a `complete` continuation); unchanged.
- **Unavailable queue status:** now a persisted report with real deltas and `queueUnreadable`.
- **Failed close:** now no event and one `discovery_hour_close_failed` log line with the typed reason.
- **No scheduled firing:** not observed in this window; a gap is for the Monitor, as before.
- **Real Discovery degradation:** not hidden; a failed close never changes what the reconcile does, and `failed` / `blocked` / `waiting` statuses are written whenever the close succeeds.

## Verification

Offline only: `tests/discovery-events.mjs` (a held projector window, an unreadable record, a lost compare-and-swap, no record, an outbox at its limit, an unread queue beside real deltas, a failed hour between two reports, no second count of a delta) and `tests/activity-ui.mjs` (the card for `queueUnreadable`, hostile fields, the legacy `incomplete` card). The safe read-only operational status and a few natural hourly events after deploy remain the owner's acceptance.
