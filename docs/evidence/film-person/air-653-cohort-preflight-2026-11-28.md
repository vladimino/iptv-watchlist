# AIR-653: the first bounded read-only production capture of the historical bridge-only cohort (28 Nov 2026 08:57 UTC)

Dated, sanitized record of one read-only production capture of the [AIR-652](air-652-prediction-alias-bridge-cohort-preflight-2026-11-25.md) design, run by the executor under the Controller's handoff for a bounded read-only preflight ([handoff](https://trello.com/c/YSPVkb1M#comment-6b0a92fcb065c5a1c9e2f01d)). Times are UTC. Card: [AIR-653](https://trello.com/c/YSPVkb1M). It authorizes nothing: **a complete capture is not an eligibility proof, and no allowlist exists.** The exact lid-to-movie result stayed in a private file outside the repository and is not recorded here.

## What ran

The AIR-652 capture and its oracle (the unchanged claim planner on a private sqlite snapshot of the captured rows), through a read-only wrapper over the AIR-647 counted database: single `SELECT` statements, one shared statement and row budget charged before every statement, indexed predicates only, a second capture and a repeated discovery to fence movement. No Letterboxd or TMDB request, no write, flag, Task or lease. Caps: the AIR-652 defaults (300 statements, 6,000 rows reserved, 2,000 pointer rows per discovery pass, 64 candidates). Run 08:57:15 to 08:57:43 UTC against D1 `iptv` after the 0055 apply and its readback. No witness scope was supplied.

