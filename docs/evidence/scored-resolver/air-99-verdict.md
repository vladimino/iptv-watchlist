# AIR-99 evidence

> Historical sample. See [evidence registry](../README.md) for context and later decisions. This text is not a current operational authorization.

**Remaining gaps.** This is not evidence-ready for [AIR-68](https://trello.com/c/qbLDc6Ql). Do not set `SCORED_RESOLUTION=on` or `CANDIDATE_DISCOVERY=on`. The rollout and rollback procedure is [AIR-100](https://trello.com/c/4441YtSU), not this card.

Read-only snapshot at `2026-10-24T08:43:16.398Z`. Published generation `cf3ba3ac-f962-4475-b9cd-3de1b07bd1eb`, phase `published`, ledger `updatedAt` `2026-10-23T15:02:58.050Z`. `origin/main` at the read was `e46729c`. Worker deploy `56ed7fb9-b509-4944-a51b-e3bdb672d7be`, source `wrangler`, 2026-10-24T08:28:57Z, message `PR #69: Stream the offline import read-back and record the AIR-73 archive run`. `SCORED_RESOLUTION` is `shadow`. `CANDIDATE_DISCOVERY` is unset. Schedules are 0. No R2 write, no resolver chunk, no EPG sync, and no prediction run.

## Detail HTTP

Five calls, all `200`, none halted. The saved cards are `docs/air-99-detail.json`. The script requested only `movie/{id}` for `36647`, `161`, `395`, `163`, and `603`. Cap 5. No search, no alias read, and no retry. A second local pass of `gateFetched` on those cards matches the stored score and gate. Catalog rivals passed into that gate are the empty list from the catalog read: each structural form had either no film or only the fetched id.

## Population

The ledger is `epg/generations/<id>/discovery-latest.json`, 49715 items. Decisions are the live `epg/discovery-resolution.json`: 8797 object keys, of which `__canonicalizedAt` is not an observation, so 8796 decisions. One decision key is not an observation key. The catalog is `epg/discovered-films.json`, 1863 films. Classes match `discoveryCounts` and `resolutionActionability`. A row is counted once in the pipeline. The other rows are cross-cuts.

| Pipeline class | Rows | Share of 49715 |
| --- | ---: | ---: |
| `readyNow` | 15036 | 30.2% |
| `retryBackoff` | 9 | 0.0% |
| `ambiguous` current | 26 | 0.1% |
| `expired` | 24175 | 48.6% |
| `historical` unresolved | 2370 | 4.8% |
| `terminalNoMatch` | 0 | 0 |
| `verified` | 3330 | 6.7% |
| non-film | 4769 | 9.6% |
| Ledger | 49715 | 100% |

`currentUnresolved` is 15071, which is `readyNow` plus the 9 retry rows plus the 26 ambiguous rows. Decisions on the ledger: `verified` 3330, none 40919, `no_confident_match` 636, `excluded_nonfilm` 4769, `ambiguous` 40, `duration_mismatch` 21. Stored `identitySource`: `known_epg_alias` 1453, `known_alias_year_runtime` 11. The other 1866 verified rows have no `identitySource`.

| Cross-cut | Rows | What it is |
| --- | ---: | --- |
| Yearless | 36298 | No observation year. 10891 of them are `readyNow`. 1354 are verified. None are in `retryBackoff`. |
| Cheap pass stored | 1453 | `identitySource` `known_epg_alias`. Every one of these titles is already in the catalog. |
| Cheap pass pending | 0 | `confirmedTmdbId` and no decision. The class is absent. |
| `retryAt` still ahead and blocked | 8 | Current, evidence still the same, not ambiguous. One of the 9 `retryBackoff` rows is not blocked. |
| `retryAt` already due | 72 | Counted inside `readyNow`, not inside `retryBackoff`. |
| `duration_mismatch` | 21 | Stored status. |
| `readyNow` with a catalog title | 140 | 133 have one film, 7 have two or more. |
| `readyNow` with no catalog title | 14896 | No local candidate. No TMDB search was run. This is not a measured miss. |
| Yearless `readyNow` with a catalog title | 57 | 53 have one film, 4 have two or more. |
| Current ambiguous with a catalog title | 6 | All six have one film. 20 current ambiguous rows have none. |

## Sample

The quotas were fixed before any score. Within each class, rows are taken in observation-key order. A row is used once. Unused quota is not given to `readyNow`. The cap is 60. `cheap_pass_pending` is present in the plan and absent in the data, so its 6 slots stay empty. Taken: 54.

| Stratum | Population | Quota | Taken |
| --- | ---: | ---: | ---: |
| Cheap pass stored | 1453 | 8 | 8 |
| Cheap pass pending | 0 | 6 | 0 |
| `readyNow`, no year | 10891 | 8 | 8 |
| `readyNow`, dated, no `retryAt` | 4073 | 8 | 8 |
| `retryAt` blocked | 8 | 8 | 8 |
| `retryAt` due | 72 | 6 | 6 |
| Ambiguous, current | 26 | 6 | 6 |
| Non-film | 4769 | 5 | 5 |
| `duration_mismatch` | 21 | 5 | 5 |

The alphabetical head of `readyNow` has no catalog film, which matches 14896 of 15036. Those rows are `not_evaluated` for the scorer: an empty local index is not a TMDB result. The eight blocked retry rows are the same concert and interview titles as the census, still `no_confident_match`, still with no catalog film. The five non-film rows are `excluded_nonfilm` / `episode_label`. The five `duration_mismatch` rows also have no catalog film. `known_alias_year_runtime` was not in the quota list. The census found 11, all listed below; 10 are `expired` and one, `шепот за окном|2026`, is current. Their stored ids were not searched again.

The separate risk pass is every `readyNow` row that already has a catalog title. The first 10 in ledger order, all single films:

| Observation | Catalog film | Scorer |
| --- | --- | --- |
| `аладдин\|1992` | 420817, 2019, 127 min | `contradicted_year` |
| `бешеные псы\|1991` | 500, 1992, 100 min | `accepted` 500 |
| `волчок\|2025` | 51272, 2009, 86 min | `contradicted_year` |
| `залечь на дно в брюгге\|2007` | 8321, 2008, 102 min | `accepted` 8321 |
| `золушка\|1950` | 42651, 1947, 84 min | `contradicted_year` |
| `конан варвар\|1982` | 37430, 2011, 112 min | `contradicted_year` |
| `обитель зла 4 жизнь после смерти\|` | 35791, 2010, 96 min | `accepted` 35791 |
| `семьянин\|` | 1248732, 2025, 98 min | `ambiguous_short_title_without_year` |
| `чудо женщина\|2020` | 297762, 2017, 141 min | `contradicted_year` |
| `шаг с крыши\|` | 254341, 1970, 98 min | `accepted` 254341 |

An `accepted` row here is a proposal. No detail call was spent on it, so none of these is `detail_verified`.

All 7 `readyNow` rows with two catalog films were scored with the alias that put each film under the observation title. None is `accepted`: `блеф|` is `ambiguous_short_title_without_year`; `голый пистолет|`, `долгий путь|`, and `дом у дороги|` are `ambiguous_collision`; `война|1994`, `землетрясение|2010`, and `левша|2026` are `contradicted_year`.

All 6 current ambiguous catalog hits are `contradicted_year` against the one local film: `дракула|2025` 49017 (2014), `кукушка|2024` 554 (2002), `русалочка|2023` 10144 (1989), `схватка|2024` 75174 (2012), `убежище|2022` 1290821 (2026), `убийца|2015` 800158 (2023). The local index does not contain TMDB 801970. That id remains the AIR-86 search proposal, not a catalog prior.

The 8 cheap-pass rows, already `verified` as `known_epg_alias`, scored against that same catalog film: 7 accept the stored id (`007 казино рояль|` 36557, `007 квант милосердия|` 10764, `007 координаты скайфолл|` 37724, `007 не время умирать|` 370172, `007 спектр|` 206647, `100 ярдов|` 1122824, `12 могучих сирот|` 625169). `11 14|` is `ambiguous_short_title_without_year`. Under `on` the cheap pass still writes `verified` before the scorer, so this disagreement would not by itself un-verify the row. It is not a new `detail_verified`.

## The five ids

Competitors were read from the catalog before the calls. The read succeeded. An empty rival list is an empty index, not a failed read. The fetched card is the TMDB detail, not the catalog copy.

| Id | Observation | Fetched card | Gate |
| --- | --- | --- | --- |
| 36647 | `блейд 1\|1998`, durations 120 | Блэйд / Blade, 1998-08-21, 120 min | `accepted_spelling_e`, `detail_verified` |
| 161 | `11 друзей оушена\|2001`, duration 117 | Одиннадцать друзей Оушена / Ocean's Eleven, 2001-12-07, 116 min | `accepted_numeral`, `detail_verified` |
| 395 | `чужой против хищника 1\|2004`, duration 101 | Чужой против Хищника / AVP: Alien vs. Predator, 2004-08-12, 100 min | `accepted_part_suffix`, `detail_verified` |
| 163 | `12 друзей оушена\|2004`, duration 125 | Двенадцать друзей Оушена / Ocean's Twelve, 2004-12-09, 120 min | `accepted_numeral`, `detail_verified` |
| 603 | `матрица 1\|1999`, durations 136 and 137 | Матрица / The Matrix, 1999-03-31, 136 min | `accepted_part_suffix`, `detail_verified` |

Year is exact on all five. Runtime distance is 0, 1, 1, 5, and 0 minutes. No `competingEditions`. `блейд 1` is a short title, and the year gap is 0, so the neighbouring-year hold does not apply.

## What AIR-68 still needs

1. The five `movie/{id}` responses, scored by the current gate. Met: 5 of 5 are `detail_verified`. That does not measure the 14896 `readyNow` rows with no catalog title.
2. A search sample of `readyNow`. 14896 of 15036 current rows have no catalog title, and this pass did not search them. An empty index is not a false-id rate and not a recall rate.
3. No known false `detail_verified` on a fetched card. Met inside these five: each title is the structural form, the year matches, and the runtime is inside tolerance. It is not met for the rest of `readyNow`.
4. The cheap pass still verifies before the scorer. `11 14|` shows a yearless short title the scorer will not accept and the cheap pass already verified.
5. Rollback of `SCORED_RESOLUTION=on` is AIR-100. It was not exercised.

The five ids close item 1 only.
