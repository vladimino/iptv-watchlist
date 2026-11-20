# View index membership options, offline analysis

**Date:** 2026-11-20 UTC. **Source:** `main` `2203a0fac237758e7b53977b51cedeaa8c0cbfd7`. **Work:** [AIR-552](https://trello.com/c/Hk2dJf2U); decision record [ADR 0183](../../adr/0183-view-index-membership-from-d1-rows.md) (Proposed); earlier audit [field audit](air-552-view-index-field-audit-2026-11-20.md).

## Scope and evidence boundary

Source reading and synthetic fixtures only. No production R2 object, D1 row, Worker setting or Cloudflare API was read, and nothing was written. Figures about production size come from the dated [footer RCA](../footer-status-oom-rca-2026-11-17.md) (17 November 2026) and are not re-measured. The real key sets are **not** compared; that needs a separate owner GO for one read-only export.

## Which readers use the key set

Searched `src` for uses of the index as a map (`index?.[id]`, `Object.keys`, `Object.entries`) and read each consumer.

| Reader | What it takes from the entry | Absent entry equals an empty entry |
| --- | --- | --- |
| Admin health dimensions (`adminHealthDimensions`) | `item.fingerprintHash`, `item.prediction` | yes |
| Limbo (`src/admin/limbo.js`) | `entry.prediction`, `entry.fingerprintHash` | yes |
| Queue and freshness (`freshness.indexed`, `index?.[id]`) | prediction and fingerprint fields | yes |
| Footer facts and counts | `watched`, `actualRating` (with the seed), `watchlist` booleans | yes |
| Finds and catalog exclusion (`accept(item)`, `catalogMergedItem`) | `watched`, `actualRating`, `watchlist`, prediction | yes |
| Worker Letterboxd archive preview (`src/admin/letterboxd-archive.js`) | none: `buildIndex` is called without the view index | not applicable |
| Prediction diagnostics (`snapshot.index?.[filmId]`) | prediction and fingerprint fields | yes |
| **`catalogBridgeIds`** (`src/worker.js`) | **the key itself**, added to the identity bridge candidate ids | **no** |
| **Admin health card** (`entries`) | **the number of keys** | **no** |
| **Operator Letterboxd scripts** (`letterboxd-reconcile`, `letterboxd-baseline-import`, `letterboxd-tmdb-search`, `letterboxd-display-exclusion`, through `buildIndex` in `src/letterboxd-match.js`) | `actualRating`, **and every lid-shaped key**, which `lidFilm('view_index', ...)` registers as a match target and counts in `lidsBySource.view_index` | **no** |

The operator scripts do not run in the Worker. They read the view index from a local snapshot file (`r2-snapshot-export` exports `enrichment/view-index.json`), so a replacement must also say what that snapshot contains: a D1-derived key set, or no view-index source.

Consequence: dropping a raw key that has no D1 row and no seed id removes no fact from any field reader. It can change the bridge candidate list, the `entries` figure and, in the operator scripts, the set of lid-shaped match targets.

## Classifier

`scripts/view-index-membership-parity.mjs` (`compareMembership`, pure, never bundled into the Worker) takes a raw key set, the film ids of `prediction_pointer` and `prediction_fingerprint`, `ratings_view` rows and a seed, and reports today's key set (raw ∪ ratings aliases ∪ seed ids), the union key set (D1 ids ∪ seed ids) and the only two differences: `disappears` and `gainsForecast` (with `addedKeys`, the subset that is a new key). It also classifies the seed against `ratings_view`: an own `null` wins, a rating wins, otherwise the seed fills, and a seed-only id is a key in both models.

`tests/view-index-membership-parity.mjs` (core) covers one id per category, a raw key that is also a seed id, a forecast id that is already a ratings alias, two spellings of one film (kept as two ids, so an alias collision is visible), empty inputs, the empty committed seed and input immutability. It uses synthetic ids only. Not covered, because the pure classifier does not model them: concurrent prediction and ratings writes (covered by the existing overlay tests and by D1 batch semantics, not by this module), the SQL keyset paging and the row caps (`PREDICTION_OVERLAY_ROWS` and `RATINGS_OVERLAY_ROWS`, 20,000 each, enforced by the existing overlays), and CPU.

## Result and limits

The offline analysis supports the recommendation in the ADR: the key set carries no facts, and the union differs from today's key set in two reportable ways. It does not show how many ids fall in each class on production, whether a `disappears` id is the only bridge to a film, or whether `gainsForecast` ids are Finds candidates. Those are the parity run, which needs the owner's GO. AIR-552 stays open.