**Tool state at the time.** The wrapper was an uncommitted-to-`main` local build (the code is delivered by [PR #1078](https://github.com/vladimino/iptv-watchlist/pull/1078) and was independently reviewed only afterwards). That build (a) did not check the schema and index predicates before its reads, and printed the 0055, 0040 and unbounded-planner texts as a static list; (b) required a named archive scope for any eligible class. PR #1078's review required both to change; the corrected tool is not the one that produced these numbers.

## Result (capture decision `complete`, read set unmoved between the two passes)

| Fact | Value |
| --- | --- |
| Keys in the cohort | 15 (`bridge_resolved` 15, `bridge_unresolved` 0) |
| Pointer keys excluded as already holding a trusted `letterboxd` claim | 410 |
| Planner verdicts | 15 `pass` (no `conflict`, no `not_proved`) |
| Classes | `unknown / witness_scope_missing` 15; `eligible_in_scope` 0 |
| Distinct Films (resolved canonical ownership) | 15; unresolved owners 0 |
| Bridge-only (no second `tmdb_<n>` pointer) / dual / differing values | 4 / 11 / 5 (equal to the AIR-627 census) |
| Witness section | the digest of the empty list: no `film_rated_admission` row exists for any of the 15 movies, under any archive |
| Work | 98 statements (of 300), 4,988 rows reserved (of 6,000), 850 pointer rows over both discoveries; 99 requests, 4,906 rows read as reported by D1, **0 rows written** |
| Digests | read set `cdefe9a5fb45a08d876f185dcd4822fdb54aa9accea638c4c37319caec6048ec`; markers `535ce50c…`, documents `57c92833…`, claims `0e556edd…`, owner `e55b5c7a…`, views `bb153365…`, witness `4f53cda1…`, pointers `9464a0b3…`; candidate digest of the empty cohort `e3b0c442…` |

`unknown / witness_scope_missing` for all 15 means exactly this: every planner verdict is a `pass`, and the witness gate could not conclude without a valid scope. The total of `rows_read` (4,906 over 99 requests, smaller than one pass over the 4,513-row projection) shows no scan of `ratings_view`.

## What this does and does not establish

- **Established (state of 08:57 UTC):** the historical pointer cohort is 15 keys on 15 distinct Films, none with an unresolved owner; the unchanged planner passes all 15 on the captured read set; no admission row exists for these movies.
- **Not established:** eligibility. `eligible_in_scope` needs a planner `pass` plus a negative witness inside a stated, valid scope; a promotion needs a fresh re-proof at write time and its own owner GO. The residual limits of the AIR-652 witness remain: it is current state, so a deleted admission row or an inferred link that never had one is not seen.
- **Indexes and blockers.** The 0055 index (applied 08:35 UTC) and the 0040 index (applied in the AIR-603 window) were verified by separate independent readbacks, not by this run. They are not unresolved blockers on this target. The planner remains unbounded on a live database and was evaluated only on the private snapshot.
- **The operator.** The existing `letterboxd_claim_backfill` operator derives only published-programme candidates and caps a call at 12 pairs, so its pins do not authorize this historical cohort; it was not used.

## Next

A fresh bounded capture with the corrected tool and a proven witness scope (a named archive digest, or the explicit conservative all-archives mode, which treats any admission of the movie as blocking or unknown), then, only for a proven cohort, an executable plan on the existing ADR 0184 writer with a full re-proof at write time and a separate owner GO; zero eligible is no operation.

## Second capture, with the corrected tool and the all-archives witness (28 Nov 2026 10:31:40-10:32:09 UTC)

Run from `main` `b545b4d` (the corrected tool of PR #1078, delivered: post-merge CI/CD run 46135186644, the three test jobs and `Deploy to Cloudflare` success at 10:30 UTC), read-only, with `--witness-all-archives` and a fresh private output file outside the repository (mode 600). The two required indexes were verified from `sqlite_master` before any other read, so no index is listed as a blocker; the two standing limitations (the unbounded planner, evaluated only on the private snapshot; the witness is current state) are reported.

| Fact | Value |
| --- | --- |
| Decision | `complete`; the read set did not move between the two passes |
| Scope | `all_archives` (the witness set is every admission of the movie across all Films and archives; the same lid and movie blocks; an admission under another lid stays `unknown`) |
| Classes | `eligible_in_scope / planner_pass_and_negative_witness_all_archives` **15 of 15**; ineligible 0; unknown 0 |
| Cohort | 15 keys on 15 distinct Films (`bridge_resolved` 15, unresolved owners 0); bridge-only 4, dual 11, differing 5; 410 pointer keys excluded as already claimed |
| Witness | no `film_rated_admission` row for any of the 15 movies (the section digest is the digest of the empty list) |
| Work | 99 statements (of 300), 4,991 rows reserved (of 6,000), 850 pointer rows over both discoveries; 100 requests, 5,540 rows read as reported by D1, **0 rows written** |
| Digests | read set `052beb7dc02fa7e91e71c41e6d8ee4982b459f6ba0f8eccdc487bc99044610d5`; candidate digest of the 15 sorted `lid:tmdb` lines `8e49a99594ce9cf5740304272bd80fb4f6eb5a8b9968ec02d73340c9bb993653`; sections: markers `ce623a64…`, documents `e1eaa729…`, claims `0e556edd…`, owner `e55b5c7a…`, views `bb153365…`, witness `4f53cda1…`, pointers `9464a0b3…` |

Against the 08:57 capture the claims, owner, views and witness digests are the same; the markers, documents and pointers digests differ because the stores moved naturally in between (the Ratings generation and documents after the 09:30 UTC Sync slot; the prediction pointers). That is movement between two runs, not inside one; it means nothing of either snapshot can be used by a writer without a fresh proof at write time.

**What this still is not.** `eligible_in_scope` is a planner `pass` plus the absence of any admission row of the movie in the current state; a deleted admission row and an inferred link that never had one are not seen. It is not production eligibility and not a GO, and the allowlist exists only in the private file. The published-programme backfill operator does not cover this cohort; the historical operator (`scripts/letterboxd-claim-historical-production.mjs`, [runbook](../../runbooks/letterboxd-claim-backfill.md#historical-cohort-operator-for-the-air-653-pointer-keys-dormant-its-apply-needs-its-own-owner-l3-go)) re-proves every pair at write time and needs its own owner L3 GO.
