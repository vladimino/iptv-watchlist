# ADR 0172: A film the owner retired on policy grounds does not re-enter Discovery through a new observation key

**Status:** Proposed (2026-11-18; the owner chose to include this protection in [PR #754](https://github.com/vladimino/iptv-watchlist/pull/754) after the independent review raised the re-entry path. Acceptance is requested on the pull request. This records an admission rule, not permission to exclude any Film or to run Discovery, EPG, TMDB, predictions, Tasks, or a storage write)  
**Original decision date:** 2026-11-18  
**Recorded at:** 2026-11-18  
**Approval source:** not yet documented as a GitHub approval; the owner's chat choice «Защита от повторного входа в этом PR»  
**Related work:** [AIR-501](https://trello.com/c/ShipZn0N), [ADR 0153](0153-catalog-policy-exclusion.md), [ADR 0169](0169-writer-only-catalog-cleanup-classification.md), [ADR 0171](0171-owner-reviewed-policy-exclusion-list.md), [ADR 0150](0150-documentary-and-concert-film-exclusion.md)  
**Supersedes:** None. It qualifies [ADR 0153](0153-catalog-policy-exclusion.md) rule 2: the writer's `rejectedTmdbIds` guard is per observation key, and this ADR adds an identity-level guard for the films the owner retired.  
**Superseded by:** None

## Context

`catalog_policy_exclude@1` rejects the verified decisions of the observation keys that point at a film and supersedes its admission. The rejection (`rejectedTmdbIds`) lives on those decision rows and `ownerRejected` reads it per observation. A different EPG observation key that resolves to the same TMDB movie has no such rejection. The independent review of PR #754 found that such a key can reach `detail_verified` again for a card the ADR 0150 gate does not exclude by itself (for example a Music-only card with an empty or placeholder synopsis), and `upsertAdmissions` then sets the admission `current` even over a `superseded` row. It applies to every film the writer has retired (160 distinct TMDB ids by 2026-11-18T14:30Z) as well as the six reviewed ones.

## Decision

1. `OWNER_POLICY_EXCLUDED_TMDB_IDS` in `src/domain/resolution-acceptance.js` lists the TMDB ids the owner retired on policy grounds: the 160 distinct ids that `catalog_policy_exclude@1` had written, plus the six reviewed ids of [ADR 0171](0171-owner-reviewed-policy-exclusion-list.md) that await an owner GO.
2. `acceptScoredIdentity` returns `candidate_decision` / `no_confident_match` / `owner_policy_excluded` for an accepted TMDB id on that list when the catalog holds no current admission of it. This applies on the first pass (before any TMDB detail read) and after it, and **an owner confirmation does not lift it**. A proven Documentary or concert recording keeps its more specific ADR 0150 reason on the detail pass.
3. The two `known_epg_alias` shortcuts in `src/discovery.js` skip a listed id unless the film is in the personal watchlist, so a retired film is not admitted through a known-title confirmation either.
4. A film the catalog still holds as a current admission is not touched; the writer has to retire it first (and its id is on the list already, so a later re-entry is blocked).
5. The list changes only by a reviewed code change. **Retiring a film with the writer is followed by adding its id here in the same delivery.** A test asserts that every id the writer can reach through the ADR 0171 list is on this list.
6. Personal data are unaffected: this gate is not consulted by the Letterboxd watchlist, ratings or the manual catalog (out of scope of AIR-501).

Not decided: a database-backed marker that makes the list implicit.

## Alternatives considered

- **Read the exclusion from D1 on each chunk** (`discovery_decision_history` writer `catalog_policy_exclude`, `rejectedTmdbIds[0]`). Rejected: the table has no index on `writer`, a read costs about 95 000 rows, and a durable marker table needs a migration.
- **Block the reactivation in `upsertAdmissions`.** Rejected here: it cannot tell a policy exclusion from the other reasons an admission is superseded without that marker; the gate in `acceptScoredIdentity` stops the new admission before it is written.
- **Keep the exclusion per observation only.** Rejected after the review: the re-entry path is real.

## Consequences

A hand-maintained list of about 166 ids (one line per 130 characters), checked by a test; a missed addition leaves the per-observation guard only. Restoring a retired film needs a reviewed change to the list.

## Recovery and migration boundary

Code rollback restores the per-observation guard and does not undo a film already excluded. This ADR authorizes no operation.
