# Candidate discovery

[AIR-80](https://trello.com/c/hQPjVTXv) adds search variants for an EPG title. A search hit is not a verified decision by itself. [AIR-95](https://trello.com/c/kD8xjvVu) lets the scorer treat one reversible form as title evidence: a numeral word, a trailing `1` removed from the title, or the single `е`/`э` swap the variant generator already produces. The movie title or original title must equal that form exactly. The detail gate repeats the same check. A prefix, a trailing `2` reduced to its stem, and a `tmdb_alias` still are not title evidence.

`CANDIDATE_DISCOVERY` accepts only `on`; the former `shadow` preview mode went with the legacy resolver. Unset and any other text are off. The repository does not commit the variable. At the 24 October 2026 cutover it was unset; verify the live Cloudflare binding before relying on that observation. [AIR-81](https://trello.com/c/ywuOtfo0) planned the extra search and skipped it; the record is `docs/air-81-parity.md`. [AIR-84](https://trello.com/c/E7wlg7uV) sent the searches on a later generation and recorded INSUFFICIENT DATA in `docs/air-84-shadow.md`. The flag was removed again after that sample. [AIR-86](https://trello.com/c/INQy9Hca) counted every stored `retryAt` in `docs/air-86-census.md`, then replayed 38 of those rows without writing production. The result is `docs/air-86-replay.md`: 2 of 38 reached `detail_verified`. At the [AIR-68](https://trello.com/c/qbLDc6Ql) cutover on 24 October, `CANDIDATE_DISCOVERY` remained unset while scored resolution became the writer; since the scored gate became the only resolver ([ADR 0035](../../adr/0035-scored-resolution-only.md)) this variable is the only optional switch of the discovery path. Confirm later Dashboard state rather than treating this dated observation as permanent.

`on` feeds the extra hits to the scored writer, which still verifies only after `detail_verified`. An exact title found at the neighbouring year can. A reversible structural form can too, after the detail card repeats that form, the id, the year, and the runtime. A `tmdb_alias` proposal is not passed to the scorer. Nothing else needs to be set: the scored resolver is always active.

[AIR-81](https://trello.com/c/ywuOtfo0) recorded NO-GO in `docs/air-81-parity.md`. [AIR-83](https://trello.com/c/3wmMNyWo) keeps a plan that misses the chunk deadline. [AIR-84](https://trello.com/c/E7wlg7uV) ran that plan on production and is INSUFFICIENT DATA in `docs/air-84-shadow.md`. It does not approve `on`. The subsequently approved [AIR-68](https://trello.com/c/qbLDc6Ql) changed scored resolution to `on` **without enabling optional candidate discovery**. The earlier NO-GO and INSUFFICIENT DATA results remain valid for their measured samples; enabling variant search is a separate owner-approved action. Rollback of the extra search is unsetting `CANDIDATE_DISCOVERY`. Authoritative rows do not need a rewrite.

The extra search uses `tmdbRequest`. It does not increment `tmdbCalls`. The chunk result and `epg/discovery-status.json` record `variantCalls`, `variantErrors`, `variantThrottled` and `variantSkipped` separately. One observation may plan 4 search queries, then up to 3 movie-detail reads for alternative titles, then one verification read when the score is already `accepted`. That is at most 8 optional TMDB requests, and the chunk cap is also 8, so one observation can use the whole optional budget. A query starts only when more than 12 seconds remain. If the optional search cannot finish inside the chunk, the writer records no `retryAt`, so the observation stays on the normal queue and a later chunk can search again; no plan is stored. The former shadow plan file `epg/discovery-variant-pending.json` is neither read nor written, and a leftover copy is ignored. A generation change and an HTTP 429 still stop optional work. The first HTTP 429 sets `variantThrottled` and stops every later optional request in the chunk; those unsent requests are `variantSkipped`. A timeout or other error is counted in `variantErrors` and does not stop the later variants. A missing year (`null`, absent, or `''`) does not become year 0.

When several search rows fail the title check, up to three are ordered by year distance, then runtime distance, then shared title tokens, and each is read for translations and alternative titles while the attempt cap remains. The matching id is recorded as `tmdb_alias`. It is not passed to the scorer as an alias, so it stays a proposal.

Variants, in order:

| Reason | Query |
| --- | --- |
| `part_suffix` | Drop a trailing `1` or `2` when the stem contains a letter. `1984` and `7500` have no stem to drop. |
| `spelling_e` | On a single token of at most eight characters, swap `е` and `э`. `Блейд` and `Блэйд` meet. A hyphenated or multi-word title does not. |
| `numeral` | A leading `1`–`12` followed by Cyrillic becomes the Russian word. `11 друзей Оушена` becomes `одиннадцать друзей Оушена`. |
| `year_before`, `year_after` | The original title at one year either side. |

A hit is kept when its year is within one of the observation, and its title equals the variant, equals the observation, or one title extends the other by another token. Only an exact title match on `part_suffix`, `spelling_e`, or `numeral` is attached as structural evidence. The scorer recomputes that form from the observation and keeps every distinct valid claim, including when the exact title arrives in a later chunk for an id already stored. The detail competitor list includes films indexed under that form as well as under the EPG title. `Бегущий человек` in 1987 does not keep a 2025 edition. The preview field `proposedCandidates` records the id, query, year, and reason.

[AIR-86](https://trello.com/c/INQy9Hca) froze these rows before this rule. The replay left them `no_exact_title`. With the reversible check and a confirming detail card, the local fixtures now score as follows. Nothing here was fetched again.

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

If no hit matches, up to three year-compatible rows are ordered by year distance, then runtime distance, then shared title tokens. Each is read for translations and alternative titles while the chunk cap remains. A matching title is recorded as `tmdb_alias` and is not given to the scorer. The id is a proposal. `Мортал Комбат` stays `no_confident_match` even when it is not the first search row. A longer title such as `Чудо-женщина: 1984` is a proposal for `Чудо-женщина`, not an acceptance.

An exact title at the neighbouring year, such as `Ирония судьбы` in 1976, is a real scorer candidate: when the detail card repeats the id, the year and the runtime, the writer verifies it and creates the catalog row; otherwise the observation keeps its `no_confident_match` decision and no row is created.
