# Fingerprint schema and prompt contracts: read-only code audit

**Captured:** 2026-10-28, read-only code reading  
**Code reviewed:** `main` `c435504`  
**Sources:** repository code, tests and maintained documentation only (`src/`, `migrations/`, `docs/`). No R2, D1, MCP, Cloudflare or production read; no fingerprint, prediction or queue record was opened  
**Scope:** the fingerprint and prediction version fields, where they are stamped and checked, how fingerprints are stored, and what a fingerprint schema or prompt change would do today  
**Verdict:** the fingerprint side is strict equality on `fingerprintSchemaVersion` and `predictionPromptVersion` in every consumer, through one shared evaluator plus four separate copies. Three gaps block any selective transition: the fingerprint is overwritten in place, the fingerprint prompt has no version, and a run is not bound to the fingerprint and prompt versions it started with  
**Used by:** [AIR-33](https://trello.com/c/rBFiUUZQ), [ADR-0035](../../adr/0035-selective-fingerprint-transition-compatibility.md); input for [AIR-207](https://trello.com/c/GiFL0jy8)–[AIR-210](https://trello.com/c/DM1Rrnrz)

## Method

1. Search for these names in `src/`, `migrations/` and `docs/`:
   - `FINGERPRINT_SCHEMA_VERSION`, `fingerprintSchemaVersion`, `DOMAIN_FINGERPRINT_SCHEMA_VERSION`;
   - `PREDICTION_PROMPT_VERSION`, `predictionPromptVersion`;
   - `fingerprintCurrent`, `fingerprint.json`, `fingerprintHash`, `invalidatedAt`.
2. Read each hit in context.

Line numbers refer to `c435504`.

## Version fields

| Field | Defined | Stamped | Notes |
| --- | --- | --- | --- |
| `fingerprintSchemaVersion` | `FINGERPRINT_SCHEMA_VERSION=1`, `src/enrichment.js:16` | part of the model output. The submit validator requires it as a constant (`FINGERPRINT_RULES`, `src/enrichment.js:85`) and copies it onto each new prediction (`src/enrichment.js:754`) | Inside the hashed content: `fingerprintHash = contentHash({...fingerprint, filmId})` (`src/enrichment.js:751`) |
| fingerprint prompt version | none | none | The generation guidance is the Scheduled Task prompt plus the runner instructions (`predictionRunnerContract`, `src/enrichment.js:705`); no record names a revision |
| `predictionPromptVersion` | `PREDICTION_PROMPT_VERSION=1`, `src/enrichment.js:17` | on each new prediction (`src/enrichment.js:754`) | Not in any hash |
| Run binding | the run record keeps `fingerprintSchemaVersion` and `predictionPromptVersion` (`src/enrichment.js:702`); `next` returns them (`src/enrichment.js:735`) | — | Next, submit and complete end a run only when the **profile hash** differs (`src/enrichment.js:713`, `741`, `782`); a changed schema or prompt constant is not detected |

The same constants are duplicated as `FINGERPRINT_SCHEMA_VERSION` and `PREDICTION_PROMPT_VERSION` in `src/prediction-repository.js:6–7`, and as `DOMAIN_FINGERPRINT_SCHEMA_VERSION` and `DOMAIN_PREDICTION_PROMPT_VERSION` in `src/domain/film-person.js:5–6`.

## Decision points

| # | Where | Rule |
| --- | --- | --- |
| 1 | `fingerprintCurrent`, `src/enrichment.js:130` | schema equals the constant and no `invalidatedAt` |
| 2 | `predictionCurrent`, `src/enrichment.js:136` | #1 plus fingerprint hash, prediction's schema and prompt equal |
| 3 | `predictionCompatibility`, `src/domain/prediction-compatibility.js:70–72` | step 1 of ADR-0031: fingerprint schema (`fingerprint_not_current`), hash and prediction's schema (`fingerprint_changed`), prompt (`prompt_changed`); used by every consumer through `predictionFreshness` (`src/enrichment.js:341`) |
| 4 | `indexedPredictionCompatibility`, `src/enrichment.js:332–336` | the index facet's schema, or the constant when the facet is unbound |
| 5 | `fingerprintFacet`, `src/enrichment.js:132` | the display facet exists only for a current fingerprint (#1) |
| 6 | submit, `src/enrichment.js:751–752` | a new fingerprint is accepted only when the stored one is not current (#1); without a current fingerprint the item fails `fingerprint_missing` |
| 7 | prediction diagnostics, `src/prediction-diagnostics.js:94`, `104` | reports the schema and #1 |
| 8 | Film lifecycle reader, `src/domain/film-person-reader.js:105` | own copy of #1 against `DOMAIN_FINGERPRINT_SCHEMA_VERSION` |
| 9 | Film lifecycle domain, `src/domain/film-person.js:140–151` | own copy of #1 and the prediction alignment |
| 10 | D1 prediction repository, `src/prediction-repository.js:73–76` | own copies of #1 and #2 |

The offline importer copies these fields without judging them (`src/offline-importer.js:203`, `419`, `550`).

## Storage

- **The fingerprint is overwritten in place.** Submit writes `enrichment/films/<id>/fingerprint.json` with `saveJSON` (`src/enrichment.js:751`). There is no version object and no history.
- **Today this replacement is rare.** It happens only when the stored fingerprint is not current. With one schema version and no code path that sets `invalidatedAt` (it is always written as `null`), the replacement applies only to films without a fingerprint.
- **A schema change would make every replacement destructive.** The previous fingerprint would be lost while predictions in `predictions.json` history keep naming its hash.
- **Predictions already have immutable version objects.** Each committed prediction can be written as a write-once object keyed by checksum (`writePredictionVersion`, `src/enrichment.js:837`), gated by `PREDICTION_VERSION_OBJECTS` ([ADR-0019](../../adr/0019-live-d1-backfill-boundaries.md) item 4). Fingerprints have no such object.
- **D1 already expects an immutable body.** `fingerprint_payload` (`migrations/0001_schema_v1.sql:331`) keeps a pointer row with `schema_version`, `fingerprint_hash`, `generated_at`, `invalidated_at`, `r2_key` and `content_sha256`. Its comment and the [D1 reference](../../reference/data/d1-schema.md) describe the R2 body as immutable and addressed by hash, which the R2 writer does not yet guarantee.

## What a change would do today

- **Raising `FINGERPRINT_SCHEMA_VERSION`** makes every fingerprint not current (#1). Every prediction becomes stale (#2, #3). The queue would select `fingerprint_and_prediction` for every film, so the whole catalogue would be regenerated.
- **Raising `PREDICTION_PROMPT_VERSION`** makes every prediction stale with `prompt_changed`. The fingerprints stay current, so the work is `prediction_only` for every film.
- **A Scheduled Task prompt edit** changes nothing in any record or check. Its effect on fingerprints is invisible to the Worker.
- **A deploy that changes either constant during a run** is not detected by the run (see Run binding). Submits are then judged against the new constants: a fingerprint generated under the old prompt and schema fails validation per item.

## Findings

1. **Strict on both fingerprint axes, everywhere.** The shared evaluator covers the consumers of ADR-0031. Four modules (#8–#10 and the domain constants) still carry their own copies, which the selective rule must replace together.
2. **Immutable fingerprint versions are a precondition.** Without them a transition loses history, and a code rollback cannot restore an earlier fingerprint without a model run.
3. **The fingerprint prompt needs a version.** A version must be stamped outside the hash, so prompt revisions can be declared and evaluated. Reading absent as 1 keeps today's outcomes.
4. **The run must be bound to the contract.** A run must end when the fingerprint schema, the fingerprint prompt or the prediction prompt changes, as it does for the profile hash.

## Limits

Code reading only. The audit does not show how many stored fingerprints exist per schema, or whether any record has `invalidatedAt` set; it reads no production record. It also does not show which Scheduled Task prompt revisions produced today's fingerprints.
