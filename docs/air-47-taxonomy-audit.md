# AIR-47 taxonomy audit

Read-only audit of genre, mood, plot-mechanic, and execution labels, plus the accepted specification for taxonomy v2. This document does not change normalization, the generation contract, fingerprints, predictions, filters, or the UI. [AIR-108](https://trello.com/c/QIke4H2N) implements section 10 and does not start until this audit is accepted and [AIR-69](https://trello.com/c/FlcWZX7W) is done. AIR-69 is not a blocker for this audit. R2 stays authoritative. D1 is not bound. Section 10 does not authorize a backfill, a model regeneration, or a production writer.

Related work: [AIR-47](https://trello.com/c/wkM9WSZB), [AIR-69](https://trello.com/c/FlcWZX7W), [AIR-108](https://trello.com/c/QIke4H2N).

Mood-mapping behavior was checked against `5f9b92c44c2bade51416a917148e82c02739bc1c`. Later `origin/main` commits through `0a8fbd04786036926b1dd93c6caf4a2932371bb2` change the film route and the film page. They do not change `mapRawMood`, `MOOD_LABELS`, or the generation contract. The production census below is a read of R2 objects.

Conclusion of the 24 October freshness check: **LIVE EVIDENCE AVAILABLE**. Aggregates were read from the current R2 bucket. The owner's taxonomy decisions are recorded in section 10. The catalog-only identity overlap was not computed. That limit does not reopen section 10.

## How to read this document

Three levels. A number from one level is not evidence for another.

- **Code-proven.** Observed in the repository. It does not depend on which films are in the bucket, or on the age of a snapshot. The romantic/historical substring bug, the other substring collisions, the closed mechanic and execution lists, the URL id rules, and the fact that derived ids are outside `fingerprintHash` are this level.
- **Corpus-dependent.** A count, with an explicit source, date, coverage, and limit. Section 3 is the 18–19 October Site export. Section 2.4 is the 24 October R2 read. Neither number is a substitute for the other. A blank cell was not measured. It is not an estimate.
- **Accepted decision.** A product rule the owner approved on 24 October 2026 and recorded on [AIR-47](https://trello.com/c/wkM9WSZB) and [AIR-108](https://trello.com/c/QIke4H2N). Section 10 is that list. AIR-108 implements it. This pull request does not.

**Hypothesis** means a reading that was not proven film by film.

## 1. What is in force today

There is one free-text field, `moodLabels`, and three closed vocabularies. There is no stored field for format, theme, style, or content property.

| Layer | Where it lives | Vocabulary | What the card shows |
| --- | --- | --- | --- |
| Genre | `film.genres`, written by `parseFilm` through `GENRE_MAP` in `src/sources.js` | 19 Letterboxd English keys mapped to Russian; an unknown English genre is stored as-is | Every genre, joined in `.film-tags` |
| Plot mechanics | `fingerprint.plotMechanics` | 14 ids in `MECHANICS` (`src/enrichment.js`) and `MECHANIC_LABELS` (`public/app.js`) | Nothing. Mechanics are a filter only |
| Execution | `fingerprint.execution` | 21 dimensions in `EXECUTION`. The UI filters the 13 general dimensions in `EXECUTION_FILTERS` | Nothing. Execution is a filter only |
| Mood | `fingerprint.moodLabels` and `prediction.moodLabels`, 2–4 strings of at most 45 characters | Free text. `mapRawMood` (`MOOD_MAPPING_VERSION` 1) derives 28 ids in `MOOD_LABELS` | Up to four Russian labels in `.film-moods` |

`MOOD_LABELS` is copied in both `src/enrichment.js` and `public/app.js`. The server map is the one that writes `moodIds`. The client map is the one that labels chips and accepts a `mood` URL parameter.

`canonicalMoodFacet` unions the fingerprint labels and the current prediction labels, maps each string, and sorts the resulting ids. `moodTags` then keeps the first four. Sort order is the id string (`absurd` before `family`), not specificity and not the Russian label.

`GET /api/enrichment/view` recomputes those ids from the raw labels on the view index. It does not trust a previously stored `mood-facet.json` for the response. The same GET can write a missing built-in rating into the view index (`README.md`). This audit did not call it. `POST /api/enrichment/moods/backfill` is the writer that materializes sidecars. `GET /api/enrichment/moods/diagnostics` only reads. This audit did not call that route on production either.

The fingerprint hash is `contentHash` of the model payload plus `filmId` (`src/enrichment.js`). `moodLabels` are inside that payload. The derived id list is not. `predictionCurrent` requires the stored fingerprint hash, profile version, profile hash, and `predictionPromptVersion` (`1`). A mapping change that leaves the raw strings in place does not invalidate a fingerprint or a prediction. A change to `fingerprintSchemaVersion` (`1`) or to the required shape of `moodLabels` does.

`migrations/0001_schema_v1.sql` stores genres only as `film_metadata.genres_json`. The schema is frozen and not bound. A format or theme split cannot add a column on this schema.

Filter composition is OR inside genres, mechanics, moods, channels, and execution values, and AND across those groups (`public/app.js`). Presets persist the query string in `ui/filter-presets.json`. `normalizePresetQuery` keeps a `mood` value only when it matches `^[a-z0-9_]{1,80}$`. It does not check that the id still exists. `readUrlState` drops a `mood` value that is not a current id and is not an exact normalized Russian label. `moodVocabulary.aliases` is consulted, and the view payload does not set `aliases`.

## 2. Evidence sources

No sync, resolver chunk, prediction, TMDB call, R2 write, migration, or production-configuration change was made. No film title, film id, profile text, or raw model sentence is copied here. `GET /api/enrichment/view` and `GET /api/events` were not called.

### 2.1 What can be read, and what was read

**Fact.** The Worker MCP tools that already exist cannot supply this census. `prediction_queue_overview`, `prediction_film_diagnostics`, and `prediction_pending` are read-only and do not list the bucket or return `moodLabels` (`docs/mcp.md`, `docs/air-98-prediction-diagnostics.md`). `enrichment_status` can write and was not called. There is no mood-aggregate MCP tool.

**Fact.** The local snapshot directory has one export, `2026-10-19-trial-01`. A `view-index` backup from 20 October 2026 is also pre-cutover. Neither is current production.

**Fact.** The census used the account R2 HTTP API: `GET` list and `GET` object on bucket `iptv`. That path does not enter a Worker GET handler, so it does not run the view or event recovery writes. Only `GET` was issued. Aggregates were computed in the request and the response kept counts. A separate MCP contract is not required for this audit.

**Fact.** The objects are not one atomic snapshot. Object upload times:

| Object | Uploaded | Role in the census |
| --- | --- | --- |
| `watchlist.json` | 2026-10-23T15:04:17.788Z | Watchlist membership and genres |
| `programme.json` | 2026-10-23T15:04:10.588Z | Programme membership. `updatedAt` inside the body is 2026-10-23T15:02:58.050Z |
| `epg/published-generation.json` | 2026-10-23T15:03:35.507Z | `programmeRunId` `cf3ba3ac-f962-4475-b9cd-3de1b07bd1eb`, phase `published` |
| `enrichment/view-index.json` | 2026-10-24T11:06:19.755Z | Fingerprint facets, prediction facets, hashes |
| `enrichment/profile/current.json` | 2026-10-19T12:56:28.332Z | Profile version 1, schema version 1, body `updatedAt` 2026-10-04T18:41:55.630Z |
| `enrichment/diagnostics/moods.json` | 2026-10-19T11:58:46.379Z | Stale sidecar. Not the inventory |
| `ui/filter-presets.json` | absent | Preset frequencies remain unknown |

The identity compare in section 2.3 read `watchlist.json` and `enrichment/view-index.json` again, after the 11:06Z index upload. Each of the four compare calls saw 398 watchlist films.

### 2.2 Why the October export is not a production total

**Fact.** Section 3 was recomputed on this machine from `/Users/vladimino/.local/share/iptv-watchlist/snapshots/2026-10-19-trial-01`. `run.json` records `startedAt` `2026-10-18T23:31:38.829Z` and `sourceOrigin` `https://iptv.vladimino.chatgpt.site`. `manifest.json` records `finishedAt` `2026-10-19T00:32:22.364Z` and says the listing is not an atomic bucket snapshot. The export is the pre-cutover Site reserve. Since the 19 October 2026 cutover, bucket `iptv` is the authoritative store.

**Fact.** That export contains 1,986 fingerprint files and 399 watchlist films, all of which have a fingerprint. The other 1,587 fingerprints are outside that watchlist. Those two numbers cannot be lined up with the current catalog by subtraction. The populations differ in four ways that a total does not show:

- Watchlist membership changed. The sorted-id digest of the export is not the digest of the current watchlist. Section 2.3 measures the overlap.
- Catalog-only membership changed by more than the watchlist. The current index has 1,882 keys that are not on the watchlist. The export has 1,587 fingerprints outside its own watchlist. The exact catalog-id overlap was not computed, so the difference of 295 is not a count of new films.
- One shared watchlist film has a different `fingerprintHash`. A larger fingerprint-file total can be new films, replaced films, or both.
- The profile body is still version 1 from 4 October 2026. The growth is new and changed film records under the same profile, not a profile regeneration.

The stored sidecar in the export (`completedAt` 2026-10-11, 484 films, `mappingVersion` 1) is older than the export. The production sidecar uploaded on 19 October is also not the inventory. Both censuses rerun `mapRawMood` from `5f9b92c`.

### 2.3 Watchlist identity

**Fact.** Each watchlist film was compared as the first 64 bits of SHA-256 of the string `watch:` plus the film id, and the first 64 bits of `fingerprintHash`. The 399 export prefixes are unique. The compare returned only counts.

| | Films |
| --- | --- |
| Export watchlist | 399 |
| Production watchlist | 398 |
| In both | 397 |
| Export only | 2 |
| Production only | 1 |
| Shared, same `fingerprintHash` prefix | 396 |
| Shared, different `fingerprintHash` prefix | 1 |
| Shared, missing fingerprint | 0 |

The current watchlist is the same set plus one film and minus two films, not a one-film deletion. Of the films that stayed, one fingerprint changed and 396 did not. Catalog-only identity overlap was not computed.

### 2.4 Production census

**Fact.** Populations at the object times in section 2.1:

| Population | Count |
| --- | --- |
| Watchlist films | 398, all with a fingerprint, a prediction, and a `fingerprintHash`. None use a `tmdb_` id prefix |
| Programme films | 398. Same membership as the watchlist. Same `programmeRunId` as the published generation |
| View-index keys | 2,280. `tmdb_` 1,867, other 413 |
| Catalog-only index keys | 1,882 (1,867 `tmdb_` and 15 other) |
| `enrichment/films/` folders | 2,279. `fingerprint.json` 2,278, `predictions.json` 2,278, `mood-facet.json` 2,278 |
| Index key with no film folder | 1 |
| Index rows missing both fingerprint and prediction | 2 |

Every prediction that exists (2,278) has `predictionPromptVersion` 1, `tasteProfileVersion` 1, the current profile hash, `fingerprintSchemaVersion` 1, and a fingerprint hash that matches the index. Stale predictions: 0. The fingerprint facet stored in the index does not carry `fingerprintSchemaVersion`; the version above is the prediction record, not a missing schema.

Label occurrences on the 2,278 films that have labels: 7,302 occurrences, 1,385 distinct raw strings, mapped 6,201, unmapped 914, mechanic-only 187, compound mechanic strings that stay unmapped 196. Fingerprint and prediction id sets disagree on 160 films. 55 films derive more than four ids.

Canonical ids, a film counted once. The first number is the 2,278 films with labels. The second is the 398 watchlist films.

| Id | All labeled films | Watchlist |
| --- | --- | --- |
| funny | 570 | 46 |
| tense | 555 | 15 |
| adventurous | 484 | 60 |
| family | 479 | 76 |
| dark | 441 | 33 |
| dynamic | 404 | 9 |
| historical | 375 | 39 |
| friendship | 325 | 47 |
| romantic | 274 | 14 |
| violent | 272 | 15 |
| eerie | 208 | 37 |
| epic | 201 | 15 |
| warm | 180 | 1 |
| light | 179 | 6 |
| military | 155 | 45 |
| inspiring | 151 | 6 |
| tragic | 139 | 10 |
| touching | 134 | 2 |
| melancholic | 121 | 4 |
| absurd | 106 | 4 |
| paranoid | 103 | 9 |
| political | 101 | 21 |
| revenge | 97 | 24 |
| black_humor | 87 | 24 |
| satirical | 82 | 13 |
| contemplative | 76 | 2 |
| surreal | 51 | 4 |
| noir | 44 | 7 |

Highest raw occurrence counts: «Напряжённый» 458, «Комедийный» 404, «Приключенческий» 361, «Мрачный» 347, «Семья и отношения» 338, «Динамичный» 334, «Дружба и команда» 265, «Романтический» 222, «Жёсткий» 218.

Family on the 2,278: `family` present 479, exact broad label 394, narrower kinship cue 0, broad-label-only chip 2, `family` as the only derived id 21. The live pass did not split that last 21 by watchlist membership. The export's "16 of them on the watchlist" stays an export figure.

Romantic heuristic, same rule as section 5.1: romantic stem 259, `historical` present 375, `historical` gained with no separate historical stem 227, `historical` without a romantic stem 128.

Watchlist genre and mood overlap. Genre counts are films, and a film can have several genres. Unknown English leftovers: none.

| Genre | Other signal | Genre | Other | Both | Genre only | Other only |
| --- | --- | --- | --- | --- | --- | --- |
| Военный | `military` | 29 | 45 | 18 | 11 | 27 |
| Исторический | `historical` | 40 | 39 | 19 | 21 | 20 |
| Семейный | `family` | 46 | 76 | 20 | 26 | 56 |
| Ужасы | `eerie` | 65 | 37 | 28 | 37 | 9 |
| Мелодрама | `romantic` | 25 | 14 | 10 | 15 | 4 |
| Комедия | `funny` | 84 | 46 | 40 | 44 | 6 |
| Детектив | `mystery` or `investigation` | 38 | 137 | 36 | 2 | 101 |

Watchlist genres beside the export, where they differ: Боевик 157 (was 158), Драма 153 (was 152), Триллер 149 (was 148), Фантастика 72 (was 73), Ужасы 65 (was 66). The other 14 Russian labels match the export table in section 3.1, including «Телефильм» 2 and «Документальный» 0. The deltas are not attributed to a named film.

Watchlist `black_humor` is 24, and 22 of those have no independent funny label. That pair matches the export.

Mechanic counts on the 2,278 fingerprints: `multi_party_conflict` 798, `rescue` 654, `chase_escape` 561, `plan_counterplan` 535, `survival` 528, `mystery` 480, `investigation` 434, `expedition_discovery` 297, `ticking_clock` 272, `siege` 181, `escort_protection` 179, `scam` 154, `puzzle` 122, `heist` 95.

Corpus-wide films whose only derived id is one broad label: `family` 21, `military` 20, `revenge` 9, `eerie` 8, `political` 7, `historical` 6, `noir` 3, `violent` 3. Those eight integers match the export.

### 2.5 Historical against current

| Measure | Site export, finished 2026-10-19T00:32:22.364Z | R2 `iptv`, objects in section 2.1 |
| --- | --- | --- |
| Watchlist films | 399 | 398 |
| Watchlist overlap | — | 397 shared, 2 export-only, 1 production-only |
| Shared fingerprints unchanged | — | 396 same prefix, 1 changed |
| Fingerprinted films | 1,986 | 2,278 with labels; 2 index rows without a fingerprint |
| Outside the watchlist | 1,587 | 1,882 catalog-only index keys. Id overlap not computed |
| Profile | not used as a version pin | version 1 since 2026-10-04, schema 1 |
| Predictions current for that profile | not measured this way | 2,278 current, 0 stale, prompt 1 |
| Fingerprint/prediction id disagree | 110 / 1,986 | 160 / 2,278 |
| Raw occurrences / distinct | 6,241 / 1,371 | 7,302 / 1,385 |
| Mapped / unmapped / mechanic-only | 5,150 / 904 / 187 | 6,201 / 914 / 187 |
| Compound mechanic, still unmapped | 196 | 196 |
| More than four derived ids | 19 | 55 |
| `historical` from a romantic stem only | 178 | 227 |
| `family` as the only id | 21, of which 16 on the watchlist | 21. Watchlist split not measured |
| Narrow kinship cue on a broad family label | 0 | 0 |
| Watchlist `black_humor` without its own funny label | 22 of 24 | 22 of 24 |
| `ui/filter-presets.json` | absent | absent |

### 2.6 What the two corpora are allowed to decide

Safe on the code, with either corpus as illustration: the romantic/historical substring bug, the other substring collisions in section 5.2, the tested dual map of «Чёрный юмор», TV Movie as the genre string «Телефильм», `family` as one broad id, mechanics and execution as separate closed lists, and the rule that a mapping change does not change `fingerprintHash` or retire a `mood=` id.

The fresh census confirms the sizes those decisions care about, and it changes the composition claim. The watchlist is almost the same set. The catalog is larger, and which catalog films are new was not identified. The owner kept the dual `funny` map, so the 22 watchlist films stay in `mood=funny`. The romantic substring fix still removes the false `historical` ids; that inflation grew with the catalog from 178 to 227. The corpus-wide singleton integers did not move. Section 10 now hides a lone generic theme chip for `family`, `military`, `political`, `historical`, and `revenge`, and leaves the filter match in place.

Still not measured, and not filled in by the export: catalog-only id overlap, the watchlist share of the 21 family-only films, execution-value frequencies, and saved preset queries. None of those four block the code-proven mapping bugs. Catalog-only identity would be required only for a claim about which non-watchlist films appeared after the resolver cutover.

## 3. Inventory of the October export

Every count in this section is the Site export from section 2.2. It is not the production census. Production counts are in section 2.4.

### 3.1 Watchlist genres

`GENRE_MAP` has 19 English keys. On the 399 watchlist films every stored genre is one of the Russian values. None fell through as raw English. `Документальный` occurs zero times. Counts are films, and a film contributes to each of its genres.

| Russian label | English source | Films |
| --- | --- | --- |
| Боевик | Action | 158 |
| Драма | Drama | 152 |
| Триллер | Thriller | 148 |
| Приключения | Adventure | 133 |
| Криминал | Crime | 89 |
| Комедия | Comedy | 84 |
| Фантастика | Science Fiction | 73 |
| Ужасы | Horror | 66 |
| Фэнтези | Fantasy | 59 |
| Семейный | Family | 46 |
| Мультфильм | Animation | 45 |
| Исторический | History | 40 |
| Детектив | Mystery | 38 |
| Военный | War | 29 |
| Мелодрама | Romance | 25 |
| Вестерн | Western | 6 |
| Телефильм | TV Movie | 2 |
| Музыкальный | Music | 1 |
| Документальный | Documentary | 0 |

### 3.2 Canonical mood ids

A film is counted once per id after the union of fingerprint and current prediction labels. The first number is all 1,986 fingerprinted films. The second is the 399 watchlist films.

| Id | Russian label | All films | Watchlist |
| --- | --- | --- | --- |
| funny | Комедийный | 474 | 46 |
| tense | Напряжённый | 459 | — |
| adventurous | Приключенческий | 406 | — |
| family | Семья и отношения | 392 | 77 |
| dark | Мрачный | 382 | — |
| dynamic | Динамичный | 316 | — |
| historical | Историческая тема | 304 | 39 |
| friendship | Дружба и команда | 267 | — |
| violent | Жёсткий | 234 | 15 |
| romantic | Романтический | 218 | 14 |
| eerie | Мистический / пугающий | 174 | 38 |
| epic | Масштабный | 169 | — |
| warm | Тёплый | 155 | — |
| military | Военная тема | 141 | 45 |
| light | Лёгкий | 134 | — |
| inspiring | Вдохновляющий | 125 | — |
| touching | Трогательный | 116 | — |
| tragic | Трагический | 116 | — |
| melancholic | Меланхоличный | 90 | — |
| revenge | Месть и возмездие | 87 | 24 |
| paranoid | Параноидальный | 86 | — |
| absurd | Абсурдный | 82 | — |
| political | Политика и общество | 82 | 21 |
| black_humor | Чёрный юмор | 78 | 24 |
| satirical | Сатирический | 66 | — |
| contemplative | Созерцательный | 59 | — |
| surreal | Сюрреалистический | 38 | — |
| noir | Нуарный | 35 | 7 |

Watchlist cells marked — were not split out. The conflict ids were.

### 3.3 Raw mood strings

**Fact.** 6,241 label occurrences, 1,371 distinct strings. `mapRawMood` classifies occurrences as mapped 5,150, unmapped 904, mechanic-only 187. A stored English id such as `tense` (54), `funny` (45), or `dynamic` (38) hits the `Object.hasOwn(MOOD_LABELS, raw)` short circuit and maps only to itself. A Russian vocabulary label is not a key, so it goes through the regex. That is why «Романтический» can gain a second id.

The frequent raw strings are the Russian vocabulary labels, the same labels in another case, and a smaller set of mechanic nouns. Highest occurrence counts: «Напряжённый» 363, «Комедийный» 318, «Мрачный» 289, «Приключенческий» 284, «Семья и отношения» 252, «Динамичный» 248, «Дружба и команда» 207, «Жёсткий» 181, «Романтический» 166. The unmapped head is generic and small (`заговор` 7, `одержимость` 5) followed by a long tail. Proper names in that tail are not listed.

**Fact.** 110 of 1,986 films have a different id set on the fingerprint than on the current prediction. The facet unions them. That is the current contract, not a second stored taxonomy.

**Fact.** 19 films derive more than four ids, so `moodTags` hides at least one.

### 3.4 Plot mechanics and execution

**Fact.** On the 1,986 fingerprints the mechanic counts are `multi_party_conflict` 667, `rescue` 589, `chase_escape` 479, `survival` 465, `plan_counterplan` 432, `mystery` 428, `investigation` 378, `expedition_discovery` 251, `ticking_clock` 243, `escort_protection` 165, `siege` 161, `scam` 123, `puzzle` 94, `heist` 90.

`MOOD_IGNORED` drops a mood label only when the entire normalized string is one of a fixed list (`осада`, `погоня`, `расследование`, `ограбление`, and the rest of the regex in `src/enrichment.js`). On this corpus the exact drops include `погоня` 24, `спасение` 24, `выживание` 22, `расследование` 19. A longer string that merely contains those words is not mechanic-only. 196 occurrences contain a mechanic word and stay `unmapped` (for example a crime-and-scam phrase, or «спасательная миссия»). `tests/mood-vocabulary.mjs` pins the opposite case: «Военная осада» maps to `military` only, and «ограбление» is `mechanic_only`.

Execution values were not counted. The closed lists are the inventory. Eight genre-conditioned dimensions (`action_readability` through `adventure_discovery_strength`) are stored and are not UI filters.

## 4. Category split

**Accepted.** Keep plot mechanics and execution as closed lists. Classify everything that is currently a genre or a mood id into the six buckets below. The bucket is a presentation and filter grouping. It is not a new stored field and not a new D1 column. Genre migration stops at «Телефильм».

| Bucket | Meaning | Members |
| --- | --- | --- |
| Genre | Story kind a viewer already expects from Letterboxd | The current `GENRE_MAP` labels, including «Документальный», «Мультфильм», «Военный», «Исторический», and «Семейный» |
| Format / type | What kind of object it is, not the story | «Телефильм» only |
| Mood / tone | How it feels | tense, dark, light, adventurous, dynamic, epic, funny, black_humor, satirical, warm, touching, inspiring, melancholic, tragic, contemplative, paranoid, eerie |
| Theme / context | What it is about | military, historical, political, family, friendship, revenge |
| Style | A recognizable manner | noir, surreal, absurd |
| Content property | A viewer-facing property that is not a tone | violent. «Жёсткий» does not by itself mean graphic violence |

**Accepted.** Do not invent a `revenge` plot mechanic. Do not add a mechanic id because a mood string looks like one. A stored `plotMechanics` value may occupy one chip under section 8. It stays out of `MOOD_LABELS` and out of the `mood` filter.

## 5. Conflicts and lossiness

### 5.1 «Романтический» is also historical

**Fact.** The historical rule contains `антич`. The normalized label «романтический» contains that substring, and the romantic rule also matches. `mapRawMood('Романтический')` returns `['romantic','historical']`. The same is true of the lowercase label. Two of the 28 vocabulary labels fail a round trip through their own rule: «Романтический» gains `historical`, and «Чёрный юмор» gains `funny`. The second one is intentional in `tests/mood-vocabulary.mjs`. The first is not covered by that test.

**Fact.** On the October export, 203 of 1,986 films have a romantic stem in some raw label. 178 of those receive `historical` even after romantic words are removed from the stem check and no separate historical stem remains. On the 24 October index the same heuristic is 227 of 259. `historical` is inflated on both corpora. The watchlist still shows 39 films with `historical` and 14 with `romantic` in both censuses.

**Accepted.** «Романтический» maps to `romantic` only. `антич` must not match inside «романтический». The dual map of «Чёрный юмор» to `funny` and `black_humor` stays; it is the exception in section 10.

### 5.2 Other substring collisions

**Fact.** These inputs were run through `mapRawMood` on `5f9b92c`:

| Input | Ids | Why |
| --- | --- | --- |
| семьдесят | family | `семь` |
| браконьер | family | `брак` |
| двойная жизнь | military | `войн` inside «двойная» |
| конфронтация | military | `фронт` |
| war | unmapped | the rule is `war `, with a trailing space |
| war film | military | the trailing space matches |
| паранормальный | eerie, paranoid | `парано` is a prefix of «паранормальный» |
| социальная драма | political | `социальн` |
| ужасы, horror | eerie | the eerie rule lists both |
| ретро, костюмная драма | historical | the historical rule lists both |
| телефильм, TV Movie | unmapped | format is not a mood |
| детектив | unmapped | the genre is not a mood and not an exact mechanic |
| братья | unmapped | the family rule has `братск`, not `брат` |

**Hypothesis.** «семьдесят», «браконьер», «двойная жизнь», and «конфронтация» are rare or absent as real labels. They are still mapping bugs, because a later raw string can hit them. They belong in the regression matrix even without a corpus count.

### 5.3 Broad «Семья и отношения»

**Fact.** The family rule collapses «семья», «семейный», «семейная драма», «отец и сын», and «брак» into one id. 307 films carry an exact broad label (`Семья и отношения`, `family`, `семейный`, or `семья`). On those films, no other raw label contained a narrower kinship cue from the set отец, сын, дочь, брак, сестра, брат, родитель, материн. The relationship kind was not stored.

**Fact.** On the October export, 21 films have `family` as their only derived id (16 of them on the watchlist, out of 77 watchlist films with `family`). The 24 October index still has 21 such films and 76 watchlist films with `family`. The live pass did not recount how many of the 21 are on the watchlist. The card then shows a single chip, «Семья и отношения». That chip does not say whether the film is about parents, a marriage, siblings, or a household in the generic sense.

**Fact.** Letterboxd genre «Семейный» is a different fact. On the watchlist, 46 films have the genre and 77 have the mood. Only 20 have both. 26 have the genre without the mood. 57 have the mood without the genre. Merging them would mix an audience label with a theme label.

**Accepted.** «Семья и отношения» is a theme. The id `family` stays, so `mood=family` keeps its meaning. AIR-108 does not invent narrower kinship ids. A lone `family` chip is suppressed because it is an overly generic theme. The same suppression applies to a lone `military`, `political`, `historical`, or `revenge` chip. A lone tone, style, content property, format, or stored mechanic is not suppressed by that rule.

The same singleton shape exists on the whole corpus for other ids: `military` 20 films, `revenge` 9, `eerie` 8, `political` 7, `historical` 6, `noir` 3, `violent` 3. Of those, the generic-theme rule covers `military`, `revenge`, `political`, and `historical`. `eerie`, `noir`, and `violent` can still stand alone.

### 5.4 Genre and mood describe the same subject twice

Watchlist overlap of the Letterboxd genre and the derived mood or mechanic on the October export. The 24 October recount is section 2.4. The war, history, romance, and comedy rows match. Horror, family, and detective each move by one film.

| Genre | Other signal | Genre films | Other films | Both | Genre only | Other only |
| --- | --- | --- | --- | --- | --- | --- |
| Военный | mood `military` | 29 | 45 | 18 | 11 | 27 |
| Исторический | mood `historical` | 40 | 39 | 19 | 21 | 20 |
| Семейный | mood `family` | 46 | 77 | 20 | 26 | 57 |
| Ужасы | mood `eerie` | 66 | 38 | 29 | 37 | 9 |
| Мелодрама | mood `romantic` | 25 | 14 | 10 | 15 | 4 |
| Комедия | mood `funny` | 84 | 46 | 40 | 44 | 6 |
| Детектив | mechanic `mystery` or `investigation` | 38 | 138 | 36 | 2 | 102 |

**Fact.** A war film often has neither the war genre nor the military mood, or only one of them. Showing both chips repeats the subject when they do co-occur, and hiding the mood whenever the genre is present would hide the 27 military-mood films that are not genre «Военный». The detective genre is almost a subset of the mechanic (36 of 38), while the mechanic covers 102 further watchlist films and is not shown on the card.

**Accepted.** A chip does not repeat a genre that is already printed in `.film-tags` when the id is only the theme echo of that genre (`military` with «Военный», `historical` with «Исторический»). The id remains a filter. `eerie` is not that echo. The accepted eerie rule matches an independent frightening or mystical stem, and it does not match «ужасы» or `horror`. Nine export watchlist films have `eerie` without the horror genre. A stored plot mechanic, such as `mystery` or `investigation` on a detective film, may be the chip under section 8. That does not create a mood id.

### 5.5 «Чёрный юмор» also means funny

**Fact.** «чёрная комедия» and «Чёрный юмор» map to `funny` and `black_humor`. On the watchlist, 24 films have `black_humor`. 22 of those have no separate raw label that maps to `funny` without `black_humor`. Dropping the extra `funny` id would remove those films from a `mood=funny` filter unless another funny label is present.

**Accepted.** Keep the dual map. Those 22 films stay in `mood=funny`. The card prefers the `black_humor` chip when both ids came from the same raw string.

### 5.6 TV Movie, noir, violent, revenge

**Fact.** `TV Movie` becomes the genre string «Телефильм». Two watchlist films have it. It is filtered with `genre=Телефильм`, in the same control as «Драма». It is not a mood.

**Fact.** `noir` matches only `нуар` or `noir`. It does not collide in the probes. It is a manner, and it currently sits in the mood filter beside «Напряжённый».

**Fact.** `violent` matches жесток, кровав, брутал, насили, and also «жёсткий», which is the vocabulary label itself. The label does not say whether the film is graphic or merely harsh.

**Accepted.** `violent` is a content property. AIR-108 does not read graphic violence out of «Жёсткий» and does not invent a second raw label to split the two readings.

**Fact.** `revenge` matches месть, возмезд, and `revenge`. There is no revenge mechanic. A revenge film can also carry `investigation` or `chase_escape` as the plot shape.

## 6. Decision table

Dispositions are the accepted decisions in section 10. `keep` means the id, the Russian label, and the filter parameter stay. `move` means the id stays and the chip or filter group changes. Nothing here is `retire`, because retiring an id silently drops it from `readUrlState` and from the next preset save.

| Legacy value | Disposition | Why | What changes for users and data |
| --- | --- | --- | --- |
| tense, dark, light, adventurous, dynamic, epic, funny, warm, touching, inspiring, melancholic, tragic, contemplative, paranoid, satirical | keep as tone | They are tones. Each vocabulary label maps to itself, except the accepted dual map below | None from a category move. The romantic, eerie, and friendship rule edits are separate rows |
| black_humor | keep as tone, and keep the dual map | «Чёрный юмор» stays in `funny` as well | The 22 watchlist films stay in `mood=funny`. The card shows `black_humor` when both ids came from the same raw string. Fingerprints stay |
| romantic | keep as tone, and fix the rule | The `historical` extra id is a substring bug | Films that gained `historical` only from «романтический» leave the historical filter. Fingerprints stay |
| eerie | keep as tone, and narrow the rule | The tone is an independent frightening or mystical atmosphere. «ужасы» and `horror` copy the horror genre | Films whose only eerie evidence is «ужасы» or `horror` leave the eerie filter. Mystical stems stay |
| surreal, absurd | move to style | They are a manner. The ids stay | Chip group changes. `mood=surreal` and `mood=absurd` keep working |
| noir | move to style | A manner, not a feeling | `mood=noir` keeps working |
| military, historical, political, revenge | move to theme, and suppress a lone chip | They say what the film is about. A lone chip of this kind is too generic to stand as the only label | Chip group changes. A singleton chip is hidden. `mood=<id>` still matches. Do not add a revenge mechanic |
| family | move to theme, and suppress a lone chip | One id hides parents, marriage, and siblings. The export shows 16 watchlist films with only this chip. The live index still has 21 corpus-wide and did not resplit them | The lone chip disappears. The filter id remains. No narrower ids are created |
| friendship | move to theme, and narrow the rule | «Дружба и команда» is a subject. The bare word «команда» is not friendship | «команда» alone leaves the friendship filter. «Дружба и команда» stays. `mood=friendship` keeps working |
| violent | move to content property | The owner accepted the bucket. «Жёсткий» is not evidence of graphic violence | Sidebar group changes. The stored string is not split and not rewritten. `mood=violent` keeps working |
| «Телефильм» / `TV Movie` | move to format in presentation | It is a type of object. Two watchlist films use it | `genre=Телефильм` keeps matching the stored string. The card shows it as format. Do not rewrite `watchlist.json` |
| «Документальный», «Мультфильм» | keep as genres | Legacy genre compatibility. Documentary is unused on this watchlist. Animation has 45 export watchlist films | They stay in the genre control. The genre migration does not grow to cover them |
| «Семейный», «Военный», «Исторический» | keep as genres | They are not the same values as `family`, `military`, and `historical` | The echo rule may hide the theme chip when the genre is already printed. Both filters remain |
| Other `GENRE_MAP` values | keep | They round-trip and the watchlist has no unknown English leftover | None |
| `MECHANICS` and `EXECUTION` | keep the closed lists | Already separate from mood | AIR-108 does not add or rename a mechanic. One stored mechanic may occupy a chip. Execution filters stay the 13 general dimensions and do not become chips |
| Exact mechanic mood strings | keep as mechanic-only | Already tested | Still no mood id |
| Compound strings that only express a mechanic | mechanic-only | 196 occurrences are invisible as moods today | They become `mechanic_only`. They do not become a mood id, and they do not create a `plotMechanics` value |
| Unmapped raw strings | keep as diagnostics | 904 export occurrences. They are not chips today | Still not chips. Still not guessed from the title |

## 7. URLs, presets, fingerprints, and regeneration

### Derived-only recompute

**Fact.** Today the view response already recomputes ids from stored raw labels. A new `MOOD_MAPPING_VERSION` with the same function shape does not rewrite `fingerprint.json` or `predictions.json`, does not change `fingerprintHash`, and does not make a current prediction stale.

**Accepted.** AIR-108 ships that kind of change only:

- Fix the romantic substring, map both `war` and `war film` to `military`, stop `eerie` from matching «ужасы» and `horror`, and stop bare «команда» from matching `friendship`.
- Keep the dual map of «Чёрный юмор» to `funny` and `black_humor`.
- Mark a compound that only expresses a plot mechanic as `mechanic_only`, without writing a new `plotMechanics` value.
- Attach the section 4 bucket to each existing id in the client and in the schema description.
- Select chips with section 8.
- Accept every current `mood=<id>` in `readUrlState`, including ids that move to theme, style, or content property.
- Keep writing `mood=<id>` from `urlForState`. Do not add `theme`, `style`, `format`, or `mechanic` query keys.

**Accepted.** Presets store the ids inside `mood`. A new key would leave saved presets on the old key, and `normalizePresetQuery` would drop an unknown key on the next edit. Keeping the id on `mood` preserves OR-within and AND-across without a preset migration. The sidebar groups those same ids under «Настроение», «Темы», «Стиль», and «Особенности». `ui/filter-presets.json` was absent from both corpora, so this audit cannot list the saved presets. The compatibility rule does not need that list if the ids are unchanged.

Genre URLs store the Russian string (`genre=Телефильм`), not an English key. Renaming the visible word without an alias drops the filter. **Accepted.** Do not rename stored genre strings. Do not move «Документальный» or «Мультфильм» out of the genre control.

`mood-facet.json` and `enrichment/diagnostics/moods.json` would become stale. The UI does not read the sidecar for chips. **Accepted.** Do not run `POST /api/enrichment/moods/backfill` as part of AIR-108. A sidecar refresh is a separate approved write, and only if something other than the view starts reading the sidecar. This audit does not grant that approval.

### Requires model regeneration

Any of the following invalidates stored predictions or fingerprints and is outside AIR-108:

- Bump `fingerprintSchemaVersion` or add a required field on the fingerprint.
- Bump `predictionPromptVersion`.
- Rewrite stored `moodLabels` so that `contentHash` changes.
- Ask the external generator to emit category ids instead of the current 2–4 strings. The generator is not in this repository. `PREDICTION_PROMPT_VERSION` is only a number the caller must echo.

**Accepted.** AIR-108 leaves the generation contract as the schema endpoint describes it: 2–4 short labels, preferably the canonical vocabulary, raw input preserved, mapped at read. New films pick up the new mapping when their existing raw labels are read. Old films do too. No queued prediction run is required. This document does not authorize one.

`film_metadata.genres_json` stays the Letterboxd list. Format is derived at read from the stored genre «Телефильм» only. That derivation is not a schema migration.

## 8. Card chips

**Fact.** The card prints every genre, then up to four mood labels in id order. The shortlist prints neither. Mechanics and execution never appear on the card.

**Accepted.** Choose two or three chips from different buckets. Do not replace the genre line. The selector applies to the mood row, plus a format chip when the stored genres include «Телефильм», plus at most one stored plot mechanic.

1. Expand raw labels with mapping v2. Drop `mechanic_only` and `unmapped`. «Чёрный юмор» contributes `black_humor` and `funny`. «Романтический» contributes `romantic` only. «ужасы» and `horror` do not contribute `eerie`. «команда» alone does not contribute `friendship`.
2. Build one candidate for each of format, theme, style, content property, and tone. Add at most one stored `plotMechanics` id as its own candidate. Do not invent that id from a mood string. If a bucket has several ids, keep the more specific one on the card (`black_humor` over `funny` when both came from the same raw string). Several unrelated tones are not an English-id sort: keep the order of the raw labels. The filter still has every derived id.
3. Remove a theme candidate that only echoes a genre already on the card (`military` when «Военный» is present, `historical` when «Исторический» is present).
4. If the only remaining candidate is `family`, `military`, `political`, `historical`, or `revenge`, show no chip. A lone tone, style, content property, format, or stored mechanic still shows.
5. Otherwise fill up to three slots in this order: format, plot mechanic, theme, style, content property, tone. Never show four. Never order by the English id.
6. The sidebar lists every id under «Настроение», «Темы», «Стиль», and «Особенности». Hiding a chip does not remove the film from `mood=<id>`. The mechanic chip does not add the mechanic to that parameter.

## 9. Regression matrix for AIR-108

Each row is a fixture input and the required outcome. Use synthetic labels, as `tests/mood-vocabulary.mjs` already does. Do not embed a production title.

| Case | Input | Required outcome |
| --- | --- | --- |
| Vocabulary round trip | Each of the 28 Russian labels | Its own id. «Романтический» does not include `historical`. «Чёрный юмор» includes `black_humor` and `funny` |
| Romantic bug | «Романтический», «романтический» | `romantic` only |
| Substring guards | семьдесят, браконьер, двойная жизнь, конфронтация, паранормальный | Not `family`, not `military`, and «паранормальный» is `eerie` only |
| Bare `war` | `war` and `war film` | Both `military`. The trailing space in today's rule is not the discriminator |
| Dual map kept | «Чёрный юмор», «чёрная комедия» | `funny` and `black_humor`. `mood=funny` matches. The card chip is `black_humor` when no more specific funny label is separate |
| Family singleton | Raw labels that map only to `family` | `mood=family` still matches. The card shows no family chip |
| Generic theme singleton | A raw label that maps only to `military`, `political`, `historical`, or `revenge` | The matching `mood=` filter still matches. That chip is hidden |
| Informative singleton | A raw label that maps only to `tense`, `noir`, or `violent` | That chip is shown. `violent` does not gain a graphic-violence claim |
| Family plus a tone | «Семья и отношения» and «Напряжённый» | The chip is the tone, not the family label. `mood=family` still matches |
| Family is not a genre | Genre «Семейный» and no family raw label | Genre line still shows «Семейный». No family chip is invented |
| Theme echo | Genre «Военный» and raw «Военная тема» plus «Напряжённый» | No military chip. The tone chip remains. `mood=military` still matches |
| Theme beside another chip | No «Военный», raw «Военная тема» and «Напряжённый» | The military chip remains beside the tone |
| Style move | «сюрреалистический», «абсурдный», «нуарный» | Ids `surreal`, `absurd`, and `noir`. Sidebar group «Стиль». `mood=surreal` still matches |
| Friendship narrowing | «команда»; «Дружба и команда» | The first is not `friendship`. The second is `friendship` |
| TV Movie | Stored genre «Телефильм» | `genre=Телефильм` still matches. Presentation calls it format. The string in the film record is unchanged |
| Genres that stay genres | Stored «Документальный» or «Мультфильм» | They stay genre chips and genre filters. They are not format |
| Horror echo | Raw «ужасы» or `horror`; raw «мистический» | The first two are not `eerie`. «мистический» is `eerie` |
| Mechanic exact | «ограбление», «расследование» | `mechanic_only`. No mood id. `plotMechanics` unchanged |
| Mechanic compound | «криминальная афера», «спасательная миссия» | `mechanic_only`. Not a mood id. Not a new `plotMechanics` value |
| Military compound already pinned | «Военная осада», «военная погоня» | Still `military` only |
| Multi-map that is real | «тёплая семейная комедия» | `funny`, `warm`, and `family`. The card drops `family` because a tone is present |
| Unknown | «неизвестная формулировка 777» | `unmapped`. Absent from chips and from filter options |
| Union | Fingerprint and prediction disagree | The facet is still the union. Hashes unchanged |
| Overflow | Five real tone ids and no other bucket | One tone chip. It is not chosen by English id order |
| Mechanic chip | `plotMechanics: ['heist']` and two tone labels | The chips are `heist` and one tone. `heist` is not a mood id. The mechanic filter still matches `heist` |
| URL id | `mood=family`, `mood=dark`, `mood=military`, `mood=surreal`, `mood=violent` | Each still selects that id after the category move |
| URL Russian label | `mood=Мрачный` | Still selects `dark`. An unknown label selects nothing |
| Sidebar | The filter panel | Groups «Настроение», «Темы», «Стиль», «Особенности». The query key is still `mood` |
| Preset | A stored query `mood=dark&genre=Драма` | `normalizePresetQuery` keeps both. Applying it restores both filters |
| Preset rejection | `mood` value with a space or a character outside `[a-z0-9_]` | Still dropped |
| Hash | The same fingerprint payload before and after the mapping change | Same `fingerprintHash`. `predictionCurrent` stays true |
| Execution | A general execution value on the fingerprint | That filter matches as it does now. Execution does not become a chip |
| Immutable source | The mood-vocabulary backfill fixture | Fingerprint and prediction JSON remain byte-for-byte unchanged |

`tests/mood-vocabulary.mjs` already pins the dual map of «чёрная комедия». The implementation PR updates that test to the rest of this matrix, including the romantic bug, the narrower eerie rule, bare «команда», and mechanic compounds. That test change belongs to AIR-108, not this pull request.

## 10. Accepted decisions

The owner approved these ten decisions on 24 October 2026. The same text is on [AIR-47](https://trello.com/c/wkM9WSZB) and [AIR-108](https://trello.com/c/QIke4H2N). They specify AIR-108. They do not start it, and they do not authorize a backfill, a model regeneration, a production writer, or a flag change.

1. `black_humor` also stays `funny`. The existing dual mapping and the `mood=funny` filter stay.
2. `eerie` does not match `horror` or «ужасы» automatically. It matches an independent frightening or mystical stem.
3. «Документальный» and «Мультфильм» stay genres. «Телефильм» is format. The genre migration does not grow beyond that.
4. `surreal` and `absurd` move to style. Their ids and `mood=` URLs stay.
5. `violent` is a content property. «Жёсткий» is not evidence of graphic violence, and AIR-108 does not invent raw evidence to split it.
6. «команда» without a friendship stem is not `friendship`. The friendship rule is narrowed.
7. A compound raw phrase that only expresses a plot mechanic is `mechanic_only`. It is not a mood. AIR-108 does not fabricate a `plotMechanics` value from it.
8. A stored plot mechanic may occupy one of the two or three card chips. Mood ids, mechanic filters, and the `mood` query stay separate.
9. The sidebar groups are «Настроение», «Темы», «Стиль», and «Особенности». Legacy ids and presets keep the `mood` query key.
10. A lone overly generic theme chip is suppressed, including `family`, `military`, `political`, `historical`, and `revenge`. The rule is informativeness, so a lone specific tone, style, content property, format, or mechanic still shows. The hidden theme id still matches its filter.

## 11. What AIR-108 implements after the blockers clear

AIR-108 is one implementation of this specification. It does not start until this audit is accepted and [AIR-69](https://trello.com/c/FlcWZX7W) is done. It does not include a backfill, a model regeneration, or a production writer.

1. The section 10 decisions are already on the AIR-108 card. Planning uses that text. Code starts after this audit is accepted and AIR-69 is done.
2. In one PR, change `mapRawMood` and the duplicated label tables, bump `MOOD_MAPPING_VERSION`, and update `tests/mood-vocabulary.mjs` to section 9. Apply the chip rule and the four sidebar headings. Do not bump `fingerprintSchemaVersion` or `predictionPromptVersion`. Do not call the model.
3. Leave genre strings, mechanic filters, execution filters, channel filters, and preset storage keys as they are, except that moved ids remain valid `mood` values and «Телефильм» is presented as format.
4. Do not rewrite R2, do not run mood backfill, and do not enqueue predictions. Stale sidecars are acceptable because the view recomputes ids. A later sidecar refresh needs its own approval.
5. After merge, the safe check is a local fixture or the existing test, not `GET /api/enrichment/view` and not `GET /api/events`. A production read of `GET /api/enrichment/moods/diagnostics` is a separate approval and is not required to ship the code.

Rollback of that PR is a revert. Stored fingerprints and predictions do not need a restore, because the PR must not write them.

## 12. What this audit did not do

No file under `src/`, `public/`, `tests/`, or `migrations/` was edited. No feature flag, Scheduled Task, R2 object, or D1 database was written. Worker GET routes that can write were not called. The read-only mood diagnostics route was not called; the census used the account R2 `GET` API instead.

**LIVE EVIDENCE AVAILABLE.** Section 2.4 is the production census. Catalog-only film identity, the watchlist share of the 21 family-only films, execution-value frequencies, and saved presets were not measured. Those gaps stay gaps. They do not reopen section 10.

AIR-108 remains blocked on acceptance of this audit and on [AIR-69](https://trello.com/c/FlcWZX7W). This document does not authorize a backfill, a model regeneration, a schema or prompt bump, or any production writer.
