# ADR 0153: One owner-fenced policy exclusion retires an already admitted Documentary or concert recording

**Status:** **Accepted** (2026-11-16; explicit Product Owner acceptance of the writer architecture recorded on [AIR-504](https://trello.com/c/jUaNE1Rs#comment-6afaef1360a439c34d32d291), after independent exact-HEAD review of [PR #676](https://github.com/vladimino/iptv-watchlist/pull/676#pullrequestreview-5919508974). This approval permits delivery of the implementation, **not** any production Film exclusion or other data mutation)  
**Original decision date:** 2026-11-16  
**Recorded at:** 2026-11-16  
**Approval source:** [AIR-504 owner acceptance, 2026-11-16](https://trello.com/c/jUaNE1Rs#comment-6afaef1360a439c34d32d291)  
**Related work:** [ADR 0150](0150-documentary-and-concert-film-exclusion.md), [ADR 0080](0080-discovery-identity-correction.md), [AIR-500](https://trello.com/c/dD3BRQ2H), [AIR-501](https://trello.com/c/ShipZn0N). Numbered 0153 because [ADR 0152](0152-prediction-retry-attempt-budget.md) is the AIR-505 retry budget.  
**Supersedes:** None  
**Superseded by:** None

## Context

ADR 0150 withholds new Discovery Film admissions for any TMDB Documentary and for a recording of a real concert. Films admitted before that gate remain in `discovery_admission`, on discovery-basis EPG shows, and in the prediction queue. `discovery_identity_correct` rejects **one** observation: it does not supersede the admission, so `refreshPredictionQueue` rebuilds the film from the catalog again.

AIR-504 needs one coordinated correction per Film that applies to every related observation, drops the catalog admission, unassigns discovery shows, and keeps the film out of the prediction queue, without rewriting the published EPG generation or deleting personal ratings, fingerprints or immutable predictions.

## Decision

1. **Capability.** `catalog_policy_exclude@1` is an owner-only Access write on one current movie admission `tmdb_<id>`. The Worker classifies the stored payload with the same ADR 0150 `admissionPolicy` as the detail gate and as `GET /api/programme`: genres/genre ids, title/aliases, and **synopsis as overview** when `overview` is empty. Eligible kinds are `documentary` and `concert`. An ambiguous Music-only Live token, a TV Movie without independent recording phrases, a feature-genre film and a missing admission are not eligible.
2. **One batch.** Under the resolver lease and the open Discovery fence, `ownerPolicyExclude` rejects every current movie decision with that TMDB id. Preview and writer use the same `tmdb_id` movie query. If any of those decisions names another `film_id` whose admission is still current on a different TMDB id, the write is `linked_admission` and changes nothing. The observation cap is `floor((STATEMENT_CAP-4)/3)` (12 at `STATEMENT_CAP` 40): each verified reject costs three statements plus four fence/admission statements, all-or-nothing. The batch deletes current-generation `published_epg_show` rows with `basis='discovery'` for those observation keys, and sets the admission `state` to `superseded`. History rows keep the before-image. `rejectedTmdbIds` keeps the excluded id first and drops older ids if the list would exceed eight.
   **Show boundary (AIR-504 vs sealed EPG).** The completed programme overlay (`completeProgramme` / `ASSIGNED_SHOWS_SQL`) adds only `basis='discovery'` rows: they become `catalogFilms` or extra shows on a sealed member. That is the user-visible Discovery projection this writer unlinks, so the original EPG slot is no longer a Film assignment and stays unresolved/nonfilm on the sealed document. Rows with `title_year` / `title_unique` / `title_duration` are sealed EPG-scan matches copied with the generation; they are not that overlay. This writer does not rewrite the published generation and does not delete those sealed rows (or unrelated slots). **Programme projection (owner 2026-11-16).** `GET /api/programme` withholds a sealed watchlist member and a catalog overlay Film from the interesting-programme payload when stored metadata proves ADR 0150 `documentary` or `concert` (`admissionPolicy` on the Film card: genres/genre ids, synopsis as overview, title/aliases; no TMDB lookup, no title-fragment-only hide). `GET /api/watchlist` and personal ratings/Diary/history stay. An ambiguous Music-only Live token and a film whose stored metadata cannot classify stay presented rather than silently excluded. `GET /api/catalog/available` uses the same withhold so a catalog-only Documentary or concert is not offered as a Film. The four AIR-504 hot examples had no `watchlist_film`.
3. **Queue.** After the D1 batch, the same POST calls `settleQueueFilms` through `mutatePredictionQueue` (not gated on programme generation) and then `refreshPredictionQueue`. A cold id outside a batch window is still removed. `already_applied` retries that queue reconcile. Durable success is reported only when the film is absent from pending, hot, cold, priority, work and retries, or when no queue object exists. A present, conflicted or unread queue is `queue_unreconciled` (409) even if Discovery already wrote. `allEnrichmentFilms` also skips ADR 0150 exclusions so a Letterboxd watchlist row cannot re-queue a documentary or concert recording. Ratings and fingerprint objects are not deleted.
4. **Not a Film delete.** Film/Person R2 objects, Letterboxd facts and `film_retention` are unchanged. If a later owner wants a canonical Film retirement, that is a separate Film/Person write after AIR-499.
5. **Idempotence.** A superseded admission is `already_applied` for Discovery and still retries the queue reconcile. An R2 receipt is bound to that `filmId` and `catalog_policy_exclude`; reusing the idempotency key for another film is `idempotency_conflict` and writes nothing. A final unread prediction queue after settle is `queue_unreconciled` (`unknown`), not success.
6. **No production write.** Shipping the route does not authorize a live exclude. Each film still needs an owner GO.

Not decided: bulk application of the AIR-500 inventory, a new `discovery_intent` kind, and reversing a policy exclusion.

## Alternatives considered

- **Loop `discovery_identity_correct` per observation.** Rejected: a reject does not supersede `discovery_admission`, and the next queue rebuild re-admits the film.
- **Blind `DELETE` of the Film.** Rejected when watchlist or ratings exist; even without them, personal history and immutable predictions stay.
- **Schema migration for a `policy_exclude` intent kind.** Deferred: the writer fences with the resolver lease and an R2 action receipt; `discovery_intent` CHECK still lists only reconsider and identity kinds.

## Consequences

Owners can retire one wrongly admitted Documentary or concert film without waiting for a new EPG generation. The next Discovery chunk will not re-verify the rejected TMDB id on those keys. A Music-only title that is only ambiguous still needs a human decision, not this writer.

## Recovery and migration boundary

The write is reversible only by a later owner-approved restore of the admission and decisions. A code rollback does not re-admit superseded rows. Production application of the writer is a separate L2/L3 GO, not this ADR.

## Evidence

- **Original decision:** [AIR-504](https://trello.com/c/jUaNE1Rs)
- **Implementation:** this PR
- **Dated verification:** [AIR-504 inventory](../evidence/discovery/air-504-policy-exclusion-inventory-2026-11-16.md) (reclassification of AIR-500 under ADR 0150; no production write)
- **Uncertainty:** live D1 counts may have moved since the AIR-500 capture; each execute still re-reads the admission

## Follow-ups

Owner-authorized per-film executes against the hot examples named on AIR-504. No Scheduled Task.
