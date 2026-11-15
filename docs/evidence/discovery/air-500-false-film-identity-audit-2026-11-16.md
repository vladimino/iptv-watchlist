# AIR-500: read-only audit of false Discovery Film identities

**Captured:** 2026-11-15 23:40–00:50 UTC (00:40–01:50 Europe/Madrid). Point-in-time D1 reads; no production write.
**Used by:** [AIR-500](https://trello.com/c/dD3BRQ2H). Inventory for [AIR-498](https://trello.com/c/3dPOigK9). This audit does not authorize a correction and does not complete AIR-498.
**Code read:** `main` `97f5dc5f409b2820f3d23b4e90f657e4b50cf8a8` (ADR 0080, ADR 0142, ADR 0149, `src/discovery-authority.js` `ownerDecision`, `src/discovery.js` `ownerRejected`, `src/domain/scored-resolution.js` year/runtime bands).
**Verdict:** one confirmed wrong observation link. Concert-shaped Music-only admissions stay `needs_review`. XMLTV category is absent on the whole active ledger, so Music, a Live/Concert title, or a missing fingerprint is not treated as proof.

## Method

Read-only `SELECT` against production D1 `iptv` (`database_id` `3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb`) through the Cloudflare D1 query API. No Worker GET, no MCP tool that can write, no TMDB call, no R2 read, no EPG/Discovery/prediction/ratings run, no flag change.

Rules, applied to every current movie admission:

| Rule | Source | What it is not |
| --- | --- | --- |
| Music-only | `discovery_admission.payload_json` genres, case-insensitive `музыка`, array length 1 | Not `confirmed_wrong`. ADR 0149 withholds only when a concert/music XMLTV category is also present. Genre id `10402` is not stored. |
| Year gap ≥ 2 | active `discovery_observation.year` vs admission `$.year` | A null observation year is not a conflict (`year_absent` in the scorer). |
| Runtime conflict | `abs(observation.duration − admission.runtime) > max(45, runtime × 0.4)` | Same threshold as `runtime_conflict` in `scored-resolution.js`. A same-title conflict is `needs_review`. |
| Title tokens | active observation title | `концерт`/`concert`, ` live `, `серия`/`эпизод`/`сезон`/`выпуск`, `телепередача`/`сериал`/`новости`/`спорт`. A token alone is not a verdict. |
| Alias title | `identitySource=known_epg_alias` and the observation title is not a punctuation variant of the admission title | A different stored title plus a stable duration mismatch can confirm a wrong id. An alternate title that was not disproved stays `needs_review`. |
| `parse_error` | prediction queue `retries` | Signal only. |

`confirmed_wrong_epg_identity` requires stored fields that contradict the link. A missing category, a missing genre id, or a missing archive row does not become confirmation.

## Pinned production state

| Marker | Value |
| --- | --- |
| `schema_contract.version` | 22 |
| `discovery_authority` | `d1` / `open`, generation 144333, `programme_run_id` `3b7c7152-eb54-45f7-8985-92c377b57181` |
| `published_epg_authority` | `d1` / `open`, generation 510 |
| Published generation | `3b7c7152-eb54-45f7-8985-92c377b57181`, phase `published`, `published_at` `2026-11-15T16:01:18.438Z` (17:01 Europe/Madrid) |
| `prediction_domain_authority` | `d1`, generation 12800, `queue_generation` 1193 |
| `ratings_domain_authority` | `d1` / `open`, generation 4019 |

Previous publications on the same table: `0e4a5f90-8f50-4c6d-b749-80c7565194a2` at `2026-11-14T16:05:56.999Z`, `4562e2d8-14f7-4497-a4d7-270e0a975fe9` at `2026-11-13T16:29:21.401Z`.

## Coverage

| Population | Count |
| --- | --- |
| `discovery_decision` rows | 39 177 |
| Verified movie decisions | 14 161 (identity source: `tmdb_detail` 8 648, `known_epg_alias` 3 636, null 1 866, `known_alias_year_runtime` 11) |
| Current movie admissions (`discovery_admission.state=current`) | **9 832** (no `tv` row) |
| Admissions with at least one genre | 9 817 |
| Admissions with an empty genre list | 15 |
| Active observations | 27 593 |
| Archive observations | 28 725 |
| Active observations with a non-null `categories` array | **0** |
| Verified decision + active observation + current admission | 8 607 decision rows, **6 567** distinct films |
| Current admissions with no such active observation | **3 265** |
| Current-generation `published_epg_show` | 16 864 (discovery basis 15 204 rows / 5 732 films; `title_year` 736; `title_unique` 614; `title_duration` 311) |
| `prediction_fingerprint` / `prediction_pointer` | 3 616 / 3 616 |
| `ratings_view` rows overlapping a current admission | 1 369 (watchlist flag 10, rating known 1 344, watched 1 360). Values are not copied. |
| `discovery_decision_history` writers | `import` 10 834, `resolver_chunk` 58 967. No `owner` row. |
| `discovery_intent` | empty |

Admission `observation_key` is null on all 9 832 current rows. The link used here is `discovery_decision.film_id` = `discovery_admission.film_id`. `discovery_score` holds 11 rows and is not an audit source.

Not read: live XMLTV, TMDB genre ids, R2 fingerprint/prediction bodies, archive observation payloads for the 14 Music-only films whose decision did not join `residence=active`. Episode-num is not a column on `discovery_observation`; zero active verified titles matched the episode/season/выпуск tokens.

## Classification of the 9 832 admissions

| Verdict | Admissions | Meaning |
| --- | --- | --- |
| `valid_film` | 6 499 | Active observation, a stored genre, no year gap ≥ 2, runtime inside the scorer's far band, not in the review sets below. Includes two Music-only theatrical titles and `tmdb_9278`, which also has one wrong observation. |
| `needs_review` | 76 | Listed below. Not deleted and not confirmed. |
| `insufficient_evidence` | 3 257 | No active observation, or an active observation with an empty genre list and no other review rule. |
| `confirmed_wrong_epg_identity` | 1 observation, not an extra admission | `беглец\|1993` on `tmdb_9278`. The admission stays `valid_film` because another active observation names the stored title. |

6 499 + 76 + 3 257 = 9 832.

Genre shape of the 9 817 admissions that have a genre (top of the histogram: драма 3 770, комедия 3 265, боевик 2 282, триллер 2 213): `музыка` on 285 films, of which **39 are Music-only**, 23 are Music+Documentary only, 223 are Music plus another feature genre, 0 are Music+TV-Movie only. TV Movie (`телевизионный фильм`) appears on 226 films and never alone. Documentary-only is 67. ADR 0149 does not treat TV Movie or Documentary as concert evidence. Those 223 + 23 + 67 stay in `valid_film` unless a runtime or title rule below caught them. None of the 33 runtime-conflict films is in the Music-only 39.

On the 8 607 joined decision rows: year gap ≥ 2 is **0**; observation year null is 4 260; runtime conflict is **33**. Observation-title tokens: concert 3, live 14, episode/season/выпуск 0, телепередача/сериал/новости/спорт 5. Those tokens were not promoted to `confirmed_wrong`.

## Confirmed wrong link

One observation. The catalog film is a real second identity and must not be retired with this observation.

| Field | Value |
| --- | --- |
| Verdict | `confirmed_wrong_epg_identity` — wrong TMDB id, not "this film does not exist" |
| Observation key | `беглец\|1993` (active) |
| EPG title / year / durations | Беглец / 1993 / `[130,131,127]` |
| Admitted film | `tmdb_9278`, title Корпорация «Бессмертие», year 1992, runtime 110, genres фантастика, боевик, криминал, драма |
| Decision | `verified`, `identitySource=known_epg_alias` |
| Why the link is wrong | The stored titles are different works. Every stored duration of this observation is 127–131 minutes; the admitted runtime is 110. This is not a punctuation or translation variant. |
| Other evidence on the same film | Active observation `корпорация бессмертие\|` and archive observation `корпорация бессмертие\|1992` also verify `tmdb_9278`. |
| Ratings view | no row for `tmdb_9278` |
| XMLTV category | absent |
| Proposed disposition (not an operation) | `reject` on `беглец\|1993` only. Do not retire the admission, the matching observation, or any prediction for `tmdb_9278`. |

## Named examples (not confirmed)

Both are current Music-only admissions, `verified` / `tmdb_detail` / `accepted_unique_evidence`. XMLTV `categories` is absent. TMDB genre id `10402` was not read. `parse_error` is a queue signal, not identity proof. Neither film is in `ratings_view`.

| Field | `tmdb_1326142` | `tmdb_238858` |
| --- | --- | --- |
| Verdict | `needs_review` | `needs_review` |
| Catalog title / year / runtime / genres | Robbie Williams: Live at the Apple Music Festival / 2016 / 82 / `["музыка"]` | Rieu Royale - André Rieu Coronation Concert Live in Amsterdam / 2013 / 119 / `["музыка"]` |
| Observation key | `robbie williams live at the apple music festival\|` | `rieu royale andré rieu coronation concert live in amsterdam\|2013` |
| EPG title / year / duration | Robbie Williams - Live at the Apple Music Festival / null / 82 (durations `[83,82]`) | same as the catalog title / 2013 / 100 (durations `[100]`) |
| Description flag | does not contain концерт/concert or фильм/кино/movie | contains a concert word; does not contain a film word |
| Current discovery shows | 2 | 1 |
| Fingerprint / prediction pointer | no / no | no / no |
| Queue at `2026-11-15T16:08:37.350Z` | hot pending, encoded index 0, `retries` attempts 3, `kind=parse_error`, `scope=item` | hot pending, encoded index 1, same retry shape, attempts 3 |
| Missing proof | XMLTV category, TMDB genre ids, and any stored fact that this slot is a telecast rather than the concert film of the same title | same, plus the description concert word is not an XMLTV category |
| Proposed disposition | no change until an owner decision. A later `reject` would target this observation key only. | same |

The title and runtime of each example agree with the admitted concert film. That supports a correct TMDB id for a Music-only movie. It does not decide whether the EPG slot is a film broadcast. ADR 0149 leaves that case to category evidence or a later owner correction.

## Needs review

### Music-only admissions (39)

Two are `valid_film`: the title is not a concert/live/tour/festival label and the runtime agrees with the observation (`tmdb_218097` Сенсации 1945-го года, 1944, 86 min, active observation, 1 show, fingerprint and prediction present, not in the queue; `tmdb_18700` Till the Clouds Roll By, 1946, 136 min, active observation duration 130, 1 show, no fingerprint, **hot pending**). They are not in the review count.

The other 37 are `needs_review`. Fourteen have no active-residence observation (`observation key unavailable` on the active ledger). Shows are current-generation `published_epg_show` rows. Queue place is the dict1 document refreshed `2026-11-15T16:08:37.350Z` (`trigger=batch_complete`, same `programme_run_id`). Proposed disposition for each is **no change** until the owner accepts a per-key `reject`. Do not retire the admission from this audit.

| film id | year | runtime | active observation | shows | fp/pred | queue | title |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `tmdb_24970` | 1995 | 142 | unavailable | 0 | no | cold | Pink Floyd: Pulse |
| `tmdb_25326` | 2006 | 110 | unavailable | 0 | no | cold | Destiny's Child: Live in Atlanta |
| `tmdb_108848` | 2006 | 71 | unavailable | 0 | no | cold | Rod Stewart: Live from Nokia Times Square |
| `tmdb_23710` | 2006 | 93 | unavailable | 0 | no | cold | Shakira: Oral Fixation Tour |
| `tmdb_46077` | 2009 | 70 | `billy idol in super overdrive live\|2009` | 1 | no | hot | Billy Idol: In Super Overdrive Live |
| `tmdb_26695` | 2009 | 134 | unavailable | 0 | yes | no | George Michael: Live in London |
| `tmdb_114207` | 2010 | 78 | `velvet revolver live in houston\|` | 2 | no | no | Velvet Revolver - Live in Houston |
| `tmdb_1356259` | 2011 | 158 | `foo fighters live in london\|2011` | 2 | no | hot | Foo Fighters - Live in London |
| `tmdb_96844` | 2011 | 162 | `peter gabriel new blood live in london\|` | 1 | no | hot | Peter Gabriel: New Blood, Live in London |
| `tmdb_63371` | 2011 | 110 | unavailable | 0 | no | cold | a-ha - Ending on a High Note - The Final Concert |
| `tmdb_62941` | 2012 | 71 | `the doors live at the bowl 68\|` | 4 | no | hot | The Doors: Концерт в Hollywood Bowl 1968 |
| `tmdb_110445` | 2012 | 139 | unavailable | 0 | no | cold | Пикник: 30 Световых лет |
| `tmdb_223936` | 2013 | 92 | unavailable | 0 | yes | no | Megadeth: Countdown to Extinction - Live |
| `tmdb_252384` | 2013 | 110 | `p nk the truth about love tour live from melbourne\|2013` | 1 | no | hot | P!NK: The Truth About Love Tour - Live from Melbourne |
| `tmdb_238858` | 2013 | 119 | see named examples | 1 | no | hot | Rieu Royale |
| `tmdb_249407` | 2013 | 95 | `roxette live travelling the world\|2013` (2 verified decisions) | 1 | no | hot | Roxette: Live Travelling the World |
| `tmdb_192657` | 2013 | 73 | `whitesnake made in japan\|2013` | 1 | no | no | Whitesnake: Made in Japan |
| `tmdb_1597390` | 2014 | 64 | unavailable | 0 | no | cold | Imagine Dragons - Live at The Moody Theater |
| `tmdb_364933` | 2015 | 56 | `nazareth no means of escape\|` | 4 | no | hot, `parse_error` attempts 1 | Nazareth - No Means of Escape |
| `tmdb_450202` | 2016 | 88 | `britney spears apple music festival\|2016` | 2 | yes | no | Britney Spears: Apple Music Festival |
| `tmdb_685530` | 2016 | 90 | unavailable | 0 | no | cold | Rihanna: Live at Made In America |
| `tmdb_1326142` | 2016 | 82 | see named examples | 2 | no | hot, `parse_error` attempts 3 | Robbie Williams |
| `tmdb_489087` | 2017 | 98 | `yello live in berlin\|2017` | 1 | no | hot | Yello - Live in Berlin |
| `tmdb_534012` | 2018 | 80 | `paul rodgers free spirit\|` | 4 | no | hot | Paul Rodgers - Free Spirit |
| `tmdb_576234` | 2019 | 64 | unavailable | 0 | yes | no | Heart: Live in Atlantic City |
| `tmdb_655125` | 2019 | 124 | `kylie minogue golden live in concert\|2019` | 2 | yes | no | Kylie Minogue: Golden Live in Concert |
| `tmdb_618548` | 2019 | 122 | `shakira in concert el dorado world tour\|2019` | 2 | yes | no | Shakira In Concert: El Dorado World Tour |
| `tmdb_724460` | 2019 | 140 | `ария гость из царства теней\|2019` (2 verified decisions; one source null) | 1 | yes | no | АРИЯ - Гость из Царства Теней |
| `tmdb_785554` | 2021 | 87 | unavailable | 0 | no | cold | BLACKPINK: The Show |
| `tmdb_988831` | 2021 | 79 | `neil young three more decades\|` | 6 | no | hot | Neil Young: Three More Decades |
| `tmdb_801575` | 2021 | 70 | unavailable | 0 | no | cold | Кино в Севкабеле |
| `tmdb_1126350` | 2023 | 134 | `dj bobo evolut30n\|2023` | 2 | yes | no | DJ BoBo - EVOLUT30N |
| `tmdb_1094451` | 2023 | 104 | unavailable | 0 | yes | no | Red Hot Chili Peppers - Live at Tokyo Dome |
| `tmdb_1081789` | 2023 | 98 | `the weeknd live at sofi stadium\|2023` | 2 | yes | no | The Weeknd: Live at SoFi Stadium |
| `tmdb_1063549` | 2024 | 117 | `gaga chromatica ball\|2024` | 1 | no | hot | Gaga Chromatica Ball |
| `tmdb_1522301` | 2025 | 142 | `david gilmour live at the circus maximus\|2025` | 1 | yes | no | David Gilmour: Live at the Circus Maximus |
| `tmdb_1603159` | 2025 | 90 | `tesseract radar\|` | 4 | no | hot | TesseracT: RADAR |

Current-generation discovery shows on all 39 Music-only films, including the two theatrical titles: 50. Concert-shaped films with a stored fingerprint and prediction pointer: 11 (`tmdb_26695`, `tmdb_223936`, `tmdb_450202`, `tmdb_576234`, `tmdb_655125`, `tmdb_618548`, `tmdb_724460`, `tmdb_1126350`, `tmdb_1094451`, `tmdb_1081789`, `tmdb_1522301`). `tmdb_218097` also has both, and is classified `valid_film`. None of `tmdb_1326142`, `tmdb_238858`, `tmdb_18700`, `tmdb_218097`, `tmdb_9278` is in `ratings_view`. The other 34 Music-only ids were not joined to `ratings_view` individually.

`tmdb_114207` and `tmdb_192657` have current shows, no fingerprint, and are not in the stored queue.

### Empty genre, concert title

`tmdb_1758404` 30 Seconds To Mars - Live In London, 2013, active observation, genre array empty. `needs_review`. Same missing category and genre id as the Music-only set. Proposed disposition: no change.

The other 14 empty-genre admissions are `insufficient_evidence` (no genre, title is not a Live/Concert label). Seven of them have an active observation (`tmdb_143112`, `tmdb_1603299`, `tmdb_183201`, `tmdb_308088`, `tmdb_534891`, `tmdb_714896`, `tmdb_730276`) and seven do not.

### Same-title runtime conflicts (33)

All 33 are `needs_review`. The observation title matches the admission title (ё/е and case aside). A short or long slot can be a bad EPG duration on a real film, a cut, or a different programme that shares the title. That is not enough to confirm a wrong id. `Губка Боб квадратные штаны` is the sharpest of this set and is still not confirmed: durations are `[87,84,240,115,60,270]` against admitted runtime 95, so some airings fit the movie and some do not, and `known_epg_alias` attached the franchise title to `tmdb_400160` Губка Боб в бегах. Proposed disposition for all 33: no change. A later reject, if the owner accepts one, is per observation key and must not retire the admission merely because one duration disagrees.

| film | observation key | duration | admitted runtime | year | source |
| --- | --- | --- | --- | --- | --- |
| `tmdb_400160` | `губка боб квадратные штаны\|` | 270 | 95 | obs null / cat 2020 | `known_epg_alias` |
| `tmdb_53010` | `любовь с риском для жизни\|` | 200 | 87 | null / 2011 | `tmdb_detail` |
| `tmdb_14486` | `новые похождения кота в сапогах\|` | 190 | 83 | null / 1958 | `known_epg_alias` |
| `tmdb_1364113` | `счастливый билетик\|` | 160 | 53 | null / 2024 | `tmdb_detail` |
| `tmdb_808960` | `прямой эфир\|` | 180 | 75 | null / 2023 | `tmdb_detail` |
| `tmdb_19995` | `аватар\|2009` | 60 | 162 | 2009 / 2009 | null |
| `tmdb_653851` | `двойная петля\|` | 230 | 138 | null / 2022 | `tmdb_detail` |
| `tmdb_59722` | `замерзший мир\|2011` | 180 | 91 | 2011 / 2011 | `tmdb_detail` |
| `tmdb_49106` | `а зори здесь тихие\|` | 94 | 180 | null / 1972 | `tmdb_detail` |
| `tmdb_2898` | `лучше не бывает\|` | 55 | 139 | null / 1997 | `tmdb_detail` |
| `tmdb_72201` | `двенадцать месяцев\|` | 55 | 135 | null / 1973 | `tmdb_detail` |
| `tmdb_63532` | `проданный смех\|1981` | 60 | 140 | 1981 / 1981 | `known_epg_alias` |
| `tmdb_416051` | `основано на реальных событиях\|` | 175 | 96 | null / 2017 | `tmdb_detail` |
| `tmdb_586387` | `август\|2025` | 60 | 138 | 2025 / 2025 | null |
| `tmdb_111` | `лицо со шрамом\|` | 93 | 170 | null / 1983 | `known_epg_alias` |
| `tmdb_325821` | `зеленый фургон\|` | 159 | 88 | null / 1959 | `tmdb_detail` |
| `tmdb_429197` | `власть\|2018` | 62 | 132 | 2018 / 2018 | `tmdb_detail` |
| `tmdb_53129` | `турецкий гамбит\|` | 200 | 130 | null / 2005 | `known_epg_alias` |
| `tmdb_2103` | `солярис\|` | 167 | 99 | null / 2002 | `known_epg_alias` |
| `tmdb_206867` | `необыкновенные приключения карика и вали\|1987` | 63 | 128 | 1987 / 1987 | `tmdb_detail` |
| `tmdb_501395` | `подлинная история банды келли\|2020` | 60 | 124 | 2020 / 2019 | null |
| `tmdb_21575` | `пророк\|` | 85 | 149 | null / 2009 | `known_epg_alias` |
| `tmdb_27939` | `дом который построил свифт\|` | 77 | 138 | null / 1985 | `tmdb_detail` |
| `tmdb_257211` | `стажер\|2015` | 60 | 121 | 2015 / 2015 | null |
| `tmdb_859` | `опасные связи\|` | 60 | 119 | null / 1988 | `known_epg_alias` |
| `tmdb_6950` | `эпидемия\|` | 69 | 128 | null / 1995 | `known_epg_alias` |
| `tmdb_677179` | `крид 3\|2023` | 60 | 116 | 2023 / 2023 | `tmdb_detail` |
| `tmdb_75656` | `иллюзия обмана\|2013` | 60 | 115 | 2013 / 2013 | `tmdb_detail` |
| `tmdb_976720` | `эра выживания\|2022` | 60 | 114 | 2022 / 2022 | `tmdb_detail` |
| `tmdb_745` | `шестое чувство\|` | 55 | 107 | null / 1999 | `tmdb_detail` |
| `tmdb_11652` | `преодоление\|` | 55 | 105 | null / 2006 | `known_epg_alias` |
| `tmdb_512412` | `точка возврата\|` | 135 | 87 | null / 2018 | `known_epg_alias` |
| `tmdb_556694` | `три тысячи лет желаний\|2022` | 60 | 108 | 2022 / 2022 | `tmdb_detail` |

`tmdb_2103` (Солярис, 2002, 99 min) is in `ratings_view`. The 167-minute slot is a poor fit for that runtime and the observation year is null, so a different Solaris film is possible. This audit did not read TMDB and does not name a replacement id. `needs_review`, not confirmed. Do not retire the admission: a ratings-view row exists.

### Alias titles that are not punctuation

`needs_review`, proposed disposition no change. Runtimes are inside the far band, so the title difference might still be an alternate distribution title.

| film | observation | admitted title | duration / runtime | source |
| --- | --- | --- | --- | --- |
| `tmdb_37094` | `крушение\|` Крушение | С меня хватит! (1993) | 130 / 113 | `known_epg_alias` |
| `tmdb_8860` | `метро\|` Метро | Городская полиция (1997) | 135 / 117 | `known_epg_alias` |

Sampled `known_epg_alias` title differences are otherwise punctuation, colon, or a translation pair (English observation title, Russian admission title) with a close runtime. Those were not marked wrong.

### `parse_error` outside the Music-only set

Queue `retries` has six films, all `kind=parse_error`, `scope=item`. Two are the named examples (attempts 3). `tmdb_364933` is in the Music-only table (attempts 1). The other three are `needs_review` only as a failure signal:

| film | title | year | runtime | genres | active observations | attempts |
| --- | --- | --- | --- | --- | --- | --- |
| `tmdb_1319522` | Мой пёс Гохан | 2026 | 145 | драма | 0 | 1 |
| `tmdb_686970` | The Campaign Against the Climate | 2020 | 58 | документальный | 1 | 1 |
| `tmdb_610338` | 14+ Продолжение | 2023 | 133 | мелодрама | 2 | 1 |

None of these three is in `ratings_view`. Proposed disposition: no change.

## Prediction queue

The stored document is `dict1`, 199 515 bytes, five chunks. Counts below are the decoded header, not a sum of index references.

| Field | Value |
| --- | --- |
| `refreshedAt` | `2026-11-15T16:08:37.350Z` (17:08 Europe/Madrid) |
| `trigger` | `batch_complete` |
| `programmeRunId` | the published run above |
| `hotCount` / `hotPredicted` / `priorityCount` / hot pending | 443 / 329 / 114 / 114 |
| `coldCount` / `coldWithoutPrediction` / cold pending | 9 722 / 6 467 / 6 472 |
| pending ids | 119 |
| distinct ids in `$queueIds` | 6 586 |

Fifteen Music-only films are hot pending, including the valid theatrical `tmdb_18700` and the two named examples at indexes 0 and 1. Ten Music-only films are cold pending. Hot-queue membership is not itself a false-film verdict.

## What `discovery_identity_correct` can cover

Read from `main` `97f5dc5f`, not executed.

`discovery_identity_correct@1` (`ownerDecision` in `src/discovery-authority.js`) writes **one** observation under the resolver lease. A reject stores that TMDB id on `rejectedTmdbIds` (the chunk later carries at most eight) and moves a verified decision to `needs_verification` when that id was the current one. The same commit deletes current-generation `published_epg_show` rows with `basis='discovery'` and `match_reason` equal to that observation key. It does not update `discovery_admission`, `prediction_queue`, `prediction_fingerprint`, or `prediction_pointer`.

The next ordinary chunk treats `ownerRejected` as `no_confident_match` / `owner_rejected` and does not fetch that movie card (`src/discovery.js`). It does not delete an admission that is already in the catalog. `refreshPredictionQueue` rebuilds from the catalog, so a rejected observation leaves the film on the queue while the admission remains. There is no bulk entry point: `discovery_intent` is empty and decision history has no `owner` writer.

Because no active observation has `categories`, a later chunk will not record `concert_recording` for these rows (ADR 0149 needs the category and Music). The reject marker is what stops the same id. Re-search can still accept a different id.

So the existing mechanism can record the one confirmed reject and can, if the owner later accepts them, record one reject per review key and drop that key's current discovery shows. It cannot clear the 11 stored concert-shaped predictions or the queue members. That gap is input for AIR-498. This audit does not design a bulk API and does not authorize any of those writes. Rejecting `беглец|1993` must not retire `tmdb_9278`.

## Limits

- Categories were tested with `json_extract(payload_json,'$.categories')` on all 27 593 active observations. A category stored under another key would have been missed. The Robbie observation's keys were listed; `categories` is not among them.
- Genre names are the stored Russian display strings, not TMDB ids.
- Archive rows were not paged except the one `tmdb_9278` archive key returned by the film-id join.
- `ratings_view` overlap is a count. Rating values and watchlist membership of individual films were not copied, except the boolean absence recorded for the ids named above and the boolean presence of `tmdb_2103`.
- Queue retry `validation` objects were not copied.
- The 6 499 `valid_film` rows are the complement of the rules above. They were not each opened by title.
