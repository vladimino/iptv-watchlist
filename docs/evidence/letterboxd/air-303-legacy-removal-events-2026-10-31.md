# AIR-303: a rated legacy removal entry names no event

**Captured:** 2026-10-31, from the read-only figures recorded on [AIR-303](https://trello.com/c/mCvySjUN). This note does not repeat a production read, and it contains no diary row, rating value or R2 payload.

**Scope.** The removal queue after `ratings_storage_migrate` `dry_run`, and the watchlist-removal events of one film that the card identifies. Denominator: that one queue entry and the two removal events named for it.

| Observation | Value |
| --- | --- |
| Queue entries | 1 |
| Legacy entries | 1 |
| References | 0 |
| Hand-over films | 0 |
| `dry_run` writes | 0 |
| Removal events for that film still without a half-star | 2 |
| Manual EPG run | `d035ce87-3fbc-4edd-aeac-ecf5a84d8aed` |
| Programme | complete |
| Inline ratings | interrupted in `post_commit` |
| `ratingAttempt` | `unknown` |
| `removalRatingLookup.checked` | 0 |

The same film was removed, added again, and removed again (29 Oct 18:07, 30 Oct 17:03 and 31 Oct 10:55 Europe/Madrid). Both removal events remained in «Остальные удаления». The Diary rating is a fact on the legacy entry. `settleRemovalRefs` writes only events named by `refs`, and this entry has none.

**Verdict.** The gap is real on those counts. The repair in [ADR 0070](../../adr/0070-legacy-removal-event-link.md) is a checkpointed page inside a later ratings removal step, not a write performed by this note.

**Authority.** Authorizes no ratings run, flag, Task, migration, EPG commit or R2/D1 write. A deploy of the repair does not itself list or update the events.

**Uncertainty.** The length of `events/items/` was not counted. It changes how many removal steps a later approved run would take, not whether the two events match by film id.
