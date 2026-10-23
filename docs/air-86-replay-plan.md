# AIR-86 stage 2 plan

Dry run only. No TMDB request has been sent. The proposed cap of 130 HTTP calls is not approved.

The cohort is the one named on the card: the 30 rows that were blocked at the census instant, plus the 8 structural rows that were not blocked. `блейд 1|1998` and `гол 2|2008` stay inside the 30. Membership was not recomputed from `retryAt` values that might have expired later.

## Snapshot

Census instant `2026-10-23T17:19:42.476Z`. Read-only capture of the live ledger `2026-10-23T17:52:50.645Z`. Published generation `cf3ba3ac-f962-4475-b9cd-3de1b07bd1eb`, phase `published`, still the pointer. The ledger copy is `epg/generations/<that id>/discovery-latest.json` (49715 items). All 38 keys are present. Decisions are the live `epg/discovery-resolution.json`, 8797 keys, the same count as the census.

Variants below are `candidateSearchVariants` from the current source, capped at 4. Every row uses `ru-RU`. None of the 38 titles contains і, ї, є, or ґ.

| Group | Rows | Planned searches |
| --- | ---: | ---: |
| Blocked, year either side only | 28 | 56 |
| Blocked, structural | 2 | 7 |
| Eligible structural | 8 | 24 |
| All 38 | 38 | 87 |

87 is 63 + 31 − 7. The overlap is Blade (4) and Goal (3). The machine-readable copy is `docs/air-86-replay-manifest.json`. `capApproved` is false.

## Drift since the census

Thirty-three minutes passed between the census and this capture. None of the 30 blocked rows crossed from a future `retryAt` to a due one. Status, attempts (all 1), terminal reason, and TMDB id are unchanged on all 38. No row was missing from the ledger.

Evidence against the captured candidate:

- 30 blocked rows: stored `evidenceKey` still equals the candidate. Same as the census.
- `11 друзей оушена|2001` and `чужой против хищника 1|2004`: still changed. The stored show list does not match the generation copy. That was already why they were eligible.
- Six due structural rows: `evidenceKey` is still null. The gate treats a missing key as a match. Their live show list is in the manifest for the replay, and it does not replace the census label.

## Replay, still not started

A local Node process will load the unchanged `candidateSearchVariants`, `scoreFilmResolution`, and `gateScoredCandidate`. It will read the pinned generation and, at run time, `epg/discovered-films.json` plus the published programme films, so catalog candidates and detail competitors are the ones the scorer already sees. It will call `api.themoviedb.org` directly. It will not call `POST /api/enrichment/discovery/resolve`, and it will not write R2, decisions, `retryAt`, flags, EPG, predictions, or schedules.

The read token is not in this environment. The replay will take it from the process environment and will not print it. It will not read the Worker secret into the log. If that environment is still missing when the cap is approved, the replay stops.

Search order inside a row is the function order. An exact normalized-title hit stops the later searches for that row, as the collector does, and those unsent queries stay listed. They are not a failure. Alias reads use `movie/{id}` with translations and alternative titles, up to three year-compatible leftovers, and those hits are not given to the scorer. A verification read is a separate `movie/{id}` call with credits as well, and only after `scoreFilmResolution` returns `accepted`.

The gate function is not edited. It is called twice per scored row:

1. With the captured live decision. A row still behind `retryAt` comes back `not_actionable`. That is recorded, and it is not a recognition result.
2. With no decision on this evidence. Every row has `attempts: 1`, so the stored decision was created by that attempt. This is the shadow preview the collector builds when there was no prior same-evidence decision. This result is the recognition outcome. It is not written back.

A row with an accepted score and no detail call is `partially_evaluated`. Absence of detail is not a rejection and not a false id. A proposal is not `verified`.

## Budget to approve

One counter for every TMDB HTTP call, including errors. No automatic retry. The first HTTP 429 stops the run. Eight calls maximum for one observation. Rows not started are `not_evaluated`.

| Step | What it spends | Bound |
| --- | --- | ---: |
| 1. Searches, in the manifest order | `search/movie` | 87 if every planned query is sent |
| 2. Verification | one detail read per accepted score, same order | 0 to 38 |
| 3. Alias reads | up to 3 per row, only with what remains, same order | 0 to 114 |

Step 1 finishes before step 2, so alias and detail calls cannot consume the searches. Structural rows are 1–10, then the 28 year-only rows. A 429 during the searches therefore leaves the year-only tail untested before it leaves a structural row untested.

