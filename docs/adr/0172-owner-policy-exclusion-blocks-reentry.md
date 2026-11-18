# ADR 0172: A film the owner retired on policy grounds does not re-enter Discovery through a new observation key

**Status:** **Accepted** (2026-11-18; explicit Product Owner decision recorded on [PR #754](https://github.com/vladimino/iptv-watchlist/pull/754#issuecomment-6983206270) after the independent [technical PASS on HEAD `81fa7df`](https://github.com/vladimino/iptv-watchlist/pull/754#pullrequestreview-5959669822). This records an admission rule, not permission to exclude any Film, and authorizes no execute of `catalog_policy_exclude` on the six remaining current films, no Discovery, EPG, TMDB or prediction run, no Task, flag, Access or storage change)  
**Original decision date:** 2026-11-18  
**Recorded at:** 2026-11-18  
**Approval source:** [Product Owner decision on PR #754, 18 November 2026](https://github.com/vladimino/iptv-watchlist/pull/754#issuecomment-6983206270) (the owner's decision, recorded as durable provenance and not as an independent production receipt)  
**Related work:** [AIR-501](https://trello.com/c/ShipZn0N), [ADR 0153](0153-catalog-policy-exclusion.md), [ADR 0169](0169-writer-only-catalog-cleanup-classification.md), [ADR 0171](0171-owner-reviewed-policy-exclusion-list.md), [ADR 0150](0150-documentary-and-concert-film-exclusion.md)  
**Supersedes:** None. It qualifies [ADR 0153](0153-catalog-policy-exclusion.md) rule 2: the writer's `rejectedTmdbIds` guard is per observation key, and this ADR adds an identity-level guard for the films the owner retired.  
**Superseded by:** None

## Context

`catalog_policy_exclude@1` rejects the verified decisions of the observation keys that point at a film and supersedes its admission. The rejection (`rejectedTmdbIds`) lives on those decision rows and `ownerRejected` reads it per observation. A different EPG observation key that resolves to the same TMDB movie has no such rejection. The independent review of PR #754 found that such a key can reach `detail_verified` again for a card the ADR 0150 gate does not exclude by itself (for example a Music-only card with an empty or placeholder synopsis), and `upsertAdmissions` then sets the admission `current` even over a `superseded` row. It applies to every film the writer has retired (160 distinct TMDB ids by 2026-11-18T14:30Z) as well as the six reviewed ones.

## Decision

1. `OWNER_POLICY_EXCLUDED_TMDB_IDS` in `src/domain/resolution-acceptance.js` lists the TMDB ids the owner retired on policy grounds: the 160 distinct ids that `catalog_policy_exclude@1` had written, plus the six reviewed ids of [ADR 0171](0171-owner-reviewed-policy-exclusion-list.md) that await an owner GO.
2. `acceptScoredIdentity` returns `candidate_decision` / `no_confident_match` / `owner_policy_excluded` for an accepted TMDB id on that list when the catalog holds no current admission of it. This applies on the first pass (before any TMDB detail read) and after it, and **an owner confirmation does not lift it**. A proven Documentary or concert recording keeps its more specific ADR 0150 reason on the detail pass.
3. The two `known_epg_alias` shortcuts in `src/discovery.js` (the paged and the whole-ledger cheap pass) skip a listed id unless the **current Discovery catalog** holds the film (`films['tmdb_<id>']`). Membership of the personal watchlist is **not** an exception: a listed id with no current admission is never verified through a known-title confirmation, so a retired film is not linked to a programme slot through the shortcut either. The personal watchlist, ratings and history themselves are not touched.
4. A film the catalog still holds as a current admission is not touched, on the scored gate and on the shortcuts alike; the writer has to retire it first (and its id is on the list already, so a later re-entry is blocked).
5. The list changes only by a reviewed code change. **Retiring a film with the writer is followed by adding its id here in the same delivery.** Tests assert that every id the writer can reach through the ADR 0171 list is on this list and that the list holds 166 valid, distinct ids with no empty member.
6. Personal data are unaffected: this gate is not consulted by the Letterboxd import, ratings or the manual catalog (out of scope of AIR-501); the only effect on a personally watchlisted retired film is that Discovery no longer links it to a programme slot by the shortcut.

Not decided: a database-backed marker that makes the list implicit.

## Alternatives considered

- **Read the exclusion from D1 on each chunk** (`discovery_decision_history` writer `catalog_policy_exclude`, `rejectedTmdbIds[0]`). Rejected: the table has no index on `writer`, a read costs about 95 000 rows, and a durable marker table needs a migration.
- **Block the reactivation in `upsertAdmissions`.** Rejected here: it cannot tell a policy exclusion from the other reasons an admission is superseded without that marker; the gate in `acceptScoredIdentity` stops the new admission before it is written.
- **Keep the exclusion per observation only.** Rejected after the review: the re-entry path is real.

## Consequences

A hand-maintained list of about 166 ids (one line per 130 characters), checked by a test; a missed addition leaves the per-observation guard only. Restoring a retired film needs a reviewed change to the list.

## Recovery and migration boundary

Code rollback restores the per-observation guard and does not undo a film already excluded. This ADR authorizes no operation.
