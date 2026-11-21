# ADR 0192: The D1-derived view index is the only view index; the read selector, the raw object's readers and writers and the Letterboxd rollback and unlink are retired

**Status:** Accepted (owner approval of 2026-11-21; production not changed by this record)  
**Original decision date:** 2026-11-21  
**Recorded at:** 2026-11-21  
**Approval source:** Owner approval of 2026-11-21 (Europe/Madrid) in the [AIR-558 Trello comment](https://trello.com/c/eSs4w27U#comment-6b01ff797b847672337b5e6f) and the [pull request comment](https://github.com/vladimino/iptv-watchlist/pull/865#issuecomment-7068807276), on the combination A, B, A, A, C set out under Decision; owner acceptance of the D1 read-source rollout on [AIR-552](https://trello.com/c/Hk2dJf2U), with the residual HTTP 5xx and `exceededMemory` risk recorded there. Merge, deploy and the Cloudflare binding removal stay separate owner actions.  
**Related work:** [AIR-558](https://trello.com/c/eSs4w27U); [AIR-552](https://trello.com/c/Hk2dJf2U); [ADR 0183](0183-view-index-membership-from-d1-rows.md); [feature flag lifecycle](../process/agent-workflow.md#feature-flag-lifecycle-plan-test-switch-remove)  
**Supersedes:** In part, without rewriting them: [ADR 0068](0068-letterboxd-archive-confirmed-apply.md) (the archive rollback capability and the rollback of the baseline commit), [ADR 0104](0104-inferred-letterboxd-identity.md) (the per-film unlink and the chunk rollback as the correction of an inferred identity), [ADR 0053](0053-permanent-letterboxd-baseline-import-route.md) (the `/rollback` route) and [ADR 0023](0023-letterboxd-user-facts.md) (the rollback of an export in decision 6). It also executes the retirement step that ADR 0183 deferred ("Retiring the writers, the selector and the raw object is a later, separately authorized step"); ADR 0183 stays Accepted as the decision for the key set and the overlay rules.  
**Superseded by:** None

## Context

ADR 0183 made the view index derivable from `prediction_pointer`, `prediction_fingerprint` and `ratings_view` and added the temporary read selector `VIEW_INDEX_SOURCE` (`r2` default, `d1` optional) while every raw writer kept the R2 object `enrichment/view-index.json` current, so that `r2` was a complete rollback. The owner set `d1` in production on 20 November 2026 and accepted the rollout on 21 November 2026 (AIR-552). The raw object has had no effect on any served field since the overlays, only on membership, and ADR 0183 replaced membership by the D1 union.

The Letterboxd baseline rollback, the per-film unlink and the admin archive rollback were the last code that restored or removed view-index fields in the raw object. Under the D1 ratings domain that restore had no visible effect, and a correct D1 replacement (a reversal of `ratings_view` with an etag fence and row compare-and-set) was designed in an earlier iteration of the change. The owner decided not to keep or build any dedicated reversal.

## Decision

The owner approved the combination A, B, A, A, C on 21 November 2026.

1. **Raw readers, writers and selector retired now (A).** The view index is **always** derived from D1 (`derivedViewIndex`): `loadJSON`, the footer reader, Admin health, Admin limbo, prediction recovery and `LetterboxdFacts.readJSON` never read the raw object, and a prediction or ratings domain that is not authoritative refuses with the domain's own code (503). There is no raw fallback and no selector. The raw writers are removed: `updateViewIndex`, `ensureInitialRatings`, the mood backfill, the fingerprint-view backfill and the Letterboxd compare-and-swap writers on the view index. A Letterboxd projection that the ratings domain does not own (marker not `d1` and open) projects nothing (`changed: 0`). The loss of the simple R2 rollback is **accepted without developing any replacement D1 to R2 rebuild**. The raw R2 object and the registry's retired-flag record are retained.
2. **Both legacy backfill routes are removed entirely (B).** `POST /api/enrichment/moods/backfill` and `POST /api/enrichment/fingerprint-view/backfill` answer an ordinary 404: not 410, not a no-op. The maintenance instructions that named them are removed.
3. **The D1 export input stays mandatory; the diagnostics export omits the view index (A).** The four Letterboxd operator scripts require the explicit `--view-index-d1` D1 export; a missing option is a usage error, never a silent read of a snapshot's raw object. `GET /api/enrichment/diagnostics/export` (group `global`) no longer returns the view index.
4. **`VIEW_INDEX_SOURCE` stays in the `feature_flags` registry as retired** (`effective` null) so that the owner can read the removal of the Cloudflare binding back as `state: absent`. A binding that is still set is inert, and `r2` is no rollback. The owner is ready to remove the binding after the deployed version ignores it, as a separate GO with a `feature_flags` readback of `absent`.
5. **Archive baseline rollback and inferred-film unlink are retired (C).** Removed: the CLI commands `rollback` and `unlink` (with the `rollback.json` output file and `--lid`); the Worker routes `/api/letterboxd/baseline/rollback` and `/api/letterboxd/baseline/unlink`; the admin archive rollback capability (`letterboxd_archive_rollback`, the routes `/api/admin/letterboxd-archive/rollback-confirm` and `/rollback`, the action record prefix `admin/actions/letterboxd_archive_rollback/v1/`); the candidate rollback exposed through the same capability (`LetterboxdRatedCandidates.rollbackCandidates`); the page controls, states and banners of the rollback; and the dedicated reversal code (`RatingsD1.reverseView`, `reverseFacts`, `rollbackBaselineChunk`, `unlinkBaselineFilm`, `unlinkInferred`) with its tests. The apply capability's compensation kind changes from `restore_before_image` to `none`, and the page says «Отменить изменение будет нельзя.». The receipt copy now says «Итог — в квитанции.» and «Эта партия уже есть в квитанции импорта. Повтор записи идемпотентен.».
6. **Preserved.** Archive preview, confirm and commit; validate, replay and resume of an interrupted commit; idempotency; intent and commit receipts, including `viewBefore` (stored `rollback` and `rollback-intent` objects of old receipts stay readable and have no writer); the conflict, identity and authority guards; historical `ratingHistory` and `rolled_back` entries (still read and merged); all data, provenance and legacy receipts; and the other independent correction and recovery operations (owner mark, rating overrides, link repair, identity retry). No production data is deleted.
7. **Future repair of a mistaken identity is case-specific** and needs a separate owner decision that names the film and the exact writes. No generic reversal exists.

## Not decided

The raw R2 object is **not** deleted here and still exists in the bucket and in snapshot exports; deleting it is a separate owner-approved R2 operation. The Cloudflare binding is **not** removed by this change (`keep_vars: true`); its removal is a separate owner GO. The local development limitation (restoring a full local D1 and R2 environment, [AIR-576](https://trello.com/c/ONq20jy9)) is unchanged. Nothing here authorizes a production operation.

## Alternatives considered

Keeping the raw writers for a further period as a rollback path was the content of ADR 0183 and the AIR-552 stabilization; the owner accepted the rollout and asked for the retirement. A raw read in contexts without a database binding was not adopted: no silent raw fallback. Keeping the rollback and unlink with a D1 reversal (etag fence plus row compare-and-set) was designed and then rejected by the owner: it would be new dedicated machinery for operations that are rare, case-specific and better decided one at a time. Keeping the rollback and unlink without any `ratings_view` reversal was rejected because it would leave the D1 projection claiming a rolled-back fact. Keeping the backfill routes as `410 Gone` was rejected in favor of removing them.

## Consequences

Each prediction submit no longer reads and rewrites an 11 MB object. The simple rollback to `r2` is gone, and no D1 to R2 rebuild exists or is planned: returning to the raw object would need a new design under a new owner decision. A code rollback to a version that reads the selector finds a raw object that is stale from the first deploy of this change on. There is no automated way to undo an archive apply, a baseline commit or an inferred link: a mistake is repaired case by case. The page and the apply capability say so. Tests that are not about the derivation use a test-only fixture seam (`tests/view-index-fixture.mjs`); the derivation itself is tested on a sqlite D1 stand-in.

## Recovery and migration boundary

Code rollback does not recreate a current raw object, and does not revert D1 or R2 data. The raw object is retained, stale and not a source. Removing the binding and deleting the object are separate owner decisions. A mistaken Letterboxd identity is repaired case by case after a separate owner decision, with its own plan and readback.

## Evidence

- **Original decision:** [AIR-558](https://trello.com/c/eSs4w27U), [owner approval comment](https://trello.com/c/eSs4w27U#comment-6b01ff797b847672337b5e6f), [pull request comment](https://github.com/vladimino/iptv-watchlist/pull/865#issuecomment-7068807276), [AIR-552 acceptance](https://trello.com/c/Hk2dJf2U)
- **Implementation:** the AIR-558 pull request (#865); [delivery evidence](../evidence/d1-migration/air-558-view-index-selector-retirement-2026-11-21.md)
- **Dated verification:** pending (post-merge CI and deploy, `feature_flags` readback after the binding removal)
- **Uncertainty:** the residual 5xx and `exceededMemory` risk accepted on AIR-552 is not caused or cured by this change and needs its own RCA.

## Follow-ups

Owner-approved removal of the `VIEW_INDEX_SOURCE` binding (separate GO, readback `absent`); a later owner decision on the raw object.
