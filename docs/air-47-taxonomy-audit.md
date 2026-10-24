# AIR-47 taxonomy audit

Read-only audit of genre, mood, plot-mechanic, and execution labels, plus a specification for a later taxonomy v2. This document does not change normalization, the generation contract, fingerprints, predictions, filters, or the UI. [AIR-108](https://trello.com/c/QIke4H2N) is the implementation card and must not start from this text until the open questions in section 10 are answered. [AIR-69](https://trello.com/c/FlcWZX7W) is not a blocker for this audit. It remains a blocker for AIR-108. R2 stays authoritative. D1 is not bound.

Related work: [AIR-47](https://trello.com/c/wkM9WSZB), [AIR-69](https://trello.com/c/FlcWZX7W), [AIR-108](https://trello.com/c/QIke4H2N).

Code under review is `origin/main` at `5f9b92c44c2bade51416a917148e82c02739bc1c`.

## How to read this document

- **Fact** — observed in the repository or recomputed locally from the source named in section 2.
- **Proposal** — a recommended rule for AIR-108. It is not implemented and is not a product decision until the owner accepts it.
- **Hypothesis** — a reading of the evidence that was not proven film by film.
- **Open question** — a choice this audit does not make.

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

## 2. Frequency source and limits

**Fact.** Counts below were recomputed on this machine from the local export at `/Users/vladimino/.local/share/iptv-watchlist/snapshots/2026-10-19-trial-01`. `run.json` records `startedAt` `2026-10-18T23:31:38.829Z` and `sourceOrigin` `https://iptv.vladimino.chatgpt.site`. `manifest.json` records `finishedAt` `2026-10-19T00:32:22.364Z` and says the listing is not an atomic bucket snapshot. The export is the pre-cutover Site reserve, not the post-cutover R2 bucket `iptv`. No production HTTP call, sync, resolver chunk, prediction, TMDB call, or backfill was made. No film title, film id, or raw model sentence is copied here.

**Fact.** The same export contains `enrichment/diagnostics/moods.json` with `completedAt` `2026-10-11T20:33:45.003Z`, `films` 484, and `mappingVersion` 1. That file is an older sidecar. It is not the inventory. The inventory reruns `mapRawMood` from `5f9b92c` over each fingerprint file and the current prediction.

**Fact.** The export has 1,986 fingerprint files and 1,986 prediction files. All 399 watchlist films are in that set. The other 1,587 are outside the watchlist. Genre counts use the watchlist only. Mood counts are given for both populations. `ui/filter-presets.json` is not in the export, so stored preset frequencies are unknown.

**Limit.** These frequencies can be stale relative to production R2 after 19 October 2026. They are evidence of how mapping v1 behaves on a large saved corpus, not a live census.

## 3. Inventory

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

**Fact.** 203 of 1,986 films have a romantic stem in some raw label. 178 of those receive `historical` even after romantic words are removed from the stem check and no separate historical stem remains. `historical` is therefore inflated. The watchlist still shows 39 films with `historical` and only 14 with `romantic`, which is consistent with the extra id landing on films that already have other labels, but the 178 figure is the corpus-level measurement.

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

**Fact.** 21 films have `family` as their only derived id (16 of them on the watchlist, out of 77 watchlist films with `family`). The card then shows a single chip, «Семья и отношения». That chip does not say whether the film is about parents, a marriage, siblings, or a household in the generic sense.

**Fact.** Letterboxd genre «Семейный» is a different fact. On the watchlist, 46 films have the genre and 77 have the mood. Only 20 have both. 26 have the genre without the mood. 57 have the mood without the genre. Merging them would mix an audience label with a theme label.

**Proposal.** «Семья и отношения» is a theme, not a mood. It is not eligible as the only chip on a card. The id `family` stays, so existing `mood=family` URLs keep a meaning. Narrower kinship labels are an open question, not a silent split.

The same singleton shape exists for other broad ids on the whole corpus: `military` 20 films, `revenge` 9, `eerie` 8, `political` 7, `historical` 6, `noir` 3, `violent` 3. Only `family` is called out by AIR-47 as ineligible to stand alone.

### 5.4 Genre and mood describe the same subject twice

Watchlist overlap of the Letterboxd genre and the derived mood or mechanic:

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
| family | move to theme, and suppress as a lone chip | One id hides parents, marriage, and siblings. 16 watchlist films show only this chip | The chip disappears when it is the only one. The filter id remains. No narrower ids are created in AIR-108 |
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

No file under `src/`, `public/`, `tests/`, or `migrations/` was edited. No feature flag, Scheduled Task, R2 object, or D1 database was touched. Production diagnostics were not called, including the read-only mood diagnostics route, because a live census was not approved. The frequency gap against current R2 is the limit in section 2.
