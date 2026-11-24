# ADR 0209: The Discovery report-fault ledger is kept in two R2 objects with a best-effort combined admission bound

**Status:** Accepted (Product Owner selected option A on 24 November 2026)  
**Original decision date:** 2026-11-24  
**Recorded at:** 2026-11-24  
**Approval source:** [owner decision on AIR-595, 24 Nov 2026: «конечно A»](https://trello.com/c/dPjrNIbQ#comment-6b056ce779079110d0ef3bb5), choosing between the alternatives of [review 6037893485 on PR #977](https://github.com/vladimino/iptv-watchlist/pull/977#pullrequestreview-6037893485); [recorded on the PR](https://github.com/vladimino/iptv-watchlist/pull/977#issuecomment-7129406215)  
**Related work:** [AIR-595](https://trello.com/c/dPjrNIbQ), [PR #977](https://github.com/vladimino/iptv-watchlist/pull/977), [ADR 0118](0118-discovery-report-failure-notice.md), [ADR 0135](0135-epg-priority-discovery-pause.md), [evidence](../evidence/discovery/air-595-discovery-report-empty-and-epg-pause-2026-11-24.md), [events reference](../reference/domain/events.md#discovery-hourly-report-discovery)  
**Supersedes:** [ADR 0118](0118-discovery-report-failure-notice.md), in part: the storage of the notice ledger in one object and the strictness of its 8,760-entry admission bound and one-entry-per-hour rule across concurrent writers. Everything else in ADR 0118 stands  
**Superseded by:** None

## Context

ADR 0118 keeps the `report_failed` notices that the journal refuses in one R2 object, `events/discovery-report-faults.json`, as four-element tuples `[generation, hour, reason index, status index]`. It never evicts, refuses the newest entry at 8,760, and drains at most 64 entries a firing, oldest first. Each write uses one compare-and-swap on that object.

AIR-595 adds notices that the Worker before it cannot decode: the `epg_priority` reason (a close refused by the EPG-priority pause of ADR 0135) and a `fault` beside it (`queue_unreadable`). The earlier Worker filters out every tuple it cannot decode when it writes its ledger back. If the new tuples shared that object, a code rollback would silently drop them, which contradicts "never evict".

Keeping them in a second object protects them on rollback, but admission then writes two objects with two independent compare-and-swaps. ADR 0111 contemplates concurrent hourly firings. Two firings that read the same combined count can each add one entry to a different object. A concurrent repeat of one hour with two reason classes can queue two tuples, one per object. A strict global bound would need a new serialization mechanism (a lock, or a D1 table and migration) for an outage-only path.

## Decision

Option **A**:

1. **Two objects, one logical ledger.** `events/discovery-report-faults.json` holds only the tuples the pre-AIR-595 Worker decodes (four elements, one of its five reasons). `events/discovery-report-faults-v2.json` holds the five-element tuple `[generation, hour, reason index, status index, fault index]` of any notice the older Worker cannot rebuild. The older Worker never reads or writes the v2 object.
2. **Per-object compare-and-swap.** Each object is written only under its own compare-and-swap. Nothing is ever evicted.
3. **Best-effort combined admission.** Before queuing, a writer reads both objects. It refuses the notice as `lost` when the combined count it observed has reached 8,760. It treats the notice as already `queued` when the same generation and hour is pending in either object. Under simultaneous writers to different objects, and while a rollback has the older Worker bounding only its own object, the total can stand above 8,760 and an hour can have two pending tuples. This is accepted as a bounded exception. Once the observed combined count reaches the bound, no new entry is admitted until the drain frees space.
4. **Strict delivery guarantees.** A firing merges both objects, orders the entries by hour (oldest first, of the set it read), and fixes one batch of at most 64 journal puts before the first put. It then cleans each object under its own compare-and-swap. No failure path adds puts or refunds the bound, and an uncertain cleanup answers `pending: null`. The journal's create-only identity (`discovery-hour-<generation>-<hour>`) keeps one visible event per hour, whatever the number of pending tuples. A later firing finds a delivered hour `exists` and removes its tuples. The deltas of a period stay in the executor accumulator and are reported exactly once.

Not decided here: any change to the journal, the executor record, the outbox, the EPG-priority gate, the drain bound or the hourly report itself.

## Alternatives considered

- **A. Accept the bounded best-effort exception** (chosen). No new coordination mechanism for an outage-only path. The deviation is bounded by the number of simultaneous writers (in practice one or two firings) and by the rollback window.
- **B. Strict global admission.** A new serialization mechanism, a lock or a D1 table with a migration, so that the bound and the one-entry-per-hour rule are atomic across both objects. Rejected by the owner as disproportionate to an emergency limit on a storage outage path.
- **Keep one object** (implicit in the first review). Loses the new tuples on a code rollback, because the older Worker rewrites the object without the tuples it cannot decode. Rejected in review.

## Consequences

- No pending notice is lost by a code rollback: v2 entries wait unevicted and are delivered once after the roll forward.
- The 8,760 bound and the one-entry-per-hour rule are guarantees for a single writer and best effort across simultaneous writers to different objects. Neither can cause a second visible event or a lost or doubled delta.
- One more small R2 object exists, written only when the journal refuses a notice the older Worker cannot decode.
- The drain reads two objects per firing. When both are absent, both reads return nothing.

## Recovery and migration boundary

Code only. No migration, flag, Task, Access or schedule change, and no production operation. A code revert leaves both objects in place: the older Worker keeps draining its own object, and the v2 entries wait for the roll forward. This ADR authorizes no operation.

## Evidence

- **Original decision:** [owner decision on AIR-595](https://trello.com/c/dPjrNIbQ#comment-6b056ce779079110d0ef3bb5); [PR comment](https://github.com/vladimino/iptv-watchlist/pull/977#issuecomment-7129406215).
- **Implementation:** [PR #977](https://github.com/vladimino/iptv-watchlist/pull/977); `src/discovery-workflow.js` (`encodeDiscoveryReportFault`, `deliverDiscoveryReportFailure`, `deliverDiscoveryReportFaults`, `cleanDiscoveryReportFaults`).
- **Dated verification:** offline only, `tests/discovery-events.mjs`:
  - 18c: the older reader's decode rule, copied verbatim.
  - 18d: one logical ledger: order, the drain bound under thrown cleanup and a refused CAS, idempotent recovery, the observed bound, one entry per hour.
  - 18e: a deterministic interleaving of two admissions at 8,759 (8,761 entries, the next refused, the drain bound held) and of one hour with two reason classes (two tuples, one visible event after replay).
- **Uncertainty:** no production observation. The deviation under real concurrency is reasoned from the code and the interleaving test, not measured.

## Follow-ups

None required. A strict mechanism (option B) would need its own ADR and owner decision.
