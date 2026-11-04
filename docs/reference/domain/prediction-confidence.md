# Prediction confidence assessment

Pure function `assessPredictionConfidence` in `src/domain/prediction-confidence.js`. It reads one fingerprint and returns a versioned `confidenceAssessment`. It does not read storage, a rating, a prediction, or the fingerprint's derived `sourceBasis`. It does not fetch a URL. The result is not written into the fingerprint and is not part of `fingerprintHash`.

The Worker loads the module and calls it once, when submit writes a new prediction snapshot. The call uses the fingerprint of that request, including its `fingerprintHash`: the body just accepted, or the stored fingerprint reused by `prediction_only`. The result is stored on that snapshot as `confidenceAssessment`. A caller-supplied `confidenceAssessment` is removed before storage and replaced by this result. `prediction.confidence` stays the model's enum. `prediction_validate`, the schema endpoint, catalog, view, Finds, Similar, EPG and the hourly task do not call the function. A read does not recompute the object and does not add it to a snapshot that was stored without the key. Versions stay `FINGERPRINT_SCHEMA_VERSION=1`, `FINGERPRINT_PROMPT_VERSION=1` and `PREDICTION_PROMPT_VERSION=1`. There is no feature flag and no backfill.

`presentConfidenceAssessment` returns a copy of a version-1 object whose `level`, `status`, reason codes and coverage are in the lists below, or `null`. A `legacy` or `insufficient` result whose level is not `low` is `null`.

## Result

| Field | Values |
| --- | --- |
| `assessmentVersion` | `1` |
| `level` | `high`, `medium` or `low` |
| `status` | `evidenced`, `legacy` or `insufficient` |
| `reasonCodes` | subset of the list below, in that fixed order |
| `coverage` | the nine counts below |
| `fingerprintHash` | the fingerprint's 64-character lowercase hex hash, or `null` |

`coverage`: `mechanicsAsserted`, `mechanicsSupported`, `keyApplicable`, `keyConcrete`, `keySupported`, `keyUnknown`, `keyNotApplicable`, `genrePresent`, `genreSupported`.

A missing `evidence` key is `legacy` / `low` / `legacy_no_evidence`. `null`, a non-object, an empty map, or a map with no supported mechanic and no supported key dimension is `insufficient` / `low`. `fingerprintSchemaVersion` other than `1` is `insufficient` / `low` / `unsupported_schema`, and the map is not scored. `legacy` and `insufficient` are never `medium` or `high`.

`evidence_shape`, `duplicate_ref` and `metadata_only_execution` reject the whole map. The result is `insufficient` / `low` even when other claims in the same fingerprint are usable. Those reason codes and the coverage counts stay on the result; the usable subset is not returned as `evidenced` or `medium`. `unknown` and `not_applicable` with no evidence items are gaps: they do not set `evidence_shape`, and a valid map can still be `evidenced` at `high` or `medium`. A metadata-only mechanic is valid and can stay `evidenced`.

## What counts as support

An item has `basis`, `refs` and `confidence` (`low`, `medium`, `high`). `metadata` refs are the four tokens `metadata:synopsis`, `metadata:genres`, `metadata:runtime` and `metadata:credits`. `model_knowledge` has that single ref. `web_research` refs are `https` URLs under the same host rules as the evidence validator (no userinfo, no loopback, private, link-local, `.local` or `.internal` host). The assessor does not check that a metadata token is present on `modelMetadata`; that check belongs to submit and `prediction_validate`. An item outside this shape is ignored.

A plot mechanic may be supported by metadata. An execution dimension may not: items that are all `metadata` set `metadata_only_execution` and do not support that dimension. A `model_knowledge` item or a URL sets `declared_source_not_verified`. That records a declared source. It is not a check that the film fact was verified independently. A repeated ref inside a claim sets `duplicate_ref` and lowers that claim's item confidence by one step. The claim's confidence is the weakest accepted item. Either `metadata_only_execution` or `duplicate_ref` then rejects the map, as the status rule above describes.

`unknown` is a gap in evidence, not a low score for a known execution value. `not_applicable` is excluded from the denominator. A genre dimension is scored only when the fingerprint has it. Its absence does not lower the level. A metadata-only genre item still sets `metadata_only_execution`.

## Key dimensions and thresholds

The key set is every schema-1 general dimension: `plot_engine`, `pace`, `stakes`, `decision_logic`, `protagonist_competence`, `opposition_competence`, `problem_solving`, `plan_counterplan_strength`, `multi_party_goals`, `chemistry`, `payoff`, `ending_quality`, `technical_plausibility`. Pace and stakes are included with the others. Genre dimensions are not in this set.

`keyApplicable` excludes `not_applicable`. `keyConcrete` is an applicable value other than `unknown` or a missing dimension. A missing key dimension counts as unknown. `keySupported` is a concrete dimension with at least one non-metadata item.

