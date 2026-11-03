# Derived taxonomy

Mapping version 2 groups the existing 28 mood ids for filters and for the watchlist card. The bucket is not a stored field, not a D1 column and not a fingerprint property. `mapRawMood` in `src/enrichment.js` and the chip selector in `public/app.js` are the runtime. This page is the contract; the dated census is [AIR-47](../../evidence/taxonomy/air-47-taxonomy-audit.md).

## What stays stored

A fingerprint and a prediction still keep 2–4 raw `moodLabels`. Those strings, `fingerprintHash`, the prediction body, `fingerprintSchemaVersion`, `fingerprintPromptVersion` and `predictionPromptVersion` stay as they were. All three versions stay 1. A new mapping does not make `predictionCurrent` false and does not change `prediction.confidence` or `confidenceAssessment`.

Genre strings stay the Letterboxd labels, including «Телефильм», «Документальный» and «Мультфильм». Plot mechanics and the thirteen general execution dimensions stay their own closed lists. Nothing here adds a mechanic id or a `plotMechanics` value.

## Buckets

`moodVocabulary.groups` on `GET /api/enrichment/view`, and `moodMapping.groups` on `GET /api/enrichment/schema`, list every id once:

| Group | Ids |
| --- | --- |
| Tone (`tone`) | tense, dark, light, adventurous, dynamic, epic, funny, black_humor, satirical, romantic, warm, touching, inspiring, melancholic, tragic, contemplative, paranoid, eerie |
| Theme (`theme`) | military, historical, political, family, friendship, revenge |
| Style (`style`) | noir, surreal, absurd |
| Content property (`property`) | violent |

«Жёсткий» is the label of `violent`. It is not a claim of graphic violence. The same ids and Russian labels are duplicated in `public/app.js`. `tests/mood-vocabulary.mjs` fails if the two copies differ.

Genre and format are not mood ids. «Телефильм» is the only format, and only as a card chip. «Документальный» and «Мультфильм» stay genre chips and genre filters.

## Mapping

Normalization is unchanged: NFKC, Russian lower case, `ё` to `е`, punctuation to spaces. An English vocabulary id maps to itself. Any other string is tested against the rules. A hit is `mapped`. If nothing hits and a mechanic phrase occurs as a whole token span, the status is `mechanic_only` and the id list is empty. Anything else is `unmapped`. A token span does not match inside a longer token, so «комиссия» is not «миссия».

Rules that version 2 narrows:

- «Романтический» is `romantic` only. The historical stem `антич` does not match inside that word. «античный» is still `historical`.
- «семь», «семьдесят», «семьсот» and «семь дней» are not `family`. The family noun matches a token that continues `семья`, `семьи`, `семье` or `семью`, and the exact token «семей». «семейный» still matches through `семейн`. «браконьер» is not `family`. «брак» and «брачный» still are.
- «двойная жизнь» and «конфронтация» are not `military`. `war` and `war film` both are. `warning` is not.
- «паранормальный» is `eerie` only. «параноидальный» is still `paranoid`.
- «ужасы», `horror` and «хоррор» are not `eerie`. «мистический» is. A horror-genre word alone is not an independent frightening or mystical stem.
- «команда» alone is not `friendship`. «Дружба и команда» is, through «дружб».
- «Чёрный юмор» and «чёрная комедия» stay `funny` and `black_humor`.
- «Военная осада» and «военная погоня» stay `military`, because the military rule matches before the mechanic span.
- «криминальная афера» and «спасательная миссия» are `mechanic_only`. They do not create a mood id or a plot mechanic.
- An exact mechanic string such as «ограбление» or «расследование» stays `mechanic_only`. «детектив» stays `unmapped`.

The facet used for filters is still the sorted union of fingerprint and prediction labels. `moodIds` on the view is that set. `moodGroups` is the mapped id lists in raw-label order, without the raw strings. Diagnostics still list `unmapped` and `mechanicOnly` with the raw text; that route is not the card.

## Card chips

`presentationChips` fills at most three slots, in this order: format («Телефильм» when that genre is stored), one stored plot mechanic, one theme, one style, one content property, one tone. The genre line is not replaced. Execution is not a chip. A mechanic chip is not added to `moodIds` or to the `mood` query.

Within one raw label that maps to both `funny` and `black_humor`, the tone candidate is `black_humor`. Across labels, the first remaining id in raw-label order wins the slot. It is not chosen by sorting English ids. `family` is dropped when any tone is also present. `military` is dropped when the genre line already shows «Военный», and `historical` when it shows «Исторический». The id remains in `moodIds`.

A lone `family`, `military`, `political`, `historical` or `revenge` chip is omitted. A lone tone, style, content property, format or stored mechanic is shown. Hiding a chip does not remove the film from `mood=<id>`.

## Filters, URLs and presets

The sidebar control is still the mood control. Inside it, options are grouped as «Настроение», «Темы», «Стиль» and «Особенности». The query key remains `mood`. `readUrlState` accepts every current id, including ids that moved to another group, and an exact Russian vocabulary label such as `mood=Мрачный`. An unknown label selects nothing. `urlForState` writes `mood=<id>` and does not write `theme`, `style` or `format`.

`normalizePresetQuery` still keeps a `mood` value that matches `^[a-z0-9_]{1,80}$` and drops a value with a space or any other character. A stored `mood=dark&genre=Драма` round-trips. Presets are not migrated.

OR within the selected mood ids and AND across filter families are unchanged. Mechanic and execution filters stay separate.

## Sidecars

`POST /api/enrichment/moods/backfill` still writes `mood-facet.json` and, when the scan finishes, `enrichment/diagnostics/moods.json`. Shipping version 2 does not call it. Those objects may stay on version 1. The view recomputes, and the page uses the view. A later sidecar refresh needs its own approval. The backfill test fixture still proves a local call leaves fingerprint and prediction JSON byte-for-byte unchanged.
