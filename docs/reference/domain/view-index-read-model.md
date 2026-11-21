# View index: field-level contract and authority

The view index is a **derived read model**, not a Film or a source of facts. It maps a film id to a small entry and is built from D1 on every read (`derivedViewIndex` in `src/worker.js`). There is one path: no selector, no raw read, no raw write. The former R2 object `enrichment/view-index.json` is retired as a source ([ADR 0190](../../adr/0190-retire-view-index-selector-and-raw-object.md), which retired the read selector of [ADR 0183](../../adr/0183-view-index-membership-from-d1-rows.md)). The object may still exist in the bucket and in snapshot exports, but no Worker code reads or writes it, and it is stale from the first deploy of the retirement on; it must not be used as a source unless it is rebuilt from D1. This page fixes, field by field, which D1 table owns each value, how the key set is formed and who reads the result.

Related: [prediction runner](../api/prediction-runner.md), [enrichment API](../api/enrichment.md), [catalog watched and rated rule](../api/catalog.md#watched-and-rated-films), [taxonomy](taxonomy.md), [UI and read models](../../architecture/ui-and-read-models.md), [persistence and migration](../../architecture/persistence-and-migration.md).

## Entry fields and their authority

Every entry is built from D1 rows only. The key set is the union of the film ids of `prediction_pointer`, `prediction_fingerprint` and `ratings_view`, read in keyset pages of 300 rows. Each field comes from one owner table. The compiled ratings seed is a separate in-memory layer applied by some readers **after** the derivation (see [Compiled ratings seed](#compiled-ratings-seed)).

| Field | Meaning | Authoritative source | Derivation |
| --- | --- | --- | --- |
| `prediction` | Display document of the current forecast | `prediction_pointer.display_json` | From the film's pointer row; absent when no row |
| `fingerprint` | Display facet of the current fingerprint (`plotMechanics`, `moodLabels`, `execution`, `fingerprintHash`) | `prediction_fingerprint.features_json` | Built from the row |
| `fingerprintHash` | Hash binding the entry to its fingerprint | `prediction_fingerprint.features_json` | Built from the row |
| `impactFeatures` | Raw execution values and schema of the exact fingerprint for selective compatibility | `prediction_fingerprint.features_json` | Built from the row |
| `moodFacet` | Canonical mood ids, groups and unmapped labels | Computed by `canonicalMoodFacet(fingerprint, prediction)` | Recomputed from the derived fingerprint and prediction; the footer reader derives without it |
| `watched` | Confirmed watched mark | `ratings_view.watched` | From the row; an absent row leaves it absent |
| `actualRating` | Owner's half-star rating, or an explicit `null` | `ratings_view.actual_rating` with `rating_known`; the compiled seed fills it only where the key is absent after the derivation | `rating_known=1` with a null rating gives an own `null`; `rating_known=0` leaves it absent |
| `watchlist` | Watchlist membership history (a boolean, either value, means the film was on the list); not a watched mark | `ratings_view.watchlist` | From the row |
| `id` | Redundant film id inside the entry | The map key | Informational only |

Id spellings are never normalized, so an alias keeps its own key. A prediction-only key is an entry without rating fields; a `prediction_fingerprint` row with no pointer adds features and the mood facet but no forecast.

**Refusals, never a fallback.** A prediction domain that is not `d1`, a missing database binding, a ratings domain that is not `d1` and open, a table above 20,000 rows or a malformed stored row refuses with the domain's own code (`prediction_domain_not_authoritative`, `prediction_domain_unavailable`, `ratings_domain_not_authoritative`, `prediction_domain_budget`); the routes answer 503. The two prediction tables and the ratings table are read as separate keyset reads, not one snapshot.

**The version token.** Where a raw ETag used to be a version (the Admin health display, the limbo pin and snapshot cache, the prediction recovery pin), the token is `d1:p<prediction generation>.q<queue generation>.r<ratings generation>`, which changes whenever either domain commits.

## Compiled ratings seed

`INITIAL_PERSONAL_RATINGS` is a map from id to rating compiled into the Worker. The committed repository seed is empty; `src/ratings-seed.js` supports a non-empty seed in a private build, and the read-side-effect harness tests that variant. Where a reader applies it, it does so **after** the D1 overlays:

- `applyRatingsSeed` sets `actualRating` for a seed id only when the entry has no **own** `actualRating` property. An own `null` (an explicit clear, `rating_known=1` with no rating) therefore wins over the seed, and a `ratings_view` rating wins over it too.
- An entry derived from `ratings_view` with `rating_known=0` or no row has no `actualRating`, so the seed value reaches the read.
- A seed id that has no entry at all **creates a new key**: membership of a seeded read is `D1 key set ∪ seed ids`.
- Seed appliers: `readViewIndex` (`GET /api/enrichment/view`), the Finds and programme reader (`overlayRatingsSeed` on the in-memory copy), and the footer fact count (`footerFacts` reads `seed[id]` for an id without an own `actualRating`, including seed ids the index does not hold). `ensureInitialRatings` is removed, so the seed is never persisted. The Admin, limbo, diagnostics and Letterboxd readers do not apply it.

## Writers

There are no writers of a stored view index. `updateViewIndex` (after a prediction submit, a batch submit or a fingerprint write), `ensureInitialRatings`, the mood backfill and the fingerprint-view backfill are removed; `POST /api/enrichment/moods/backfill` and `POST /api/enrichment/fingerprint-view/backfill` answer `410 Gone`. A prediction submit therefore no longer reads and rewrites a large object: it commits the prediction domain's D1 rows and the immutable R2 bodies, and the next read derives the view. The Letterboxd compare-and-swap writers on the view index are removed too: a projection goes to `ratings_view` through the ratings domain, and where that domain is not `d1` and open the facts layer projects nothing (`changed: 0`) and writes no raw object. The removed-film restore of raw view-index fields in the Letterboxd rollback no longer exists; under the D1 ratings domain it had no visible effect.

## Reader paths

| Reader path | Source | Seed |
| --- | --- | --- |
| Worker `loadJSON` (programme and Finds, queue and freshness, prediction diagnostics) | `derivedViewIndex`: key set and fields from D1 | Programme and Finds only |
| `readViewIndex` (`GET /api/enrichment/view`) | As `loadJSON` | yes |
| Footer streaming reader | Derived without the mood facet and projected to the footer fields; the authority is checked again after the read | per-id count only |
| Admin health (`/api/admin/health`) | Derived body; the displayed version is the D1 token | no |
| Admin limbo (`/api/admin/limbo`) | Derived body; the index version in the pin and the snapshot cache is the D1 token | no |
| Prediction recovery (`/api/admin/prediction-recovery`) | Derived through `loadJSON` on the get-only environment; the pin carries the D1 token | no |
| `LetterboxdFacts.readJSON` (scan, reconciliation and archive consumers) | `derivedViewIndex` with `ratingsOnly`: the `ratings_view` aliases only, no prediction table is read | no |
| Owner diagnostic export (`/api/enrichment/diagnostics/export`, group `global`) | No longer returns the view index | no |
| Operator Letterboxd scripts and `scripts/r2-snapshot-export.mjs` | See [Operator tools](#operator-tools) | no |

`LetterboxdFacts.readJSON` carries no prediction fields: its consumers read `watched`, `actualRating` and `watchlist`. No reader depends on a field this page does not list, except `id`, which is informational.

## Per-film mood object

`enrichment/films/<film>/mood-facet.json` is not produced and has no reader. The display facet is the `moodFacet` field of the entry, recomputed at read. Objects written by older versions remain in the bucket, are inert and need no repair.

## Operator tools

The four Letterboxd operator scripts (`scripts/letterboxd-reconcile.mjs`, `letterboxd-baseline-import.mjs`, `letterboxd-tmdb-search.mjs`, `letterboxd-display-exclusion.mjs`) require `--view-index-d1 <absolute file>`, the document written by `scripts/view-index-d1-export.mjs`; a missing option is a usage error and there is no fallback to the raw object of a snapshot. The exporter reads, with `SELECT` statements only, the film ids of `prediction_pointer` and `prediction_fingerprint` and the rows of `ratings_view`, and writes one private, never-overwritten JSON file outside the repository: the derived index (the union of the three key sets, each id spelled exactly as stored, with `watched`, `actualRating` and `watchlist` where `ratings_view` holds them, an own `actualRating: null` kept, a prediction-only key an empty entry), the D1 identity, the authority markers before and after, the counts and the read time. It refuses (exit code 3, nothing written) unless the prediction domain is `d1` and the ratings domain is `d1` and open, a table is within the 20,000-row cap, and no marker generation moved during the read; it does not retry. The tools validate the file (schema, source, entry objects, key count), record its digest, read time and key count in the baseline identity, and bind a TMDB results file to that digest, so a plan or a results file made from it is never reused with another view index. These tools read only the ratings evidence and the lid-shaped keys of the index, which the export carries. The compiled seed is a Worker layer and is not part of the export. Running the export against production is a separate owner-approved read operation. `scripts/r2-snapshot-export.mjs` still copies the bucket, so a snapshot may contain the stale raw object; it is not an input of these tools. `scripts/local-store.mjs` and `scripts/local-fixtures.mjs` build a local development store on the R2 stand-in and are not tools of the D1 source: they write `enrichment/view-index.json` only for operator tools and snapshot import, the Worker never reads it, and local development has no authoritative D1, so `/api/enrichment/view`, Finds and the footer refuse locally with `502` or `503` (a local D1 that satisfies the ratings contract also forces the published-EPG authority). The owner accepted this temporary limitation; restoring the full local D1 and R2 environment is [AIR-576](https://trello.com/c/ONq20jy9).

**Cost.** A full view is at most `floor(rows / 300) + 1` statements per table (49 on a table set of about 4,900, 4,900 and 4,500 rows) and holds only the derived fields, instead of reading and parsing one mutable object. Each reader that builds the view on its own does this work itself.

Retirement history, the loss of the former `r2` rollback and the owner-approved recovery boundary are in the [view index source runbook](../../runbooks/view-index-source.md).
