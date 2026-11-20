# AIR-503: legacy alias recall gap and the owner-review table

**Captured:** 20 November 2026 (UTC), read-only `SELECT` against production D1 `iptv` (`rows_written` 0, 426 rows read). No Worker GET, no TMDB call, no R2 read, no EPG, Discovery, prediction or ratings run, no flag change.
**Used by:** [AIR-503](https://trello.com/c/t9fZCHLQ). Follows [the alias provenance impact record](air-503-alias-provenance-impact-2026-11-17.md) and the owner's natural-run verification of 20 November 2026 (EPG generations 512 to 515), which this record does not repeat. [ADR 0158](../../adr/0158-epg-title-alias-provenance.md).
**Verdict:** the guard against false identities works; the recovery of correct legacy aliases has not started. Of the 222 pinned decisions, 51 have an active observation in the latest run; none of the 51 has an `anchor` or `failedDurations` (no revalidation outcome was ever recorded) and one has `movieTitles`. The 51 are a mixture that no single rule separates, so the owner decided on 20 November 2026: **reserve revalidation calls (this PR), then owner-review for what TMDB does not list (next PR)**.

## What was read

The 222 `(observation key, film)` pairs of the impact record, joined to the active observation (`source_key='active'`, `residence='active'`, `seen_in_latest=1`), the verified decision and the current admission:

```sql
SELECT o.observation_key, json_extract(o.payload_json,'$.durations'), json_extract(o.payload_json,'$.airings'),
       json_array_length(json_extract(o.payload_json,'$.confirmedSlots')),
       a.film_id, json_extract(a.payload_json,'$.title'), json_extract(a.payload_json,'$.original'),
       json_extract(a.payload_json,'$.runtime'), json_extract(a.payload_json,'$.year'), json_extract(a.payload_json,'$.movieTitles'),
       json_extract(d.payload_json,'$.identitySource'), json_extract(d.payload_json,'$.failedDurations'), json_extract(d.payload_json,'$.anchor')
FROM discovery_observation o
JOIN discovery_decision d ON d.observation_key=o.observation_key AND d.status='verified'
JOIN discovery_admission a ON a.film_id=d.film_id AND a.state='current'
WHERE o.source_key='active' AND o.residence='active' AND o.seen_in_latest=1
  AND o.observation_key IN (<the 222 keys of the impact record>)
ORDER BY o.observation_key;
```

The `source_key` filter uses the primary key, so the query is cheap. Result: 51 rows, every decision `known_epg_alias`, `anchor` and `failedDurations` null on all 51, `confirmedSlots` non-empty on one (`и целого мира мало|`, whose Film has `movieTitles`).

## What this shows and does not show

- No revalidation outcome was recorded for any of the 51. This means the revalidation did not reach them, or did not finish. The cause is not proven. It is consistent with the call budget: the revalidation runs after the candidates that have no decision and shares the chunk's 16 TMDB calls with them, and the natural runs had thousands of such candidates. The owner's read of the pipeline on 20 November 2026 recorded about 6 500 observations still being processed.
- It does not show that TMDB lacks the titles. Nobody has asked TMDB for these Films yet. For a title that TMDB lists (a translation or an alternative title) the existing gate will accept it and record `movieTitles`; for a title that TMDB does not list (`шрэк`, `пила 10`) it will refuse with `detail_title_mismatch` whatever the reserve is.
- 187 airings do not mean 186 lost correct shows: the group contains wrong identities too.

## Preliminary reading of the 51 (the executor's, not a verdict)

| Reading | Keys | Meaning |
| --- | --- | --- |
| variant of the Film's own title | 31 | spelling (`шрэк`, `дежа вю`), a numeral (`пила 10`), a dropped prefix (`007:`, `Эпизод 7 -`, `3D`) or subtitle |
| alternative title | 11 | a different Russian or short title of the same release; nothing in the stored titles shows it |
| looks wrong | 8 | the owner's confirmed cases (`губка боб квадратные штаны`, `крушение`, `метро`) and five more (`искатели`, `о чем еще говорят мужчины` twice, `саботаж`, `стукач`) |
| recovered | 1 | `и целого мира мало` |

Why no deterministic rule: the same operation gives right and wrong answers. Dropping a word or a number recovers `История игрушек: Большой побег`, and inserting one gives `О чём ещё говорят мужчины`, which is the 2011 sequel and another film. A transliteration of `Metro` would accept the wrong film `метро`. `Саботаж` and `Стукач` look like their Films' titles and are the titles of other films. A rule that accepts spelling and numeral folding recovers part of the 31 but cannot tell the eight apart, so the decision stays with the owner for what TMDB does not list.

## What the owner decided and what this PR does

Owner decision, 20 November 2026: reserve a bounded part of each chunk's TMDB calls for revalidating legacy `known_epg_alias` decisions without title provenance (this PR, no ADR change: it carries out the ADR 0158 recovery as designed), and put what TMDB does not list through owner review (next PR, after the owner has decided each row of the table below). Provenance still comes only from the movie-detail gate. No TMDB call per slot, no trust in an EPG title, no production write by hand.

## Owner-review table (51 rows)

Columns: the observation key and Film; the Film's title and original; its runtime and year; the stored slot durations; the airings of the key; the executor's preliminary reading and note; the owner's decision (empty: approve the title as the Film's, or reject). A rejected row stays an ordinary observation; nothing is deleted. No row is acted on until the owner has filled it in.

