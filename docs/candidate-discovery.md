# Candidate discovery

[AIR-80](https://trello.com/c/hQPjVTXv) adds search variants for an EPG title. The acceptance gate is unchanged. A search hit is not a verified decision.

`CANDIDATE_DISCOVERY` accepts only `shadow` or `on`. Unset and any other text are off. The repository does not commit the variable. Production leaves it unset, so the extra search does not run.

`shadow` pairs with `SCORED_RESOLUTION=shadow`. The extra hits update the preview only. The legacy decision and the catalog stay as the legacy branch wrote them. `on` pairs with `SCORED_RESOLUTION=on`. The same search then feeds the existing scored writer, which still verifies only after `detail_verified`. A spelling proposal or a `tmdb_alias` proposal is not title evidence for that gate, so it cannot become `verified` by itself. An exact title found at the neighbouring year can. Setting only one of the two variables does not activate the search, and the legacy `else` branch never calls it. [AIR-81](https://trello.com/c/ywuOtfo0) is the approval to turn the pair on in production. [AIR-68](https://trello.com/c/qbLDc6Ql) is the later cutover.

The extra search uses `tmdbRequest`. It does not increment `tmdbCalls`. The chunk result and `epg/discovery-status.json` record `variantCalls`, `variantErrors`, `variantThrottled`, and `variantSkipped` separately. A 429 increments `variantThrottled` and does not fail the chunk. A candidate plans at most 4 variant queries. A chunk stops after 8 attempts. A query that would start with fewer than 12 seconds left is `variantSkipped`. A missing year (`null`, absent, or `''`) does not become year 0.

When several search rows fail the title check, up to three are ordered by year distance, then runtime distance, then shared title tokens, and each is read for translations and alternative titles while the attempt cap remains. The matching id is recorded as `tmdb_alias`. It is not passed to the scorer as an alias, so it stays a proposal.

Variants, in order:

| Reason | Query |
| --- | --- |
| `part_suffix` | Drop a trailing `1` or `2` when the stem contains a letter. `1984` and `7500` have no stem to drop. |
| `spelling_e` | On a single token of at most eight characters, swap `е` and `э`. `Блейд` and `Блэйд` meet. A hyphenated or multi-word title does not. |
| `numeral` | A leading `1`–`12` followed by Cyrillic becomes the Russian word. `11 друзей Оушена` becomes `одиннадцать друзей Оушена`. |
| `year_before`, `year_after` | The original title at one year either side. |

A hit is kept when its year is within one of the observation, and its title equals the variant, equals the observation, or one title extends the other by another token. `Бегущий человек` in 1987 does not keep a 2025 edition. The preview field `proposedCandidates` records the id, query, year, and reason.

If no hit matches and one returned film is within a year, one movie-detail read can record `tmdb_alias` when a translation or alternative title equals the observation. That alias is not given to the scorer. The id is a proposal. `Мортал Комбат` stays `no_confident_match`. A longer title such as `Чудо-женщина: 1984` is a proposal for `Чудо-женщина`, not an acceptance.

An exact title at the neighbouring year, such as `Ирония судьбы` in 1976, is a real scorer candidate. Shadow may then show `detail_verified` on the preview. The stored decision stays the legacy `no_confident_match`, and no catalog row is created.

Rollback is unsetting `CANDIDATE_DISCOVERY`. Authoritative rows do not need a rewrite.
