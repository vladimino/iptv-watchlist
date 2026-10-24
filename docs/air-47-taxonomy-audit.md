# AIR-47 taxonomy audit

Read-only audit of genre, mood, plot-mechanic, and execution labels, plus a specification for a later taxonomy v2. This document does not change normalization, the generation contract, fingerprints, predictions, filters, or the UI. [AIR-108](https://trello.com/c/QIke4H2N) is the implementation card and must not start from this text until the open questions in section 10 are answered. [AIR-69](https://trello.com/c/FlcWZX7W) is not a blocker for this audit. It remains a blocker for AIR-108. R2 stays authoritative. D1 is not bound.

Related work: [AIR-47](https://trello.com/c/wkM9WSZB), [AIR-69](https://trello.com/c/FlcWZX7W), [AIR-108](https://trello.com/c/QIke4H2N).

Mood-mapping behavior was checked against `5f9b92c44c2bade51416a917148e82c02739bc1c`. `origin/main` later moved to `98273ef3b48089fe4e9770b20a478717a6116094` (film route, pull request 76). That commit does not change `mapRawMood`, `MOOD_LABELS`, or the generation contract. The production census below is a read of R2 objects, not a claim about that route change.

Conclusion of the 24 October freshness check: **LIVE EVIDENCE AVAILABLE**. Aggregates were read from the current R2 bucket. This audit is not closed: section 10 is still an owner decision, and the catalog-only identity overlap was not computed.

## How to read this document

Three levels. A number from one level is not evidence for another.

- **Code-proven.** Observed in the repository. It does not depend on which films are in the bucket, or on the age of a snapshot. The romantic/historical substring bug, the other substring collisions, the closed mechanic and execution lists, the URL id rules, and the fact that derived ids are outside `fingerprintHash` are this level.
- **Corpus-dependent.** A count, with an explicit source, date, coverage, and limit. Section 3 is the 18–19 October Site export. Section 2.4 is the 24 October R2 read. Neither number is a substitute for the other. A blank cell was not measured. It is not an estimate.
- **Product proposal.** A rule for AIR-108. It is not implemented and is not a product decision until the owner accepts it. Section 10 lists the choices this audit does not make.

**Hypothesis** means a reading that was not proven film by film. **Open question** means a choice left to the owner.

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

The fresh census confirms the sizes those decisions care about, and it changes the composition claim. The watchlist is almost the same set. The catalog is larger, and which catalog films are new was not identified. Filter-impact counts that section 10 still asks the owner to weigh (the 22-film funny dual map, the romantic/historical inflation, the family singleton) were remeasured. The 22-film figure is unchanged. The romantic/historical inflation grew with the catalog (178 to 227). The corpus-wide singleton integers did not move.

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

**Proposal.** Keep plot mechanics and execution as they are. Classify everything that is currently a genre or a mood id into the six buckets below. The bucket is a presentation and filter grouping. It is not a new stored field and not a new D1 column.

| Bucket | Meaning | Current members |
| --- | --- | --- |
| Genre | Story kind a viewer already expects from Letterboxd | Боевик, Драма, Триллер, Приключения, Криминал, Комедия, Фантастика, Ужасы, Фэнтези, Детектив, Мелодрама, Вестерн, Музыкальный, plus the genre readings of Военный, Исторический, Семейный |
| Format / type | What kind of object it is, not the story | Телефильм. Документальный and Мультфильм are candidates |
| Mood / tone | How it feels | tense, dark, light, adventurous, dynamic, epic, funny, satirical, absurd, warm, touching, inspiring, melancholic, tragic, contemplative, paranoid, and the tone reading of eerie and surreal |
| Theme / context | What it is about | military, historical, political, family, friendship, revenge |
| Style | A recognizable manner | noir. surreal and absurd are candidates for style instead of tone |
| Content property | A viewer-facing property that is not a tone | violent, if «Жёсткий» means graphic content |

**Proposal.** Do not invent a `revenge` plot mechanic. Revenge stays out of `MECHANICS` unless a later card adds it. Do not copy `investigation` or `heist` into a mood chip.

## 5. Conflicts and lossiness

### 5.1 «Романтический» is also historical

**Fact.** The historical rule contains `антич`. The normalized label «романтический» contains that substring, and the romantic rule also matches. `mapRawMood('Романтический')` returns `['romantic','historical']`. The same is true of the lowercase label. Two of the 28 vocabulary labels fail a round trip through their own rule: «Романтический» gains `historical`, and «Чёрный юмор» gains `funny`. The second one is intentional in `tests/mood-vocabulary.mjs`. The first is not covered by that test.

**Fact.** On the October export, 203 of 1,986 films have a romantic stem in some raw label. 178 of those receive `historical` even after romantic words are removed from the stem check and no separate historical stem remains. On the 24 October index the same heuristic is 227 of 259. `historical` is inflated on both corpora. The watchlist still shows 39 films with `historical` and 14 with `romantic` in both censuses.

**Proposal.** A vocabulary label maps to its own id and to no other id. `антич` must not match inside «романтический».

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

**Proposal.** «Семья и отношения» is a theme, not a mood. It is not eligible as the only chip on a card. The id `family` stays, so existing `mood=family` URLs keep a meaning. Narrower kinship labels are an open question, not a silent split.

The same singleton shape exists for other broad ids on the whole corpus: `military` 20 films, `revenge` 9, `eerie` 8, `political` 7, `historical` 6, `noir` 3, `violent` 3. Only `family` is called out by AIR-47 as ineligible to stand alone.

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

**Proposal.** A chip does not repeat a genre that is already printed in `.film-tags` when the mood id is only the theme echo of that genre (`military` with «Военный», `historical` with «Исторический»). The mood id remains available as a filter. `eerie` is not that echo: the eerie rule also matches supernatural words, and 9 watchlist films have `eerie` without the horror genre.

### 5.5 «Чёрный юмор» also means funny

**Fact.** «чёрная комедия» and «Чёрный юмор» map to `funny` and `black_humor`. On the watchlist, 24 films have `black_humor`. 22 of those have no separate raw label that maps to `funny` without `black_humor`. Dropping the extra `funny` id would remove those films from a `mood=funny` filter unless another funny label is present.

**Open question.** Keep the dual map, or let the specific label win?

### 5.6 TV Movie, noir, violent, revenge

**Fact.** `TV Movie` becomes the genre string «Телефильм». Two watchlist films have it. It is filtered with `genre=Телефильм`, in the same control as «Драма». It is not a mood.

**Fact.** `noir` matches only `нуар` or `noir`. It does not collide in the probes. It is a manner, and it currently sits in the mood filter beside «Напряжённый».

**Fact.** `violent` matches жесток, кровав, брутал, насили, and also «жёсткий», which is the vocabulary label itself. The label does not say whether the film is graphic or merely harsh.

**Fact.** `revenge` matches месть, возмезд, and `revenge`. There is no revenge mechanic. A revenge film can also carry `investigation` or `chase_escape` as the plot shape.

## 6. Decision table

Dispositions are proposals. `keep` means the id, the Russian label, and the filter parameter stay. `move` means the id stays and the chip or filter group changes. Nothing here is `retire`, because retiring an id silently drops it from `readUrlState` and from the next preset save.

| Legacy value | Proposed disposition | Why | What changes for users and data |
| --- | --- | --- | --- |
| tense, dark, light, adventurous, dynamic, epic, funny, warm, touching, inspiring, melancholic, tragic, contemplative, paranoid | keep | They are tones. The probes map each vocabulary label to itself, except the two rows below | None, if the romantic and black-humor fixes are the only rule edits |
| satirical, absurd | keep | Tone. Absurd is a style candidate | None unless section 10 moves absurd to style |
| surreal | keep | Tone. Style is the alternative | Open question |
| romantic | keep, and fix the rule | The label is a tone. The `historical` extra id is a substring bug | Films that gained `historical` only from «романтический» leave the historical filter. Fingerprints stay |
| black_humor | keep | The specific label is the one the model was asked to prefer | Dual `funny` membership is an open question. Filter membership of about 22 watchlist films depends on it |
| eerie | keep as tone, narrow the rule | «Мистический / пугающий» is a tone. Matching every `ужас` and `horror` copies the horror genre into the mood filter | Films whose only eerie evidence is the word «ужасы» or `horror` would leave the eerie filter. Supernatural stems stay |
| military, historical, political | move to theme | They say what the film is about. They are also Letterboxd genres under other Russian words | Chip group changes. `mood=military` must keep working. See section 7 |
| family | move to theme, and suppress as a lone chip | One id hides parents, marriage, and siblings. The export shows 16 watchlist films with only this chip. The live index still has 21 corpus-wide and did not resplit them | The chip disappears when it is the only one. The filter id remains. No narrower ids are created in AIR-108 |
| friendship | move to theme | «Дружба и команда» is a subject, and the rule also matches «команда», which is broad | Same URL-keep rule as family. Whether «команда» is too broad is an open question |
| revenge | move to theme | It is not one of the 14 mechanics | Same URL-keep rule. Do not add a mechanic |
| noir | move to style | A manner, not a feeling | Same URL-keep rule |
| violent | unresolved | «Жёсткий» may mean graphic content or a harsh tone. The corpus cannot separate them without rereading raw strings against titles | Leave the id in the mood filter until the owner chooses. Do not split the stored strings |
| «Телефильм» / `TV Movie` | move to format in presentation | It is a type of object. Two watchlist films use it | `genre=Телефильм` keeps matching the stored string. The card can show it as format instead of as one more genre. Do not rewrite `watchlist.json` |
| «Документальный», «Мультфильм» | unresolved | Both are Letterboxd genres. Documentary is unused in this watchlist. Animation has 45 films | They stay genres until the owner says they are formats |
| «Семейный», «Военный», «Исторический» | keep as genres | They are not the same values as `family`, `military`, and `historical` | Chip selection may hide the echo mood when the genre is already printed. Both filters remain |
| Other `GENRE_MAP` values | keep | They round-trip and the watchlist has no unknown English leftover | None |
| `MECHANICS` and `EXECUTION` | keep | Closed, hashed, and already separate from mood | AIR-108 does not add, rename, or display a new mechanic. Execution filters stay the 13 general dimensions |
| Exact mechanic mood strings | keep as mechanic-only | Already tested | Still no mood chip |
| Compound mechanic strings that are otherwise unmapped | unresolved | 196 occurrences are invisible as moods and invisible as mechanics | A later mapping may mark them mechanic-only. That does not create a chip. It does change diagnostics |
| Unmapped raw strings | keep as diagnostics | 904 occurrences. They are not chips today | Still not chips. Still not guessed from the title |

## 7. URLs, presets, fingerprints, and regeneration

### Derived-only recompute

**Fact.** Today the view response already recomputes ids from stored raw labels. A new `MOOD_MAPPING_VERSION` with the same function shape does not rewrite `fingerprint.json` or `predictions.json`, does not change `fingerprintHash`, and does not make a current prediction stale.

**Proposal.** AIR-108 ships that kind of change only:

- Fix the substring rules and the vocabulary-label round trip.
- Attach a category to each existing id in the client and in the schema description.
- Select chips with the rules in section 8.
- Accept every current `mood=<id>` in `readUrlState`, including ids that move to theme or style.
- Keep writing `mood=<id>` from `urlForState` for those ids. Do not add `theme`, `style`, or `format` query keys in AIR-108.

**Why no new query keys yet.** Presets store the ids inside `mood`. A new key would leave saved presets on the old key, and `normalizePresetQuery` would drop an unknown key on the next edit. Keeping the id on `mood` preserves OR-within and AND-across without a preset migration. `ui/filter-presets.json` was not in the frequency snapshot, so this audit cannot list the saved presets. The compatibility rule does not need that list if the ids are unchanged.

Genre URLs store the Russian string (`genre=Телефильм`), not an English key. Renaming the visible word without an alias drops the filter. **Proposal.** Do not rename stored genre strings in AIR-108.

`mood-facet.json` and `enrichment/diagnostics/moods.json` would become stale. The UI does not read the sidecar for chips. **Proposal.** Do not run `POST /api/enrichment/moods/backfill` as part of AIR-108. A sidecar refresh is a separate approved write, and only if something other than the view starts reading the sidecar.

### Requires model regeneration

Any of the following invalidates stored predictions or fingerprints and is outside AIR-108:

- Bump `fingerprintSchemaVersion` or add a required field on the fingerprint.
- Bump `predictionPromptVersion`.
- Rewrite stored `moodLabels` so that `contentHash` changes.
- Ask the external generator to emit category ids instead of the current 2–4 strings. The generator is not in this repository. `PREDICTION_PROMPT_VERSION` is only a number the caller must echo.

**Proposal.** AIR-108 leaves the generation contract as the schema endpoint describes it: 2–4 short labels, preferably the canonical vocabulary, raw input preserved, mapped at read. New films pick up the new mapping when their existing raw labels are read. Old films do too. No queued prediction run is required.

`film_metadata.genres_json` stays the Letterboxd list. Format is derived at read from «Телефильм» and from whatever format decision section 10 records. That derivation is not a schema migration.

## 8. Card chips

**Fact.** The card prints every genre, then up to four mood labels in id order. The shortlist prints neither. Mechanics and execution never appear on the card.

**Proposal.** Choose two or three chips from different buckets. Do not replace the genre line in AIR-108. The new selector applies to the mood row only, plus a format chip when the film's stored genres include a value that section 6 has moved.

1. Expand raw labels with mapping v2. Drop `mechanic_only` and `unmapped`. A vocabulary label contributes its own id only.
2. Build one candidate per bucket: tone, theme, style, content property, format. If a bucket has several ids, keep the more specific one (`black_humor` over `funny` when both came from the same raw string; a narrow kinship id over `family` if one exists later).
3. Remove a theme candidate that only echoes a genre already on the card (`military` when «Военный» is present, `historical` when «Исторический» is present).
4. If `family` is the only remaining candidate, show no mood chip.
5. Otherwise show the first two or three candidates in this order: format, theme, style, content property, tone. Never show four. Never order by the English id.
6. The filter panel still lists every id. Hiding a chip does not remove the film from `mood=family`.

**Open question.** Whether one of the three slots may be a plot mechanic. The card does not show mechanics today, and the detective overlap says the mechanic is often the more precise fact. Putting it on the card is a separate UI change from remapping moods. Default for AIR-108: do not take a slot for a mechanic.

## 9. Regression matrix for AIR-108

Each row is a fixture input and the required outcome. Use synthetic labels, as `tests/mood-vocabulary.mjs` already does. Do not embed a production title.

| Case | Input | Required outcome |
| --- | --- | --- |
| Vocabulary round trip | Each of the 28 Russian labels | Exactly its own id. «Романтический» does not include `historical`. «Чёрный юмор» follows the owner's dual-map decision |
| Romantic bug | «Романтический», «романтический» | `romantic` only |
| Substring guards | семьдесят, браконьер, двойная жизнь, конфронтация, паранормальный | Not `family`, not `military`, and «паранормальный» is `eerie` only |
| Bare `war` | `war` and `war film` | Both `military`, or both documented. Today they disagree |
| Family singleton | Raw labels that map only to `family` | Filter `mood=family` still matches. The card mood row is empty |
| Family plus a tone | «Семья и отношения» and «Напряжённый» | The chip is the tone, not the family label |
| Family is not a genre | Genre «Семейный» and no family raw label | Genre line still shows «Семейный». No family chip is invented |
| Theme echo | Genre «Военный» and raw «Военная тема» | No military chip. `mood=military` still matches |
| Theme without the genre | No «Военный», raw «Военная тема» | Military chip remains |
| TV Movie | Stored genre «Телефильм» | `genre=Телефильм` still matches. Presentation calls it format. The string in the film record is unchanged |
| Horror echo | Raw «ужасы» or `horror` | Does not become `eerie` if the owner accepts the narrower eerie rule. «мистический» still does |
| Mechanic exact | «ограбление», «расследование» | `mechanic_only`. No mood chip. `plotMechanics` unchanged |
| Mechanic compound | «криминальная афера», «спасательная миссия» | Not a mood id. Outcome `unmapped` or `mechanic_only` per the open question. Not a new mechanic id |
| Military compound already pinned | «Военная осада», «военная погоня» | Still `military` only, unless the owner changes this pin |
| Multi-map that is real | «тёплая семейная комедия» | `funny`, `warm`, and `family`, matching the current test, then the chip rule drops `family` if a tone is present |
| Unknown | «неизвестная формулировка 777» | `unmapped`. Absent from chips and from filter options |
| Union | Fingerprint and prediction disagree | The facet is still the union. Hashes unchanged |
| Overflow | Five real tone ids | At most three chips, and not the alphabetical prefix |
| URL id | `mood=family`, `mood=dark`, `mood=military` | Still selects that id after the category move |
| URL Russian label | `mood=Мрачный` | Still selects `dark`. An unknown label selects nothing |
| Preset | A stored query `mood=dark&genre=Драма` | `normalizePresetQuery` keeps both. Applying it restores both filters |
| Preset rejection | `mood` value with a space or a character outside `[a-z0-9_]` | Still dropped |
| Hash | The same fingerprint payload before and after the mapping change | Same `fingerprintHash`. `predictionCurrent` stays true |
| Mechanics and execution | A fingerprint with `plotMechanics: ['heist']` and a general execution value | Those filters match exactly as they do now. No extra chip |
| Immutable source | The mood-vocabulary backfill fixture | Fingerprint and prediction JSON remain byte-for-byte unchanged |

`tests/mood-vocabulary.mjs` will need to change where it asserts the old `historical` or `funny` extras. That test change belongs to the implementation PR, not this one.

## 10. Open questions

These block a faithful AIR-108. The audit does not pick them.

1. Does «Чёрный юмор» also stay in `funny`? About 22 watchlist films sit in `mood=funny` only because of the dual map.
2. Does the eerie rule stop matching «ужасы» and `horror`?
3. Are «Документальный» and «Мультфильм» formats or genres?
4. Do `surreal` and `absurd` stay tones, or move to style?
5. Is `violent` a content property, a tone, or a split that needs new raw labels from a future generator?
6. Is the broad friendship match on «команда» acceptable?
7. Should a compound that is only a mechanic become `mechanic_only`, or stay `unmapped`?
8. May a plot mechanic occupy one of the two or three chip slots?
9. After ids move to theme and style, should the filter sidebar group them under new headings while the query key stays `mood`? The proposal says yes. Confirm the headings before implementation.
10. Is the watchlist-only suppression of a lone `family` chip also required for `military`, `political`, `historical`, and `revenge` singletons? This audit suppresses only `family`.

## 11. Recommended sequence for AIR-108

AIR-108 can stay one implementation card if the answers above are in the card before code starts. It should not grow a backfill or a regeneration.

1. Record the section 10 answers on the AIR-108 card. If the owner splits format, chip selection, and the substring fixes into separate releases, split the card before coding. The substring fixes change who matches `mood=historical` and can ship alone. Chip selection can ship after the mapping, because it only hides labels the mapping already produced.
2. In one PR, change `mapRawMood` and the duplicated label tables, bump `MOOD_MAPPING_VERSION`, and update `tests/mood-vocabulary.mjs` to the matrix in section 9. Do not bump `fingerprintSchemaVersion` or `predictionPromptVersion`. Do not call the model.
3. In that same PR, apply the chip rule in `moodTags` only. Leave genre text, mechanic filters, execution filters, channel filters, and preset storage keys as they are, except that moved ids remain valid `mood` values.
4. Do not rewrite R2, do not run mood backfill, and do not enqueue predictions. Stale sidecars are acceptable because the view recomputes ids.
5. After merge, the safe check is a local fixture or the existing test, not `GET /api/enrichment/view` and not `GET /api/events`. A production read of `GET /api/enrichment/moods/diagnostics` is a separate approval and is not required to ship the code.

Rollback of that PR is a revert. Stored fingerprints and predictions do not need a restore, because the PR must not write them.

## 12. What this audit did not do

No file under `src/`, `public/`, `tests/`, or `migrations/` was edited. No feature flag, Scheduled Task, R2 object, or D1 database was written. Worker GET routes that can write were not called. The read-only mood diagnostics route was not called; the census used the account R2 `GET` API instead.

**LIVE EVIDENCE AVAILABLE.** Section 2.4 is the production census. The audit is not finished as a product decision. Section 10 is still open. Catalog-only film identity, the watchlist share of the 21 family-only films, execution-value frequencies, and saved presets were not measured. AIR-108 stays blocked on those owner answers and on [AIR-69](https://trello.com/c/FlcWZX7W). This document does not authorize a backfill, a prediction run, or a schema bump.