| Level | Rule |
| --- | --- |
| `high` | the map is not rejected; every asserted mechanic is supported; every concrete key dimension is supported; at least 8 concrete key dimensions are supported at item confidence `high`; at most 2 key dimensions are unknown; none of those supported claims is `low` |
| `medium` | the map is not rejected and is not `high`; at least one asserted mechanic and at least half of them supported; at least 4 concrete key dimensions supported and at least half of the concrete ones; unknown dimensions are at most half of the applicable ones; `low` item-confidence claims are not a majority of the supported ones |
| `low` | anything else that is still `evidenced`, and every `legacy` or `insufficient` result |

Thresholds live in `CONFIDENCE_ASSESSMENT_THRESHOLDS` (`highUnknownMax: 2`, `highSupportedMin: 8`, `mediumSupportedMin: 4`). The half rules are integer comparisons (`supported * 2 >= concrete`, and the same shape for mechanics, unknown and low item confidence).

## Reason codes

`legacy_no_evidence`, `evidence_unusable`, `unsupported_schema`, `evidence_shape`, `metadata_only_execution`, `metadata_mechanic`, `declared_source_not_verified`, `low_item_confidence`, `duplicate_ref`, `unknown_gap`, `no_asserted_mechanics`, `partial_mechanic_coverage`, `partial_execution_coverage`, `key_coverage_complete`, `not_applicable_excluded`, `genre_optional`.

`evidence_shape` covers a claim list that is not 1–4 items, an item the shape rejects, a mechanic that is not in the asserted list or has no usable items, evidence items on an `unknown` or `not_applicable` dimension, and a concrete key dimension with no usable items. An `unknown` or `not_applicable` dimension with no evidence entry is not `evidence_shape`. Together with `duplicate_ref` and `metadata_only_execution`, it fails the whole map closed. The assessor does not try to detect a contradiction between two URLs.

## Effective level

`effectivePredictionConfidence` is the level Finds and Similar use. It is derived when the page reads a prediction. It is not a second stored field.

| Stored snapshot | Effective level |
| --- | --- |
| No `confidenceAssessment` key | the model's `prediction.confidence` (`low`, `medium` or `high`), or `null` when that field is not one of those three |
| The key is present, including `null`, but the object is not a complete bound version-1 assessment (`reasonCodes`, every coverage count, and a matching 64-character lowercase hex `fingerprintHash`), or the snapshot has no such hash | `low` |
| A version-1 assessment whose `fingerprintHash` equals the snapshot hash | `assessment.level` |

`legacy` and `insufficient` are stored as `low`, so a bound assessment in either status is effective `low`. A missing evidence map is `legacy` / `low` / `legacy_no_evidence`. A rejected map (`evidence_shape`, `duplicate_ref`, `metadata_only_execution`) is `insufficient` / `low`. Neither is presented as `medium` or `high`. The model's `confidence` is left unchanged and is not used once the key is present. Rating and probability thresholds are not part of this function.

The page copies the same rule in `effectiveConfidence`. It does not call `assessPredictionConfidence`.

## Film page

When `prediction.confidenceAssessment` is absent, the forecast shows the stored `prediction.confidence` as before (`уверенность` plus низкая / средняя / высокая). Finds and Similar then use that same model field. When a version-1 assessment is present, `level` and `status` are exactly `high` / `medium` / `low` and `evidenced` / `legacy` / `insufficient` (an inherited name such as `toString` or `constructor` does not match), its reason codes are an array, and every coverage count is an integer from 0 to 99, the stored model field is labelled `уверенность модели` and a second block says `Качество доказательств` with the assessment level in words. Up to three reason sentences are visible; the `title` carries the same sentences. The level is also a `data-level` attribute. Color is not the only signal, and the block does not reuse the rating numeral's fill. Text is escaped. An object outside that shape, including one that has only version, level and status, renders nothing. When the prediction object already has a 64-character lowercase hex `fingerprintHash`, the block renders only if the assessment hash is that same value. The view and catalog responses copy `confidenceAssessment` and `fingerprintHash` whenever the stored snapshot has the `confidenceAssessment` key, including when the value is `null` or otherwise not a complete assessment. The page does not fetch either field on its own.

Finds and the catalog half of Similar apply the effective level above. The floor stays a fresh `predictedRating` of at least 4.0 and a `probability4Plus` of at least 0.70. A snapshot without the key still passes or fails on the model field. A snapshot with the key passes only when the effective level is `medium` or `high`. A new snapshot whose fingerprint has no usable evidence is effective `low` and leaves Finds even when the model submitted `high`.

History events keep the stored `confidence` of that record. The event whitelist does not copy `confidenceAssessment`, and a reader does not invent one. The immutable prediction version body includes the assessment because that body is the snapshot minus the pointer fields.

## Rollback

Revert the Worker. Snapshots already written keep `confidenceAssessment` on their immutable bodies; reverting the code does not strip them and does not recompute older snapshots. After a revert, a later submit stops attaching the object, and Finds again reads the model field even on a snapshot that still carries the key. No migration runs in either direction.
