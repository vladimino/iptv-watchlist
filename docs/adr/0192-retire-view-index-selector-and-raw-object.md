# ADR 0192: The D1-derived view index is the only view index; the read selector and the raw object's readers and writers are retired

**Status:** Proposed (code delivered in the AIR-558 pull request; production not changed)  
**Original decision date:** 2026-11-21  
**Recorded at:** 2026-11-21  
**Approval source:** Owner direction on [AIR-558](https://trello.com/c/eSs4w27U) of 2026-11-21 (Europe/Madrid): prepare the whole retirement as one code pull request and keep merge, deploy and the Cloudflare binding removal behind separate owner decisions; owner acceptance of the D1 read-source rollout on [AIR-552](https://trello.com/c/Hk2dJf2U), with the residual HTTP 5xx and `exceededMemory` risk recorded there. This ADR becomes Accepted only on the owner's decision to merge.  
**Related work:** [AIR-558](https://trello.com/c/eSs4w27U); [AIR-552](https://trello.com/c/Hk2dJf2U); [ADR 0183](0183-view-index-membership-from-d1-rows.md); [feature flag lifecycle](../process/agent-workflow.md#feature-flag-lifecycle-plan-test-switch-remove)  
**Supersedes:** None. It executes the retirement step that ADR 0183 deferred ("Retiring the writers, the selector and the raw object is a later, separately authorized step"); ADR 0183 stays Accepted as the decision for the key set and the overlay rules.  
**Superseded by:** None

## Context

ADR 0183 made the view index derivable from `prediction_pointer`, `prediction_fingerprint` and `ratings_view` and added the temporary read selector `VIEW_INDEX_SOURCE` (`r2` default, `d1` optional) while every raw writer kept the R2 object `enrichment/view-index.json` current, so that `r2` was a complete rollback. The owner set `d1` in production on 20 November 2026 and accepted the rollout on 21 November 2026 (AIR-552). The raw object has had no effect on any served field since the overlays, only on membership, and ADR 0183 replaced membership by the D1 union.

## Decision

1. The view index is **always** derived from D1 (`derivedViewIndex`): `loadJSON`, the footer reader, Admin health, Admin limbo, prediction recovery and `LetterboxdFacts.readJSON` never read the raw object, and a prediction or ratings domain that is not authoritative refuses with the domain's own code (503), as under `d1` before. There is no raw fallback and no selector.
2. The raw writers are removed: `updateViewIndex`, `ensureInitialRatings`, the mood backfill, the fingerprint-view backfill and the Letterboxd compare-and-swap writers on the view index. The two backfill routes answer `410 Gone`. A Letterboxd projection that the ratings domain does not own (marker not `d1` and open) projects nothing (`changed: 0`) instead of writing the raw object; the facts stay the source of truth and the callers keep their own gates. The removed-film restore of raw view-index fields in the Letterboxd rollback is replaced by a D1 reversal (`RatingsD1.reverseView`): a baseline rollback or unlink reverses, per alias id (lid and TMDB) and per field, only the fields it actually rolled back, returning the `ratings_view` row to its before-image or to the table's unknown encoding. The decision is taken at write time on the current fact record (a field whose fact a surviving or newer observation still carries is kept) and each row update is a compare-and-set on the row it read, inside the fenced batch; contention re-reads and retries a bounded number of times and then refuses with `write_contention`. The earlier raw restore had been invisible, because the overlay drops those fields from a raw entry, which left the D1 projection claiming a rolled-back fact.
3. `GET /api/enrichment/diagnostics/export` (group `global`) no longer returns the raw object.
4. `VIEW_INDEX_SOURCE` stays in the `feature_flags` registry as **retired** (`effective` null) so that the owner can read the removal of the Cloudflare binding back as `state: absent`. A binding that is still set is inert, and `r2` is no rollback.
5. The four Letterboxd operator scripts require the explicit D1-derived input (`--view-index-d1`); a missing option is a usage error, never a silent read of a snapshot's raw object.

## Not decided

The raw R2 object is **not** deleted here and still exists in the bucket and in snapshot exports; its retirement is a separate owner-approved R2 operation. The Cloudflare binding is **not** removed by this change (`keep_vars: true`). Nothing here authorizes a production operation.

## Alternatives considered

Keeping the raw writers for a further period as a rollback path was the content of ADR 0183 and the AIR-552 stabilization; the owner accepted the rollout and asked for the retirement. A raw read in contexts without a database binding (as the prediction and ratings domains allow behind `*_DB_REQUIRED`) was not adopted: the card forbids a silent raw fallback.

## Consequences

Each prediction submit no longer reads and rewrites an 11 MB object. The simple rollback to `r2` is gone: returning to the raw object needs an owner-approved plan that restores the code, sets the binding and rebuilds the object from D1 (a D1 to R2 export), none of which exists as a routine. A code rollback to a version that reads the selector finds a raw object that is stale from the first deploy of this change on. Tests that are not about the derivation use a test-only fixture seam (`tests/view-index-fixture.mjs`); the derivation itself is tested on a sqlite D1 stand-in.

## Recovery and migration boundary

Code rollback does not recreate a current raw object. The raw object is stale after the first deploy and must not be used as a source unless it is rebuilt from D1. Removing the binding and deleting the object are separate owner decisions.

## Evidence

- **Original decision:** [AIR-558](https://trello.com/c/eSs4w27U), [AIR-552 acceptance](https://trello.com/c/Hk2dJf2U)
- **Implementation:** the AIR-558 pull request
- **Dated verification:** pending (post-merge CI and deploy, `feature_flags` readback after the binding removal)
- **Uncertainty:** the residual 5xx and `exceededMemory` risk accepted on AIR-552 is not caused or cured by this change and needs its own RCA.

## Follow-ups

Owner-approved removal of the `VIEW_INDEX_SOURCE` binding and of the raw object, each with its own readback.