The theoretical maximum is 87 + 38 + 114 = 239. The proposed cap is **130**, which is 87 searches plus a shared reserve of 43. That reserve cannot verify and alias-check all 38 rows. It covers every verification if at most 43 scores are accepted, and alias reads only with the leftover. Blade is the only row whose planned worst case is 4 + 3 + 1 = 8, so the per-row cap does not drop a planned search unless an error has already used a slot.

130 is the number that needs a separate yes. Approving the 38 rows did not approve it. A result on this cohort does not unblock AIR-68.

## Manifest

| # | Group | Key | Stored title | Legacy | Evidence | Searches | Queries |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | blocked_structural | `блейд 1\|1998` | Блейд 1 | no_confident_match | same | 4 | part_suffix: Блейд @1998<br>spelling_e: Блэйд @1998<br>year_before: Блейд 1 @1997<br>year_after: Блейд 1 @1999 |
| 2 | blocked_structural | `гол 2\|2008` | Гол 2 | no_confident_match | same | 3 | part_suffix: Гол @2008<br>year_before: Гол 2 @2007<br>year_after: Гол 2 @2009 |
| 3 | eligible_structural | `11 друзей оушена\|2001` | 11 друзей Оушена | no_confident_match | changed | 3 | numeral: одиннадцать друзей Оушена @2001<br>year_before: 11 друзей Оушена @2000<br>year_after: 11 друзей Оушена @2002 |
| 4 | eligible_structural | `чужой против хищника 1\|2004` | Чужой против Хищника 1 | no_confident_match | changed | 3 | part_suffix: Чужой против Хищника @2004<br>year_before: Чужой против Хищника 1 @2003<br>year_after: Чужой против Хищника 1 @2005 |
| 5 | eligible_structural | `12 друзей оушена\|2004` | 12 друзей Оушена | no_confident_match | missing | 3 | numeral: двенадцать друзей Оушена @2004<br>year_before: 12 друзей Оушена @2003<br>year_after: 12 друзей Оушена @2005 |
| 6 | eligible_structural | `код 8 часть 2\|2024` | Код 8 Часть 2 | no_confident_match | missing | 3 | part_suffix: Код 8 Часть @2024<br>year_before: Код 8 Часть 2 @2023<br>year_after: Код 8 Часть 2 @2025 |
| 7 | eligible_structural | `матрица 1\|1999` | Матрица 1 | no_confident_match | missing | 3 | part_suffix: Матрица @1999<br>year_before: Матрица 1 @1998<br>year_after: Матрица 1 @2000 |
| 8 | eligible_structural | `чебурашка 2\|2025` | Чебурашка 2 | no_confident_match | missing | 3 | part_suffix: Чебурашка @2025<br>year_before: Чебурашка 2 @2024<br>year_after: Чебурашка 2 @2026 |
| 9 | eligible_structural | `черный телефон 2\|2025` | Черный телефон 2 | no_confident_match | missing | 3 | part_suffix: Черный телефон @2025<br>year_before: Черный телефон 2 @2024<br>year_after: Черный телефон 2 @2026 |
| 10 | eligible_structural | `убежище\|2022` | Убежище | ambiguous | missing | 3 | spelling_e: Убэжищэ @2022<br>year_before: Убежище @2021<br>year_after: Убежище @2023 |
| 11 | blocked_year | `apocalyptica w o a\|2025` | APOCALYPTICA：W：O：A | no_confident_match | same | 2 | year_before: APOCALYPTICA：W：O：A @2024<br>year_after: APOCALYPTICA：W：O：A @2026 |
| 12 | blocked_year | `dirkschneider and the old gang live in studio\|2025` | Dirkschneider And The Old Gang Live @ In Studio | no_confident_match | same | 2 | year_before: Dirkschneider And The Old Gang Live @ In Studio @2024<br>year_after: Dirkschneider And The Old Gang Live @ In Studio @2026 |
| 13 | blocked_year | `maroon 5 live the town\|2023` | Maroon 5 Live @ The Town | no_confident_match | same | 2 | year_before: Maroon 5 Live @ The Town @2022<br>year_after: Maroon 5 Live @ The Town @2024 |
| 14 | blocked_year | `mary gu качала пресс разбила нос пошла на пилон опасная поездка на blablacar е музloft 53\|2023` | Mary Gu \| Качала пресс, разбила нос, пошла на пилон. Опасная поездка на BlaBlaCar-е. МУЗLOFT #53 | no_confident_match | same | 2 | year_before: Mary Gu \| Качала пресс, разбила нос, пошла на пилон. Опасная поездка на BlaBlaCar-е. МУЗLOFT #53 @2022<br>year_after: Mary Gu \| Качала пресс, разбила нос, пошла на пилон. Опасная поездка на BlaBlaCar-е. МУЗLOFT #53 @2024 |
| 15 | blocked_year | `midnight oil armistice day live sydney\|2018` | Midnight Oil Armistice Day Live @ Sydney | no_confident_match | same | 2 | year_before: Midnight Oil Armistice Day Live @ Sydney @2017<br>year_after: Midnight Oil Armistice Day Live @ Sydney @2019 |
| 16 | blocked_year | `sevak от строителя до евровидения музloft 32\|2022` | SEVAK \| От строителя до Евровидения. МузLOFT #32 | no_confident_match | same | 2 | year_before: SEVAK \| От строителя до Евровидения. МузLOFT #32 @2021<br>year_after: SEVAK \| От строителя до Евровидения. МузLOFT #32 @2023 |
| 17 | blocked_year | `skid row live london\|2022` | Skid Row Live @ London | no_confident_match | same | 2 | year_before: Skid Row Live @ London @2021<br>year_after: Skid Row Live @ London @2023 |
| 18 | blocked_year | `айдар гараев о шоу плохие песни проблемах квн и современных артистах музloft 3\|2021` | Айдар Гараев о шоу плохие песни, проблемах КВН и современных артистах \| МузLoft #3 | no_confident_match | same | 2 | year_before: Айдар Гараев о шоу плохие песни, проблемах КВН и современных артистах \| МузLoft #3 @2020<br>year_after: Айдар Гараев о шоу плохие песни, проблемах КВН и современных артистах \| МузLoft #3 @2022 |
| 19 | blocked_year | `академик пивоваров 10 поворотных моментов российской истории скажи гордеевой\|2024` | Академик Пивоваров: 10 поворотных моментов российской истории // «Скажи Гордеевой» | no_confident_match | same | 2 | year_before: Академик Пивоваров: 10 поворотных моментов российской истории // «Скажи Гордеевой» @2023<br>year_after: Академик Пивоваров: 10 поворотных моментов российской истории // «Скажи Гордеевой» @2025 |
| 20 | blocked_year | `дракула история любви\|2025` | Дракула - История любви | no_confident_match | same | 2 | year_before: Дракула - История любви @2024<br>year_after: Дракула - История любви @2026 |
| 21 | blocked_year | `дунцову боятся власти почему кандидата от народа не допускают к выборам\|2023` | Дунцову боятся власти? Почему кандидата от народа не допускают к выборам | no_confident_match | same | 2 | year_before: Дунцову боятся власти? Почему кандидата от народа не допускают к выборам @2022<br>year_after: Дунцову боятся власти? Почему кандидата от народа не допускают к выборам @2024 |
| 22 | blocked_year | `звездные собаки белка и стрелка\|2010` | Звёздные собаки: Белка и Стрелка | no_confident_match | same | 2 | year_before: Звёздные собаки: Белка и Стрелка @2009<br>year_after: Звёздные собаки: Белка и Стрелка @2011 |
| 23 | blocked_year | `из нее сделали пельмени или мать сама ее продала тайна исчезновения алены имамовой тюменский маньяк\|2024` | ИЗ НЕЕ СДЕЛАЛИ ПЕЛЬМЕНИ ИЛИ МАТЬ САМА ЕЕ ПРОДАЛА. Тайна исчезновения Алены Имамовой/Тюменский маньяк | no_confident_match | same | 2 | year_before: ИЗ НЕЕ СДЕЛАЛИ ПЕЛЬМЕНИ ИЛИ МАТЬ САМА ЕЕ ПРОДАЛА. Тайна исчезновения Алены Имамовой/Тюменский маньяк @2023<br>year_after: ИЗ НЕЕ СДЕЛАЛИ ПЕЛЬМЕНИ ИЛИ МАТЬ САМА ЕЕ ПРОДАЛА. Тайна исчезновения Алены Имамовой/Тюменский маньяк @2025 |
| 24 | blocked_year | `м ф том и джерри гигантское приключение\|2013` | м/ф Том и Джерри Гигантское приключение | no_confident_match | same | 2 | year_before: м/ф Том и Джерри Гигантское приключение @2012<br>year_after: м/ф Том и Джерри Гигантское приключение @2014 |
| 25 | blocked_year | `м ф фабрика иллюзий алисы и терезы\|2023` | м/ф Фабрика иллюзий Алисы и Терезы | no_confident_match | same | 2 | year_before: м/ф Фабрика иллюзий Алисы и Терезы @2022<br>year_after: м/ф Фабрика иллюзий Алисы и Терезы @2024 |
| 26 | blocked_year | `мой друг кот и пушкин\|2025` | Мой друг, кот и Пушкин | ambiguous | same | 2 | year_before: Мой друг, кот и Пушкин @2024<br>year_after: Мой друг, кот и Пушкин @2026 |
| 27 | blocked_year | `мортал комбат\|1995` | Мортал Комбат | no_confident_match | same | 2 | year_before: Мортал Комбат @1994<br>year_after: Мортал Комбат @1996 |
| 28 | blocked_year | `нежный travel бали\|2026` | Нежный Travel: БАЛИ | no_confident_match | same | 2 | year_before: Нежный Travel: БАЛИ @2025<br>year_after: Нежный Travel: БАЛИ @2027 |
| 29 | blocked_year | `он охотится на меня мой преследователь полицейский это твой последний день рождения тебя зарежу\|2024` | ОН ОХОТИТСЯ НА МЕНЯ. Мой преследователь- полицейский. ЭТО ТВОЙ ПОСЛЕДНИЙ ДЕНЬ РОЖДЕНИЯ, ТЕБЯ ЗАРЕЖУ | no_confident_match | same | 2 | year_before: ОН ОХОТИТСЯ НА МЕНЯ. Мой преследователь- полицейский. ЭТО ТВОЙ ПОСЛЕДНИЙ ДЕНЬ РОЖДЕНИЯ, ТЕБЯ ЗАРЕЖУ @2023<br>year_after: ОН ОХОТИТСЯ НА МЕНЯ. Мой преследователь- полицейский. ЭТО ТВОЙ ПОСЛЕДНИЙ ДЕНЬ РОЖДЕНИЯ, ТЕБЯ ЗАРЕЖУ @2025 |
| 30 | blocked_year | `отт бь ч\|2006` | }{отт@бь)ч | no_confident_match | same | 2 | year_before: }{отт@бь)ч @2005<br>year_after: }{отт@бь)ч @2007 |
| 31 | blocked_year | `пиноккио раскрепощенный\|2026` | Пиноккио - Раскрепощенный | no_confident_match | same | 2 | year_before: Пиноккио - Раскрепощенный @2025<br>year_after: Пиноккио - Раскрепощенный @2027 |
| 32 | blocked_year | `самый далекий регион чукотка на край земли на собаках как люди живут\|2021` | Самый далёкий регион / Чукотка / на край Земли на собаках / Как Люди живут | no_confident_match | same | 2 | year_before: Самый далёкий регион / Чукотка / на край Земли на собаках / Как Люди живут @2020<br>year_after: Самый далёкий регион / Чукотка / на край Земли на собаках / Как Люди живут @2022 |
| 33 | blocked_year | `солженицын который все про нас понял\|2024` | Солженицын, который всё про нас понял | no_confident_match | same | 2 | year_before: Солженицын, который всё про нас понял @2023<br>year_after: Солженицын, который всё про нас понял @2025 |
| 34 | blocked_year | `то что внутри\|2024` | То, что внутри | no_confident_match | same | 2 | year_before: То, что внутри @2023<br>year_after: То, что внутри @2025 |
| 35 | blocked_year | `уральские пельмени серьги на ветер\|2009` | Уральские пельмени: Серьги на ветер | no_confident_match | same | 2 | year_before: Уральские пельмени: Серьги на ветер @2008<br>year_after: Уральские пельмени: Серьги на ветер @2010 |
| 36 | blocked_year | `циркафрика эфиопия\|2025` | Циркафрика. Эфиопия | no_confident_match | same | 2 | year_before: Циркафрика. Эфиопия @2024<br>year_after: Циркафрика. Эфиопия @2026 |
| 37 | blocked_year | `чудо женщина\|2020` | Чудо-женщина | no_confident_match | same | 2 | year_before: Чудо-женщина @2019<br>year_after: Чудо-женщина @2021 |
| 38 | blocked_year | `я себя знаю алексей смирнов х азамат мусагалиев\|2022` | Я себя знаю! Алексей Смирнов х Азамат Мусагалиев | no_confident_match | same | 2 | year_before: Я себя знаю! Алексей Смирнов х Азамат Мусагалиев @2021<br>year_after: Я себя знаю! Алексей Смирнов х Азамат Мусагалиев @2023 |
