# AIR-86 retry census

Stage 1 only. No TMDB call, no resolver chunk, no flag change. Stage 2 waits for a separate decision on volume.

Snapshot `2026-10-23T17:19:42.476Z`. Published generation `cf3ba3ac-f962-4475-b9cd-3de1b07bd1eb`, phase `published`. The ledger read is `epg/generations/<that id>/discovery-latest.json` (49715 items, same `programmeRunId`). Decisions are the live `epg/discovery-resolution.json` (8797 keys). Variants below are `candidateSearchVariants` from the current code, capped at 4, run locally against that snapshot.

## What `retryAt` is

A future `retryAt` is the normal backoff after an uncertain decision. It is not, by itself, a wrong search. `resolutionActionability` hides the row only when the activity is still `current`, the row is not a non-film, the decision is not terminal, and the stored evidence still matches. A missing `evidenceKey` counts as a match. A changed `evidenceKey` makes the row eligible again even if `retryAt` is still in the future.

`discoveryCounts` does not use that evidence test for `retryBackoff`. On this snapshot the pipeline shape is:

| Counter | Value | What it actually is |
| --- | ---: | --- |
| `retryBackoff` | 36 | Current, not ambiguous, `retryAt` still ahead. Includes 7 rows whose evidence has changed, so the queue can already select them. |
| `ambiguous` | 30 | Every current ambiguous row. Only 7 of all ambiguous decisions have a `retryAt` at all, and only 1 of those is still blocked. |
| `readyNow` | 17029 | Current work with no blocking backoff. Not part of this census. |
| `terminalNoMatch` | 0 | No terminal row is hiding behind `retryAt`. |

## The whole retry population

105 decisions have `retryAt != null`. None are orphans. None are terminal. None are non-films. Every `attempts` value is 1.

| Slice | Count |
| --- | ---: |
| `retryAt` still ahead | 40 |
| `retryAt` already due | 65 |
| Activity `current` | 90 |
| Activity `historical` | 4 |
| Activity `expired` | 11 |
| Evidence matches | 30 |
| Evidence key missing (treated as a match) | 65 |
| Evidence changed | 10 |
| Status `no_confident_match` | 96 |
| Status `ambiguous` | 7 |
| Status `duration_mismatch` | 2 |

**Currently blocked: 30.** Current, evidence still the same or absent, `retryAt` still ahead, not terminal. 29 are `no_confident_match` and 1 is `ambiguous` (`мой друг кот и пушкин|2025`). Those 30 are the rows a normal chunk will not pick.

The other 75 are not a hidden backlog. 65 are already due. 10 have new evidence, so they are eligible despite a future `retryAt`. That is why `retryBackoff` is 36 rather than 29: the counter still includes 7 `no_confident_match` rows whose evidence changed.

## What the current variants would send

On the 30 blocked rows, every title has a year, so none has zero variants. 28 rows are only `year_before` + `year_after` (56 searches). Two rows add a structural variant:

| Key | Extra reasons | Searches |
| --- | --- | ---: |
| `блейд 1\|1998` | `part_suffix`, `spelling_e`, both years | 4 |
| `гол 2\|2008` | `part_suffix`, both years | 3 |

Blocked search total: **63**. The stage 2 cap written on the card is 40 requests for the whole replay, including any alias or detail read. 63 already exceeds that before a single detail read. Alias and detail reads are extra and only happen after a search hit; they are not in the 63.

Across all 105 retry rows, only 10 have a part, spelling, or numeral variant. Queries if each of those 10 is searched under the cap of 4: **31**.

| Key | Kinds | `retryAt` | Blocked |
| --- | --- | --- | --- |
| `блейд 1\|1998` | part, spelling, year | future | yes |
| `гол 2\|2008` | part, year | future | yes |
| `11 друзей оушена\|2001` | numeral, year | future | no, evidence changed |
| `чужой против хищника 1\|2004` | part, year | future | no, evidence changed |
| `12 друзей оушена\|2004` | numeral, year | due | no |
| `код 8 часть 2\|2024` | part, year | due | no |
| `матрица 1\|1999` | part, year | due | no |
| `чебурашка 2\|2025` | part, year | due | no |
| `черный телефон 2\|2025` | part, year | due | no |
| `убежище\|2022` | spelling, year | due | no, ambiguous |

`мортал комбат|1995` and `чудо женщина|2020` are in the blocked 30, but only as year-either-side. The hyphen in the stored Wonder Woman title blocks the spelling swap, and the title no longer contains `1984`. `ирония судьбы или с легким паром|1975` is not blocked: its evidence changed, and its only variants are the two neighbouring years.

## What this census does not cover

Verified rows and the cheap pass never get a `retryAt`, so they are outside this population. `readyNow` is 17029 current rows the resolver has not finished. A replay of the 30 blocked rows does not measure those.

False-id risk, if a later replay runs: a year-either-side query on a generic title can surface a neighbouring film; `блейд 1` can propose the spelling and still fail the exact-title gate; `гол 2` can propose the stem `Гол`. None of that has been fetched. This file does not claim a TMDB result.

## Pause

