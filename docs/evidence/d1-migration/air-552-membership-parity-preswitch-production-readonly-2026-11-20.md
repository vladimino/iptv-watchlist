# View index membership parity before the switch: a second read-only production cut

**Date:** 2026-11-20 UTC, preflight 18:06 and cut 18:12:25 to 18:12:40 (19:12 Europe/Madrid). **Source tree:** `main` `58593fa36a8cdee0d4179213eb75b589fde54ab0`. **Work:** [AIR-552](https://trello.com/c/Hk2dJf2U); decision [ADR 0183](../../adr/0183-view-index-membership-from-d1-rows.md); earlier cut [membership parity, first production cut](air-552-membership-parity-production-readonly-2026-11-20.md); runbook [view index source](../../runbooks/view-index-source.md).

## Verdict

**INCONCLUSIVE by the cut's own fence, with no membership difference observed.** The classifier finds none of the four differences (`removedKeys`, `newKeys`, forecast gains, feature gains are all 0) and the two key sets are identical (8,188 and 8,188), but the prediction domain's generation advanced from 31,051 to 31,054 inside the 14-second window, which the cut defines as a failed fence. Every other fence held. Nothing here is a PASS, and nothing here accepts or rejects a switch.

## Authorization and boundary

One owner-approved, bounded, read-only comparison of the key set of `enrichment/view-index.json` in bucket `iptv` against the film ids of three D1 tables, in the owner's words a fresh parity before the switch, with no authorization to set `VIEW_INDEX_SOURCE`, change a binding or flag, write to D1 or R2, run `scripts/view-index-d1-export.mjs`, retry, or clean up. A first attempt failed because of a defect in the measuring script (below); the owner then authorized exactly one replacement cut, which this report describes. No retry followed it. Nothing was written anywhere in production, and no identifier, payload or credential is recorded here, only counts and shapes.

## What happened, in order

| UTC | Step | Result |
| --- | --- | --- |
| 18:06 | Read-only `feature_flags` | `VIEW_INDEX_SOURCE` absent, valid, effective `r2` (default), `sideEffects: none`, storage not accessed |
| 18:06 | D1 identity and preflight | database `iptv`, uuid `3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb`, equal to `wrangler.jsonc` and Cloudflare; schema 29; prediction `d1`, `writes=held`, generation 31,046; ratings `d1`, `cutover=open`, generation 4,193; tables 4,976, 4,976 and 4,497 rows, all below the 20,000-row cap |
| 18:07:20 to 18:07:31 | **First attempt** (not counted) | One pass of the same reads. The script died on a defect of its own (a variable used before its declaration) at its last line, after all production reads and before it wrote its fence values; the ETag, size, digest, markers and closing HEAD of that pass were lost. The key sets it had saved were not used as evidence. No second pass was made on the spot |
| 18:12:25 to 18:12:40 | **Replacement cut** (this report) | Described below |

The measuring tool was then rebuilt so that the failure class cannot repeat: it resolves everything local before the first production read, rewrites a progress document after every stage (the ETag, digest and markers are on disk before the next read), records a failure in that document before rethrowing, never retries, and stops before any R2 read if the authorities are not the production ones. It was tested offline with fakes (a normal run, a page boundary, a moved ETag, a moved generation, a row appearing during the read, a failing statement with no retry, a marker that is not authoritative, a missing object and a crash after the cut) before the replacement cut ran. The tool and its tests are working files, not part of the repository.

## The replacement cut

- **R2:** one HEAD, one GET with `If-Match` of that ETag, one closing HEAD, no listing, no retry. Object `enrichment/view-index.json`, ETag `cf70f25e873cce6f16400e26b5ff5241`, **13,889,184 bytes**, last modified 18:01:28 GMT (11 minutes before the cut), SHA-256 of the received bytes `0944adf3da5d89e24dde6dce07f01931cd561c971522aed0a2ac21f1804fc7cf`. The ETag was identical at the first HEAD, the GET and the closing HEAD.
- **D1:** `SELECT` statements only, keyset pages of 300: `film_id` of `prediction_pointer` and of `prediction_fingerprint`, and `alias_id`, `rating_known` and `actual_rating` of `ratings_view`. No `display_json` or `features_json` was selected. Every answer reported `rows_written: 0` and `changed_db: false` (the helper rejects any other answer).
- **Pages:** pointer 17 pages, fingerprint 17 pages, ratings 15 pages; rows read equal rows returned on each.
- **Markers:** before and after, in the same window.

| Fence | Before | After | Held |
| --- | --- | --- | --- |
| R2 ETag (three reads) | `cf70f25e…` | `cf70f25e…` | yes |
| Schema version | 29 | 29 | yes |
| Ratings generation | 4,193 | 4,193 | yes |
| Prediction generation | 31,051 | **31,054** | **no** |
| Authorities still `d1` and open | | | yes |
| Paged rows equal the preflight counts (4,976, 4,976, 4,497) | | | yes |
| Keys unique in every table | | | yes |

## Result (offline classification of the cut's key sets)

Classified with `compareMembership` (`scripts/view-index-membership-parity.mjs`); the compiled seed is the repository seed of `58593fa`, which is empty (the seed of the deployed bytes was not read, as before, so seed precedence is not shown on production data).

| Quantity | Value |
| --- | --- |
| Raw view-index keys | **5,409** (all unique) |
| `prediction_pointer` ids | **4,976** (the same set as the fingerprint ids) |
| `prediction_fingerprint` ids | **4,976** |
| `ratings_view` aliases | **4,497** (3,877 `rating_known=1`, of which 16 are an explicit null; 620 unknown) |
| Current key set (raw ∪ ratings aliases ∪ seed) | **8,188** |
| Union key set (pointer ∪ fingerprint ∪ ratings aliases ∪ seed) | **8,188** |
| `removedKeys`, `newKeys` | **0, 0** |
| Forecast gains, feature gains (`forecastOnly`, `featuresOnly`, `forecastAndFeatures`) | **0, 0** (0, 0, 0) |
| Gains on an already existing key, seed categories | 0; 0, 0, 0, 0 |

Independent set arithmetic agrees: `today − union = 0` and `union − today = 0`; every pointer and fingerprint id is already a raw key; every raw key is in at least one D1 table; 433 raw keys have no prediction row and are kept by their ratings alias; 3,691 raw keys have no ratings row and are kept by their prediction rows; 2,779 ratings aliases are not raw keys, which today's overlay already adds. The failed first attempt, read a few minutes earlier, gave the same counts and the same classification (an observation, not evidence).

**Against the earlier cut** (20 November, 15:29 to 15:30 UTC: raw 5,380; pointer and fingerprint 4,947; ratings 4,494; both key sets 8,158): raw +29, pointer and fingerprint +29, ratings aliases +3, both key sets +30, differences still 0, 0, 0, 0. The earlier numbers are a baseline, not an expectation.

## Why the fence failed, and what it does not show

- The prediction domain's generation advanced from 31,046 (18:06) to 31,051 (18:12:27) to 31,054 (18:12:39). It moves with every fenced prediction write, queue and lease writes included, so while predictions run it moves continuously; the earlier cut simply fell into a quiet interval. A fence on this counter alone will usually report a moving generation on a live system. In this window the R2 object had not been written for 11 minutes, and no table gained or lost a row, so no change of membership is visible. A write that added one id and removed another cannot be excluded by counts.
- The cut is one non-atomic instant, as before. Field values were not compared, only ids. The compiled seed of the deployed build was not read. Worker CPU, memory and latency were not measured. The D1-derived export for the operator tools was not run (outside this authorization).
- Production calls in total: R2, four HEAD and two GET across both passes, no listing; D1, 119 `SELECT` statements (six in the preflight, 55 in the first pass, 58 in the replacement), plus one metadata read of the database by the Cloudflare API and one `feature_flags` read. No write of any kind.

## For the owner

Whether this evidence is sufficient to plan the switch, or a different fence is wanted, is the owner's decision; a fence that cannot be satisfied while predictions run needs a different definition (for example the R2 ETag, the three row counts and an id checksum, rather than the prediction generation). No new cut was made, no switch plan was started, and AIR-552 stays open.
