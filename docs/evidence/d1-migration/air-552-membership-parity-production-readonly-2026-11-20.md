# View index membership parity: one read-only production cut

**Date:** 2026-11-20 UTC, window 15:29:47 to 15:30:01 (16:29 to 16:30 Europe/Madrid). **Source tree:** `main` `117d9a0` (the classifier `scripts/view-index-membership-parity.mjs` and the overlays it models are unchanged since [PR #812](https://github.com/vladimino/iptv-watchlist/pull/812)). **Work:** [AIR-552](https://trello.com/c/Hk2dJf2U); decision [ADR 0183](../../adr/0183-view-index-membership-from-d1-rows.md) (Accepted target design A); earlier analysis [offline analysis](air-552-membership-options-offline-2026-11-20.md).

## Authorization and boundary

One owner-approved, scoped, read-only comparison ([owner decision](https://trello.com/c/Hk2dJf2U#comment-6b005e464d8174c52aca7148), executor handoff on the card): the key set of the single R2 object `enrichment/view-index.json` in bucket `iptv` against the film ids of three D1 tables, plus the compiled ratings seed. Nothing was written to R2 or D1; no setting, flag, Task, lease, writer or Access rule was touched, and no authority marker changed. The result is **evidence for the owner's review**; it does not accept any difference, switch anything, or authorize the implementation.

No raw payload, film id or title is recorded here, only counts and shapes. The R2 object was read into memory of a local process, reduced to its key list, and not kept. Nothing was committed or posted outside this report and the Trello comment.

## Identity and preflight

| Item | Observed |
| --- | --- |
| D1 database | `iptv`, uuid `3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb`, equal to `wrangler.jsonc` `database_id` and to the Cloudflare listing (one database named `iptv`, `production`) |
| Schema | `schema_contract.version` **28**, before and after |
| Prediction marker | `d1`, `writes=held` (the historical import fence, normal under [ADR 0162](../../adr/0162-d1-only-authority-retire-rollback-toolchain.md)), generation **30655** before and after, queue generation 2663 |
| Ratings marker | `d1`, `cutover=open`, generation **4158** before and after |
| R2 object | `enrichment/view-index.json`, ETag `c3244641b8e43be55a97050260fe7dec`, **13,809,022 bytes**, last modified 2026-11-20 15:27:17 GMT, SHA-256 of the received bytes `554939f112082c2246c3b2106d295e6261f410f84e1754ff1affb534dc903e57` |
| Compiled seed | Not verified in the deployed bytes (see limits). The repository seed `src/ratings-seed.js` is `{}` and `build.mjs` embeds it; no workflow step replaces it. The cut used the empty seed |

## Method and read-only proof

- **R2:** a read-only bucket-scoped Object Read credential, the repository's own GET/HEAD-only client (`createReadOnlyClient`, `retries: 0`), not the full-bucket exporter. Calls: one HEAD, one GET with `If-Match` of that ETag, one closing HEAD; **0** listings. The ETag was identical at the first HEAD, the GET and the closing HEAD.
- **D1:** the Cloudflare REST query endpoint through a helper that refused anything but a single `SELECT` before a request was made and rejected any answer whose `meta` was not `changed_db: false, rows_written: 0` (none was rejected). 62 statements in total: 7 in the preflight (three markers, three counts, one ratings distinct count), 6 marker reads inside the window, and 49 keyset pages of 300:

```sql
SELECT version FROM schema_contract;
SELECT mode, writes, generation, queue_generation FROM prediction_domain_authority;
SELECT mode, cutover, generation FROM ratings_domain_authority;
SELECT film_id FROM prediction_pointer WHERE film_id > ? ORDER BY film_id LIMIT ?;
SELECT film_id FROM prediction_fingerprint WHERE film_id > ? ORDER BY film_id LIMIT ?;
SELECT alias_id, rating_known, actual_rating, watched, watchlist FROM ratings_view WHERE alias_id > ? ORDER BY alias_id LIMIT ?;
```

  No `display_json` or `features_json` column was selected. The rows read equal the rows returned on every page.
- **Window:** one 14-second pass, R2 first, then D1, then the markers and the R2 HEAD again. The cut is **not atomic** across the two stores; it is comparable because the R2 ETag and both authority generations were unchanged across it. No writer or lease was frozen and no repeat was made.
- **Classification:** the keys went offline into `compareMembership` (the seed `{}`). The invariants were then recomputed by separate set arithmetic in a second script.

## Result

| Quantity | Value |
| --- | --- |
| Raw view-index keys | **5,380** (4,922 `tmdb_<n>`, 458 short lid-like ids; no other spelling) |
| `prediction_pointer` ids | **4,947** (4,947 unique, 17 pages) |
| `prediction_fingerprint` ids | **4,947** (4,947 unique, 17 pages); the set is **identical** to the pointer set |
| `ratings_view` aliases | **4,494** (4,494 unique, 15 pages); 3,874 `rating_known=1`, of which 16 are an explicit null; 620 `rating_known=0` |
| Today's key set (raw ∪ ratings aliases ∪ seed) | **8,158** |
| Union key set (pointer ∪ fingerprint ∪ ratings ∪ seed) | **8,158** |
| `removedKeys` | **0** |
| `newKeys` | **0** |
| `forecastGains`, `featureGains` (`forecastOnly`, `featuresOnly`, `forecastAndFeatures`) | **0, 0** (0, 0, 0) |
| Gains on an already existing key (ratings alias or seed) | 0 |
| Seed (`nullWins`, `ratingsWin`, `fills`, `onlyKeys`) | 0, 0, 0, 0: the seed is empty |

Independent arithmetic: `today − union = 0` and `union − today = 0`; every one of the 4,947 pointer ids and 4,947 fingerprint ids is already a raw key; every raw key is in at least one D1 table (`raw − (pointer ∪ fingerprint ∪ ratings) = 0`). Composition: 433 raw keys have no prediction row and are kept by their `ratings_view` alias; 3,664 raw keys have no ratings row and are kept by their prediction rows; 2,778 `ratings_view` aliases are not raw keys, so today's overlay already adds them (the raw object holds 5,380 keys, the full view 8,158).

Raw entries, as counts only: 4,947 carry a `prediction` and a `fingerprintHash`, 568 an `actualRating`, 293 a `watched`, 802 a `watchlist`; none is empty. Those fields are replaced at read by the overlays and are not part of the comparison.

## Business impact of the differences

There are none to assess: no removed key, no new key and no forecast or feature gain. Consequently, on this cut, the identity bridge candidate list, the Admin health `entries` count, the operator Letterboxd scripts' lid targets, Finds eligibility, the footer prediction coverage, queue freshness and the mood and mechanics filters would receive exactly the same ids and the same field values under the union as today. Watched, rating and watchlist facts come from the same `ratings_view` rows in both models, so they are preserved by construction; the 16 explicit nulls stay nulls while the seed is empty. The `LetterboxdFacts.readJSON` path (ratings overlay only) needs the `ratings_view` aliases, which the union contains.

## Resource budget

49 keyset pages in total. The largest table has 4,947 rows, **24.7%** of the existing 20,000-row overlay cap, a margin of about 4×; no page read more rows than it returned. The raw object is 13.8 MB, against 11.3 MB in the [17 November measurement](../footer-status-oom-rca-2026-11-17.md), which is the object a switch stops reading. CPU, Worker memory and per-request D1 latency were **not measured**: this was an offline cut, not a Worker request.

## Limits

- One non-atomic cut at one instant. Membership changes as predictions and ratings are written; the cut shows parity at 15:29 to 15:30 UTC and does not bound later drift. It should be repeated under a fresh approval immediately before any controlled switch.
- The compiled seed of the **deployed** build was not read: the token used has no Workers read access (HTTP 403, nothing else tried). The empty repository seed is the expectation, not a proof. With a non-empty private seed the seed categories above would need to be recomputed.
- Alias collisions (one film under two spellings) cannot be seen by comparing id strings and are irrelevant here because the two key sets are equal, but this audit says nothing about duplicate films.
- Field values (as opposed to ids) were not compared: they come from the same overlays in both models, which is covered by the offline tests, not by this cut.
- The 62 D1 statements and the three R2 requests are the only production reads; the single HTTP 403 on the Workers script endpoint touched no data.

## Verdict and recommendation

**Option A is confirmed by this cut** as far as membership is concerned: at this instant the D1-derived key set is identical to the key set the Worker serves today, with no removed key, no new key, no forecast gain and no feature gain, and with a roughly 4× margin to the row caps. B (an explicit membership table) and a targeted preservation of ids are not indicated by the data. This is a recommendation for the owner's review, not an acceptance of any difference and not a permission to implement or switch. AIR-552 stays open: the implementation PR, the temporary selector, the controlled switch under its own owner plan, a repeat of this comparison before it, the readback and acceptance remain.
