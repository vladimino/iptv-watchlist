# Prediction and rating history: gap matrix

- **Card:** [AIR-12](https://trello.com/c/kh3xGQSp). **Captured:** 28 October 2026, 17:40–18:00 UTC. **Code:** GitHub `main` at `1a4a3ac`.
- **Scope:** the R2 keys, record shapes and writers of prediction history and of the owner's actual Letterboxd ratings; write invariants, idempotency, compare-and-swap and crash/replay; what is missing for a durable quality history. Read the code, plus aggregate read-only R2 reads of production (Cloudflare API `GET`/`LIST`, no record contents reproduced).
- **Verdict:** two real gaps, fixed in the AIR-12 pull request under [ADR 0038](../../adr/0038-durable-rating-and-prediction-lineage.md) (Proposed): no durable rating change history under `LETTERBOXD_FACTS=on`, and three missing lineage fields on new prediction records. Everything else is already present and is not rewritten.
- **Operational authority:** none. No write, flag, Task, model, sync or ratings call.

## Matrix

| Area | Already present (key, writer) | Missing | Production impact |
| --- | --- | --- | --- |
| Current prediction and its history | `enrichment/films/<id>/predictions.json` `{current, history[]}`; `enrichmentSubmit` appends the replaced record with `replacedAt`, under the prediction writer lease | — | none |
| Immutable prediction versions | `…/predictions/versions/<sha256>.json`, create-only, written before the bundle (`writePredictionVersion`), with `PREDICTION_VERSION_OBJECTS=on` since 27 Oct 2026 about 17:42 UTC; history keeps the pointers; one-time materialization of older records is AIR-179/AIR-74 | — (not rewritten, no duplicate objects) | none |
| Prediction fields | `filmId`, model fields (`predictedRating`, `probability4Plus`, `confidence`, `matchSignals`, `mainRisk`, `moodLabels`), `generatedAt`, `tasteProfileVersion`, `tasteProfileHash`, `fingerprintHash`, `fingerprintSchemaVersion`, `predictionPromptVersion` | `fingerprintPromptVersion` (part of a fingerprint's identity since ADR 0035), `runId`, `trigger`; all three known at submit | added to new records only; old records unchanged and treated as unknown |
| Recalculation reason | derivable from the replaced and the new record (profile version/hash, fingerprint hash/schema/prompt, prompt version) | — (not stored, by decision) | none |
| Immutable fingerprints | `…/fingerprints/<hash>.json` and `…/fingerprint-generations/<hash>-s<n>-p<n>.json` with `FINGERPRINT_VERSION_OBJECTS=on` (AIR-208/210) | — | none |
| Actual rating, current | fact record `letterboxd/facts/films/<factKey>.json` (`rating` with `observedAt`, `source`, `sourceRef`, `observationId`, one-level `replaced`), compare-and-swap with five retries; projection to `enrichment/view-index.json`; `actual.json` per film | — | none |
| Actual rating, change history | legacy `enrichment/diagnostics/rating-observations.json`: appended only by the pre-facts writers and only while the diagnostic baseline exists | **no durable change history under `LETTERBOXD_FACTS=on`**: `replaced` holds one level, a second change loses the first | `ratingHistory` in the fact record (ADR 0038); no backfill |
| Scan summaries | `letterboxd/facts/scans/films-list.json` and `watchlist.json`, replaced wholesale by a newer complete scan; staged with `.pending.json` | — (a summary is a snapshot, not history; changes it causes reach the records) | none |
| Watched / watchlist | facts `watched`, `watchlist` with one `replaced` level | not in AIR-12 scope (quality history needs ratings) | none |

## Production observations (aggregate, read-only)

| Observation | Value |
| --- | --- |
| `rating-observations.json` entries | 324 (318 `letterboxd_public_films`, 6 `letterboxd_member_film`) |
| Its first and last `observedAt` | 2026-10-08 15:41 UTC and 2026-10-25 22:04 UTC; none after `LETTERBOXD_FACTS=on` (27 Oct) |
| Fact records | 438 |
| Sample of 30 records: with a rating / with `replaced` | 11 (all `letterboxd_export`) / 0 |

No production rating has changed under the facts gate yet, so nothing has been lost so far; the first change after deployment of the fix starts the history.

## Invariants checked in code

- **Idempotency:** a fact observation is identified by `observationId` (SHA-256 of key, fact, value, time, source, reference); the same observation is `unchanged`. Prediction versions are content-addressed and create-only.
- **Compare-and-swap:** every fact record write re-reads and re-applies on an ETag mismatch; the history entry is added inside that function, so a retry applies it to the fresh record once.
- **Crash/replay:** the history is in the record's own write, so it is never ahead of or behind the value; a replay of an applied observation is `unchanged` and adds nothing. A prediction version written before a failed bundle write stays unreferenced (existing behaviour).
- **Pre-existing values:** an export or first scan of an already rated film is `first_observed`; its `observedAt` is the observation time, not a rating date.
- **Rollback:** a baseline-import rollback restores `replaced` (unchanged) and appends a `rolled_back` entry; a prediction rollback is a code revert and deletes nothing in R2.

## Limits

- No history exists for changes before the deployment of the fix; `replaced` and the legacy log are the only earlier traces and are not converted.
- The convergence merge of two fact records is specified but has no writer yet; it must union the histories when it is built.
