# AIR-652: offline RCA and preflight of the historical bridge-only prediction keys

Date: **25 November 2026**. Scope: **offline only** (repository code at `main` `4ec19bb`, synthetic fixtures, dated evidence already recorded). No production read, no write, no flag, no Task. Card: [AIR-652](https://trello.com/c/WLBx05Y9) (ADR 0216 delivery step 7). Source finding: [AIR-627](https://trello.com/c/IOERZ9GI). Existing proof and writer: [AIR-559](https://trello.com/c/733sRAxu), [ADR 0184](../../adr/0184-ratings-confirmed-letterboxd-claim-on-existing-film.md) (unchanged). Downstream: [AIR-653](https://trello.com/c/YSPVkb1M).

**Verdict.**
- The earlier zero cohort of AIR-559 is **explained by scope, not by a verdict**: the backfill never looked at these keys.
- **No key can be called eligible from existing evidence.** The AIR-627 statement that all 15 are candidates rests on the link index alone. The ADR 0184 proof reads more, and one part of it is blind by design.
- A bounded private preflight (below) is the next step. It needs its own authorization. **This report grants none and starts none.**

The 15 keys, 4 Films without another pointer, 11 with a second pointer and 5 with a different value are the AIR-627 dated census (ratings g4442, predictions g46576, 25 Nov 2026), not live counts.

## 1. Why the AIR-559 cohort did not contain them

| Question | Answer | Source |
| --- | --- | --- |
| Where does the backfill take its candidates? | Only lids of the **current published programme run** (`published_epg_member`) that hold no trusted `letterboxd` claim. | `CANDIDATE_SQL` in `src/letterboxd-claim-backfill.js` |
| What did the dry run report? | `already_current`, cohort 0, no blockers, on 24 Nov 2026. | [activation preflight](../d1-migration/air-559-claim-activation-preflight-2026-11-24.md) |
| What follows? | A lid of the run that lacked a claim would have given cohort above 0, or a blocker. Cohort 0 with no blocker means **none of the missing-claim lids was in the run.** The 15 keys lack a trusted claim (AIR-627), so they are outside it. | inference from the two rows above |
| Does the producer reach them? | No. The natural producers offer only pairs they verified themselves in that step (Diary, Watchlist admission). A lid that the Ratings protocol already linked is not offered; the 24 Nov Ratings run considered 0 ids. | same preflight, "What the activation would change" |

The control in the test inserts one such lid into the run and it becomes a candidate at once. The reason is therefore the **candidate source**, not the ADR 0184 proof. The inference is as strong as the two dated readings; the test proves the code half offline, and a fresh run is not needed to establish it.

## 2. Why "all 15 are candidates" is not yet "eligible"

AIR-627 checked the live link index: `letterboxd:<lid>` and `tmdb:<n>` name one fact key, one movie alias, no competing claim. The planner `planLetterboxdClaim` additionally reads or requires:

| Check | Read by the AIR-627 L0 | Consequence for the 15 |
| --- | --- | --- |
| Fact record states the same lid and movie, not a redirect, not mid-migration | not stated | unknown |
| Record carries no `identity` mark and no `inferredPairs` entry for the pair | not stated | unknown |
| `ratings_view` corroboration (no alias of either id on another key) | not stated | unknown |
| One trusted `tmdb` claim, Film exists, no redirect, movie not retired, `canonical_identity` null or `tmdb:<n>` | partly (claims, retirement ledger) | unknown for the rest |
| **Legacy unmarked inferred pair** | **not detectable by the planner** | see below |

**The planner's documented limit.** A pair linked by the inferred import before AIR-559, on a record that already held facts, carries neither durable mark. The planner answers `pass`. The [legacy pair audit](../d1-migration/air-559-legacy-inferred-pair-audit-2026-11-23.md) found **one** such pair on 23 Nov 2026, **not a member of the published run**, with a Film that has one trusted `tmdb` claim: the planner would pass it. Whether it is one of the 15 is **unknown offline**. A promotion cohort must therefore be screened with that audit's admission witness (D1 `film_rated_admission` row of an inferred-import archive with the same lid and movie) in addition to the planner. A planner `pass` alone is not `eligible`.

Two further observations, both pinned by the test:
- A key whose lid key shares no movie alias cannot be resolved to a movie from the authoritative index (the backfill's `ratings_movie_link_missing_or_ambiguous`). The planner's `ratings_link_points_elsewhere` is unreachable from this discovery; it stays a write-time guard.
- Promotion adds a trusted claim only. It does **not** reconcile the 5 Films whose two pointers differ, and it creates no lineage for the 15 (0 today). Those stay with the aggregate's `partial` and [AIR-649](https://trello.com/c/AmxRHJOS)/[AIR-650](https://trello.com/c/gYGqljS9).

## 3. Not a blocker for the aggregate

[AIR-647](https://trello.com/c/WKSwJOwm) already covers the reader side: `tests/film-aggregate.mjs` case 19 returns `predictions: partial` with `unresolved_candidate`, never `none`, and never returns the candidate's value. After a later promotion the key becomes a direct claim (AIR-627 acceptance case 10). Nothing here depends on promotion being done or authorized.

## 4. Reproducible offline fixture and cohort accounting

`tests/prediction-alias-bridge-cohort.mjs` (core suite, `node tests/prediction-alias-bridge-cohort.mjs`). Synthetic ids only, sqlite3-CLI D1 stand-in over the full migration chain, no apply path imported (asserted statically). It runs the **real** `planLetterboxdClaim` and `deriveBackfillCohort`.

Fixture shape follows the AIR-627 finding: 15 keys, 4 bridge-only, 11 with a second pointer, 5 of those with a different value. Each key is given one designed situation:

| Class | Keys | Reasons |
| --- | ---: | --- |
| `eligible` | 3 | `proved` (one with `canonical_identity` NULL, allowed by ADR 0184 2c) |
| `ineligible` | 8 | `ratings_link_inferred` (record mark, and `inferredPairs`), `ratings_link_ambiguous`, `ratings_record_not_settled`, `film_redirected`, `tmdb_retired`, `canonical_identity_mismatch`, `lid_claimed_elsewhere` (untrusted claim; a trusted one removes the key from the discovery) |
| `unknown` | 4 | `legacy_inferred_pair_suspected` (planner `pass`, admission witness), `ratings_movie_link_missing_or_ambiguous` (two keys), `film_absent` |
| `already` | 0 | none by construction: a key with a trusted claim is not bridge-only |
| **Total** | **15** | total = eligible + ineligible + unknown + already, asserted |

These are the fixture's designed outcomes. **They are not a prediction of the production result.** Infrastructure states (a held Film/Person marker, a ratings domain that is not `d1`) are `unknown` (`film_person_not_open`, `ratings_not_authoritative`), never a verdict. Classification writes nothing (a before/after dump of 17 tables is asserted equal; 0 receipts).

**Read cost, measured on the stand-in.**
- Discovery is one statement with an indexed claim anti-join (`EXPLAIN QUERY PLAN` asserted: an index of `film_external_id`, no full scan of it), bounded by `LIMIT`.
- Classification costs up to **24 D1 statements per key** (the measured worst case, pinned), fewer on refusal.
- The link index (`letterboxd/facts/links.json`, a 128 KB multi-part document on 25 Nov) is **re-read for every key**, so the production row cost per key is above its statement count.
- For 15 keys: at most 360 statements, plus one discovery statement. A private run should read the index once per run.

## 5. Preflight for a possible separate L3 operation (not executed)

If the owner wants the live verdict, it needs its own authorization and a plan before any read. Proposed bounded read-only shape, for that decision:

1. Verify the markers (Film/Person, ratings, prediction) and record their generations before and after.
2. One discovery statement of §4, `LIMIT 64`. If it returns more than 15 plus a small margin, stop and report the count.
3. Read the link index and the fact record of each key **once**, offline from a single read. Evaluate the planner predicates and the admission witness locally; supply the inferred-import archive digest privately.
4. Per key: `film_external_id` rows for the lid, the movie and the owner Film; `film_redirect`, the retirement ledger, `film_rated_admission`. All by indexed key.
5. Report **counts per class and reason only**. No lid, movie, key, rating or document body goes to GitHub or Trello. A cohort digest in the form of `cohortDigest` may be recorded.
6. Stop on a moved generation or an unreadable document. Unknown stays unknown.

The result would be input for [AIR-653](https://trello.com/c/YSPVkb1M) only. It would not itself freeze a cohort for a write.

## 6. Limits and unknowns

- The 15-key census is dated. Nothing here refreshes it.
- R2 prediction bodies were not checked (AIR-627 unknown); pointer existence is all that is established.
- Whether the legacy unmarked inferred pair is among the 15 is unknown.
- The fixture proves classification logic and the scope explanation. It proves nothing about any real key.
- The full-suite `npm run test:all` and `npm run build` results are in the PR body.

## 7. Decision boundary

No bridge, rename, promotion, backfill, activation, flag, Task, migration or production read is authorized or performed. ADR 0184 and the [runbook](../../runbooks/letterboxd-claim-backfill.md) are unchanged: the finding in §2 is a limit already stated there; a contract change would need the proven result of a private preflight first.
