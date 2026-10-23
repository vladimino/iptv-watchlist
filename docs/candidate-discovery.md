# Candidate discovery

[AIR-80](https://trello.com/c/hQPjVTXv) adds search variants for an EPG title. The acceptance gate is unchanged. A search hit is not a verified decision.

`CANDIDATE_DISCOVERY` accepts only `shadow` or `on`. Unset and any other text are off. The repository does not commit the variable. Production has a dashboard-only `shadow` binding from the AIR-81 experiment. That experiment did not send the extra search: the plans were skipped after the legacy loop had used the chunk deadline. The record is `docs/air-81-parity.md`.

`shadow` pairs with `SCORED_RESOLUTION=shadow`. The extra hits update the preview only. The legacy decision and the catalog stay as the legacy branch wrote them. `on` pairs with `SCORED_RESOLUTION=on` and feeds the same hits to the existing scored writer, which still verifies only after `detail_verified`. A spelling proposal or a `tmdb_alias` proposal is not title evidence for that gate, so it cannot become `verified` by itself. An exact title found at the neighbouring year can. Setting only one of the two variables does not activate the search, and the legacy `else` branch never calls it.

[AIR-81](https://trello.com/c/ywuOtfo0) set `CANDIDATE_DISCOVERY=shadow` next to the existing `SCORED_RESOLUTION=shadow` and recorded NO-GO in `docs/air-81-parity.md`. It does not approve `on`. [AIR-83](https://trello.com/c/3wmMNyWo) is the deadline skip that kept `variantCalls` at 0. [AIR-68](https://trello.com/c/qbLDc6Ql) is the `on` cutover, and only after a later positive GO and after [AIR-42](https://trello.com/c/drLBuWjl). Rollback of the extra search is unsetting `CANDIDATE_DISCOVERY`. Authoritative rows do not need a rewrite.

The extra search uses `tmdbRequest`. It does not increment `tmdbCalls`. The chunk result and `epg/discovery-status.json` record `variantCalls`, `variantErrors`, `variantThrottled`, `variantSkipped`, and `variantDeferred` separately. One observation may plan 4 search queries, then up to 3 movie-detail reads for alternative titles, then one verification read when the score is already `accepted`. That is at most 8 optional TMDB requests, and the chunk cap is also 8, so one observation can use the whole optional budget. A query starts only when more than 12 seconds remain. When the legacy loop has already used that window, the observation is not searched again through `retryAt`: that backoff would hide it. The plan is stored in `epg/discovery-variant-pending.json` for the same `programmeRunId` and is run on a later resolve, still inside that resolve's deadline, without clearing `retryAt` and without rewriting the legacy decision. `variantDeferred` counts those stored plans. A changed published generation drops them. The first HTTP 429 sets `variantThrottled` and stops every later optional request in the chunk; those unsent requests are `variantSkipped` and are not stored for the next resolve. A timeout or other error is counted in `variantErrors` and does not stop the later variants. A missing year (`null`, absent, or `''`) does not become year 0.

When several search rows fail the title check, up to three are ordered by year distance, then runtime distance, then shared title tokens, and each is read for translations and alternative titles while the attempt cap remains. The matching id is recorded as `tmdb_alias`. It is not passed to the scorer as an alias, so it stays a proposal.

Variants, in order:

| Reason | Query |
| --- | --- |
| `part_suffix` | Drop a trailing `1` or `2` when the stem contains a letter. `1984` and `7500` have no stem to drop. |
| `spelling_e` | On a single token of at most eight characters, swap `е` and `э`. `Блейд` and `Блэйд` meet. A hyphenated or multi-word title does not. |
| `numeral` | A leading `1`–`12` followed by Cyrillic becomes the Russian word. `11 друзей Оушена` becomes `одиннадцать друзей Оушена`. |
| `year_before`, `year_after` | The original title at one year either side. |

A hit is kept when its year is within one of the observation, and its title equals the variant, equals the observation, or one title extends the other by another token. `Бегущий человек` in 1987 does not keep a 2025 edition. The preview field `proposedCandidates` records the id, query, year, and reason.

If no hit matches, up to three year-compatible rows are ordered by year distance, then runtime distance, then shared title tokens. Each is read for translations and alternative titles while the chunk cap remains. A matching title is recorded as `tmdb_alias` and is not given to the scorer. The id is a proposal. `Мортал Комбат` stays `no_confident_match` even when it is not the first search row. A longer title such as `Чудо-женщина: 1984` is a proposal for `Чудо-женщина`, not an acceptance.

An exact title at the neighbouring year, such as `Ирония судьбы` in 1976, is a real scorer candidate. Shadow may then show `detail_verified` on the preview. The stored decision stays the legacy `no_confident_match`, and no catalog row is created.
