# AIR-79 orphaned ratings runtime removal and rollback-tooling classification, 17 November 2026

**Trello:** [AIR-79](https://trello.com/c/485tlGLA). **Code reference:** `main` at `ace1dfffa50b3d48b9506d37ab9192015fd39789`. **Captured:** 17 November 2026 (UTC). Continues the [first audit](air-79-legacy-r2-runtime-audit-2026-11-17.md).

## Scope and method

Second bounded slice of the retirement audit. It removes Worker code that no production path calls and classifies the remaining rollback tooling. No production read or write was made, and no migration, flag, binding or marker was touched.

**Method.** Every top-level function and constant in `src/` was matched against every identifier in `src/`, `tests/`, `scripts/`, `build.mjs` and `public/` at the reference commit, counting whole-identifier occurrences in the full file text. A definition whose identifier occurs only once in `src/` (its own definition) has no Worker caller. Occurrences in tests and scripts were then listed separately, so that a definition kept alive only by a test or an operator script is visible as such. The files are concatenated into one Worker bundle without module boundaries, so an identifier match is the same thing as a reachable call, apart from names built at run time from strings; no such construction exists for these names.

**Limits of the method.** It finds definitions with no caller; it does not find a reachable function that does dead work inside, and it cannot see a call written through a computed property name. Truncated `grep` output hid a caller once during this work (see the restored helper below); the table is therefore based on the full-text counts, which were recomputed on the reference commit, not on `grep` excerpts.

Not touched, to stay clear of parallel work: `src/worker.js::catalogFilmRoute`, `src/canonical-catalog-reader.js`, `src/enrichment.js::filmHistoryRoute`, `public/app.js` (AIR-475), and the alias and scan code of Discovery (AIR-503).

## Removed

All of these had exactly one occurrence in `src/` (their own definition), or were called only by another entry of this list.

| Function | File | Why nothing calls it | Superseded by |
| --- | --- | --- | --- |
| `lookupRemovalRatings` | `src/enrichment.js` | No caller remains in `src/`: the EPG commit hands removed films over and never looks them up, and the Ratings step performs the lookups itself. | The Ratings step in `src/letterboxd-ratings.js` (same claim, outcome and 403/429 backoff rules). |
| `refreshRatingsFromFilms` | `src/enrichment.js` | The films-list scan left the EPG commit when ratings became diary-first. The reference page already described it as "stays in the code but is not part of the EPG commit". | Diary-first ratings. |
| `parsePublicFilmsPage` | `src/enrichment.js` | Called only by `refreshRatingsFromFilms`. | — |
| `repairRemovedBaselineRatings`, `repairRecentDiaryRatings`, `diaryRatedEntries` | `src/enrichment.js` | Fallbacks after a failed films-list scan; `diaryRatedEntries` was called only by `repairRecentDiaryRatings`. | — |
| `stepSizeClass` | `src/enrichment.js` | A diagnostic bucket helper with no reader. | — |
| `enrichKnownRemovalEvent`, `ratingsPhase` | `src/worker.js` | No caller remains in `src/`. `ratingsPhase` only stamped `run.ratingAttempt.phase` and logged. | The Ratings step; `closeInterruptedRatings` still reads the phase of attempts stored before that change. |

**Retained after a check found a caller.** `enrichRecentRemovalRatings` (`src/worker.js`) was removed in a first pass and restored: `refreshPersonalRating` calls it, so it is live. The error came from a `grep` excerpt that cut the long line holding the call, which is why the method above counts identifiers over the full text.

## Tests changed

Removing dead code removes the tests that drove it, but not the coverage of the live code that those tests also exercised.

| File | Change |
| --- | --- |
| `tests/removal-rating-lookup.mjs` | Sections 1–9b drove only `lookupRemovalRatings` and are removed. Sections 10 and 11 (the hand-over built from the removed ids of a run, and a hand-over left on a completed run) test live Worker code and stay. The claim, outcome, 403/429, expiry and pause rules remain proved by `tests/ratings-queue-v2.mjs` and `tests/ratings-orchestration.mjs`. |
| `tests/removal-ratings.mjs` | The removed event helper is replaced by a three-line test step over `withRemovalRatings` and `writeEvent`, so replay, stale-rating and race cases still run on the live primitives. |
| `tests/ratings.mjs` | The films-list parser and direct scan cases are removed; the backfill, personal-rating identity, and "the EPG commit requests nothing from Letterboxd" cases stay. |
| `tests/letterboxd-facts.mjs` | The scan call inside the stale-binding loop is removed; the watchlist observation and the films-list cases elsewhere in the file stay. |
| `tests/epg-ratings-attempt.mjs`, `tests/ratings-migration.mjs`, `tests/activity.mjs` | One call or stub each, for names that no longer exist. |

## Found and deliberately kept

| Item | Reason |
| --- | --- |
| `LetterboxdFacts.applyFilmsListScan` | Its only Worker caller (`refreshRatingsFromFilms`) is gone, so it is now reached only by tests, but it carries much of the fact-record semantics those tests prove (`rating-history`, `finds-watched-mark`, `letterboxd-baseline-import`, `letterboxd-facts`). Deferred: retire it together with a deliberate rewrite of those cases. |
| `src/generation-stage.js`, `src/epg-repository.js`, `src/prediction-repository.js`, `src/offline-importer.js` | Offline libraries for the backfill and import scripts. `generation-stage.js` states that the Worker does not import it. |
| `src/d1-enrichment.js` | Kept by a recorded decision, because the status diagnostic and shared SQL helpers still import it. |
| The `PAGED_FINAL_WRITES`, `authorityCause`, `mergeStarted` and similar unreferenced constants and locals | Cosmetic, not a legacy R2 path; left alone to avoid churn in files other open work touches. |

## Rollback tooling classification (D-1)

The same scan lists, per domain, the functions that have no Worker caller and are reached only by owner operator scripts and tests. These are the marker import, activation, hold and revert entry points. They are dead for the Worker at the recorded markers, but they are not orphans: each is defined as part of an accepted decision, and a code rollback restores no marker.

| Domain | Functions (no Worker caller) | Operator entry point |
| --- | --- | --- |
| Ratings documents | `importDocuments`, `activateDocuments`, `releaseHeld`, `sealHeld`, `revertMarker` | `scripts/ratings-domain-production.mjs` |
| Mutable predictions | `importPredictionDomain`, `activatePredictionDomain`, `releasePredictionWriters`, `revertPredictionDomain`, `reconcilePredictionIntents` | `scripts/prediction-domain-*.mjs` |
| Owner reviews | `importOwnerReviews`, `activateOwnerReviews`, `revertOwnerReviews` | `scripts/owner-review-authority.mjs` |
| Metadata cache | `importMetadataCache`, `activateMetadataCache`, `revertMetadataCache` | `scripts/metadata-cache-*.mjs` |
| Published EPG | `importPublished`, `activatePublished`, `sealPublished`, `releasePublished`, `revertPublished` | `scripts/published-epg-*.mjs` |
| Discovery | cutover and activation entry points | `scripts/discovery-cutover.mjs`, `scripts/discovery-production.mjs` |

The owner direction recorded on the card on 17 November is that D1 stays authoritative and a return to R2 is not planned. That direction is the input for removing this tooling; it is not a replacement for the record. The removal changes decisions that the per-domain ADRs accepted, so it needs a superseding ADR that the owner accepts, and for the published EPG it must keep the `held` reader contract (readers stay on the R2 pointer while mirror repair stops), which is not rollback tooling. Film/Person has no revert path to remove.

Proposed order of the next slices, smallest coupling first: owner reviews, metadata cache, ratings documents, predictions, published EPG, Discovery. Each slice deletes the module functions, the operator script, its tests and its runbook section in one reviewable change, and keeps the stand-in modes that local development and the test harness use.

## Ratings storage migration (D-3)

`migrationState()` is a hard gate for the Ratings start and step and for the removal hand-over, and the migration tool is an owner-only MCP call. The migration is recorded as complete, but retiring the tool means making the gate unconditional, which changes the EPG commit hand-over in `src/worker.js` and several tests. It is a separate slice with its own live read of the migration state; it is not in this change.

## Verification

- **Local, on the final checkout of the removal PR** (commit `ae18bcb12a0b31db6052b6fdbc93f6db2b0379ad`, after a fresh `npm ci`): `npm run test:all` passed with the core suite at 419 of 419 files and the non-functional suite at 40 of 40; `npm run build` and `git diff --check` were clean; the pre-commit mutation-anchor preflight passed (137 anchors, 2 harnesses). A first full run stopped at `tests/projector-window-r2-inventory.mjs`, which counts R2 write sites per file: the removed code held three removal-queue writes and one `sync.json` write, none of them a projector input, so only the per-file counts changed (218 to 214 sites) and the table was updated with that reason.
- **CI on the exact head** (GitHub Actions run 44084792137): `Test and build`, `Test shard 2 of 3` and `Test shard 3 of 3` succeeded; the PR deployment job was skipped, as expected.
- **Independent review** on the same head: technical pass (review 5939416888). It confirmed that the nine functions have no caller, that `enrichRecentRemovalRatings` is correctly kept, that the Ratings step and the legacy `ratingAttempt.phase` recovery are intact, and that the write-site table accounts for exactly the removed sites.
- **Merge:** merge commit `30896e2f74d4e47f4e1df0100ec14b3b6840b00f`. The post-merge `Test and build`, shard 2, shard 3 and `Deploy to Cloudflare` results are recorded by the delivery controller on the card, not in this document.

The reviewer's two documentation notes, this section and the comment above `REMOVAL_LOOKUP_KEY` in `src/enrichment.js`, were fixed in a follow-up change.
