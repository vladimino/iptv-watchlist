# Taste-profile equality guards: read-only code audit

**Captured:** 2026-10-27, read-only code reading  
**Code reviewed:** `main` `1f956dd`  
**Sources:** repository code only (`src/`, `public/app.js`). No R2, D1, MCP, Cloudflare or production read; no profile, prediction or queue was opened  
**Scope:** every place that decides whether a stored prediction is current with respect to the published taste profile, and the profile publisher  
**Verdict:** the profile rule is strict equality of version **and** hash, duplicated in 13 decision points across 8 files with no shared function; any selective model must replace all of them together  
**Used by:** [AIR-32](https://trello.com/c/eKFV3v2j), [ADR-0031](../../adr/0031-selective-prediction-profile-compatibility.md); input for [AIR-202](https://trello.com/c/POMLJNUx)–[AIR-206](https://trello.com/c/87mg3VNi)

## Method

Search for `tasteProfileVersion`, `tasteProfileHash`, `profileHash`, `profile.version`, `predictionCurrent`, `indexedPredictionCurrent`, `stale` and the prompt-version constants in `src/` and `public/`, then read each hit in context. Line numbers refer to `1f956dd`.

## Decision points

| # | Where | Rule | Role | Successor |
| --- | --- | --- | --- | --- |
| 1 | `predictionCurrent`, `src/enrichment.js:98` | fingerprint current; version, hash, fingerprint hash, fingerprint schema, prompt all equal | Shared by the runner and `publicPrediction` | AIR-203 / AIR-205 |
| 2 | `indexedPredictionCurrent`, `src/enrichment.js:258` | same fields, from the view-index copy; does not check `fingerprintCurrent` | Queue builder, catalog route, diagnostics | AIR-203 / AIR-204 |
| 3 | `refreshPredictionQueue`, `src/enrichment.js:431–441` | a film is pending when #2 fails; the queue records `profileVersion`, `profileHash` | Prediction queue (hot/cold pending, `hotPredicted`, discovery readiness) | AIR-204 |
| 4 | `enrichmentStart`, `src/enrichment.js:596–599` | pending count via #1; run bound to `tasteProfileVersion/Hash`; resume only with the same hash | Run creation | AIR-204 |
| 5 | `enrichmentNext`, `src/enrichment.js:609–615` | 409 `Profile changed; start a new run` when the hash differs from the run's; repairs and completions via #1 | Runner step | AIR-204 (run binding kept) |
| 6 | `enrichmentSubmit`, `src/enrichment.js:642–646` | `already_current` via #1; a new prediction stamps the current version and hash | Writer | AIR-204 |
| 7 | `enrichmentComplete`, `src/enrichment.js:674–677` | 409 on a hash change without a stop reason; created/recalculated counted by run hash and prompt; pending via #1 | Run summary | AIR-204 |
| 8 | `enrichmentView`, `src/enrichment.js:691` | inline `stale` from version, hash, fingerprint hash, prompt (a fourth copy of the rule) | View payload read by `public/app.js` («ожидает пересчёта», chance hidden, Finds strength) | AIR-205 |
| 9 | `catalogAvailable`, `src/worker.js:161` | film skipped unless #2 holds | `GET /api/catalog/available`, therefore Finds | AIR-205 |
| 10 | `predictionDiagnosticPrediction` / `predictionDiagnosticIndex` / `predictionDiagnosticReasons`, `src/prediction-diagnostics.js:93–137` | #1 and #2; `profileMatch` as version+hash equality; `profile_version_differs`, `profile_hash_differs`, `index_ahead_of_queue` | MCP `prediction_film_diagnostics`, `prediction_queue_overview` | AIR-205 |
| 11 | `predictionState`, `src/domain/film-person.js:143–150` and `invalidatePredictionForProfile`, `:262` | own copy with `DOMAIN_*` constants; any profile change moves every non-missing prediction to `stale` | Film lifecycle dimension | AIR-205 |
| 12 | `legacyPredictionStatus`, `src/domain/film-person-reader.js:106–112` | own copy | Lifecycle reader and parity | AIR-205 |
| 13 | `readFilm` → `predictionCurrent`, `src/prediction-repository.js:64–76` | own copy with its own `PREDICTION_PROMPT_VERSION` | D1 projection (not production-authoritative) | AIR-205 |

Not a freshness decision: `src/offline-importer.js` validates and compares stored prediction and profile fields byte for byte (parity), and `freezeDiagnosticSnapshot` / `predictionBenchmarkStart` only record the profile. They need no compatibility logic.

## Publisher

`PUT /api/enrichment/profile` (`src/enrichment.js:1056`) validates the body, requires `version` greater than current, computes `profileHash` over the body, then writes `profile/versions/<n>.json` and `profile/current.json` with two plain writes (no create-only condition, no compare-and-swap on the current pointer) and refreshes the queue best-effort. It records nothing about what changed. Two concurrent publications with different versions can both pass the version check. These are inputs for AIR-202, not defects fixed here.

## Findings for the design

- The five-field equality exists in four independent copies (#1/#2, #8 inline, #11/#12 domain, #13 D1) plus the run binding; agreement between queue and readers is today only a consequence of copying. One evaluator is needed (ADR-0031 section 5).
- The view-index fingerprint facet keeps only general execution dimensions and drops `unknown` and `not_applicable` (`executionFacet`), and holds no genres. It cannot evaluate genre-specific or unknown-aware selectors; the queue needs its own impact features.
- Stored genres are display names: Russian TMDB names from discovery (`language=ru-RU`) and Russian labels from the Letterboxd source map. Selectors need a closed canonical genre list with an alias table; an unmapped name has to count as unknown.
- The runner binds a run to one profile hash (#4, #5, #7). That boundary is compatible with selective freshness and stays.
- `public/app.js` consumes only the boolean `stale`; a `compatible` prediction must arrive as `stale: false`.

## Limits

Code reading only, at one commit. It says nothing about the live profile version, the queue size or how many films a real profile edit would reach.
