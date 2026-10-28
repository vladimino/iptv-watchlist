# Prediction quality — read-only prospective metrics

`GET /api/enrichment/quality[?limit=<n>][&cursor=<cursor>]` evaluates one page of the owner's Letterboxd fact records against the stored prediction history and returns metrics with a named denominator, every excluded case with its reason, and additive statistics for summing pages. It is owner-only like every Worker path (Cloudflare Access; no bypass, not exposed through MCP) and only reads R2: no write, model call, ratings refresh, lease or background work (`tests/get-side-effects.mjs`, `tests/prediction-quality.mjs`).

Implementation: `classifyFilmQuality`, `addFilmQuality`, `mergeQualityStats`, `finalizeQuality` in `src/domain/prediction-quality.js` (pure); `predictionQualityRoute` in `src/enrichment.js` (reads). The per-film events are those of the [film history API](film-history.md).

## Request and cost

| Parameter | Rule |
| --- | --- |
| `limit` | 1–50 fact records per page, default 25. Otherwise 400. |
| `cursor` | `page.nextCursor` of the previous page (the R2 listing cursor). A malformed cursor is 400. |

Per request: one `LIST` of `letterboxd/facts/films/` bounded by `limit`; per record its own `GET` and the prediction bundle of each of its ids (`<lid>` and `tmdb_<n>`); the legacy rating log and the profile once; one `GET` of the immutable version object of each prospective pair. There is no full listing per request. A record with `redirectTo` is skipped (its target is listed on its own); a record in a convergence (`migrating`) is skipped and named, because no convergence writer exists yet.

Pages are read at different times; a client that sums them gets the statistics of the records as each page saw them.

## Classification

Every standing rating event of a record (`ratingHistory`, each observation once: a rollback without a later re-application removes it, a re-application counts once) gets exactly one class:

| Class | Reason | Rule |
| --- | --- | --- |
| `prospective` | `absent_after_prediction` | A `changed` event to a half-star value whose `previous` value is `null` (seen, not rated) with an `observedAt`, the value itself observed **strictly later** than that absence, and a prediction generated **at or before** the absence observation. The rating did not exist when it was predicted, so the pair is blind. At most one per film: the first. |
| `pre_existing_or_unknown` | `first_observed` | The value existed before it was first observed; when it was given is unknown. |
| `rerating` | `previous_rating` | A change from one value to another. Descriptive only. |
| `unknown_order` | `no_absence_observation` | A change without a dated absence observation before it. |
| `unknown_order` | `rating_time_missing`, `rating_time_equals_absence`, `rating_time_before_absence` | The value's `observedAt` is missing, equal to the absence observation or earlier than it: no proof that the value came after the absence. |
| `unknown_order` | `prediction_inside_rating_window` | The only predictions were made between the absence observation and the value, so the order is unknown. |
| `excluded` | `rating_not_a_value`, `no_prediction`, `no_prediction_before_rating`, `later_rating_after_clear` | A `null` rating; no prediction at all; predictions only after the rating; a value after the rating was cleared again (not a second blind pair). |
| `excluded` | `prediction_incomplete` | The chosen record lacks a numeric `predictedRating` or a `probability4Plus` in [0, 1]. |
| `excluded` | `version_unverified` | The chosen record points to an immutable version object that is missing, mismatching or invalid. |

The chosen prediction is the latest one generated at or before the absence observation; at the same instant a replaced record is older than its replacement, and `predictionTie` is reported. Its values, versions and lineage are its own, never today's. `observedAt` is never a rating or watch date. Entries of the legacy rating log (`legacyUnverified`) are counted per film and never paired, so they cannot double-count a facts event.

## Metrics

On the prospective pairs only (`metrics.denominator.n`); with `n = 0` every rate is `null`, never 0:

| Field | Definition |
| --- | --- |
| `exactHits`, `exactHitRate` | predicted rating rounded to the nearest 0.5 equals the actual rating |
| `mae` | mean absolute error |
| `bias`, `biasDirection` | mean of predicted minus actual; positive means over-prediction |
| `probability4Plus.target` | the binary target actual ≥ 4.0 |
| `probability4Plus.brier` | mean of (probability4Plus − target)² |
| `probability4Plus.calibration` | five bins [0, .2), [.2, .4), [.4, .6), [.6, .8), [.8, 1] with `n`, `meanPredicted`, `observedRate`; only from `minimumN` (30) pairs, otherwise `null` with `calibrationStatus: insufficient_n` |
| `caveats` | pairs with unknown lineage (no `runId` or `fingerprintPromptVersion`), without an immutable version (`none`), with a prediction tie |
| `segments` | `n`, `mae`, `bias`, `exactHitRate` per `profile:<tasteProfileVersion>|prompt:<predictionPromptVersion>` |
| `excluded`, `reasons`, `legacyUnverified` | counts per class and reason |

## Response

`{schemaVersion, readAt, profile, page: {limit, records, nextCursor}, stats, metrics, films}`. `stats` is the additive form: sum two pages with `mergeQualityStats` (counts and sums add field by field) and apply `finalizeQuality` to get the metrics of both. `films` lists per record its `factKey`, `filmIds`, every classified rating (`class`, `reason`, `actual`, `ratingObservedAt`, and for a paired prediction its time, values, versions, `lineageKnown`, `versionStatus`) or `skipped`. No account URL or name is returned.

## Relation to the older accuracy diagnostic

`GET /api/enrichment/diagnostics/accuracy` is unchanged: it compares the frozen diagnostic snapshot of 8 October 2026 with the legacy rating log and does not read the fact records or the prediction history. This route is the one built on the durable history; the two are not merged.
