# AIR-86 variant replay

> Historical sample. See [evidence registry](../README.md) for context and later decisions. This text is not a current operational authorization.

Isolated replay of the 38-row cohort from `docs/air-86-replay-plan.md`. No production write: no Worker flag, R2 object, legacy decision, `retryAt`, EPG sync, prediction run, or `POST /api/enrichment/discovery/resolve`. [AIR-68](https://trello.com/c/qbLDc6Ql) stays blocked. Two verified rows are not a cutover.

The machine-readable calls and scores are `docs/air-86-replay-results.json`. The runner is `scripts/air-86-replay.mjs`. It calls the unchanged `candidateSearchVariants`, `variantHit`, `scoreFilmResolution`, and `gateScoredCandidate`.

## Spend

Generation `cf3ba3ac-f962-4475-b9cd-3de1b07bd1eb`. The gate clock is the census capture `2026-10-23T17:52:50.645Z`. Ledger rows and decisions were read again at `2026-10-23T18:23:05.431Z`; all 38 keys were still present, and statuses, attempts, and `retryAt` matched the manifest.

| Call | Count |
| --- | ---: |
| `search/movie` | 87 |
| movie detail for an accepted score | 2 |
| alias detail, not given to the scorer | 12 |
| errors, 429s, extra diagnostic calls | 0 |
| Total, inside the cap of 130 | 101 |

All 38 rows are `evaluated`. The exact-title stop did fire for Чебурашка 2 and Убежище, on their last variant, so it saved no calls. The other 36 rows sent every planned query.

## Why only two rows reached detail

Detail runs only after `scoreFilmResolution` returns `accepted`. Acceptance needs the TMDB title, original title, or an alias already on the candidate to fold to the same string as the observation. `variantHit` is looser: it keeps a neighbouring-year row when the query matches, or when one title extends the other by a word. An alias read is recorded and is not added to the scorer.

That split is the whole result. The scorer accepted 2 of 38. Both were the observation's own title at year + 1. Both then passed `verifyTmdbDetail`, so both recognition gates are `detail_verified`. The other 36 were not accepted, so they received no detail call. A missing detail is not a negative identification.

| Scorer | Rows | What happened |
| --- | ---: | --- |
| `accepted` | 2 | Чебурашка 2 at 2026, Убежище at 2023. Detail checked both. |
| `contradicted` / `contradicted_year` | 1 | Чудо-женщина 2020. The catalog already has Чудо-женщина 2017. The year gap is 3. |
| `no_confident_match` / `no_exact_title` | 35 | No candidate title folded to the observation. |

## Gates

The live gate sees the stored decision. The recognition gate sees no decision, which is the shadow preview for a first attempt. Neither gate was edited, and neither result was written.

| Gate | `detail_verified` | `candidate_decision` | `refused` / `not_actionable` |
| --- | ---: | ---: | ---: |
| Live | 2 | 6 | 30 |
| Recognition | 2 | 36 | 0 |

The 30 live refusals are the census blocked rows: `retryAt` was still ahead and the stored evidence still matched, so the live gate refuses them before the score matters. None of those 30 were accepted, so the refusal did not hide a verification. The two verifications were already actionable: their `retryAt` had expired and the stored evidence key was empty. The live gate and the recognition gate agree on both.

## Groups

The census still has 105 rows with `retryAt`. This replay is 38 of them. It does not measure `readyNow`, verified rows, the cheap pass, or yearless titles.

| Group | Rows | Search calls | Accepted | `detail_verified` | Exact-title miss | Year contradiction |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Blocked, year either side only | 28 | 56 | 0 | 0 | 27 | 1 |
| Blocked, structural | 2 | 7 | 0 | 0 | 2 | 0 |
| Eligible structural | 8 | 24 | 2 | 2 | 6 | 0 |
| All 10 structural | 10 | 31 | 2 | 2 | 8 | 0 |
| All 38 | 38 | 87 | 2 | 2 | 35 | 1 |

Part, spelling, and numeral queries verified nothing. They did find the film a person would name, under a different title string:

| Observation | Found | Why the scorer stopped |
| --- | --- | --- |
| `блейд 1\|1998` | 36647 Блэйд / Blade, 1998 | The spelling query matches. The observation still says «блейд 1». |
| `гол 2\|2008` | 9815 Гол 2: Жизнь как мечта, 2007 | The stem «Гол» extends to the longer title. The observation is only «гол 2». |
| `11 друзей оушена\|2001` | 161 Одиннадцать друзей Оушена, 2001 | The numeral word is not the digit title. |
| `12 друзей оушена\|2004` | 163 Двенадцать друзей Оушена, 2004 | Same numeral gap. |
| `чужой против хищника 1\|2004` | 395 Чужой против Хищника, 2004 | Dropping the part suffix removes the «1» the observation still has. |
| `матрица 1\|1999` | 603 Матрица, 1999 | Same part-suffix gap. |
| `код 8 часть 2\|2024` | 932420, alias «Код 8: Часть 2» | The alias text matches the observation. The scorer never received it. |
| `черный телефон 2\|2025` | nothing | No search hit and no alias candidate. |

The alias read for Мортал Комбат 1995 found the same kind of unused match: 9312 Смертельная битва carries the alias «Мортал Комбат». Белка и Стрелка 2010 was in the non-hit pool as «Белка и Стрелка. Звёздные собаки»; its alias list did not contain the EPG word order, so it stayed unused.

## The two verifications

Чебурашка 2, observation year 2025. Search at 2026 returned 1228477 «Чебурашка 2», release year 2026, runtime 103. The ledger durations are 102 and 103. Score 0.895, `accepted_unique_evidence`. Detail passed title, year within 1, and runtime. Both gates are `detail_verified`. The title is specific. The year gap is the intended neighbouring-year case.

Убежище, observation year 2022. Search at 2023 returned 801970 «Убежище» / Refuge, release year 2023, runtime 91. The ledger durations are 87 and 88. Score 0.895, `accepted_year_separates_remakes`. The catalog already has another «Убежище» / Shelter, 1290821, year 2026. The scorer kept the nearer year and the detail check passed. Both gates are `detail_verified`. This is the generic-title risk: a one-word title verified at the neighbouring year while a different edition remains in the catalog. The gate did what its year rule says. It is not an independent identification of the broadcast.

## False-ID pressure that was not verified

Гол 2. The stem search also offered Гол 3, «Голубой пирог 2», and «Голый барабанщик». Their alias lists did not contain «гол 2», so they were not proposed to the scorer. The kept hit is Goal II under a longer title, and that hit was not accepted.

Чудо-женщина 2020. Year − 1 returned 537055 «Чудо-женщина: Кровные узы» (2019). Year + 1 returned 464052 «Чудо-женщина: 1984» (2020). Both extend the observation by extra words, so `variantHit` kept them. Neither title equals «чудо женщина», so they did not decide the score. The contradiction is the 2017 catalog film. No detail call.

Блейд. «Бегущий по лезвию» (1982) was on the search page and was not alias-checked: its year is outside the one-year window.

No other row produced a search hit.

## What this does not say

Twenty-five of the 28 blocked year-only rows returned no search hit at either neighbouring year. An empty search is not a false ID. The other three are Чудо-женщина, Белка и Стрелка, and Мортал Комбат, above. Sixty-seven other `retryAt` rows were not in this cohort. The cheap pass, yearless titles, and the 17029 `readyNow` rows from the census were not replayed. Alias evidence is diagnostic only; feeding it to the scorer would be a different algorithm and was not done here.

The replay does not support cutover. The variants retrieve some of the structural misses, and the current exact-title scorer then drops them.

## All 38

| # | Group | Key | Scorer | Live gate | Recognition gate | Search hits | Alias reads |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | blocked_structural | `блейд 1\|1998` | no_confident_match / no_exact_title | refused / not_actionable | candidate_decision / no_exact_title | 36647 Блэйд (1998) via spelling_e | 36647 Блэйд (1998), no alias match |
| 2 | blocked_structural | `гол 2\|2008` | no_confident_match / no_exact_title | refused / not_actionable | candidate_decision / no_exact_title | 9815 Гол 2: Жизнь как мечта (2007) via part_suffix | 15706 Голубой пирог 2: Парни идут вразнос! (2008), no alias match; 19139 Гол 3 (2008), no alias match; 10186 Голый барабанщик (2008), no alias match |
| 3 | eligible_structural | `11 друзей оушена\|2001` | no_confident_match / no_exact_title | candidate_decision / no_exact_title | candidate_decision / no_exact_title | 161 Одиннадцать друзей Оушена (2001) via numeral | 161 Одиннадцать друзей Оушена (2001), no alias match |
| 4 | eligible_structural | `чужой против хищника 1\|2004` | no_confident_match / no_exact_title | candidate_decision / no_exact_title | candidate_decision / no_exact_title | 395 Чужой против Хищника (2004) via part_suffix | — |
| 5 | eligible_structural | `12 друзей оушена\|2004` | no_confident_match / no_exact_title | candidate_decision / no_exact_title | candidate_decision / no_exact_title | 163 Двенадцать друзей Оушена (2004) via numeral | 163 Двенадцать друзей Оушена (2004), no alias match |
| 6 | eligible_structural | `код 8 часть 2\|2024` | no_confident_match / no_exact_title | candidate_decision / no_exact_title | candidate_decision / no_exact_title | — | 932420 Код 8: часть II (2024), alias «Код 8: Часть 2» |
| 7 | eligible_structural | `матрица 1\|1999` | no_confident_match / no_exact_title | candidate_decision / no_exact_title | candidate_decision / no_exact_title | 603 Матрица (1999) via part_suffix | — |
| 8 | eligible_structural | `чебурашка 2\|2025` | accepted / accepted_unique_evidence | detail_verified / tmdb_detail | detail_verified / tmdb_detail | 1228477 Чебурашка 2 (2026) via year_after | 1409695 Чебурашка. Новый год (2025), no alias match |
| 9 | eligible_structural | `черный телефон 2\|2025` | no_confident_match / no_exact_title | candidate_decision / no_exact_title | candidate_decision / no_exact_title | — | — |
| 10 | eligible_structural | `убежище\|2022` | accepted / accepted_year_separates_remakes | detail_verified / tmdb_detail | detail_verified / tmdb_detail | 801970 Убежище (2023) via year_after | 917594 Лагерь-убежище (2023), no alias match; 1134471 БНТ представя: „Георги Господинов в убежището на времето“ (2023), no alias match |
| 11 | blocked_year | `apocalyptica w o a\|2025` | no_confident_match / no_exact_title | refused / not_actionable | candidate_decision / no_exact_title | — | — |
| 12 | blocked_year | `dirkschneider and the old gang live in studio\|2025` | no_confident_match / no_exact_title | refused / not_actionable | candidate_decision / no_exact_title | — | — |
| 13 | blocked_year | `maroon 5 live the town\|2023` | no_confident_match / no_exact_title | refused / not_actionable | candidate_decision / no_exact_title | — | — |
| 14 | blocked_year | `mary gu качала пресс разбила нос пошла на пилон опасная поездка на blablacar е музloft 53\|2023` | no_confident_match / no_exact_title | refused / not_actionable | candidate_decision / no_exact_title | — | — |
| 15 | blocked_year | `midnight oil armistice day live sydney\|2018` | no_confident_match / no_exact_title | refused / not_actionable | candidate_decision / no_exact_title | — | — |
| 16 | blocked_year | `sevak от строителя до евровидения музloft 32\|2022` | no_confident_match / no_exact_title | refused / not_actionable | candidate_decision / no_exact_title | — | — |
| 17 | blocked_year | `skid row live london\|2022` | no_confident_match / no_exact_title | refused / not_actionable | candidate_decision / no_exact_title | — | — |
| 18 | blocked_year | `айдар гараев о шоу плохие песни проблемах квн и современных артистах музloft 3\|2021` | no_confident_match / no_exact_title | refused / not_actionable | candidate_decision / no_exact_title | — | — |
| 19 | blocked_year | `академик пивоваров 10 поворотных моментов российской истории скажи гордеевой\|2024` | no_confident_match / no_exact_title | refused / not_actionable | candidate_decision / no_exact_title | — | — |
| 20 | blocked_year | `дракула история любви\|2025` | no_confident_match / no_exact_title | refused / not_actionable | candidate_decision / no_exact_title | — | — |
| 21 | blocked_year | `дунцову боятся власти почему кандидата от народа не допускают к выборам\|2023` | no_confident_match / no_exact_title | refused / not_actionable | candidate_decision / no_exact_title | — | — |
| 22 | blocked_year | `звездные собаки белка и стрелка\|2010` | no_confident_match / no_exact_title | refused / not_actionable | candidate_decision / no_exact_title | — | 36696 Белка и Стрелка. Звёздные собаки (2010), no alias match |
| 23 | blocked_year | `из нее сделали пельмени или мать сама ее продала тайна исчезновения алены имамовой тюменский маньяк\|2024` | no_confident_match / no_exact_title | refused / not_actionable | candidate_decision / no_exact_title | — | — |
| 24 | blocked_year | `м ф том и джерри гигантское приключение\|2013` | no_confident_match / no_exact_title | refused / not_actionable | candidate_decision / no_exact_title | — | — |
| 25 | blocked_year | `м ф фабрика иллюзий алисы и терезы\|2023` | no_confident_match / no_exact_title | refused / not_actionable | candidate_decision / no_exact_title | — | — |
| 26 | blocked_year | `мой друг кот и пушкин\|2025` | no_confident_match / no_exact_title | refused / not_actionable | candidate_decision / no_exact_title | — | — |
| 27 | blocked_year | `мортал комбат\|1995` | no_confident_match / no_exact_title | refused / not_actionable | candidate_decision / no_exact_title | — | 9312 Смертельная битва (1995), alias «Мортал Комбат» |
| 28 | blocked_year | `нежный travel бали\|2026` | no_confident_match / no_exact_title | refused / not_actionable | candidate_decision / no_exact_title | — | — |
| 29 | blocked_year | `он охотится на меня мой преследователь полицейский это твой последний день рождения тебя зарежу\|2024` | no_confident_match / no_exact_title | refused / not_actionable | candidate_decision / no_exact_title | — | — |
| 30 | blocked_year | `отт бь ч\|2006` | no_confident_match / no_exact_title | refused / not_actionable | candidate_decision / no_exact_title | — | — |
| 31 | blocked_year | `пиноккио раскрепощенный\|2026` | no_confident_match / no_exact_title | refused / not_actionable | candidate_decision / no_exact_title | — | — |
| 32 | blocked_year | `самый далекий регион чукотка на край земли на собаках как люди живут\|2021` | no_confident_match / no_exact_title | refused / not_actionable | candidate_decision / no_exact_title | — | — |
| 33 | blocked_year | `солженицын который все про нас понял\|2024` | no_confident_match / no_exact_title | refused / not_actionable | candidate_decision / no_exact_title | — | — |
| 34 | blocked_year | `то что внутри\|2024` | no_confident_match / no_exact_title | refused / not_actionable | candidate_decision / no_exact_title | — | — |
| 35 | blocked_year | `уральские пельмени серьги на ветер\|2009` | no_confident_match / no_exact_title | refused / not_actionable | candidate_decision / no_exact_title | — | — |
| 36 | blocked_year | `циркафрика эфиопия\|2025` | no_confident_match / no_exact_title | refused / not_actionable | candidate_decision / no_exact_title | — | — |
| 37 | blocked_year | `чудо женщина\|2020` | contradicted / contradicted_year | refused / not_actionable | candidate_decision / contradicted_year | 537055 Чудо-женщина: Кровные узы (2019) via year_before; 464052 Чудо-женщина: 1984 (2020) via year_after | — |
| 38 | blocked_year | `я себя знаю алексей смирнов х азамат мусагалиев\|2022` | no_confident_match / no_exact_title | refused / not_actionable | candidate_decision / no_exact_title | — | — |
