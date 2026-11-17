# AIR-503: impact of alias provenance on the existing `known_epg_alias` decisions

**Captured:** 17 November 2026 (UTC), read-only `SELECT` against production D1 `iptv` (`database_id` `3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb`). `rows_written` was 0 on every query. No Worker GET, no TMDB call, no R2 read, no EPG, Discovery, prediction or ratings run, no flag change.
**Used by:** [AIR-503](https://trello.com/c/t9fZCHLQ), second delivery; [ADR 0158](../../adr/0158-epg-title-alias-provenance.md). Follows [the RCA of the 33 conflicts](air-503-same-title-runtime-conflicts-rca-2026-11-17.md).
**Pinned state:** `published_epg_authority` `d1` / `open`, published run `47663279-3e6b-423d-b696-b22edfcead91` (EPG generation 511). The only total of published shows used for scale is the 16 864 that AIR-500 counted in generation 510 on 16 November; generation 511 was not recounted.
**Verdict:** the stored aliases carry no provenance, so the origin of the `tmdb_400160` series-title alias stays unproven. The new rule affects 222 of 3 790 current `known_epg_alias` decisions. Those 222 own 99 current shows (58 keys, 56 Films). Nothing stored is rewritten.

## The existing `tmdb_400160` alias

`discovery_admission.payload_json` of `tmdb_400160` (`Губка Боб в бегах`, 2020, 95 minutes) holds, in order: `Губка Боб в бегах`, `The SpongeBob Movie: Sponge on the Run`, `Губка Боб: Втеча Губки`, `The Spongebob Movie: It's a Wonderful Sponge`, `Губка Боб 3`, `The SpongeBob Movie - Sponge on the Run`, `Spongebob Movie 3`, `Гу́бка Боб в бега́х`, `Губка Боб - Квадратные Штаны`, `Губка Боб в бегах (2020)`, `Губка Боб в бегах (2020).`, `Губка Боб — квадратные штаны`, `Губка Боб квадратные штаны`. The canonical `film_alias` table holds one row for `film:tmdb:400160` (`The SpongeBob Movie: Sponge on the Run`, provenance `letterboxd`), so the series title is only in the catalog payload.

What the data shows and what it does not:

- The normalized key `губка боб квадратные штаны` was already present as the spelling `Губка Боб - Квадратные Штаны` before the last two spellings were appended. The last two spellings, in that order, equal the raw titles of the active observation `губка боб квадратные штаны|` (`["Губка Боб — квадратные штаны","Губка Боб квадратные штаны"]`). This is consistent with `touchCanonicalFilm` adding cosmetic spellings of a key the Film already had. It does **not** show where the key itself came from, because the strings carry no provenance. This record does not claim that the key was learned from the EPG, or that TMDB supplied it.
- The decision of that key was written once, by `resolver_chunk` on 2026-11-08T19:18:09Z, with `identitySource` `known_epg_alias`. Its current observation has `confirmed_tmdb_id` null and one stored `confirmedSlots` entry (`ch2341`, `start` 1794756813000, the 87 minute slot), which is the only current show under the key.
- Neighbouring keys in `discovery_decision` (no row has `media_kind` `tv`; the site has no series): `губка боб квадратные штаны фильм|2004` and `губка боб квадратные штаны|2004` are `no_confident_match`, `губка боб квадратные штаны сезон 7 серия 14|` is `excluded_nonfilm`, `губка боб|` is `no_confident_match`, `губка боб в бегах|2020` is `verified` by `tmdb_detail`. The catalog holds three other SpongeBob feature films (`tmdb_228165`, `tmdb_281649`, `tmdb_991494`) beside `tmdb_400160`.

## Other aliases that equal a raw EPG title

For the current `known_epg_alias` decisions with an active observation, aliases of the admission payload that are equal (case-sensitively, because SQLite `lower()` does not fold Cyrillic) to a raw title of that observation and differ from the Film's title and original were listed. The first 80 rows by film id are overwhelmingly cosmetic spellings that normalize to the Film's own key (`х/ф …`, a trailing dot, a year, a dash for a colon) and a few alternative Russian titles of the same film (`Удача` for `Везунчики`, `Батарейки в комплект не входят` for `Батарейки не прилагаются`). This is a diagnostic, not a verdict: it does not prove that any of them is wrong and it does not prove where any of them came from.

## Impact on the existing decisions

Method. All 3 790 current `known_epg_alias` decisions were read with their admission's `title` and `original` (query 1). Each observation key was normalized with the `norm` of `src/sources.js` (NFKC, lower case, `ё` as `е`, punctuation as a space) and compared with the normalized title and original of the Film. Neither `movieTitles` exists in any stored record yet, so these two are the only titles that count under ADR 0158 decision 4.

| Count | Value |
| --- | --- |
| Current decisions with `identitySource` `known_epg_alias` joined to a current admission | 3 790 |
| Key equals the Film's normalized title or original (confirmation unchanged) | 3 568 |
| Key is another alias (translation, synonym, Ukrainian title, series title) | **222** |
| Keys of those 222 with a show in generation 511 (`published_epg_show.match_reason` = key and the Film's id) | **58** |
| Current shows of those 58 keys | **99** |
| Films behind those shows | 56 |

The 99 shows are about 0.6% of the 16 864 that AIR-500 counted in generation 510. The 222 also include `губка боб квадратные штаны|` (`tmdb_400160`), `крушение|` (`tmdb_37094`) and `метро|` (`tmdb_8860`), the two alias titles AIR-500 left as `needs_review`.

What changes for them. A stored decision is not rewritten. A slot under such a key is no longer confirmed by the scan, and a `known_epg_alias` decision has no anchor, so the slot is withheld. A decision already has a verdict, so its observation does not re-enter the resolver as a candidate; only the bounded revalidation of [ADR 0142](../../adr/0142-epg-owned-generation-addressed-discovery-slots.md) decision 6 reads it again (`catalogFilmFromDetail` is not on that path). The revalidation therefore records the movie's titles itself: after a drifted duration is reconfirmed alone by the movie-detail gate, one fenced `upsertAdmissions` stores `movieTitles`, before the decision that makes the duration an anchor. See the next section for what that can and cannot recover.

## What the 222 can and cannot recover

Verified by `tests/discovery-revalidation.mjs` scenarios J to M (a sqlite stand-in D1, a recording TMDB stub and a controllable clock; no production call).

| Case | Result |
| --- | --- |
| The observed title is listed by TMDB for the stored movie (a `uk` translation, a `US` alternative title), and the drifted duration is accepted alone by the scorer and the gate | The duration joins the anchor, the decision becomes `tmdb_detail`, and the Film record gains `movieTitles` (TMDB's `ru`/`uk`/`en` translations and `RU`/`UA`/`US`/`GB` alternative titles) and the same titles in `aliases`. A later chunk writes nothing more. Slots under any of those titles are then scan-confirmed. |
| The observed title is only a stored alias that TMDB does not list | The gate refuses with `detail_title_mismatch`. The duration goes to `failedDurations`; no anchor, no provenance, no row. The decision stays `verified`; the Film and its aliases are not rewritten. |
| Another duration of a recovered key | Covered by the anchor only within its tolerance, `min(10, max(5, 5%))` minutes; otherwise it needs its own revalidation, up to twelve failed durations. |
| The provenance write is skipped (the Film is not in `written`) or the chunk's time does not fit the provenance, decision and slot-assignment writes | Nothing durable changes: no anchor, no failed duration, no provenance. The observation is counted as deferred, the drift persists, and the next chunk evaluates the duration again and stores both (scenarios L and M). The provenance is written before the decision precisely so that an anchor never exists without it. |
| A watchlist Film | Unchanged: it keeps every alias and the revalidation writes no provenance. |

Costs and limits. Revalidation runs after the candidates without a decision and shares the chunk's 16 TMDB calls with them; each reconfirmed Film costs one more fenced admission write; when the chunk's time does not fit it, the whole observation waits for the next chunk. Nothing recovers by itself in one chunk for all 222: a key whose title TMDB does not list never recovers, and for the series title of `tmdb_400160` the outcome depends on whether TMDB lists it, which this record did not read.

## Reproduction

Query 1 (3 790 rows, a few hundred kilobytes; export it and normalize outside SQL):

```sql
SELECT d.observation_key AS ok, a.film_id AS f,
       json_extract(a.payload_json,'$.title') AS t, json_extract(a.payload_json,'$.original') AS o
FROM discovery_decision d
JOIN discovery_admission a ON a.film_id=d.film_id AND a.state='current'
WHERE d.status='verified' AND json_extract(d.payload_json,'$.identitySource')='known_epg_alias';
```

Query 2, with the 222 `(key, film)` pairs below in `k` (the result is 58 keys, 99 shows, 56 Films on 17 November):

```sql
WITH k(key,film) AS (VALUES ('<observation key>','<tmdb_id>'), …)
SELECT count(DISTINCT k.key) AS keys_with_current_shows, count(*) AS current_shows, count(DISTINCT k.film) AS films
FROM published_epg_show s JOIN k ON s.film_id=k.film AND s.match_reason=k.key
WHERE s.programme_run_id='47663279-3e6b-423d-b696-b22edfcead91';
```

The 222 pairs (`observation key`, tab, `film_id`):

```text
matchbox|2026	tmdb_1148365
the covenant|2023	tmdb_882569
the island|	tmdb_3764
tyler perry s joe s college road trip|	tmdb_1243460
барва з позамежжя світу|	tmdb_548473
бетонная утопия|	tmdb_729854
будь якою ціною|	tmdb_338766
васабі|	tmdb_2110
великий|	tmdb_2280
вершина|	tmdb_1318447
виживуть тільки коханці|	tmdb_152603
володарі ночі|	tmdb_2001
війна з дідусем|	tmdb_425001
голда|	tmdb_899524
девичник в спа|	tmdb_1341138
девушка из каюты no10|	tmdb_1290879
девушка из каюты no10|2025	tmdb_1290879
дежа вю|2006	tmdb_7551
джанґо|	tmdb_10772
джеймс бонд 007 казино рояль|2006	tmdb_36557
джеймс бонд 007 квант милосердия|2008	tmdb_10764
джеймс бонд 007 координаты скайфолл|2012	tmdb_37724
джеймс бонд 007 не время умирать|2021	tmdb_370172
джо едет в колледж|	tmdb_1243460
дневники принцессы|2001	tmdb_9880
добро пожаловать в зомбилэнд|	tmdb_19908
дом динамита|	tmdb_1290159
дом динамита|2025	tmdb_1290159
дом у дороги|1989	tmdb_10135
дьявол носит прада|	tmdb_350
дівчина у потягу|	tmdb_346685
ешь молись рычи|	tmdb_1635276
ешь молись рычи|2026	tmdb_1635276
жага смерті|	tmdb_395990
женщина король|	tmdb_724495
женщина король|2022	tmdb_724495
живешь только дважды|	tmdb_667
засуха|2021	tmdb_567797
захват|	tmdb_572751
звездные войны эпизод v империя наносит ответный удар|	tmdb_1891
золотой глаз|	tmdb_710
искатели|	tmdb_762955
казино рояль|	tmdb_36557
казино рояль|2006	tmdb_36557
капоне|	tmdb_429422
квант милосердия|	tmdb_10764
квант милосердия|2008	tmdb_10764
код залізна кора|	tmdb_522241
коммандо|	tmdb_10999
контрудар|	tmdb_1356039
кривизна|2017	tmdb_475961
крушение|	tmdb_37094
кухарка|	tmdb_143073
леди баг и супер кот|	tmdb_496450
людина амфібія|	tmdb_43685
людина на ім я уве|	tmdb_348678
майор пейн|	tmdb_11008
меланхолія|	tmdb_62215
метро|	tmdb_8860
мечник|2020	tmdb_492008
на землі святих і грішних|	tmdb_1027073
на яскравому сонці|	tmdb_10363
не грози южному централу|1995	tmdb_10607
не може бути|	tmdb_42275
небезпечна правда|	tmdb_9989
невидимий гість|	tmdb_411088
непіддатливі|	tmdb_159999
ножі наголо|	tmdb_546554
о чем еще говорят мужчины 2011|	tmdb_35428
о чем еще говорят мужчины|	tmdb_35428
о чем еще говорят мужчины|2011	tmdb_35428
одержимый местью|	tmdb_1382406
одруження бальзамінова|	tmdb_76277
оксамитові ручки|	tmdb_63274
перевізник 2|	tmdb_9335
перевізник|	tmdb_4108
пипець|	tmdb_23483
побег из плена|	tmdb_1328803
побег из плена|2025	tmdb_1328803
повернення високого блондина|	tmdb_10939
поезд идет на восток|	tmdb_1341796
полицейский из беверли хиллз 4|	tmdb_280180
помни|2000	tmdb_77
попелюшка|	tmdb_42651
прибульці 3 взяття бастилії|	tmdb_248705
прибульці|	tmdb_11687
проект аве мария|	tmdb_687163
прости хочу на тебе жениться|	tmdb_34494
під гіпнозом|	tmdb_536437
під замком|	tmdb_1083968
розлучення по італійськи|	tmdb_20271
саботаж|	tmdb_31997
светлячок|	tmdb_1320380
свободный штат джонса|	tmdb_316152
свободный штат джонса|2016	tmdb_316152
серцеїд|	tmdb_41211
сканеры|	tmdb_9538
сначала дамы|	tmdb_1368881
сначала дамы|2026	tmdb_1368881
сутінки сага світанок частина 2|	tmdb_50620
сіністер 2|	tmdb_283445
только через твой труп|	tmdb_1390300
три дні на вбивство|	tmdb_192102
у чужій шкурі|	tmdb_1007757
удача|	tmdb_1114967
формула любви 1984|	tmdb_27940
хлопчик у смугастій піжамі|	tmdb_14574
ціна пристрасті|	tmdb_63493
чудова сімка|	tmdb_333484
шпигунська гра|	tmdb_467952
шульга|	tmdb_307081
я вижу тебя|	tmdb_1383154
ілюзія обману 3|	tmdb_425274
ірландець|	tmdb_67913
всадник шторма легенда о молоте|	tmdb_874860
життя і мета собаки|2017	tmdb_381289
затемнення|1962	tmdb_21135
зоряна брама|1994	tmdb_2164
леви для ягнят|2007	tmdb_4515
перевізник 3|2008	tmdb_13387
помни|	tmdb_77
экипаж 2016|	tmdb_380111
дежа вю|	tmdb_7551
заложница 3 2014|	tmdb_260346
пила 10|	tmdb_951491
пила 10|2023	tmdb_951491
таро|	tmdb_719221
8 подруг оушена|2018	tmdb_402900
el camino во все тяжкие|	tmdb_559969
беспредел в средней школе|1996	tmdb_9308
брудні танці|1987	tmdb_88
біжи лоло біжи|1998	tmdb_104
вид на убийство|	tmdb_707
вспомнить заново|2017	tmdb_395814
відчайдушні шахраї|1988	tmdb_10141
гнів беккі|2023	tmdb_986070
гра кілера|2024	tmdb_507241
губка боб квадратные штаны|	tmdb_400160
двенадцать обезьян|	tmdb_63
дедпул|2016	tmdb_293660
екзотичне весілля|2018	tmdb_489929
збройний барон|2005	tmdb_1830
зло|	tmdb_2246
и целого мира мало|	tmdb_36643
история игрушек большой побег|	tmdb_10193
карнавальна ніч|1956	tmdb_63258
космос між нами|2017	tmdb_365942
крильце чи ніжка|1976	tmdb_761
кримінальне чтиво|1994	tmdb_680
лего шазам магия и монстры|	tmdb_690369
мой кровавый валентин|	tmdb_14435
міміно|1977	tmdb_27861
острые козырьки бессмертный человек|	tmdb_875828
падіння янгола|2019	tmdb_423204
поліцейська історія 2|1988	tmdb_10753
пустоши|	tmdb_933131
путь во все тяжкие|2019	tmdb_559969
самый быстрый индиан|	tmdb_9912
сканери|1981	tmdb_9538
соперники амзиа кинга|	tmdb_1124142
хантер кіллер|2018	tmdb_399402
шерлок холмс и доктор ватсон смертельная схватка|1980	tmdb_126850
matchbox|	tmdb_1148365
африканець|1983	tmdb_71055
бэмби|1942	tmdb_3170
винни и слонотоп|	tmdb_14885
вулиця гріха|1945	tmdb_17058
дзеркало|1974	tmdb_1396
дочка болотного короля|2023	tmdb_798362
жандарм одружується|1968	tmdb_4729
желание|	tmdb_1022796
живе такий хлопець|1964	tmdb_91282
життя чака|2024	tmdb_842924
как я стал русским 2018|	tmdb_517543
каникулы петрова и васечкина|	tmdb_192305
летять журавлі|1957	tmdb_38360
мала з характером|2020	tmdb_737568
приглашение на убийство|2023	tmdb_989473
просто кров|1984	tmdb_11368
роккі 2|1979	tmdb_1367
стукач|	tmdb_65760
шалено закоханий|1981	tmdb_11441
шрэк 2|	tmdb_809
шрэк|	tmdb_808
щосили|1987	tmdb_1825
библиотекарь|	tmdb_14207
боксер|2025	tmdb_1280440
бэмби|	tmdb_3170
двадцать восемь панфиловцев|	tmdb_427342
затвор|	tmdb_10885
лицензия на убийство|	tmdb_709
мой кровавый валентин|2009	tmdb_14435
монахиня 2|2023	tmdb_968051
поймай собаку если сможешь|	tmdb_1384198
поймай собаку если сможешь|2024	tmdb_1384198
трансформеры месть падших|	tmdb_8373
чемпион|	tmdb_1250117
шерлок холмс и доктор ватсон король шантажа|	tmdb_126846
шерлок холмс и доктор ватсон смертельная схватка|	tmdb_126850
8 подруг оушена|	tmdb_402900
бенкет бабетти|1987	tmdb_11832
вавилон н э|	tmdb_9381
довга хода|2025	tmdb_604079
испытания на фронтире|	tmdb_1379413
крушащая машина|2025	tmdb_760329
звездные войны пробуждение силы|	tmdb_140607
1 1 нова історія|	tmdb_440472
без семьи|2018	tmdb_458302
битва при чосинском водохранилище|2021	tmdb_779029
великий кайф|1986	tmdb_11028
віва марія|1965	tmdb_11799
вікі крістіна барселона|	tmdb_5038
дочь короля|	tmdb_245842
коломбіана|	tmdb_62835
місія нло|	tmdb_916401
quicksand|	tmdb_954388
американская история х|1998	tmdb_73
батарейки в комплект не входят|1987	tmdb_11548
беги|	tmdb_546121
бой с тенью 3d последний раунд|	tmdb_81298
даргемський бик|1988	tmdb_287
з росії з любов ю|1963	tmdb_657
```

## Verification after deploy (read-only, no run is started)

The next natural EPG publication and Discovery chunks apply the rule. Nothing here authorizes a run, a flag, a Scheduled Task or a write.

1. Under `губка боб квадратные штаны|` no show of `tmdb_400160` is added by a later generation, and the stored aliases and decision are unchanged.
2. `uncertain` diagnostics of the scan can carry `alias_without_movie_provenance`; a count of those slots is the size of the effect.
3. Of the 58 keys that have a show now, how many still have one in a later generation, how many of the 222 decisions gained `anchor` or `identitySource` `tmdb_detail`, and how many of their Films gained `movieTitles` in `discovery_admission.payload_json`. Shows that do not return are a finding for the owner, not something this record corrects.

## Limits

The impact is measured on generation 511 only. Titles that the scan confirmed through a watchlist Film are unaffected and are not counted. Which of the 222 aliases the movie authority really lists cannot be read from stored data, so the share of correct translations among them is not known. The revalidation return is an expectation from the code and the stand-in tests, not an observation of production.
