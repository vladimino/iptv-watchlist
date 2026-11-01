# Candidate discovery

## Current invariant

[ADR 0082](../../adr/0082-retire-candidate-discovery.md) (Proposed) retires the optional variant search. The Worker does not plan title, year, spelling or numeral variant searches. `CANDIDATE_DISCOVERY` is not read and is not in the `feature_flags` registry. A leftover binding, including `on`, adds no TMDB request, no `proposedCandidates` and no catalog row, and does not turn a no-match into a verified decision.

The chunk result and `epg/discovery-status.json` still include `variantCalls`, `variantErrors`, `variantThrottled` and `variantSkipped`. Each is 0. There is no variant-only hold. The ordinary exact-title search, the movie-detail gate, year and runtime checks, competing-edition and short-title safeguards, and the generation fence are unchanged ([scored resolution](scored-resolution.md)).

The owner-only `feature_flags` read at 2026-11-01T22:24:21.589Z reported the binding absent, effective off. The owner confirmed Worker `iptv` has no such binding. Removing the name from the registry is not proof a binding was deleted. The historical AIR-86 replay still plans the old queries from `scripts/air-86-variant-generator.js`, which the Worker does not load. The evidence files under `docs/evidence/scored-resolver/` stay in their original sense.

[AIR-95](https://trello.com/c/kD8xjvVu) still lets the scorer treat one reversible form as title evidence when that form arrives through the ordinary search or a known alias: a numeral word, a trailing `1` removed from the title, or the single `е`/`э` swap. The movie title or original title must equal that form exactly. The detail gate repeats the same check. A prefix, a trailing `2` reduced to its stem, and a `tmdb_alias` still are not title evidence. The Worker no longer searches TMDB for those forms.

## Historical experiment

The paragraphs and tables below describe the experiment. They are not the current writer.

[AIR-80](https://trello.com/c/hQPjVTXv) added search variants for an EPG title. A search hit was not a verified decision by itself. `CANDIDATE_DISCOVERY` accepted only `on`; the former `shadow` preview mode went with the legacy resolver. Unset and any other text were off. The repository did not commit the variable. At the 24 October 2026 cutover it was unset. [AIR-81](https://trello.com/c/ywuOtfo0) planned the extra search and skipped it; the record is `docs/evidence/scored-resolver/air-81-parity.md`. [AIR-84](https://trello.com/c/E7wlg7uV) sent the searches on a later generation and recorded INSUFFICIENT DATA in `docs/evidence/scored-resolver/air-84-shadow.md`. The flag was removed again after that sample. [AIR-86](https://trello.com/c/INQy9Hca) counted every stored `retryAt` in `docs/evidence/scored-resolver/air-86-census.md`, then replayed 38 of those rows without writing production. The result is `docs/evidence/scored-resolver/air-86-replay.md`: 2 of 38 reached `detail_verified`. At the [AIR-68](https://trello.com/c/qbLDc6Ql) cutover on 24 October, `CANDIDATE_DISCOVERY` remained unset while scored resolution became the writer. While the scored gate was the only resolver ([ADR 0036](../../adr/0036-scored-resolution-only.md)), this variable was the only optional switch of the discovery path. That sentence is superseded in part by ADR 0082.

While the flag was `on`, the extra hits were fed to the scored writer, which still verified only after `detail_verified`. An exact title found at the neighbouring year could. A reversible structural form could too, after the detail card repeated that form, the id, the year, and the runtime. A `tmdb_alias` proposal was not passed to the scorer.

[AIR-81](https://trello.com/c/ywuOtfo0) recorded NO-GO. [AIR-83](https://trello.com/c/3wmMNyWo) keeps a plan that misses the chunk deadline. [AIR-84](https://trello.com/c/E7wlg7uV) ran that plan on production and is INSUFFICIENT DATA. It does not approve `on`. The subsequently approved [AIR-68](https://trello.com/c/qbLDc6Ql) changed scored resolution to `on` without enabling optional candidate discovery. Those NO-GO and INSUFFICIENT DATA results remain valid for their measured samples. They are not a plan to turn the search back on. Authoritative rows do not need a rewrite.

The extra search used `tmdbRequest` and did not increment `tmdbCalls`. The chunk result recorded `variantCalls`, `variantErrors`, `variantThrottled` and `variantSkipped` separately. One observation could plan 4 search queries, then up to 3 movie-detail reads for alternative titles, then one verification read when the score was already `accepted`. That was at most 8 optional TMDB requests, and the chunk cap was also 8. A query started only when more than 12 seconds remained. If the optional search could not finish inside the chunk, the writer recorded no `retryAt`, so the observation stayed on the normal queue; no plan was stored. The former shadow plan file `epg/discovery-variant-pending.json` was neither read nor written, and a leftover copy was ignored. A generation change and an HTTP 429 stopped optional work. The first HTTP 429 set `variantThrottled` and stopped every later optional request in the chunk; those unsent requests were `variantSkipped`. A timeout or other error was counted in `variantErrors`. A missing year (`null`, absent, or `''`) did not become year 0.

The generator below is what `scripts/air-86-variant-generator.js` still reproduces for the AIR-86 manifest. The Worker does not run it.

When several historical search rows failed the title check, up to three were ordered by year distance, then runtime distance, then shared title tokens, and each was read for translations and alternative titles while the attempt cap remained. The matching id was recorded as `tmdb_alias`. It was not passed to the scorer as an alias, so it stayed a proposal.

Variants, in the order the generator planned them:

| Reason | Query |
| --- | --- |
| `part_suffix` | Drop a trailing `1` or `2` when the stem contains a letter. `1984` and `7500` have no stem to drop. |
| `spelling_e` | On a single token of at most eight characters, swap `е` and `э`. `Блейд` and `Блэйд` meet. A hyphenated or multi-word title does not. |
| `numeral` | A leading `1`–`12` followed by Cyrillic becomes the Russian word. `11 друзей Оушена` becomes `одиннадцать друзей Оушена`. |
| `year_before`, `year_after` | The original title at one year either side. |

A historical hit was kept when its year was within one of the observation, and its title equalled the variant, equalled the observation, or one title extended the other by another token. Only an exact title match on `part_suffix`, `spelling_e`, or `numeral` was attached as structural evidence. The scorer still recomputes that form when a candidate reaches it by the ordinary search or a known alias. The detail competitor list includes films indexed under that form as well as under the EPG title. `Бегущий человек` in 1987 does not keep a 2025 edition. The experimental preview field `proposedCandidates` recorded the id, query, year, and reason. The current writer does not add that field.

[AIR-86](https://trello.com/c/INQy9Hca) froze these rows before the reversible rule. The replay left them `no_exact_title`. With the reversible check and a confirming detail card, the local fixtures of that experiment scored as follows. Nothing here was fetched again. The current writer does not send the searches that found these rows.

| Observation | Found title | AIR-86 | After the reversible check |
| --- | --- | --- | --- |
| `11 друзей оушена\|2001` | Одиннадцать друзей Оушена, 161 | `no_exact_title` | `accepted_numeral`, then `detail_verified` when the detail repeats that title |
| `12 друзей оушена\|2004` | Двенадцать друзей Оушена, 163 | `no_exact_title` | `accepted_numeral` |
| `матрица 1\|1999` | Матрица, 603 | `no_exact_title` | `accepted_part_suffix` for the first part only |
| `чужой против хищника 1\|2004` | Чужой против Хищника, 395 | `no_exact_title` | `accepted_part_suffix` |
| `блейд 1\|1998` | Блэйд, 36647 | `no_exact_title` | `accepted_spelling_e` of the first-part stem, with the year still checked |
| `гол 2\|2008` | Гол 2: Жизнь как мечта, and a bare «Гол» | `no_exact_title` | still `no_exact_title`; dropping `2` does not prove which Goal it is |
| `чудо женщина\|2020` | Кровные узы, 1984, and the 2017 catalog film | `contradicted_year` | unchanged; a longer title is not the form |
| `чебурашка 2\|2025` | Чебурашка 2, 1228477 | `detail_verified` | unchanged literal neighbouring year |
| `убежище\|2022` | Убежище / Refuge, 801970, beside Shelter 1290821 | `detail_verified` | `needs_verification` / `short_title_adjacent_year`; the id stays a proposal |
| `код 8 часть 2\|2024`, `мортал комбат\|1995` | alias text only | not scored | still not scored |

If no historical hit matched, up to three year-compatible rows were ordered by year distance, then runtime distance, then shared title tokens. Each was read for translations and alternative titles while the chunk cap remained. A matching title was recorded as `tmdb_alias` and was not given to the scorer. The id was a proposal. `Мортал Комбат` stayed `no_confident_match` even when it was not the first search row. A longer title such as `Чудо-женщина: 1984` was a proposal for `Чудо-женщина`, not an acceptance.

An exact title at the neighbouring year, such as `Ирония судьбы` in 1976, was a scorer candidate of that experiment: when the detail card repeated the id, the year and the runtime, that writer verified it and created the catalog row. The current writer does not search the neighbouring year, so that path does not verify the observation or create the row.