Stage 2 does not start here. Three sizes are inside the rules already written:

1. **31 requests.** Every part, spelling, and numeral row in the retry population. The 28 blocked year-only rows stay unchecked and stay listed below.
2. **63 requests.** Every currently blocked row, search queries only. Needs the cap raised from 40. Still skips the eight structural rows that are already eligible.
3. **40, the cap as written.** The 10 structural rows (31) plus the first four blocked year-only keys in alphabetical order (8): `apocalyptica w o a|2025`, `dirkschneider and the old gang live in studio|2025`, `maroon 5 live the town|2023`, `mary gu…|2023`. The other 24 blocked year-only keys stay unchecked, starting at `midnight oil armistice day live sydney|2018`.

Alias and detail reads are not included in those three numbers. One 429 stops the replay. No flag, no `/resolve`, no decision edit.

## Register

All 105. `when` is `future` or `due` at the snapshot instant. `evidence` is `same`, `missing`, or `changed`.

| Key | Status | Activity | Evidence | When |
| --- | --- | --- | --- | --- |
| `11 друзей оушена\|2001` | no_confident_match | current | changed | future |
| `12 друзей оушена\|2004` | no_confident_match | current | missing | due |
| `18 david guetta miami ultra music festival\|2023` | no_confident_match | current | changed | future |
| `apocalyptica w o a\|2025` | no_confident_match | current | same | future |
| `clawfinger w o a\|2025` | no_confident_match | current | missing | due |
| `dirkschneider and the old gang live in studio\|2025` | no_confident_match | current | same | future |
| `dirkschneider back to the roots accepted live brno\|2016` | no_confident_match | current | missing | due |
| `ivan дуэты с носковым и анкудиновой гроул по белорусски и волк на евровидении 61\|2023` | no_confident_match | current | missing | due |
| `madonna madame x pop\|2020` | no_confident_match | current | missing | due |
| `maroon 5 live the town\|2023` | no_confident_match | current | same | future |
| `mary gu качала пресс разбила нос пошла на пилон опасная поездка на blablacar е музloft 53\|2023` | no_confident_match | current | same | future |
| `midnight oil armistice day live sydney\|2018` | no_confident_match | current | same | future |
| `mylène farmer nevermore live paris\|2024` | no_confident_match | current | missing | due |
| `noize mc с оркестром классно alternative\|2019` | no_confident_match | historical | missing | due |
| `pet shop boys live isle of wight\|2024` | no_confident_match | current | missing | due |
| `sevak от строителя до евровидения музloft 32\|2022` | no_confident_match | current | same | future |
| `skid row live london\|2022` | no_confident_match | current | same | future |
| `triptykon w o a\|2026` | no_confident_match | historical | missing | due |
| `айдар гараев о шоу плохие песни проблемах квн и современных артистах музloft 3\|2021` | no_confident_match | current | same | future |
| `академик пивоваров 10 поворотных моментов российской истории скажи гордеевой\|2024` | no_confident_match | current | same | future |
| `анаконда\|2025` | ambiguous | current | changed | future |
| `андрей перцев чекист не любит армейцев скажи гордеевой что будет дальше\|2023` | no_confident_match | current | missing | due |
| `белка и стрелка лунные приключения\|2013` | no_confident_match | current | missing | due |
| `блейд 1\|1998` | no_confident_match | current | same | future |
| `братство\|2019` | ambiguous | current | missing | due |
| `бэтмен семейные дела\|2019` | no_confident_match | current | missing | due |
| `вера надежда любовь и ненависть документальный фильм\|1973` | no_confident_match | expired | missing | due |
| `ворон\|2024` | ambiguous | current | changed | future |
| `вячеслав макаров камызяки маска киркоров и антидепрессанты музloft 34\|2022` | no_confident_match | current | missing | due |
| `гол 2\|2008` | no_confident_match | current | same | future |
| `джанго освобожденный\|2012` | no_confident_match | current | missing | due |
| `дитя чудовища\|2015` | no_confident_match | current | missing | due |
| `дневники девочки\|2016` | no_confident_match | current | missing | due |
| `добряки\|1979` | no_confident_match | historical | missing | due |
| `дракула история любви\|2025` | no_confident_match | current | same | future |
| `дракула\|2000` | no_confident_match | current | missing | due |
| `дракула\|2025` | ambiguous | current | missing | due |
| `дунцову боятся власти почему кандидата от народа не допускают к выборам\|2023` | no_confident_match | current | same | future |
| `дэр пароль\|2011` | no_confident_match | current | missing | due |
| `елкииголки\|2022` | no_confident_match | current | missing | due |
| `есть идея\|1977` | no_confident_match | expired | missing | due |
| `замужем за психопатом муж говорил сын должен носить использованные подгузники плачет не подходи\|2021` | no_confident_match | current | missing | due |
| `звездные собаки белка и стрелка\|2010` | no_confident_match | current | same | future |
| `зять спрятал гулю под землей на кладбище домашних животных\|2026` | no_confident_match | current | missing | due |
| `из нее сделали пельмени или мать сама ее продала тайна исчезновения алены имамовой тюменский маньяк\|2024` | no_confident_match | current | same | future |
| `ирония судьбы или с легким паром\|1975` | no_confident_match | current | changed | future |
| `искатели могил\|2010` | no_confident_match | expired | missing | due |
| `как я стал гангстером\|1997` | no_confident_match | current | missing | due |
| `календарь дьявола\|2020` | no_confident_match | current | missing | due |
| `капитан волконогов бежал\|2021` | no_confident_match | current | missing | due |
| `клевый парень\|1999` | no_confident_match | current | missing | due |
| `код 8 часть 2\|2024` | no_confident_match | current | missing | due |
| `крепкий орешек 5\|2013` | no_confident_match | current | missing | due |
| `кровавый округ\|1983` | no_confident_match | expired | missing | due |
| `м ф бен 10 против вселеннои фильм\|2020` | no_confident_match | expired | missing | due |
| `м ф паранорман или как приручить зомби\|2012` | no_confident_match | historical | missing | due |
| `м ф том и джерри гигантское приключение\|2013` | no_confident_match | current | same | future |
| `м ф фабрика иллюзий алисы и терезы\|2023` | no_confident_match | current | same | future |
| `малыш каратист\|2026` | duration_mismatch | current | missing | due |
| `матрица 1\|1999` | no_confident_match | current | missing | due |
| `медсестра\|2013` | no_confident_match | expired | missing | due |
| `месть и закон\|1975` | duration_mismatch | current | missing | due |
| `мой друг кот и пушкин\|2025` | ambiguous | current | same | future |
| `мортал комбат\|1995` | no_confident_match | current | same | future |
| `москва слезам не верит\|1979` | no_confident_match | current | missing | due |
| `московское гетто 90 х черкизон бордели с малолетними и подземный город с нелегалами\|2025` | no_confident_match | current | missing | due |
| `мощная баллада\|2026` | no_confident_match | current | changed | future |
| `нежный travel бали\|2026` | no_confident_match | current | same | future |
| `он охотится на меня мой преследователь полицейский это твой последний день рождения тебя зарежу\|2024` | no_confident_match | current | same | future |
| `осенние колокола\|1978` | no_confident_match | current | missing | due |
| `остров сокровищ\|1998` | no_confident_match | expired | missing | due |
| `откройте полиция 3\|2003` | no_confident_match | current | changed | future |
| `отт бь ч\|2006` | no_confident_match | current | same | future |
| `пиноккио раскрепощенный\|2026` | no_confident_match | current | same | future |
| `последний рубеж\|2019` | no_confident_match | current | missing | due |
| `приключения электроника\|1979` | no_confident_match | current | missing | due |
| `проклятие пустоши\|2025` | no_confident_match | expired | missing | due |
| `проклятые\|2025` | ambiguous | current | changed | future |
| `самый далекий регион чукотка на край земли на собаках как люди живут\|2021` | no_confident_match | current | same | future |
| `самый ценный примат\|2000` | no_confident_match | current | missing | due |
| `северный флот live in moscow\|2017` | no_confident_match | current | missing | due |
| `сказка о царе салтане\|1966` | no_confident_match | current | missing | due |
| `солдатик\|2018` | no_confident_match | current | changed | future |
| `солженицын который все про нас понял\|2024` | no_confident_match | current | same | future |
| `тайник красных камней\|2015` | no_confident_match | current | missing | due |
| `то что внутри\|2024` | no_confident_match | current | same | future |
| `тюрьмы где сидят дети страшнее взрослых истории бывших заключенных подростков из россии и сша\|2025` | no_confident_match | current | missing | due |
| `убежище\|2022` | ambiguous | current | missing | due |
| `уральские пельмени много шубы из ничего\|2009` | no_confident_match | current | missing | due |
| `уральские пельмени серьги на ветер\|2009` | no_confident_match | current | same | future |
| `уральские пельмени страна гирляндия\|2009` | no_confident_match | expired | missing | due |
| `уральские пельмени тесто под солнцем\|2009` | no_confident_match | expired | missing | due |
| `хождение по мукам хмурое утро\|1959` | no_confident_match | current | missing | due |
| `циркафрика эфиопия\|2025` | no_confident_match | current | same | future |
| `цыгане узбекистана кто такие люли и как они живут\|2022` | no_confident_match | expired | missing | due |
| `чарли чудо пес\|2025` | no_confident_match | current | missing | due |
| `чгк 20 12\|2020` | no_confident_match | current | missing | due |
| `чебурашка 2\|2025` | no_confident_match | current | missing | due |
| `чебурашка\|2022` | no_confident_match | current | missing | due |
| `черный и синий черное и синее\|2019` | no_confident_match | current | missing | due |
| `черный телефон 2\|2025` | no_confident_match | current | missing | due |
| `чудо женщина\|2020` | no_confident_match | current | same | future |
| `чужой против хищника 1\|2004` | no_confident_match | current | changed | future |
| `эскорт или вебкам новый социальный лифт лядов с места событий\|2021` | no_confident_match | current | missing | due |
| `я себя знаю алексей смирнов х азамат мусагалиев\|2022` | no_confident_match | current | same | future |
