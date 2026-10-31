# ADR 0071: A rated legacy removal entry is linked to existing events of the same film id

**Status:** Proposed  
**Original decision date:** 2026-10-31  
**Recorded at:** 2026-10-31  
**Approval source:** Pending owner decision. Independent review does not accept this record.  
**Related work:** [AIR-303](https://trello.com/c/mCvySjUN); [ADR 0060](0060-independent-letterboxd-ratings-pipeline.md); [ADR 0043](0043-removal-rating-lookup-queue.md); [evidence](../evidence/letterboxd/air-303-legacy-removal-events-2026-10-31.md)  
**Supersedes:** In part: [ADR 0060](0060-independent-letterboxd-ratings-pipeline.md) decision 3, the sentence that a version 1 entry migrated as `legacy: true` with `refs: []` promises nothing for an event. That promise stays for an entry that is not `rated` with a confirmed half-star. The migration shape, reopen-on-new-reference rule, retention of unresolved references, and every other decision of that record stay.  
**Superseded by:** None

## Context

- **ADR 0060 decision 3** stores one lookup per film and one reference per removal event. A version 1 entry has no event key. Migration writes `refs: []` and `legacy: true`. The rating can still become a fact. The entry promises nothing for an event and is pruned by the version 1 rules. `settleRemovalRefs` writes a confirmed rating only onto events named by unresolved references.
- **Diary resolution does not add a reference.** `resolveRemovalByDiary` marks the queue entry `rated` with `lastResult: diary` and leaves `legacy` and `refs` as they are. The fact is stored. The historical watchlist events are not.
- **Production shape on 2026-10-31, as recorded on AIR-303 from read-only checks.** One legacy queue entry (`entries: 1`, `legacy: 1`, `refs: 0`, hand-over films `0`, `ratings_storage_migrate` `dry_run` `writes: 0`). The same film was removed twice, and both removal events stayed in «Остальные удаления» after a Diary rating. The manual EPG run `d035ce87-3fbc-4edd-aeac-ecf5a84d8aed` reached `programme` complete; inline ratings were interrupted in `post_commit` with `ratingAttempt: unknown` and `removalRatingLookup.checked: 0`. This record does not repeat those reads and does not include a diary row or a rating value. Counts and the run id are in the evidence note.
- **A full scan on every EPG commit or every ordinary ratings step is the wrong repair.** `enrichRecentRemovalRatings` already lists up to 100 events on the inline path. Putting that on the EPG commit, or on every removal step after the repair, walks `events/items/` for no further work. `addRemovalRef` must not be reused for this repair: a new reference on a finished entry reopens it to `pending` and would start another Letterboxd lookup.
- **Number.** On 2026-10-31, `main` ended at ADR 0069. Open [PR #291](https://github.com/vladimino/iptv-watchlist/pull/291) already carries Accepted ADR 0070, the metadata-sync freshness clocks ([AIR-311](https://trello.com/c/81P7wg4u)). That acceptance belongs to that record. This record is 0071. No other open branch held 0071.

## Decision

A ratings removal step links a rated legacy entry to existing watchlist-removal events, then the existing settle writes the rating the entry already holds.

- The candidate is a version 2 entry with `legacy: true`, `state: rated`, a confirmed half-star, and `legacyLink.done` not set. Any other legacy entry is unchanged and is not a reason to list events.
- One `events/items/` list page of 20 keys per removal step. The cursor and the snapshotted film ids live on the queue as `legacyLink` until that scan finishes. A step with no candidate and no cursor does not list.
- Match is the exact film id on `event.removed` of a stored watchlist event. A different id, including the same title and another year, is not a match. The removal is not treated as a viewing. No rating is invented. No event is created.
- Attaching a reference does not reopen the entry: `state`, `attempts`, `rating`, `lastResult` and `claim` stay. `addRemovalRef` is not used.
- When the list is exhausted, each snapshotted candidate gets `legacyLink.done`. If it has at least one reference, `legacy` is cleared and the new references stay unresolved for `settleRemovalRefs`. If it has none, `legacy` and `refs: []` stay, so version 1 retention still applies, and later steps do not list.
- Settle then writes the stored half-star. `withRemovalRatings` does not replace a confirmed rating already on the event. The reference resolves when the stored event lists that film as removed with a confirmed rating. A missing event stays `event_missing` and is not recreated.
- Retention does not run while the scan is unfinished, so an old unmatched `refs: []` entry is not deleted between pages. After the scan, unresolved references follow the existing rule and are not pruned.
- The run checkpoint `legacyPagesLinked` counts pages whose queue write succeeded. Two interrupted runs at different page counts are not the same checkpoint. The queue cursor is the authority; the counter only feeds isolation. An absent `legacyPagesLinked` compares as 0, so a run stored before this field still matches a new run that linked no page. 0 does not match 1. Other checkpoint fields still treat absence as null, not as zero.
- The EPG commit, `ratings_sync_status`, and `ratings_storage_migrate` do not list events for this repair. A code deploy does not start a ratings run.

What this record does **not** decide: a production ratings run, a flag change, a Task edit, a storage migration, a backfill outside the next owner-approved ratings removal phase, a new Letterboxd request, or a change to how a new v2 removal enqueues its own event.

## Alternatives considered

- **One-shot migration inside `ratings_storage_migrate`.** The queue is already migrated (`dry_run` reported `already` on the card). A second migration would walk every event in one call and would write during a tool whose contract is the version conversion. A killed call would need its own cursor anyway. Rejected for this repair.
- **Scan on every EPG commit.** The commit already has a memory ceiling, and the missing references are historical. New removals already enqueue their own event key. Rejected.
- **Reopen the rated entry through `addRemovalRef`.** That starts a new lookup and can replace a finished diary result with `pending`. Rejected.

## Consequences

- The first removal steps after this code is deployed, and only if an owner-approved ratings run is later started while a rated legacy entry remains, walk `events/items/` twenty keys at a time. The observed volume is one legacy entry and two removal events for that film. The cost is the length of the event prefix, once, not a list on later steps.
- A second removal of the same film after the scan uses the existing v2 enqueue. It is not another full scan.
- Two diagrams in `docs/architecture/scheduling-and-orchestration.md` change: the ratings sequence diagram gains one optional list page, and the ratings state diagram's removal loop names that page. The drift sequence diagram does not change. Both changed diagrams need the owner's visual approval before merge. This record stays Proposed until the owner accepts or declines it. Open PR #291 splits the earlier scheduling diagrams for the metadata-sync clocks and does not edit these two ratings diagrams. If that pull request reaches `main` first, keep both edits.

## Recovery and migration boundary

No new R2 object and no change to `ratings_storage_migrate`. The cursor is a field on the existing queue. A kill mid-page leaves the previous cursor; the next removal step repeats that page, and references are idempotent. Clearing `legacy` after a successful link is reversible only by a later code change; the event rating, once settled, stays under the existing event merge, which keeps a confirmed half-star. This record authorizes no flag, Task, EPG, Diary, lookup, R2 or D1 operation. Merge does not backfill.

## Evidence

- **Original decision:** the body of [AIR-303](https://trello.com/c/mCvySjUN), which records the read-only counts. This session did not repeat a production read.
- **Implementation:** the pull request that delivers this record. The historical sentence in ADR 0060 decision 3 is left in place; the supersession is the header pointer on that record.
- **Dated verification:** [air-303-legacy-removal-events-2026-10-31.md](../evidence/letterboxd/air-303-legacy-removal-events-2026-10-31.md) for the discrepancy, and offline tests in `tests/ratings-legacy-link.mjs`. No production ratings step is part of this record.
- **Uncertainty:** the exact number of `events/items/` keys in production was not counted here. The repair is paged by 20, so the count changes the number of removal steps, not the match rule.

## Follow-ups

An owner-approved ratings run, after this code is deployed, is what would walk the prefix and settle the stored rating. That run is a separate approval. AIR-295 is not blocked by this record.