| observation key | film | title / original | runtime / year | durations | airings | reading | note | owner decision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `matchbox\|` | `tmdb_1148365` | Matchbox: фильм / Matchbox the Movie | 126 / 2026 | [126] | 1 | variant of the Film's own title | short form of the Film's title | |
| `the covenant\|2023` | `tmdb_882569` | Переводчик / Guy Ritchie's The Covenant | 123 / 2023 | [123] | 1 | variant of the Film's own title | English title without the director's prefix | |
| `tyler perry s joe s college road trip\|` | `tmdb_1243460` | Джо едет выбирать колледж / Joe's College Road Trip | 109 / 2026 | [105] | 2 | variant of the Film's own title | original title with the franchise prefix | |
| `американская история х\|1998` | `tmdb_73` | Американская история X / American History X | 119 / 1998 | [119] | 2 | variant of the Film's own title | Cyrillic х for the Latin X | |
| `беги\|` | `tmdb_546121` | Взаперти / Run | 90 / 2020 | [84, 95] | 3 | alternative title | Russian rendering of the original title; not in the stored titles | |
| `вавилон н э\|` | `tmdb_9381` | Вавилон нашей эры / Babylon A.D. | 90 / 2008 | [90, 97, 100, 105] | 3 | variant of the Film's own title | abbreviation of «нашей эры» | |
| `вершина\|` | `tmdb_1318447` | На вершине / Apex | 96 / 2026 | [91, 95, 96] | 3 | alternative title | one generic word | |
| `вид на убийство\|` | `tmdb_707` | 007: Вид на убийство / A View to a Kill | 131 / 1985 | [126] | 1 | variant of the Film's own title | title without the «007:» prefix | |
| `голда\|` | `tmdb_899524` | Голда. Судный день / Golda | 101 / 2023 | [100] | 2 | variant of the Film's own title | title without the subtitle | |
| `губка боб квадратные штаны\|` | `tmdb_400160` | Губка Боб в бегах / The SpongeBob Movie: Sponge on the Run | 95 / 2020 | [87, 84, 240, 115, 60, 270] | 9 | looks wrong | series title; marathons of 240 and 270 minutes; the owner decision of 17 Nov 2026 | |
| `двадцать восемь панфиловцев\|` | `tmdb_427342` | 28 панфиловцев / 28 панфиловцев | 120 / 2016 | [125, 130, 155] | 3 | variant of the Film's own title | numeral spelled out | |
| `девичник в спа\|` | `tmdb_1341138` | Спа-уикенд / Spa Weekend | 97 / 2026 | [97] | 1 | alternative title | a different Russian title | |
| `девушка из каюты no10\|` | `tmdb_1290879` | Девушка из каюты № 10 / The Woman in Cabin 10 | 92 / 2025 | [95, 91] | 4 | variant of the Film's own title | № written as «no» | |
| `дежа вю\|` | `tmdb_7551` | Дежавю / Déjà Vu | 126 / 2006 | [104, 105, 110, 125, 115, 120] | 8 | variant of the Film's own title | spelling of «Дежавю» | |
| `дежа вю\|2006` | `tmdb_7551` | Дежавю / Déjà Vu | 126 / 2006 | [126] | 2 | variant of the Film's own title | spelling of «Дежавю» | |
| `джо едет в колледж\|` | `tmdb_1243460` | Джо едет выбирать колледж / Joe's College Road Trip | 109 / 2026 | [111] | 6 | alternative title | shortened Russian title | |
| `живешь только дважды\|` | `tmdb_667` | 007: Живёшь только дважды / You Only Live Twice | 117 / 1967 | [112] | 1 | variant of the Film's own title | title without the «007:» prefix and with е for ё | |
| `заложница 3 2014\|` | `tmdb_260346` | Заложница 3 / Taken 3 | 109 / 2014 | [114] | 2 | variant of the Film's own title | the year is part of the written title | |
| `звездные войны пробуждение силы\|` | `tmdb_140607` | Звёздные войны: Эпизод 7 - Пробуждение силы / Star Wars: The Force Awakens | 135 / 2015 | [132, 138] | 5 | variant of the Film's own title | title without «Эпизод 7 -» | |
| `золотой глаз\|` | `tmdb_710` | 007: Золотой глаз / GoldenEye | 130 / 1995 | [125] | 1 | variant of the Film's own title | title without the «007:» prefix | |
| `и целого мира мало\|` | `tmdb_36643` | 007: И целого мира мало / The World Is Not Enough | 128 / 1999 | [123] | 1 | recovered | movieTitles already stored; one confirmed slot | |
| `искатели\|` | `tmdb_762955` | Грозный папа / Грозный папа | 95 / 2022 | [104, 118, 102, 114, 103, 96] | 4 | looks wrong | the title has no relation to the Film's titles | |
| `испытания на фронтире\|` | `tmdb_1379413` | Кровь на границе / Frontier Crucible | 124 / 2025 | [119] | 1 | alternative title | a different Russian title | |
| `история игрушек большой побег\|` | `tmdb_10193` | История игрушек 3: Большой побег / Toy Story 3 | 103 / 2010 | [103, 99] | 6 | variant of the Film's own title | title without the «3» | |
| `казино рояль\|` | `tmdb_36557` | 007: Казино Рояль / Casino Royale | 139 / 2006 | [126, 139] | 2 | variant of the Film's own title | title without the «007:» prefix | |
| `казино рояль\|2006` | `tmdb_36557` | 007: Казино Рояль / Casino Royale | 139 / 2006 | [145, 144, 140] | 2 | variant of the Film's own title | title without the «007:» prefix | |
| `квант милосердия\|2008` | `tmdb_10764` | 007: Квант милосердия / Quantum of Solace | 106 / 2008 | [106, 102] | 2 | variant of the Film's own title | title without the «007:» prefix | |
| `крушение\|` | `tmdb_37094` | С меня хватит! / Falling Down | 113 / 1993 | [107, 110, 103, 115, 108, 125, 130, 100] | 13 | looks wrong | another film (plot of Plane, 2023), per the owner's verification of 20 Nov 2026 | |
| `лего шазам магия и монстры\|` | `tmdb_690369` | ЛЕГО Супергерои DC: Шазам! Магия и чудовища / LEGO DC: Shazam! Magic and Monsters | 81 / 2020 | [81] | 5 | variant of the Film's own title | title without the franchise prefix, «монстры» for «чудовища» | |
| `леди баг и супер кот\|` | `tmdb_496450` | Леди Баг и Супер-Кот: Пробуждение силы / Miraculous - le film | 105 / 2023 | [102] | 2 | variant of the Film's own title | title without the subtitle, hyphen dropped | |
| `метро\|` | `tmdb_8860` | Городская полиция / Metro | 117 / 1997 | [131, 132, 126, 60, 135] | 9 | looks wrong | another film (Moscow disaster film), per the owner's verification of 20 Nov 2026 | |
| `мой кровавый валентин\|` | `tmdb_14435` | Мой кровавый Валентин 3D / My Bloody Valentine | 101 / 2009 | [101, 102, 81] | 4 | variant of the Film's own title | title without «3D» | |
| `мой кровавый валентин\|2009` | `tmdb_14435` | Мой кровавый Валентин 3D / My Bloody Valentine | 101 / 2009 | [101] | 1 | variant of the Film's own title | title without «3D» | |
| `не грози южному централу\|1995` | `tmdb_10607` | Не грози южному централу, попивая сок у себя в квартале / Don't Be a Menace to South Central While Drinking Your Juice in the Hood | 89 / 1996 | [89, 90] | 1 | variant of the Film's own title | title without the subtitle; year 1995 against 1996 | |
| `о чем еще говорят мужчины 2011\|` | `tmdb_35428` | О чём говорят мужчины / О чём говорят мужчины | 93 / 2010 | [98] | 1 | looks wrong | «О чём ещё говорят мужчины» is the 2011 sequel, a different film from the 2010 one | |
| `о чем еще говорят мужчины\|` | `tmdb_35428` | О чём говорят мужчины / О чём говорят мужчины | 93 / 2010 | [100, 95, 90, 94, 110, 105, 80] | 4 | looks wrong | the same sequel title as above | |
| `острые козырьки бессмертный человек\|` | `tmdb_875828` | Острые козырьки: бессмертный / Peaky Blinders: The Immortal Man | 112 / 2026 | [114, 107] | 6 | variant of the Film's own title | «бессмертный человек» for «бессмертный» | |
| `пила 10\|` | `tmdb_951491` | Пила X / Saw X | 118 / 2023 | [114, 120, 110, 105] | 3 | variant of the Film's own title | X written as 10 | |
| `пила 10\|2023` | `tmdb_951491` | Пила X / Saw X | 118 / 2023 | [118, 119] | 5 | variant of the Film's own title | X written as 10 | |
| `побег из плена\|2025` | `tmdb_1328803` | Военнопленный / Prisoner of War | 113 / 2025 | [113] | 2 | alternative title | a different Russian title | |
| `поезд идет на восток\|` | `tmdb_1341796` | Тайна Чёрной руки / Тайна Чёрной руки | 80 / 2024 | [87, 80, 115] | 4 | alternative title | no visible relation to the stored titles; needs evidence | |
| `поймай собаку если сможешь\|2024` | `tmdb_1384198` | УничтоЖанна / УничтоЖанна | 98 / 2024 | [92] | 1 | alternative title | no visible relation to the stored titles; needs evidence | |
| `проект аве мария\|` | `tmdb_687163` | Проект «Конец света» / Project Hail Mary | 156 / 2026 | [156] | 2 | alternative title | a different Russian title | |
| `саботаж\|` | `tmdb_31997` | Диверсант / Saboteur | 109 / 1942 | [105, 104, 108, 95, 100, 110] | 9 | looks wrong | «Саботаж» is the Russian title of Sabotage (2014), not of Saboteur (1942) | |
| `самый быстрый индиан\|` | `tmdb_9912` | Самый быстрый Indian / The World's Fastest Indian | 127 / 2005 | [120, 115, 127, 125, 121] | 4 | variant of the Film's own title | transliteration of «Indian» | |
| `сначала дамы\|2026` | `tmdb_1368881` | Дамы вперед / Ladies First | 94 / 2026 | [93, 87] | 8 | alternative title | a different Russian title | |
| `стукач\|` | `tmdb_65760` | Стукачка / The Whistleblower | 112 / 2010 | [95, 94, 115, 111, 120, 123, 105, 110, 100] | 6 | looks wrong | «Стукач» against «Стукачка»; the stored durations scatter | |
| `трансформеры месть падших\|` | `tmdb_8373` | Трансформеры 2: Месть Падших / Transformers: Revenge of the Fallen | 147 / 2009 | [148, 144] | 3 | variant of the Film's own title | title without the «2:» | |
| `удача\|` | `tmdb_1114967` | Везунчики / Good Fortune | 97 / 2025 | [105] | 8 | alternative title | a different Russian title | |
| `шрэк 2\|` | `tmdb_809` | Шрек 2 / Shrek 2 | 93 / 2004 | [92, 89] | 4 | variant of the Film's own title | э for е | |
| `шрэк\|` | `tmdb_808` | Шрек / Shrek | 90 / 2001 | [90, 86] | 4 | variant of the Film's own title | э for е | |

## Limits

The reading is one person's, from stored fields only; TMDB, XMLTV and R2 were not read. The 51 are the active observations of the latest run; the other 171 pairs have no active observation and are not in the table. Durations are the stored distinct values (at most twelve), not every airing.
