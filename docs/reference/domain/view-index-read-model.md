# View index: field-level contract and authority

`enrichment/view-index.json` is one R2 object that maps a film id to a small entry. It is a **derived projection**, not a Film or a source of facts. This page fixes, field by field, which store owns each value, who writes the object, who reads it, and what is still only held by the raw object. The target design for removing the dependency is a proposal and needs an owner decision; the current behavior below is what the source does.

Related: [prediction runner](../api/prediction-runner.md), [enrichment API](../api/enrichment.md), [catalog watched and rated rule](../api/catalog.md#watched-and-rated-films), [taxonomy](taxonomy.md), [UI and read models](../../architecture/ui-and-read-models.md), [persistence and migration](../../architecture/persistence-and-migration.md).

## Entry fields and their authority

Every reader goes through the same two overlays (`PredictionD1.overlayIndex`, then `RatingsD1.overlayView`). With the prediction domain at `d1` and the ratings domain `d1` and `open`, each overlay **deletes** the fields below from the raw entry before laying the D1 rows over it, so the raw value is never served.

| Field | Meaning | Authoritative source | Overlay behavior | Raw R2 value still used |
| --- | --- | --- | --- | --- |
| `prediction` | Display document of the current forecast | `prediction_pointer.display_json` | Dropped, replaced from the film's pointer row; absent when no row | No |
| `fingerprint` | Display facet of the current fingerprint (`plotMechanics`, `moodLabels`, `execution`, `fingerprintHash`) | `prediction_fingerprint.features_json` | Dropped, rebuilt from the row | No |
| `fingerprintHash` | Hash binding the entry to its fingerprint | `prediction_fingerprint.features_json` | Dropped, rebuilt | No |
| `impactFeatures` | Raw execution values and schema of the exact fingerprint for selective compatibility | `prediction_fingerprint.features_json` | Dropped, rebuilt | No |
| `moodFacet` | Canonical mood ids, groups and unmapped labels | Computed by `canonicalMoodFacet(fingerprint, prediction)` | Dropped, recomputed from the overlaid fingerprint and prediction (the function is passed by the caller; a caller that passes none gets no `moodFacet`) | No |
| `watched` | Confirmed watched mark | `ratings_view.watched` | Dropped, replaced; an absent row leaves it absent | No |
| `actualRating` | Owner's half-star rating, or an explicit `null` | `ratings_view.actual_rating` with `rating_known` | Dropped, replaced; `rating_known=0` leaves it absent | No |
| `watchlist` | Watchlist membership history (a boolean, either value, means the film was on the list); not a watched mark | `ratings_view.watchlist` | Dropped, replaced | No |
| `id` | Redundant film id inside the entry | The map key | Not touched | Informational only |

A held ratings cutover refuses (`ratings_domain_not_authoritative`) instead of serving the raw facts. A prediction overlay above 20,000 rows refuses (`overlay_rows`). Neither falls back to the raw object.

## What only the raw object holds

For production authority the raw object contributes **only the set of keys** (membership):

- The prediction overlay changes only films whose key is already in the raw object. A film with a D1 prediction row and no raw key shows no forecast in the full view.
- The ratings overlay **adds** a key for every `ratings_view` row, so a rated film is present whether or not the raw object holds it.
- An entry with no D1 row of either kind carries no fact at all; its only effect is that its key exists.

Consumers that enumerate keys (`Object.keys`, a `for...of Object.entries` loop) therefore see: raw keys, plus every `ratings_view` alias. Consumers that look one film up by id see the overlaid entry or nothing. Single-film pages that must not depend on the raw key use `PredictionD1.projectItems` and `RatingsD1.viewItems`, which read the D1 rows for exactly the requested ids.

The compiled ratings seed (`INITIAL_PERSONAL_RATINGS`) fills a missing `actualRating` in memory for the programme and Finds readers; `ensureInitialRatings` can persist it to the raw object. With the ratings domain open the overlay removes `actualRating` first, so the seed does not reach a D1-ready read.

## Producers of the raw object

| Writer | Fields written | Production reachability |
| --- | --- | --- |
| `updateViewIndex` (after a prediction submit, a batch submit, a fingerprint write) | `prediction`, `fingerprintHash`, `fingerprint`, `impactFeatures`, `moodFacet` | Reachable; ETag compare-and-swap, five attempts. It writes the index only; no per-film mood object. |
| `POST /api/enrichment/moods/backfill` | the same fingerprint and prediction facets for scanned films | Owner route; patches through the CAS merge. |
| `ensureInitialRatings` | persists the compiled seed | A writer that already mutates the index calls it. |
| `LetterboxdFacts.projectRecords` and the removed-film cleanup | `actualRating`, `watched`, `watchlist`, or deletes an entry | At ratings `d1` and open the projection goes to `ratings_view`; the R2 branch is the uninstalled local stand-in. |

Every field a producer still writes to the raw object is overwritten at read by the overlays above. The remaining production effect of those writes is membership: a film becomes a key.

## Consumers

The object is read as a whole (single-object reads) by the programme and Finds readers, the prediction queue and freshness code, the footer (a streaming reader that keeps only needed fields), the Admin health and limbo reads, prediction diagnostics and recovery, the Letterboxd reconciliation and matching code, and the owner diagnostic export. Every one of them reads the overlaid body. None of them reads a field that the overlays leave in place, except the key set.

## Per-film mood object

`enrichment/films/<film>/mood-facet.json` is not produced and has no reader. The display facet is the `moodFacet` field of the entry, recomputed at read. Objects written by older versions remain in the bucket, are inert and need no repair.

## Target and open decision

Goal: no mutable `view-index.json` and no second mutable authority. Because every value is already overlaid, the only thing to replace is membership. Two options were put to the owner; neither is accepted:

1. **Union of D1 rows (recommended).** The id set is the union of `prediction_pointer`, `prediction_fingerprint` and `ratings_view` film ids, built by keyset-paged reads. No new table and no migration. Behavior differs for a film that is a raw key with no D1 row (it disappears) and for a film with D1 rows and no raw key (it appears). Footer counters, Finds exclusion and the queue input can change, so a read-only comparison on production data is required before any switch.
2. **Explicit membership table in D1.** Keeps current keys exactly, at the cost of a migration, a second writer and a backfill; it is a new mutable authority.

Neither option may import the raw object over canonical predictions or ratings. Any activation, backfill or production read of the raw object needs a separate owner approval; until then the raw object and its writers stay as described above.
