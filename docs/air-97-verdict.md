# AIR-97 evidence preflight

**NO-GO.** Do not set `SCORED_RESOLUTION=on` or `CANDIDATE_DISCOVERY=on`. Do not start [AIR-68](https://trello.com/c/qbLDc6Ql). A positive GO still needs its own owner approval after this verdict changes. [AIR-69](https://trello.com/c/FlcWZX7W) stays behind that approval.

This rescores the frozen [AIR-86](https://trello.com/c/INQy9Hca) cohort on the current scorer and gate. It does not call TMDB, write R2, start an EPG sync or a prediction run, or change a Worker variable. The stored calls remain `docs/air-86-replay-results.json`. The runner is `scripts/air-97-rescore.mjs`. [AIR-95](https://trello.com/c/kD8xjvVu) and [AIR-96](https://trello.com/c/prY7T5iE) are on `main` and in the deployed Worker. They remove two known defects. They do not make this sample a cutover measurement.

## Preflight

Read on 2026-10-24, after the PR #67 deploy. No setting was changed.

| Item | Value |
| --- | --- |
| `origin/main` | `281d3d5`, merge of PR #67 |
| Worker deploy | `c99165b3-b2ef-41b5-ba4c-4fdeabeb12a5`, source `wrangler`, 2026-10-24T07:45:17Z, message `PR #67: Hold short-title matches that are one year away` |
| `SCORED_RESOLUTION` | `shadow` |
| `CANDIDATE_DISCOVERY` | unset |
| Schedules | 0 |
| Published generation | `cf3ba3ac-f962-4475-b9cd-3de1b07bd1eb`, phase `published` |

The deploy annotation names PR #67. It does not carry a git SHA. `281d3d5` is the `main` commit that contains that PR. Lifecycle localization was read and left as it was. The resolution ledger was not read again. Live-gate actionability below is the frozen clock `2026-10-23T17:52:50.645Z` from the replay file, together with `retryAt` and `evidenceState` from `docs/air-86-replay-manifest.json`.

## What was re-run

All 38 stored rows. Search hits, the two saved detail cards, and alias reads are taken from the replay file. Durations and the frozen clock come from the manifest. A structural claim is attached only when the stored hit's title or original title folds to the stored query and the stored reason is `part_suffix`, `spelling_e`, or `numeral`. That is the same rule as `collectVariantProposals`. Alias reads stay out of the scorer, as they did in the replay.

Two catalog films are not in the replay rows. The report and the earlier parity record name them, and the stored scores require them: `1290821` Убежище / Shelter, 2026, for `убежище|2022`; `297762` Чудо-женщина / Wonder Woman, 2017, for `чудо женщина|2020`. Their runtimes were not stored, so this rescore passes `runtime: null`. Status, reason, and accepted id still match the stored score on every row. The Wonder Woman numeric score moves from 0.65 to 0.575 because that missing runtime is no longer in the sum. The status stays `contradicted_year`. No other numeric score moves.

Without those claims, the current gate matches the stored live gate and the stored recognition gate on 37 rows. `убежище|2022` is the exception, and it is the AIR-96 change. Rows with no saved detail are `not_evaluated` for verification. A missing card is not a pass.

## GO criteria

A later GO has to meet all six. An empty cell is not a zero.

| # | Criterion | This sample |
| --- | --- | --- |
| 1 | No known false `detail_verified` among rows whose detail card was saved | Met for 2 of 2 saved cards. Unmeasured for 5 newly accepted ids |
| 2 | An accepted id stays a proposal until `detail_verified` | Met. The only remaining `detail_verified` is Чебурашка 2 |
| 3 | A short title one year away, without same-observation confirmation, stays `needs_verification` | Met for Убежище. No other saved card is in that class |
| 4 | A structural form is accepted only when it reverses, and a longer title or a prefix does not | Met on the stored hits. Goal 2 stays `no_exact_title`. The five new accepts have no saved detail card |
| 5 | The sample stands in for the live distribution | Not met. These 38 are a `retryAt` slice, not `readyNow`, the cheap pass, or the other 67 `retryAt` rows |
| 6 | Rollback of `SCORED_RESOLUTION=on` has been checked on the deployed Worker | Not met. The variable is `shadow`. Unsetting it is the documented rollback and was not exercised |

## Result

| Group | Rows | Accepted now | `detail_verified` on a saved card | Held on a saved card | Accepted, card not saved | Rejected |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Blocked structural | 2 | 1 | 0 | 0 | 1 | 1 |
| Eligible structural | 8 | 6 | 1 | 1 | 4 | 2 |
| Blocked, year either side | 28 | 0 | 0 | 0 | 0 | 28 |
| All 38 | 38 | 7 | 1 | 1 | 5 | 31 |

Recognition outcomes, frozen clock. The live gate agrees, except `блейд 1|1998`: that row is still behind `retryAt`, so the live gate stays `refused` / `not_actionable` even though the scorer now accepts 36647.

| Observation | AIR-86 recognition | Current scorer | Current recognition | Detail evidence |
| --- | --- | --- | --- | --- |
| `блейд 1\|1998` | `no_exact_title` | `accepted_spelling_e`, 36647 | `needs_verification` / `needs_verification` | not saved |
| `гол 2\|2008` | `no_exact_title` | `no_exact_title` | unchanged | not applicable |
| `11 друзей оушена\|2001` | `no_exact_title` | `accepted_numeral`, 161 | `needs_verification` / `needs_verification` | not saved |
| `чужой против хищника 1\|2004` | `no_exact_title` | `accepted_part_suffix`, 395 | `needs_verification` / `needs_verification` | not saved |
| `12 друзей оушена\|2004` | `no_exact_title` | `accepted_numeral`, 163 | `needs_verification` / `needs_verification` | not saved |
| `код 8 часть 2\|2024` | `no_exact_title` | `no_exact_title` | unchanged | alias 932420 was not scored |
| `матрица 1\|1999` | `no_exact_title` | `accepted_part_suffix`, 603 | `needs_verification` / `needs_verification` | not saved |
| `чебурашка 2\|2025` | `detail_verified` | `accepted_unique_evidence`, 1228477 | `detail_verified` / `tmdb_detail` | saved, runtime 103 |
| `черный телефон 2\|2025` | `no_exact_title` | `no_exact_title` | unchanged | no hit |
| `убежище\|2022` | `detail_verified` | `accepted_year_separates_remakes`, 801970 | `needs_verification` / `short_title_adjacent_year` | saved, runtime 91; competing edition 1290821, 2026 |

The other 28 blocked year-only rows are unchanged: 27 stay `no_exact_title`, and `чудо женщина|2020` stays `contradicted_year`. `мортал комбат|1995` still has an alias match on 9312 that the scorer does not see. `звездные собаки белка и стрелка|2010` still has no alias match. No row becomes `ambiguous`. No second id is `detail_verified`.

`needs_verification` on the five new accepts is what the gate returns when the detail argument is absent. It is not a check of a movie card. Those five stay `not_evaluated`. They are not counted as clean verifies and not counted as false verifies.

## What this does not clear

The false-verify risk on the two saved cards is closed: Убежище is held, and Чебурашка 2 remains the one specific neighbouring-year verify. The five structural proposals are the recognition gain from AIR-95, and their detail checks were never stored because AIR-86 did not accept them. Goal 2 still does not accept Goal II, a bare «Гол», or another part. Prefix hits for Чудо-женщина still do not decide the score. The two alias matches are still outside this gate. Twenty-five year-only rows had an empty search; an empty search is a recorded miss, not a recovered film.

This cohort is still the 38-row slice from the replay. It is not a production shadow of the code that is deployed now. It does not measure `readyNow`, the cheap pass, yearless titles, or the other 67 rows that had `retryAt` at the census. Rollback of `on` was not run.

## Next measurement, not started

Owner approval is required before any call. This card does not approve it, and a clean result would still not be a GO.

Scope: the five accepted ids whose detail card is missing. No other row, no search, and no alias read.

| Observation | Detail id |
| --- | --- |
| `блейд 1\|1998` | 36647 |
| `11 друзей оушена\|2001` | 161 |
| `чужой против хищника 1\|2004` | 395 |
| `12 друзей оушена\|2004` | 163 |
| `матрица 1\|1999` | 603 |

Budget: 5 HTTP calls, one `movie/{id}` detail each, cap 5. A 429 stops the run. The remaining ids stay `not_evaluated`. Leftover budget is not spent. Competitors come only from films already indexed under that structural form in a read-only catalog copy. If that copy is not taken, the competitor check is `not_evaluated`, not an empty rival list. No Worker variable, R2 write, `POST /api/enrichment/discovery/resolve`, EPG sync, or prediction run.

The measurement is accepted when each completed id has a current-gate outcome, `detail_verified` occurs only if the structural form, id, year, and runtime all pass, and nothing is written. Five verifies would close this detail gap. They would not meet criteria 5 or 6, and they would not unblock AIR-68.
