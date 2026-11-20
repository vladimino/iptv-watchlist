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

## Target and open decision

Goal: no mutable `view-index.json` and no second mutable authority. Because every value is already overlaid, the only thing to replace is membership. Two options were put to the owner; neither is accepted:

1. **Union of D1 rows (recommended, with the seed kept as a separate layer).** The id set is the union of `prediction_pointer`, `prediction_fingerprint` and `ratings_view` film ids, built by keyset-paged reads. No new table and no migration. The compiled seed is **not** a D1 row: it must stay an in-memory layer applied after the union with the same rule as today (an own `actualRating`, including `null`, wins; a seed-only id adds a key), or the supported non-empty seed silently loses its ids and ratings. Behavior differs for a film that is a raw key with no D1 row (it disappears) and for a film with D1 rows and no raw key (it appears). Footer counters, Finds exclusion and the queue input can change, so a read-only comparison on production data is required before any switch. The comparison must cover: raw-only keys, D1-only keys, a seed-only id, a seed id with an own `null`, a seed id with a `ratings_view` rating, and the `LetterboxdFacts` path, which does not use the prediction overlay. A focused fixture with a non-empty seed should exist before the switch.
2. **Explicit membership table in D1.** Keeps current keys exactly, at the cost of a migration, a second writer and a backfill; it is a new mutable authority.

Neither option may import the raw object over canonical predictions or ratings. Any activation, backfill or production read of the raw object needs a separate owner approval; until then the raw object and its writers stay as described above.
