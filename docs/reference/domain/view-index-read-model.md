# View index: field-level contract and authority

`enrichment/view-index.json` is one R2 object that maps a film id to a small entry. It is a **derived projection**, not a Film or a source of facts. This page fixes, field by field, which store owns each value, who writes the object, who reads it, and what is still only held by the raw object. The target design for removing the dependency is a proposal and needs an owner decision; the current behavior below is what the source does.

Related: [prediction runner](../api/prediction-runner.md), [enrichment API](../api/enrichment.md), [catalog watched and rated rule](../api/catalog.md#watched-and-rated-films), [taxonomy](taxonomy.md), [UI and read models](../../architecture/ui-and-read-models.md), [persistence and migration](../../architecture/persistence-and-migration.md).

## Entry fields and their authority

Readers that load the object through the Worker's `loadJSON` (and the footer reader) apply two overlays: `PredictionD1.overlayIndex`, then `RatingsD1.overlayView`. With the prediction domain at `d1` and the ratings domain `d1` and `open`, each overlay **deletes** the fields below from the raw entry before laying the D1 rows over it, so the raw value is never served. One reader path differs: `LetterboxdFacts.readJSON` applies only the ratings overlay, so the prediction fields stay raw there (see [Reader paths](#reader-paths)). The compiled ratings seed is a third, in-memory layer applied by some readers **after** the overlays (see [Compiled ratings seed](#compiled-ratings-seed)).

| Field | Meaning | Authoritative source | Overlay behavior | Raw R2 value still used |
| --- | --- | --- | --- | --- |
| `prediction` | Display document of the current forecast | `prediction_pointer.display_json` | Dropped, replaced from the film's pointer row; absent when no row | No |
| `fingerprint` | Display facet of the current fingerprint (`plotMechanics`, `moodLabels`, `execution`, `fingerprintHash`) | `prediction_fingerprint.features_json` | Dropped, rebuilt from the row | No |
| `fingerprintHash` | Hash binding the entry to its fingerprint | `prediction_fingerprint.features_json` | Dropped, rebuilt | No |
| `impactFeatures` | Raw execution values and schema of the exact fingerprint for selective compatibility | `prediction_fingerprint.features_json` | Dropped, rebuilt | No |
| `moodFacet` | Canonical mood ids, groups and unmapped labels | Computed by `canonicalMoodFacet(fingerprint, prediction)` | Dropped, recomputed from the overlaid fingerprint and prediction (the function is passed by the caller; a caller that passes none gets no `moodFacet`) | No |
| `watched` | Confirmed watched mark | `ratings_view.watched` | Dropped, replaced; an absent row leaves it absent | No |
| `actualRating` | Owner's half-star rating, or an explicit `null` | `ratings_view.actual_rating` with `rating_known`; the compiled seed fills it only where the key is absent after the overlay | Dropped, replaced; `rating_known=1` with a null rating gives an own `null`; `rating_known=0` leaves it absent | No; the seed can supply a value (see below) |
| `watchlist` | Watchlist membership history (a boolean, either value, means the film was on the list); not a watched mark | `ratings_view.watchlist` | Dropped, replaced | No |
| `id` | Redundant film id inside the entry | The map key | Not touched | Informational only |

A held ratings cutover refuses (`ratings_domain_not_authoritative`) instead of serving the raw facts. A prediction overlay above 20,000 rows refuses (`overlay_rows`). Neither falls back to the raw object.

## What only the raw object holds

For production authority the raw object contributes **only the set of keys** (membership), before the optional compiled seed:

- The prediction overlay changes only films whose key is already in the raw object. A film with a D1 prediction row and no raw key shows no forecast in the full view.
- The ratings overlay **adds** a key for every `ratings_view` row, so a rated film is present whether or not the raw object holds it.
- An entry with no D1 row of either kind carries no fact at all; its only effect is that its key exists.

Consumers that enumerate keys (`Object.keys`, a `for...of Object.entries` loop) therefore see: raw keys, plus every `ratings_view` alias, plus the seed ids for the seeded readers above. Consumers that look one film up by id see the overlaid entry or nothing. Single-film pages that must not depend on the raw key use `PredictionD1.projectItems` and `RatingsD1.viewItems`, which read the D1 rows for exactly the requested ids.


## Compiled ratings seed

`INITIAL_PERSONAL_RATINGS` is a map from id to rating compiled into the Worker. The committed repository seed is empty; `src/ratings-seed.js` supports a non-empty seed in a private build, and the read-side-effect harness tests that variant. Where a reader applies it, it does so **after** the D1 overlays:

- `applyRatingsSeed` sets `actualRating` for a seed id only when the entry has no **own** `actualRating` property. An own `null` (an explicit clear, `rating_known=1` with no rating) therefore wins over the seed, and a `ratings_view` rating wins over it too.
- After `RatingsD1.overlayView` an entry with `rating_known=0` or no row has no `actualRating`, so the seed value reaches the read.
- A seed id that has no entry at all **creates a new key**: membership of a seeded read is `raw keys ∪ ratings_view aliases ∪ seed ids`.
- Seed appliers: `readViewIndex` (`GET /api/enrichment/view`), the Finds and programme reader (`overlayRatingsSeed` on the in-memory copy), and the footer fact count (`footerFacts` reads `seed[id]` for an id without an own `actualRating`, including seed ids the index does not hold). `ensureInitialRatings` can persist the seed into the raw object, which the ratings overlay later strips. The Admin, limbo, diagnostics and Letterboxd readers do not apply it.

## Producers of the raw object

| Writer | Fields written | Production reachability |
| --- | --- | --- |
| `updateViewIndex` (after a prediction submit, a batch submit, a fingerprint write) | `prediction`, `fingerprintHash`, `fingerprint`, `impactFeatures`, `moodFacet` | Reachable; ETag compare-and-swap, five attempts. It writes the index only; no per-film mood object. |
| `POST /api/enrichment/moods/backfill` | the same fingerprint and prediction facets for scanned films | Owner route; patches through the CAS merge. |
| `ensureInitialRatings` | persists the compiled seed | A writer that already mutates the index calls it. |
| `LetterboxdFacts.projectRecords` and the removed-film cleanup | `actualRating`, `watched`, `watchlist`, or deletes an entry | At ratings `d1` and open the projection goes to `ratings_view`; the R2 branch is the uninstalled local stand-in. |

Every field a producer still writes to the raw object is overwritten at read by the overlays above. The remaining production effect of those writes is membership: a film becomes a key.

## Reader paths

| Reader path | Prediction overlay | Ratings overlay | Seed |
| --- | --- | --- | --- |
| Worker `loadJSON` (programme and Finds, queue and freshness, Admin health and limbo, prediction diagnostics and recovery, owner diagnostic export) | yes | yes | Programme and Finds only |
| `readViewIndex` (`GET /api/enrichment/view`) | yes (applied by the caller, with the mood function) | yes | yes |
| Footer streaming reader | yes (no mood function) | yes | per-id count only |
| `LetterboxdFacts.readJSON` (scan, reconciliation and archive consumers) | **no** | yes | no |

`LetterboxdFacts.readJSON` is the exception: the prediction fields it carries are the raw ones. Its consumers read `watched`, `actualRating` and `watchlist` facts (the ratings-overlaid fields), so the raw prediction fields are carried through and not consumed. The other readers consume the overlaid fields and, beyond them, the key set. No reader depends on a field that neither overlay nor seed controls, except `id`, which is informational.

## Per-film mood object

`enrichment/films/<film>/mood-facet.json` is not produced and has no reader. The display facet is the `moodFacet` field of the entry, recomputed at read. Objects written by older versions remain in the bucket, are inert and need no repair.

## Accepted target and rollout gates

The accepted target is [ADR 0183](../../adr/0183-view-index-membership-from-d1-rows.md): derive the view-index membership from the union of film ids in D1 `prediction_pointer`, `prediction_fingerprint` and `ratings_view`. Preserve `INITIAL_PERSONAL_RATINGS` as a separate in-memory layer applied after the authoritative D1 values, including the existing rule that an own `actualRating`, even an explicit `null`, wins. No separate D1 membership table or permanent R2 membership mirror is part of the target.

This **does not describe current runtime authority**: the existing mutable R2 `enrichment/view-index.json` remains the source of membership until a separately authorized and verified cutover. For field-based readers, a missing key has no other fact, but the key set also feeds identity bridge candidates, the Admin health entry count and local Letterboxd operator scripts. These paths must be covered by the replacement implementation.

The target differs from current reads in precisely classified ways: a raw-only id without a D1 row or compiled seed id may disappear; a `prediction_pointer` row with no raw key can add a visible forecast; a `prediction_fingerprint` row with no raw key can add mood/mechanics features but **not** a forecast. Either of the latter may already be a membership key through a ratings alias or the seed. A real production parity comparison, reviewed before implementation or activation, must assess these changes, identity bridges, Finds and footer/queue effects, seed precedence, row caps and execution budgets. No observed difference is pre-accepted just because the target architecture is Accepted.

The owner selected a temporary `r2` (default) / `d1` read selector for controlled rollout, keeping existing R2 writers until an approved switch and removing the selector and obsolete writers only after stabilization. One bounded read-only parity comparison is approved in the ADR; implementing or changing a production selector/flag, migration, authority activation, data repair or R2 cleanup requires a distinct owner authorization. The replacement must cover all reader paths, including `LetterboxdFacts.readJSON` (ratings overlay only), the footer streaming reader and operator scripts, while retaining bounded D1 reads and fail-closed behavior for unavailable authorities.
