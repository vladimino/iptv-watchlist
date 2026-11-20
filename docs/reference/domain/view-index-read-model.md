# View index: field-level contract and authority

`enrichment/view-index.json` is one R2 object that maps a film id to a small entry. It is a **derived projection**, not a Film or a source of facts. This page fixes, field by field, which store owns each value, who writes the object, who reads it, and what is still only held by the raw object. The read source is chosen by the temporary selector `VIEW_INDEX_SOURCE` ([read source selector](#read-source-selector)): `r2` (the default) reads the raw object and lays the D1 overlays over it; `d1` derives the same view from D1 and never reads the raw object. Both are implemented; which one a deployment uses is its binding, not this page.

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

| Reader path | Prediction overlay | Ratings overlay | Seed | Under `d1` |
| --- | --- | --- | --- | --- |
| Worker `loadJSON` (programme and Finds, queue and freshness, prediction diagnostics) | yes | yes | Programme and Finds only | `derivedViewIndex`: key set and fields from D1; no raw read |
| `readViewIndex` (`GET /api/enrichment/view`) | yes (applied by `loadJSON`; the second pass is skipped under `d1`) | yes | yes | As `loadJSON`, then the seed layer |
| Footer streaming reader | yes (no mood function) | yes | per-id count only | Derived without the mood facet and projected to the footer fields; the authority is checked again after the read |
| Admin health (`/api/admin/health`) | yes | yes | no | Derived body; the displayed version is the D1 token |
| Admin limbo (`/api/admin/limbo`) | no (raw fields only) | no | no | Derived body, so its fields now come from D1; the index version in the pin and the snapshot cache is the D1 token |
| Prediction recovery (`/api/admin/prediction-recovery`) | yes | yes | no | Derived through `loadJSON` on the get-only environment; the pin carries the D1 token for the index |
| `LetterboxdFacts.readJSON` (scan, reconciliation and archive consumers) | **no** | yes | no | `derivedViewIndex` with `ratingsOnly`: the `ratings_view` aliases only, no prediction table is read |
| Owner diagnostic export (`/api/enrichment/diagnostics/export`) | no | no | no | Unchanged: it returns the raw bytes and ETag of the stored object as an audit record |
| Operator Letterboxd scripts and `scripts/r2-snapshot-export.mjs` | no | no | no | Unchanged: they read a snapshot of the raw object, which stays current only while the raw writers run |

`LetterboxdFacts.readJSON` is the exception among the Worker readers: the prediction fields it carries are the raw ones. Its consumers read `watched`, `actualRating` and `watchlist` facts (the ratings-overlaid fields), so the raw prediction fields are carried through and not consumed. The other readers consume the overlaid fields and, beyond them, the key set. No reader depends on a field that neither overlay nor seed controls, except `id`, which is informational. Admin limbo is the other reader that does not apply the overlays under `r2`: it reads the raw `prediction` and `fingerprintHash` fields.

## Per-film mood object

`enrichment/films/<film>/mood-facet.json` is not produced and has no reader. The display facet is the `moodFacet` field of the entry, recomputed at read. Objects written by older versions remain in the bucket, are inert and need no repair.

## Read source selector

`VIEW_INDEX_SOURCE` ([flag register](../feature-flags.md)) has two values. Only exactly `d1` selects the D1 source; an absent, empty or any other value is `r2`.

- **`r2` (default).** Every reader goes through the paths above unchanged: the raw object, then the overlays, then the seed where the reader applies it.
- **`d1`.** The key set is the union of the film ids of `prediction_pointer`, `prediction_fingerprint` and `ratings_view`, read in keyset pages of 300 rows. Each entry is built by the overlay rule that already applies (`prediction` from a pointer row; `fingerprint`, `fingerprintHash` and `impactFeatures` from a fingerprint row; the mood facet from either; `watched`, `actualRating` and `watchlist` from `ratings_view`), and the compiled seed stays a separate in-memory layer applied afterwards with the existing rule: an own `actualRating`, an explicit `null` included, wins, and a seed-only id adds a key. Id spellings are never normalized, so an alias keeps its own key. The raw object is not read.

**Refusals, never a fallback.** Under `d1` a prediction domain that is not `d1`, a missing database binding, a ratings domain that is not `d1` and open, a table above 20,000 rows or a malformed stored row refuses with the domain's own code (`prediction_domain_not_authoritative`, `prediction_domain_unavailable`, `ratings_domain_not_authoritative`, `prediction_domain_budget`); the routes answer 503. The two prediction tables and the ratings table are read as separate keyset reads, not one snapshot, as in the overlays.

**The version token.** Where a raw ETag was a version (the Admin health display, the limbo pin and snapshot cache, the prediction recovery pin), `d1` uses `d1:p<prediction generation>.q<queue generation>.r<ratings generation>`, which changes whenever either domain commits.

**Writers are not behind the selector.** `updateViewIndex`, `ensureInitialRatings`, the mood and fingerprint backfills and the Letterboxd compare-and-swap writers read and write the raw object whatever the selector says (the Letterboxd writers read it through a separate raw reader, not the selector-aware one). The raw object therefore stays current, and setting the selector back to `r2` is a complete rollback of the read path. Retiring the writers, the selector and the raw object is a later, separately authorized step.

**Known differences of `d1` from `r2`.** A raw key with no D1 row of any of the three kinds and no seed id is not a key (it carries no fact); a `prediction_pointer` row with no raw key adds a forecast; a `prediction_fingerprint` row with no raw key adds features and the mood facet but no forecast. [ADR 0183](../../adr/0183-view-index-membership-from-d1-rows.md) records the decision and the parity gate for these; the offline classifier is `scripts/view-index-membership-parity.mjs`. Admin limbo reads D1 facts under `d1` where it read raw fields under `r2`. The operator tools have their own explicit D1-derived input, described next.

**Operator tools.** The four Letterboxd operator scripts (`scripts/letterboxd-reconcile.mjs`, `letterboxd-baseline-import.mjs`, `letterboxd-tmdb-search.mjs`, `letterboxd-display-exclusion.mjs`) read a view index from a snapshot or catalog directory. They each accept `--view-index-d1 <absolute file>`, the document written by `scripts/view-index-d1-export.mjs`, which replaces the raw object **entirely** (the two are never merged). The exporter reads, with `SELECT` statements only, the film ids of `prediction_pointer` and `prediction_fingerprint` and the rows of `ratings_view`, and writes one private, never-overwritten JSON file outside the repository: the derived index (the union of the three key sets, each id spelled exactly as stored, with `watched`, `actualRating` and `watchlist` where `ratings_view` holds them, an own `actualRating: null` kept, a prediction-only key an empty entry), the D1 identity, the authority markers before and after, the counts and the read time. It refuses (exit code 3, nothing written) unless the prediction domain is `d1` and the ratings domain is `d1` and open, a table is within the 20,000-row cap, and no marker generation moved during the read; it does not retry. The tools validate the file (schema, source, entry objects, key count), record its digest, read time and key count in the baseline identity, and bind a TMDB results file to that digest, so a plan or a results file made from it is never reused with another view index. These tools read only the ratings evidence and the lid-shaped keys of the index, which the export carries. The compiled seed is a Worker layer and is not part of the export, as it was never part of the raw object. Without the option the tools read the raw object of the snapshot as before; `scripts/r2-snapshot-export.mjs` still copies the bucket, so after the raw writers are retired the raw object in a snapshot is stale and the tools must be given the D1 export. `scripts/local-store.mjs` and `scripts/local-fixtures.mjs` build a local development store on the R2 stand-in and are not tools of the D1 source.

**Cost.** Under `d1` a full view is at most `floor(rows / 300) + 1` statements per table (49 on a table set of about 4,900, 4,900 and 4,500 rows) and holds only the overlay fields, instead of reading and parsing one mutable object. Each reader that builds the view on its own does this work itself; the second prediction pass of the queue builder and of `GET /api/enrichment/view` is skipped under `d1`.

Operating the selector (preflight, switch, readback, rollback and retirement) is in the [view index source runbook](../../runbooks/view-index-source.md).
