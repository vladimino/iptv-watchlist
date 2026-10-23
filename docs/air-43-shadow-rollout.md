# AIR-43 shadow rollout

Controlled comparison of the legacy resolver and the scored resolver on production. The preflight below was written before the flag existed. The sample after it is the limited run that followed. Verdict: **INSUFFICIENT DATA**. `on` was not enabled. The live binding is still `shadow`.

Related: [AIR-43](https://trello.com/c/7NY6n1Az), [AIR-42](https://trello.com/c/drLBuWjl), [AIR-48](https://trello.com/c/rVf8rRoJ), [AIR-49](https://trello.com/c/YNaLFwtW), [AIR-65](https://trello.com/c/MKb4JMXi). Prerequisites: [PR 45](https://github.com/vladimino/iptv-watchlist/pull/45), [PR 47](https://github.com/vladimino/iptv-watchlist/pull/47). Code deploy: [CI/CD 39870651210](https://github.com/vladimino/iptv-watchlist/actions/runs/39870651210).

## 1. What is deployed

Code checked 2026-10-22 23:25 UTC. The settings deploy is later and does not change that code.

| Item | Value |
| --- | --- |
| `origin/main` | `203727b5c59a6a315bfd3e86cbbbf1bcb9819c81` |
| PR 47 | Merged 2026-10-22 23:16:03 UTC. Pull-request checks ran Test and build only. Deploy is skipped on pull requests and runs on the push to `main`. |
| Push workflow | [39870651210](https://github.com/vladimino/iptv-watchlist/actions/runs/39870651210). Test and build succeeded. Deploy to Cloudflare succeeded. |
| Worker code deployment | `6be9a444-099f-47b5-9ee5-6f7ee6310ef9`, created 2026-10-22 23:17:27 UTC, source `wrangler`, message `Compare shadow on the same TMDB evidence as legacy (#47)`. |
| Settings deployment | `3697aafb-07b4-401e-b463-f5ae85449158`, created 2026-10-22 23:41:50 UTC, source `dash`, message `Deployed version 28fada3d`. |
| Compatibility | `2026-10-18`, `cpu_ms` 120000. Schedules: none. |

`wrangler.jsonc` does not contain `SCORED_RESOLUTION`. `keep_vars` is true, so a later code deploy does not add or remove the dashboard binding.

## 2. The binding

At 23:25 UTC the binding was absent, so `scoredResolutionMode` was `off`. The Cloudflare API token can read settings and returned HTTP 403 on `PATCH /accounts/…/workers/scripts/iptv/settings`. Local Wrangler is not logged in. The binding was added in the dashboard: one plain-text variable, key `SCORED_RESOLUTION`, value `shadow`, secret unchecked, previews unchecked, production checked. A second empty placeholder row appeared in the dialog and was not saved.

Read back after the dash deploy:

- `SCORED_RESOLUTION` is the text `shadow`.
- `LIFECYCLE_LOCALIZATION` is still `on:programme,on:watchlist,on:epg`.
- `BUCKET` still points at the `iptv` bucket. The TMDB token binding is still present. Its value was not read.
- Schedules length 0. Compatibility date and `cpu_ms` unchanged.
- No extra variable was stored.

Before any chunk, `GET /api/enrichment/pipeline/status` reported `scoringPreview.cutover` `shadow`, `programmeRunId` null on the preview, `rows` 0, and `stale` false. The same route after the twelfth chunk still reports `cutover` `shadow`.

Rollback is deleting that plain-text binding or setting its text to anything other than `shadow` or `on`. Both are `off`. No code change is required.

## 3. Invariants in the deployed code

Read from `203727b`, `src/discovery.js`.

- `shadow` is the legacy branch. It still writes the legacy decision and the catalog. It does not replace that decision with a scored one.
- Scorer candidates and competitors are copied before `indexFilm` runs for that candidate. A film inserted by the same legacy write is not a pre-existing alias. The preview field is `knownBefore`.
- Search hits legacy already fetched are included in that score. The gate reuses legacy's movie card when the accepted id is that card.
- A shadow-only card is requested after the legacy candidates of the chunk, through `tmdbRequest` rather than the counter behind the 16-call legacy cap. A 429 is swallowed. The chunk error and the candidate attempt counter stay unchanged.
- That extra request is skipped when fewer than 12 seconds remain before the 22-second chunk deadline. The row stays `detail_not_compared`.
- `detail_not_compared` is only the label for an accepted score that never received a card. It is not `legacy_only`.
- `saveScorePreview()` replaces `epg/discovery-score-preview.json` on every chunk. `scoringPreview.comparison` on the status route is that last object. It is not the sum of the chunks.
- The preview stores `programmeRunId`. `scorePreviewSummary` drops a preview whose run id is not the pinned generation.
- A published-generation mismatch still refuses the catalog write. Shadow does not add its own catalog write.

## 4. Baseline, before the flag

Published generation `2e63530d-27f6-43cc-85dd-f5a2c9c97e16`, phase `published`, discovery ledger `updatedAt` 2026-10-22 15:01:30 UTC. Raw candidates 23079. Filtered non-movies in the latest snapshot 3200. Ledger rows 48777.

`epg/discovery-score-preview.json` did not exist.

`epg/discovery-status.json` is the previous generation, `5811dc50-2072-41f5-97ee-5ca66470df78`, finished 2026-10-20 20:37:42 UTC: stage `partial`, checked 7, TMDB calls 14, added 3, remaining 38921. It is not the status of the published generation.

`epg/resolver-continuation.json` at 2026-10-22 15:02:44 UTC: stage `paused`, reason `epg_committed`, `remainingChunks` 12, `retryAt` null. The new generation was committed and the resolver had not taken that queue.

Pipeline status at that generation, before the run: current unresolved 16146, ready now 16116, retry backoff 0, historical unresolved 1426, terminal no-match 0, confirmed films 1802, verified films 1792, queued for prediction 0, hot already predicted 1769.

Decision histogram on the published ledger:

| Status | Rows before | Rows after the 12 chunks |
| --- | ---: | ---: |
| `verified` | 3132 | 3257 |
| `no_confident_match` | 609 | 628 |
| `excluded_nonfilm` | 4769 | 4769 |
| `ambiguous` | 39 | 39 |
| `duration_mismatch` | 21 | 21 |

Shape of the whole ledger, not of the actionable subset: year present 13219, year absent 35558, short title 6393, longer title 42384. The designed run is hot and dated rows first. That order is a selection bias.

## 5. The run

Twelve calls to `POST /api/enrichment/discovery/resolve` with an empty body, one chunk each, from 2026-10-22 23:44:20 UTC to 23:57:10 UTC. The same published generation was pinned on every response. No EPG sync was started. The prediction runner was not called. No resolution decision was edited by hand.

Each preview was copied from R2 after the chunk returned and before the next chunk. No observation key appeared in more than one snapshot, so the latest-row aggregate is the same as the sum. The status object after chunk 12 is only that chunk: 6 rows, 5 `agree_verified`, 1 `agree_unresolved`.

| Chunk | Recorded at | Checked | Legacy TMDB calls | Catalog films added | Remaining | Preview rows | `agree_verified` | `agree_unresolved` |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 2026-10-22 23:44:47 UTC | 82 | 12 | 4 | 16068 | 7 | 4 | 3 |
| 2 | 2026-10-22 23:46:09 UTC | 6 | 12 | 5 | 16056 | 6 | 5 | 1 |
| 3 | 2026-10-22 23:47:04 UTC | 7 | 14 | 4 | 16048 | 7 | 4 | 3 |
| 4 |  | 7 | 14 | 3 | 16041 | 7 | 3 | 4 |
| 5 | 2026-10-22 23:48:37 UTC | 7 | 14 | 3 | 16034 | 7 | 3 | 4 |
| 6 |  | 6 | 12 | 4 | 16017 | 6 | 4 | 2 |
| 7 |  | 6 | 12 | 5 | 16011 | 6 | 5 | 1 |
| 8 |  | 7 | 14 | 5 | 16004 | 7 | 5 | 2 |
| 9 |  | 7 | 14 | 4 | 15997 | 7 | 4 | 3 |
| 10 |  | 6 | 12 | 5 | 15988 | 6 | 5 | 1 |
| 11 |  | 7 | 14 | 3 | 15978 | 7 | 3 | 4 |
| 12 | 2026-10-22 23:57:10 UTC | 6 | 12 | 5 | 15970 | 6 | 5 | 1 |

Blank clocks are chunks whose preview was saved and whose response counters were kept, without a retained response timestamp. Chunk 1's checked count is 82 because the response also reports `reused` 75. Those 75 rows are the cheap pass over known aliases. They are not preview rows. The other chunks' checked counts match their preview rows. 154 checked minus those 75 leaves the 79 preview rows.

Every chunk returned `error` null and `retryAt` null. Stage stayed `partial`. After chunk 12 the continuation is `paused`, reason `chunk_budget`, `remainingChunks` 0, `nextCatchUpAt` 2026-10-23 00:00:00 UTC. This session stopped there.

## 6. Comparison

79 preview rows, one generation, no duplicate keys.

| Comparison | Rows | Share of the 79 |
| --- | ---: | ---: |
| `agree_verified` | 50 | 63% |
| `agree_unresolved` | 29 | 37% |
| `legacy_only` | 0 | 0 |
| `scored_only` | 0 | 0 |
| `different_id` | 0 | 0 |
| `detail_not_compared` | 0 | 0 |

There is no discrepancy row to adjudicate. `legacy_only`, `scored_only`, and `different_id` did not occur, so this sample has no case where one resolver verified and the other did not.

Every `agree_verified` row has the same shape: legacy `verified`, gate `detail_verified`, reason `tmdb_detail`, `knownBefore` false, and the accepted TMDB id below. Forty-nine scores are 0.925. `казнь|2021` is 0.895.

| Chunk | Observation | TMDB id | Confidence |
| ---: | --- | ---: | ---: |
| 1 | `жанна д арк\|1999` | 10047 | 0.925 |
| 1 | `мементо\|2000` | 77 | 0.925 |
| 1 | `король вечеринок\|2002` | 11452 | 0.925 |
| 1 | `дежавю\|2006` | 7551 | 0.925 |
| 2 | `индиана джонс в поисках утраченного ковчега\|1981` | 85 | 0.925 |
| 2 | `легенда о самбо\|2023` | 930513 | 0.925 |
| 2 | `сезон охоты\|2025` | 1387382 | 0.925 |
| 2 | `карантин\|2008` | 13812 | 0.925 |
| 2 | `полет навигатора\|1986` | 10122 | 0.925 |
| 3 | `гайвер\|1991` | 15026 | 0.925 |
| 3 | `маленькие женщины\|1994` | 9587 | 0.925 |
| 3 | `кукла реинкарнация зла\|2023` | 977177 | 0.925 |
| 3 | `девятые врата\|1999` | 622 | 0.925 |
| 4 | `камышовый рай\|1989` | 389547 | 0.925 |
| 4 | `хоббит битва пяти воинств\|2014` | 122917 | 0.925 |
| 4 | `работа без авторства\|2018` | 423612 | 0.925 |
| 5 | `шаг вперед 4\|2012` | 85446 | 0.925 |
| 5 | `смурфики\|2011` | 41513 | 0.925 |
| 5 | `кто угодно кроме тебя\|2023` | 1072790 | 0.925 |
| 6 | `дорога в один конец\|2023` | 1059126 | 0.925 |
| 6 | `зависнуть в палм спрингс\|2020` | 587792 | 0.925 |
| 6 | `за бортом\|1987` | 10780 | 0.925 |
| 6 | `чочара\|1960` | 24167 | 0.925 |
| 7 | `золотой гусь\|1964` | 4652 | 0.925 |
| 7 | `шальная императрица\|2025` | 1566700 | 0.925 |
| 7 | `зверогонщики\|2023` | 1008102 | 0.925 |
| 7 | `рождественская история\|2009` | 17979 | 0.925 |
| 7 | `принцесса и лягушка\|2009` | 10198 | 0.925 |
| 8 | `каменщик\|2023` | 927107 | 0.925 |
| 8 | `солт\|2010` | 27576 | 0.925 |
| 8 | `красная жара\|1988` | 9604 | 0.925 |
| 8 | `крепкий орешек 3 возмездие\|1995` | 1572 | 0.925 |
| 8 | `осенний марафон\|1979` | 27924 | 0.925 |
| 9 | `шаг с крыши\|1970` | 254341 | 0.925 |
| 9 | `возвращение в страну оз\|1985` | 13155 | 0.925 |
| 9 | `мой наставник\|1983` | 2193 | 0.925 |
| 9 | `казнь\|2021` | 650030 | 0.895 |
| 10 | `анна каренина история вронского\|2017` | 451765 | 0.925 |
| 10 | `соблазни меня\|1994` | 281029 | 0.925 |
| 10 | `бугония\|2025` | 701387 | 0.925 |
| 10 | `добрый сынок\|1993` | 9272 | 0.925 |
| 10 | `новогодний переполох\|2017` | 492263 | 0.925 |
| 11 | `приключения посейдона\|2005` | 28512 | 0.925 |
| 11 | `особое мнение\|2002` | 180 | 0.925 |
| 11 | `идеальный голос\|2012` | 114150 | 0.925 |
| 12 | `победители и грешники\|1983` | 25539 | 0.925 |
| 12 | `рядовой чээрин\|2021` | 752589 | 0.925 |
| 12 | `достать ножи стеклянная луковица\|2022` | 661374 | 0.925 |
| 12 | `хэллоуин хьюби\|2020` | 617505 | 0.925 |
| 12 | `могучий джо янг\|1998` | 9822 | 0.925 |

These agreements were not re-checked against a separate TMDB identity review. Agreement records that both resolvers accepted the same id after the legacy movie card. It does not by itself prove the EPG title is that film.

## 7. Shared unresolved rows

All 29 are `candidate_decision`, `knownBefore` false, and a legacy status other than `verified`. They are shared refusals. They are not `legacy_only` or `scored_only`.

| Chunk | Observation | Gate reason | Legacy | Score status | Confidence |
| ---: | --- | --- | --- | --- | ---: |
| 1 | `ворон\|2024` | `ambiguous_collision` | `ambiguous` | `ambiguous` | 0.85 |
| 1 | `анаконда\|2025` | `ambiguous_collision` | `ambiguous` | `ambiguous` | 0.85 |
| 1 | `mary gu качала пресс разбила нос пошла на пилон опасная поездка на blablacar е музloft 53\|2023` | `no_exact_title` | `no_confident_match` | `no_confident_match` | 0 |
| 2 | `18 david guetta miami ultra music festival\|2023` | `no_exact_title` | `no_confident_match` | `no_confident_match` | 0 |
| 3 | `dirkschneider and the old gang live in studio\|2025` | `no_exact_title` | `no_confident_match` | `no_confident_match` | 0 |
| 3 | `циркафрика эфиопия\|2025` | `no_exact_title` | `no_confident_match` | `no_confident_match` | 0 |
| 3 | `солдатик\|2018` | `no_exact_title` | `no_confident_match` | `no_confident_match` | 0 |
| 4 | `мортал комбат\|1995` | `no_exact_title` | `no_confident_match` | `no_confident_match` | 0 |
| 4 | `блейд 1\|1998` | `no_exact_title` | `no_confident_match` | `no_confident_match` | 0 |
| 4 | `дракула история любви\|2025` | `no_exact_title` | `no_confident_match` | `no_confident_match` | 0 |
| 4 | `я себя знаю алексей смирнов х азамат мусагалиев\|2022` | `no_exact_title` | `no_confident_match` | `no_confident_match` | 0 |
| 5 | `ирония судьбы или с легким паром\|1975` | `no_exact_title` | `no_confident_match` | `no_confident_match` | 0 |
| 5 | `11 друзей оушена\|2001` | `no_exact_title` | `no_confident_match` | `no_confident_match` | 0 |
| 5 | `м ф фабрика иллюзий алисы и терезы\|2023` | `no_exact_title` | `no_confident_match` | `no_confident_match` | 0 |
| 5 | `мощная баллада\|2026` | `no_exact_title` | `no_confident_match` | `no_confident_match` | 0 |
| 6 | `дунцову боятся власти почему кандидата от народа не допускают к выборам\|2023` | `no_exact_title` | `no_confident_match` | `no_confident_match` | 0 |
| 6 | `apocalyptica w o a\|2025` | `no_exact_title` | `no_confident_match` | `no_confident_match` | 0 |
| 7 | `академик пивоваров 10 поворотных моментов российской истории скажи гордеевой\|2024` | `no_exact_title` | `no_confident_match` | `no_confident_match` | 0 |
| 8 | `солженицын который все про нас понял\|2024` | `no_exact_title` | `no_confident_match` | `no_confident_match` | 0 |
| 8 | `чудо женщина\|2020` | `contradicted_year` | `no_confident_match` | `contradicted` | 0.65 |
| 9 | `он охотится на меня мой преследователь полицейский это твой последний день рождения тебя зарежу\|2024` | `no_exact_title` | `no_confident_match` | `no_confident_match` | 0 |
| 9 | `гол 2\|2008` | `no_exact_title` | `no_confident_match` | `no_confident_match` | 0 |
| 9 | `пиноккио раскрепощенный\|2026` | `no_exact_title` | `no_confident_match` | `no_confident_match` | 0 |
| 10 | `м ф том и джерри гигантское приключение\|2013` | `no_exact_title` | `no_confident_match` | `no_confident_match` | 0 |
| 11 | `самый далекий регион чукотка на край земли на собаках как люди живут\|2021` | `no_exact_title` | `no_confident_match` | `no_confident_match` | 0 |
| 11 | `нежный travel бали\|2026` | `no_exact_title` | `no_confident_match` | `no_confident_match` | 0 |
| 11 | `то что внутри\|2024` | `no_exact_title` | `no_confident_match` | `no_confident_match` | 0 |
| 11 | `чужой против хищника 1\|2004` | `no_exact_title` | `no_confident_match` | `no_confident_match` | 0 |
| 12 | `уральские пельмени серьги на ветер\|2009` | `no_exact_title` | `no_confident_match` | `no_confident_match` | 0 |

`ворон|2024` and `анаконда|2025` are the only collision rows. Both resolvers left them ambiguous. `чудо женщина|2020` is the only year contradiction. Legacy stored `no_confident_match` and the scorer stored `contradicted` at 0.65. Both refused a film. The numbered titles `блейд 1|1998`, `гол 2|2008`, `11 друзей оушена|2001`, `чужой против хищника 1|2004`, and `мортал комбат|1995` missed an exact title on both sides. Several other `no_exact_title` rows are concerts, talk programmes, or travel programmes that reached the movie queue. This pass did not assign a correct TMDB id to any of these refusals.

## 8. Coverage

The 79 preview rows:

- Year present on every row. Year-absent titles were not in the preview.
- `knownBefore` false on every row. The preview did not measure a film that was already an alias. Chunk 1's 75 reused alias rows never entered the preview.
- Sixteen rows are short by the scorer rule (one token, or a normalized title of eight characters or fewer). All sixteen have a year. The missing-year short-title case was not observed. `казнь|2021` is the one accepted short title below 0.925.
- Runtime contradiction: none. `duration_mismatch` stayed 21 on the ledger.
- Remake collisions that appeared were refused by both resolvers.
- Shadow-only detail fetch, the 12-second skip, and `detail_not_compared` were not used. Every accepted score was checked on the card legacy had already fetched.
- No chunk reported a 429.

Hot-first order explains the shape. The queue that was waiting after the generation commit is current, dated, and mostly new to the alias index. A later sample still has to include yearless rows, known aliases inside the preview, a contradictory runtime, and at least one accepted id whose card legacy did not fetch.

## 9. Load and side effects

Legacy TMDB counter: 156 calls across the 12 chunks, 12 or 14 per chunk. Sum of the HTTP request durations is 363 seconds. No chunk error.

The generation id and its `updatedAt` did not change. No EPG sync ran.

Legacy inserted 50 catalog films. Confirmed films 1802 → 1852. Verified catalog films 1792 → 1842. That matches the 50 `agree_verified` rows. Decision rows in status `verified` rose by 125, which is those 50 plus the 75 cheap-pass reuses in chunk 1. The 75 keys were not snapshotted.

`no_confident_match` rose by 19. The preview has 27 legacy refusals that are `no_confident_match` or, for the one year contradiction, the same legacy status. This note does not reconcile that gap row by row. `ambiguous` and `duration_mismatch` did not change.

Ready now 16116 → 15940. Current unresolved 16146 → 15997. Retry backoff 0 → 27. No chunk response carried `retryAt`. Terminal no-match stayed 0.

The prediction queue's pending count went from 0 to 50, the same 50 new films. The status field for hot films that already have a prediction moved from 1769 to 1782 when the queue was rebuilt. This session did not call the prediction runner.

Shadow wrote no second decision and no second catalog row. The films that are now available are the ones legacy verified.

## 10. Facts and hypotheses

Facts: the binding is `shadow`; the code is `203727b`; the generation is `2e63530d-27f6-43cc-85dd-f5a2c9c97e16`; the twelve snapshots sum to 50 agreements and 29 shared refusals; the live status comparison is only chunk 12; legacy inserted 50 films; `on` is not set.

Hypothesis, not a finding: a wider or stratified sample would stay this quiet. This slice cannot support that. Hypothesis, not a finding: a shared `agree_verified` id is the right film. That needs an identity review this run did not do.

## 11. Rollback

The binding is still `shadow`. To return to the legacy-only branch, delete `SCORED_RESOLUTION` or set it to `off`. Leave `LIFECYCLE_LOCALIZATION`, the TMDB secret, schedules, and `wrangler.jsonc` as they are. The continuation is paused until 2026-10-23 00:00 UTC. A later call to the resolve route after that time would take another budget and would keep writing legacy decisions while the binding stays `shadow`.

## 12. Recommendation

**INSUFFICIENT DATA.**

The sample is large enough to show that this hot slice did not produce a disagreement, a shadow-only fetch, or a chunk failure. It is not large enough, and not varied enough, to authorize a cutover proposal. `on` stays off. A later proposal needs a sample that actually contains the rows section 8 lists. Until then the safe production mode is the current one: legacy remains the writer, and shadow only records the comparison.
