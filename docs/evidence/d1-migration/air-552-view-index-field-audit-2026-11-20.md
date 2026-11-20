# View index and mood facet field audit

**Date:** 2026-11-20 UTC. **Source:** `main` `30d11b4d2a6ebb601d74d12495664f0ccd5b8523` plus this change. **Work:** [AIR-552](https://trello.com/c/Hk2dJf2U), inventory [AIR-546](https://trello.com/c/1dRSJEbp), blocked [AIR-275](https://trello.com/c/4x7hH0gI), documentation [AIR-547](https://trello.com/c/99faXisC).

## Scope and evidence boundary

Source audit only. No production object, D1 row or Worker setting was read, and nothing was written. The audit shows what the code does with `enrichment/view-index.json` and `enrichment/films/<film>/mood-facet.json`; it does not show what the production object contains. The maintained result is the [field-level contract](../../reference/domain/view-index-read-model.md).

## Method

Review correction (PR #809, independent review at `9715844`): the first version of this audit and contract wrongly said the ratings overlay stops the seed from reaching a D1-ready read, and that every reader applies both overlays. Both are corrected below and in the contract.

Searched `src` for the two keys and for the helpers that touch them (`updateViewIndex`, `ensureInitialRatings`, `fingerprintIndexPatch`, `applyRatingsSeed`, `overlayRatingsSeed`, `PredictionD1.overlayIndex`, `PredictionD1.projectItems`, `RatingsD1.overlayView`, `RatingsD1.viewItems`, `LetterboxdFacts.projectRecords`), then read each overlay to see which entry fields it deletes and which rows it applies.

## Findings

1. **Every entry field is overlaid at production authority.** `overlayedItem` deletes `prediction`, `fingerprint`, `fingerprintHash`, `impactFeatures` and `moodFacet` and rebuilds them from `prediction_pointer` and `prediction_fingerprint`. `overlayView` deletes `actualRating`, `watched` and `watchlist` and rebuilds them from `ratings_view`. The raw values of those fields are never served on a path that applies both overlays while the prediction marker is `d1` and the ratings domain is `d1` and open. One reader path applies only the ratings overlay: `LetterboxdFacts.readJSON` (`src/letterboxd-facts.js`, `readJSON`), whose consumers read the rating, watched and watchlist facts, so the raw prediction fields are carried and not consumed.
2. **Only membership remains, then the compiled seed.** The prediction overlay changes only keys already in the raw object; the ratings overlay adds a key per `ratings_view` row. `readViewIndex`, the Finds and programme reader and the footer fact count then apply `INITIAL_PERSONAL_RATINGS` after the overlays: an own `actualRating` (including `null`) wins, otherwise the seed value is set, and a seed-only id creates a key. The committed seed is empty; a private build can supply a non-empty one (`src/ratings-seed.js`, tested by the read-side-effect harness), so the seed is a supported input of membership. The footer reader also drops overlaid fields before it streams the object, so it keeps only the key set and the fields the overlays leave alone (`id`).
3. **The raw writes are redundant for values.** `updateViewIndex` and the mood backfill write prediction and fingerprint facets that the next read replaces. Their remaining effect is making a film a key.
4. **`mood-facet.json` had no reader.** The only matches for the key in `src`, `scripts`, `public` and `tests` were the two writers, the offline importer's derived-projection classification and one test. The page builds chips from the view's recomputed `moodIds`.
5. **The proposed D1 union must keep the seed as its own layer** and be compared with a fixture covering raw-only, D1-only, seed-only, seed with an own `null`, seed with a `ratings_view` rating and the `LetterboxdFacts` path.
6. **Residual unknowns (not resolvable from source):** whether the production raw object holds keys with no D1 row, whether it lacks keys that have D1 rows, and whether any entry holds a field outside the list above. These decide the membership design and need a read of the object, which is a separate owner approval.

## Change in this delivery

`updateViewIndex` and `POST /api/enrichment/moods/backfill` no longer write `enrichment/films/<film>/mood-facet.json`. The index entry still carries `moodFacet`, and the backfill still patches the index and writes `enrichment/diagnostics/moods.json`. Objects written earlier stay in R2 and are inert; no delete or repair is part of this change. `tests/mood-vocabulary.mjs` now asserts that neither path creates the object and that the entry carries the mapped facet. Rolling the code back would resume the writes and restore nothing else, so there is no data rollback step.

## Verdict and limits

The field-level mapping is complete for the source. Source sufficiency is shown for the overlaid fields (each has a D1 source); the compiled ratings seed is not a D1 source and stays a separate in-memory layer. Parity of membership is **not** shown and no activation, replacement read model or removal of the raw object was done. The membership decision (union of D1 rows against an explicit table) is open with the owner; the recommended option and its behavior differences are in the contract. AIR-552 stays open until that decision, the read-only comparison, the read model, the switch and the owner acceptance of the criteria on the card.
