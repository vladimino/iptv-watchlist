# AIR-79 mutable predictions D1-only slice (ADR 0162), 18 November 2026

**Trello:** [AIR-79](https://trello.com/c/485tlGLA). **Decision:** [ADR 0162](../../adr/0162-d1-only-authority-retire-rollback-toolchain.md). **Captured:** 18 November 2026 (UTC). Fourth per-domain slice of ADR 0162, after [owner reviews](air-79-owner-reviews-d1-only-2026-11-18.md), the [metadata cache](air-79-metadata-cache-d1-only-2026-11-18.md) and [ratings documents](air-79-ratings-documents-d1-only-2026-11-18.md). No production read or write was made for it; the production marker was read on 17 November ([marker read](air-79-d2-closeout-and-d1-preparation-2026-11-17.md#production-markers-read-on-17-november): mutable predictions `mode` `d1`, `writes` `held`, generation 18665). For predictions the rule checks `mode` only: `writes` `held` is the normal state after activation and is served.

## Change

| Item | Verdict |
| --- | --- |
| `importPredictionDomain`, `activatePredictionDomain`, `releasePredictionWriters`, `reconcilePredictionIntents`, `revertPredictionDomain`, `predictionParity`, `snapshotParity` and their helpers (hold, prune, mirror repair, listing) in `src/prediction-d1.js`, and `scripts/prediction-domain-authority.mjs` | Removed |
| `--load`, `--activate`, `--revert`, `--release`, `--reconcile` of `scripts/prediction-domain-production.mjs` | Refused with `retired` before any request. Retained: the status command (now a raw, never-refusing read of the marker, so an operator still sees an uninstalled domain and a marker in mode `r2`), the schema `--apply`, and `--materialize-fingerprints` |
| `readPredictionAuthority` | A marker in mode `r2` fails closed with `prediction_domain_unavailable` (the migration inserts it, and a Time Travel restore to before the activation would bring it back). With `PREDICTION_DB_REQUIRED=on` (production) a contract below 7 and a database with none of the domain tables now fail closed too; before, both silently returned the R2 stand-in. Without that variable (local development and tests) the uninstalled domain is still the stand-in |
| The mode-`r2` write claim: `reservePredictionWrite`, `completePredictionWrite`, `r2Claim`, the claimed branch of `saveMutable`, and the claim and intent around the object put of `writeQueue` and `writeLease` | Removed. A head captured before the tables existed still refuses against an installed domain (and the reverse); two stand-in heads write the object, unconditionally on a claim. The callers in `src/enrichment.js` (profile publication) and `src/worker.js` (`saveJSON`) no longer carry a claim token |
| `prediction_domain_intent` | Dormant: nothing writes or reads it. The table stays in the schema (ADR 0162 keeps the CHECK values and constraints; dropping it is a migration with no benefit) |
| Batch runner v2 start | A marker in mode `r2` or a missing table is `502` `prediction_domain_unavailable` under `PREDICTION_DB_REQUIRED`; `409` `batch_runner_requires_d1` remains only for the local stand-in |
| The enrichment projector (`src/d1-enrichment.js`) | Unchanged in code: it already stops on the authority reader's refusal, so it never projects against the R2 objects |
| Generation and queue/profile CAS, the commit guard, the request scope of AIR-441, immutable body verification, the R2 mirror writes after a `d1` commit, `COMMIT_GUARD` | Retained |

## Decision for the Controller

`--materialize-fingerprints` is **kept**. It repairs a missing immutable fingerprint body in R2 (create-only) and is not a return to R2; ADR 0162 does not list it among the cutover commands and ADR point 4 keeps immutable bodies. It can be retired in a later slice if the owner wants it gone.

## Neighbouring work

Open pull requests that touch the same files, checked on 18 November before the change: #734 (prediction recovery intent, ADR 0165 Proposed: `src/enrichment.js`, `src/prediction-diagnostics.js`, `src/worker.js`) and #743 (`src/enrichment.js`, `tests/submit-validation.mjs`). This slice edits two small hunks of `src/enrichment.js` (profile publication) and `src/worker.js` (`saveJSON`) and no file those pull requests create. #745 (poster hydration) and #746 (`POST /api/started`) touch `src/worker.js` and `src/canonical-catalog-reader.js` elsewhere. A textual conflict on a later rebase is possible in `src/enrichment.js` or `src/worker.js` and is resolved by keeping both changes.

## Tests

`tests/prediction-domain.mjs` is rewritten around the rule: a marker in mode `r2`, a restored `r2`, a missing table, a missing binding and a binding that does not answer are refused by the reader and by every writer; `writes` `held` is served; the local stand-in keeps the objects; a stale head is refused against an installed domain; the d1 reads, the fenced writes, the immutable body checks and the projector are kept, with the fixture seeding state through the normal writers instead of the retired import. `tests/prediction-domain-production.mjs` proves every retired command is refused before any request (also with a binding that throws on use), the raw status for an uninstalled, an `r2` and a `d1`/`held` database, the schema apply, a lost response, and the fingerprint body repair with its failure redaction. Fixtures that relied on the `r2` marker put it at `d1` (the projector tests through the shared fixture constant, `published-epg`, the GET write audit, the film page) or drop the prediction tables to stand for the uninstalled local domain (`tests/film-history.mjs`, the forecast-from-R2 section of `tests/catalog-film.mjs`). `tests/projector-window-r2-inventory.mjs` records two fewer R2 write sites in `src/prediction-d1.js`.

## Verification

Local, after a fresh `npm ci`: `npm run test:all` on the final checkout, `npm run build`, `git diff --check`; the result is in the pull request. No Mermaid block changed.
