# Candidate discovery

[AIR-80](https://trello.com/c/hQPjVTXv) adds search variants for an EPG title. The acceptance gate is unchanged. A search hit is not a verified decision.

`CANDIDATE_DISCOVERY=shadow` is the only value that runs the extra search. Unset, empty, and `on` are off. The repository does not commit the variable. Production `SCORED_RESOLUTION` stays `shadow`. This gate stays off until [AIR-81](https://trello.com/c/ywuOtfo0).

The extra search runs only beside an existing shadow comparison, and only when the first score has no exact title. It uses `tmdbRequest`, so it does not spend the legacy 16-call counter and a 429 does not fail the chunk. A candidate stops after 4 variant queries. A chunk stops after 8. Each query waits for 12 seconds of chunk time. The legacy decision and the catalog are written before this search and are not rewritten from it. `SCORED_RESOLUTION=on` does not call it.

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
