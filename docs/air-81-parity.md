# AIR-81 shadow parity

**NO-GO.** Do not set `SCORED_RESOLUTION=on` or `CANDIDATE_DISCOVERY=on`. Do not start [AIR-68](https://trello.com/c/qbLDc6Ql).

This is the second parity decision, after the candidate-discovery code in [AIR-80](https://trello.com/c/hQPjVTXv). It is not a new search and not a cutover. The first decision stays NO-GO in `docs/air-67-parity.md`. The two production samples are separate. Do not add this run to the AIR-66 counts, and do not treat the AIR-80 fixtures as a live recall gain.

## 1. What was measured

Preflight on 2026-10-23, before the flag change:

| Item | Value |
| --- | --- |
| Code | `dbaf4f70b07d548069fa56fb6401bc749dee0cce` (PR 54). AIR-80 `d03b390` is an ancestor. |
| Worker deploy | `9d4ec5b1-b97c-42c5-8898-276999c5d711`, source `wrangler`, 2026-10-23T09:43:59Z |
| `SCORED_RESOLUTION` | `shadow` |
| `CANDIDATE_DISCOVERY` | unset |
| Schedules | 0 |
| Published generation | `2e63530d-27f6-43cc-85dd-f5a2c9c97e16`, phase `published` |
| Continuation | paused, `chunk_budget`, `nextCatchUpAt` already passed |

The approved experiment set only `CANDIDATE_DISCOVERY=shadow`. Dashboard deploy `a2087dab-dbb4-474e-945a-ff281cabfb02` at 2026-10-23T09:48:16Z, source `dash`, version annotation `610a6987`. A settings deploy does not change the script. The read-back was `CANDIDATE_DISCOVERY=shadow`, `SCORED_RESOLUTION=shadow`, lifecycle localization unchanged, schedules still 0.

Two `POST /api/enrichment/discovery/resolve` calls followed. Each is one chunk. The run stopped there. The continuation then had `remainingChunks` 10 and a null reason, so another POST would continue that budget. Worker cron is empty, so nothing resumes it. Predictions and EPG sync were not started.

| Chunk | Wall time | Checked | Legacy `tmdbCalls` | Added | `variantCalls` | `variantSkipped` | `variantErrors` | `variantThrottled` | Error |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 30349 ms | 7 | 13 | 4 | 0 | 4 | 0 | 0 | null |
| 2 | 32273 ms | 7 | 14 | 4 | 0 | 6 | 0 | 0 | null |

Both chunks stayed on generation `2e63530d-27f6-43cc-85dd-f5a2c9c97e16`. No retry, no 429. `variantCalls` is outside `tmdbCalls`, so the 27 legacy lookups are not the extra search. The extra search sent nothing.

The preview object is overwritten each chunk. The rows below were read from `epg/discovery-score-preview.json` after each chunk, before the next write. Fourteen observation keys, no duplicate inside the generation. The last preview is the second chunk only and is not the total.

| Comparison | Rows |
| --- | ---: |
| `agree_verified` | 8 |
| `agree_unresolved` | 6 |
| `legacy_only` | 0 |
| `scored_only` | 0 |
| `agree` on any other label | 0 |
| `different_id` | 0 |
| `detail_not_compared` | 0 |
| rows with `proposedCandidates` | 0 |

Chunk 1: `звездные собаки белка и стрелка|2010` and `откройте полиция 3|2003` are `no_exact_title` (`agree_unresolved`); `проклятые|2025` is `ambiguous_collision`; `никуко из рыбацкой гавани|2021` (781816), `кейт и лео|2001` (11232), `наследие|2023` (1135511), and `инферно|2016` (207932) are `detail_verified` and agree with legacy. The four skipped variant plans match the two `no_exact_title` rows, each with a year on either side.

Chunk 2: `путь рыцаря|2025` (1312833), `на ощупь|2022` (1047065), `петрушка|2026` (1494140), and `искусственный разум|2001` (644) are `detail_verified` and agree with legacy. `skid row live london|2022`, `midnight oil armistice day live sydney|2018`, and `sevak от строителя до евровидения музloft 32|2022` are `no_confident_match`. The six skipped plans match those three rows, again a year on either side.

`accepted` on the preview is not a new verification. The eight agreements were already the legacy `verified` write. Legacy inserted eight catalog films (`added` 4 and 4). That is the ordinary legacy writer. No catalog row came from a proposal, because no proposal was fetched.

## 2. What this sample cannot say

The variant work runs after the legacy loop. A query starts only when more than 12 seconds remain of the chunk deadline. Both chunks took about 30 seconds and spent 13 or 14 legacy lookups, so every planned variant was `variantSkipped` and `variantCalls` stayed 0. The rows that need another title or year are the rows that already spent the search budget. Waiting for more of the same queue repeats the skip and keeps the legacy writer going. This run therefore has no live candidate-recall delta against AIR-66 or AIR-67. Do not read the eight `agree_verified` rows as an improvement from AIR-80.

The named misses stay fixture-only. Their stored decisions are `no_confident_match` with `attempts` 1 and a `retryAt` later on 2026-10-23 UTC, so this feed did not select them:

| Observation | Stored state |
| --- | --- |
| `блейд 1\|1998` | not selected |
| `11 друзей оушена\|2001` | not selected |
| `ирония судьбы или с легким паром\|1975` | not selected |
| `мортал комбат\|1995` | not selected |
| `чудо женщина\|2020` | not selected |
| `гол 2\|2008` | not selected |
| `чужой против хищника 1\|2004` | not selected |

`бегущий человек|` is already `verified` to 798645 by the cheap pass. A verified row is not re-scored. `бегущий человек|1987` is `verified` to 865. This sample has no yearless row and no `known_epg_alias` row, so it does not measure the cheap-pass difference recorded in AIR-67.

The AIR-80 tests still show the fixture behaviour: a spelling proposal for Blade is not verified, an exact neighbouring-year title for Irony of Fate can pass the existing gate, and an alias proposal for Mortal Kombat stays a proposal. Those fixtures are not this production sample.

## 3. Decision

**NO-GO for [AIR-68](https://trello.com/c/qbLDc6Ql).**

The paired shadow flag is on, and the optional search did not run. There is no live evidence that title or year variants find a film the legacy search missed, and no live evidence that they pick a wrong id. Absence of `scored_only` and `different_id` here means the extra search was skipped, not that those disagreements were cleared. Another twelve chunks would not supply that evidence while the deadline skip remains.

[AIR-83](https://trello.com/c/3wmMNyWo) is the defect: give the already bounded variant pass a chance to run on the rows that have no exact title, without taking the legacy `tmdbCalls` budget, without holding up the legacy decision, and without turning a skipped plan into a silent success. A later shadow sample is a separate measurement after that fix. This card does not implement the fix.

`SCORED_RESOLUTION` stays `shadow`. `CANDIDATE_DISCOVERY` stays `shadow` from the approved experiment. With the current code that flag adds no TMDB calls, because the plans are skipped. Rollback of the extra search is deleting `CANDIDATE_DISCOVERY` or setting it to anything other than `shadow` or `on`. Do not set either variable to `on`. No catalog or decision rewrite is required.
