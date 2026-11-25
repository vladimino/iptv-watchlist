# AIR-652: offline RCA and preflight design for the historical bridge-only prediction keys

Date: **25 November 2026**. Scope: **offline only** (repository code at `main` `4ec19bb`, synthetic fixtures, dated evidence already recorded). No production read, no write, no flag, no Task. Card: [AIR-652](https://trello.com/c/WLBx05Y9) (ADR 0216 delivery step 7). Source finding: the [AIR-627 census comment](https://trello.com/c/IOERZ9GI#comment-6b06a0deb3fbeaeb5f93f8b2). Existing proof and writer: [AIR-559](https://trello.com/c/733sRAxu), [ADR 0184](../../adr/0184-ratings-confirmed-letterboxd-claim-on-existing-film.md) (unchanged). Downstream: [AIR-653](https://trello.com/c/YSPVkb1M).

**Verdict.**
- The backfill's **candidate source is a proven mechanism** that can hide a key outside the current published run. It does **not** prove why each of the 15 historical keys was absent from the earlier dry run.
- **No key is called eligible.** The strongest offline state is `eligible_in_scope`: a planner `pass` plus a negative witness inside a stated, validated evidence scope. That is not proven production eligibility.
- An executable, bounded offline **design** of the preflight is pinned by tests. A live run needs its own authorization and a plan with the caps below. **This report grants none and starts none.**

The 15 keys, 4 Films without another pointer, 11 with a second pointer and 5 with a different value are the AIR-627 dated census (Film/Person g2, EPG P519, ratings g4442, predictions g46576, 25 Nov 2026), not live counts.

## 1. The AIR-559 zero cohort: mechanism proven, per-key cause unknown

| Fact | Source |
| --- | --- |
| The backfill takes candidates **only** from lids of the current published programme run that hold no trusted `letterboxd` claim. | `CANDIDATE_SQL`, `src/letterboxd-claim-backfill.js` |
| Its dry run on 24 Nov 2026 saw publication generation **518** and ratings generation **4371**: `already_current`, cohort 0, no blockers. | [activation preflight](../d1-migration/air-559-claim-activation-preflight-2026-11-24.md) |
| The AIR-627 census a day later saw EPG **P519** and ratings **g4442**. | the census comment linked above |
| A run-scoped source never lists a key outside the run, whatever the ADR 0184 verdict (tested: the same lid inside the run becomes a candidate at once). | `tests/prediction-alias-bridge-cohort.mjs`, section 7 |

**What this proves and what it does not.**
- A zero cohort proves that, **in the run observed on 24 Nov**, no lid lacking a claim was a member. The 15 keys were found against a later run and later generations.
- It is therefore **not** shown that each of the 15 was outside the earlier run, nor that no producer ever offered it. The exact historical cause per key is **unknown** without evidence aligned to one generation.
- The mechanism is enough for the forward question: this source cannot be the way to reach keys that sit outside the published run.
- The natural producers offer only pairs they verified in that step; a lid the Ratings protocol already linked is not offered (the 24 Nov Ratings run considered 0 ids). This is the preflight's description of the design, not a per-key observation.

## 2. Why "all 15 are candidates" is not "eligible", and the repaired legacy pair

AIR-627 checked the live link index. The planner `planLetterboxdClaim` also requires the fact record (same lid and movie, not a redirect, not mid-migration, no `identity` mark, no `inferredPairs` entry for the pair), the `ratings_view` corroboration, and the canonical side. The census does not state those readings.

**The planner's limit and its history.**
- A pair linked by the inferred import before AIR-559, on a record that already held facts, carries neither durable mark. In practice that is a **Diary-first `lb-<lid>` record**.
- The [audit of 23 Nov](../d1-migration/air-559-legacy-inferred-pair-audit-2026-11-23.md) found **one** such pair. It was **marked on 24 Nov 2026 at 05:39 UTC** by the owner-approved one-record repair, and the independent readback answered `already_marked` / `ratings_link_inferred` ([apply evidence](../d1-migration/air-559-inferred-pair-repair-apply-2026-11-24.md)).
- So that pair is **not** a current planner pass. Whether the repaired pair is among the 15, and whether any **undetected** pair remains, is **unknown**.
- The fixture models both sides: a Diary-first record with the historical invariant (no mark, inferred-import admission row) and the **post-repair control** (the same shape with `inferredPairs`), which the planner itself refuses.

**What the screen may and may not claim.** The witness is the `film_rated_admission` row of an inferred-import archive with the same lid and movie.
- A **positive** witness blocks (`inferred_admission_witness`).
- A **negative** witness is only absence of that row within the stated archive set. Canonical merges can move or delete admission rows, so the screen looks up by lid and movie across all Films and binds the rows into the read-set token (§4). Absence is **not** proof of independent verified identity.
- The scope must be **valid**: the named invariant and a non-empty set of well-formed archive digests. A missing, empty or malformed scope gives `unknown` (`witness_scope_missing`) for every would-be eligible key. A scope naming a different archive does not see the witness; the verdict is relative to the stated scope.
- A witness that cannot be read is a typed `unknown` with no digest.

## 3. Bounded discovery, and what the query does not prove

- **Not the historical cohort.** The discovery selects every non-`tmdb_` pointer key without a trusted claim. That is a superset of the 15 historical ratings-bridge keys, not a reproduction of them. The fixture keeps keys with no bridge and no canonical Film as **unresolved controls** (`ratings_link_absent`, `film_absent`, `ratings_movie_link_missing_or_ambiguous`); they are reported, not hidden.
- **Bounded by work, not by output.** `tmdb_`-spelled keys form one contiguous range of the pointer primary key, so the scan reads two exclusive key ranges and skips it. Pages are keyset pages (50), with a total inspected-row cap before any claim anti-join, a candidate cap and a statement cap. Hitting any cap is `incomplete` with no digest.
- **Measured, not assumed.** With 3,000 `tmdb_` pointers, 300 direct-claim lid pointers and 4 candidates, the discovery inspects **304** pointer rows, never 3,304. Tests cover cap and cap+1 (303 fails, 304 passes), the candidate cap (3 fails, 4 passes), the statement cap, no matches (complete and empty, 300 rows inspected) and mixed controls (direct, bridge-resolved, unresolved).
- **The link index is capped first.** It is checked against the AIR-647 limits (`LINK_DOCUMENT_MAX_PARTS` 40, `LINK_INDEX_MAX_ENTRIES` 50,000, `FACT_RECORD_MAX_PARTS` 8) **before** the legacy planner runs; an over-cap document is `incomplete`. The planner itself is unchanged.

**Read cost (fixture measurements, not a guarantee).**

| Fixture | Pointer rows inspected | D1 statements |
| --- | ---: | ---: |
| 15 keys, full classification, two read-set passes, discovery repeated | 15 | 280 |
| 3,304 pointers, 4 candidates | 304 | 119 |

A single full planner pass cost up to 24 statements on the stand-in. This is the **measured fixture maximum, not a general bound**: the legacy planner reads the link and record parts unbounded, the claim and view sets without a cap, and **re-reads the link index for every key**, so production rows per key exceed the statement count.

## 4. A coherent read-set for the proof

The earlier sketch only compared markers before and after. Film/Person generation need not move for a claim, revision or admission mutation, so that was not a fence. The design binds the **exact data the verdicts consume**, one token with per-section digests:

| Section | What it binds |
| --- | --- |
| `markers` | Film/Person, ratings and prediction authority (mode, cutover or writes, generation) |
| `documents` | the part and etag of the link index and of each consumed fact record |
| `pointers` | the candidate pointer rows and their `tmdb_<n>` siblings (hashes and values; only agreement is reported) |
| `claims` | every `letterboxd` claim of the lids and every `tmdb` claim of the movies: the competing and absence predicates |
| `views` | the `ratings_view` rows of the aliases and fact keys (the corroboration) |
| `owner` | redirect and retirement rows of the owner Films and movies |
| `witness` | the admission rows by lid and movie |

The token is computed before the classification and **again after**, and the discovery is repeated. Any movement makes the whole answer `unknown`, names the section and returns **no candidate digest**. The test moves each part: a new competing claim, a projection disagreement, a pointer change, a document etag change, a redirect, a ratings, prediction and Film/Person marker move, a new pointer key, and the admission witness inserted, deleted and moved to another Film. A read failure of the witness is `unknown` with the typed error.

- **Multiplicity** is reconciled by **resolved canonical ownership**: the Film that holds the movie as its unique trusted claim, and its `tmdb_<n>` key. The fixture's order plays no part. Over the 13 bridge-resolved fixture keys: 4 bridge-only, 8 with a second pointer (4 differing), 1 without a resolvable owner.
- **Duplicates.** Two candidates on one Film or one movie are refused as `cohort_duplicate_target`, the same guard `deriveBackfillCohort` applies.
- **Not a frozen cohort.** The candidate digest is information. [AIR-653](https://trello.com/c/YSPVkb1M) must re-prove every key at write time under its own GO.

## 5. Fixture and accounting

`tests/prediction-alias-bridge-cohort.mjs` (core suite; `AIR652_REPORT=1` prints the work numbers). Synthetic ids, sqlite3-CLI D1 stand-in over the full migration chain, the **real** `planLetterboxdClaim` and `deriveBackfillCohort`, no apply path imported (asserted statically), 17 tables asserted unchanged.

| Class | Keys | Reasons |
| --- | ---: | --- |
| `eligible_in_scope` | 3 | planner `pass` and negative witness in the stated scope (one with `canonical_identity` NULL) |
| `ineligible` | 9 | `inferred_admission_witness`, `ratings_link_inferred` (post-repair control and the identity mark), `ratings_link_ambiguous`, `ratings_record_not_settled`, `film_redirected`, `tmdb_retired`, `canonical_identity_mismatch`, `lid_claimed_elsewhere` |
| `unknown` | 3 | `ratings_movie_link_missing_or_ambiguous`, `ratings_link_absent`, `film_absent` |
| **Total** | **15** | sources: 0 direct, 13 bridge-resolved, 2 bridge-unresolved |

These are the fixture's designed outcomes, **not a prediction of the production result**. Infrastructure states (a held Film/Person marker, a ratings domain that is not `d1`) are `unknown`, never a verdict.

## 6. Proposed live plan, for a separate decision (not executed)

Any live read needs its own authorization. If requested, it would follow the tested design with **exact caps**, stopping on `incomplete`:

1. Record the three markers; read the pointer key ranges with the page, row, candidate and statement caps of §3 (the defaults used by the test: page 50, 2,000 pointer rows, 64 candidates, 400 statements).
2. Check the link index against the AIR-647 limits above before any planner call; read it once per run for the design's own reads.
3. Bind the read-set of §4 in chunks of 20 candidates, evaluate offline, then recompute it and repeat the discovery.
4. Supply the inferred-import archive digest privately, with the invariant of §2; report **counts per class and reason only**, never a lid, movie, key, rating or document body.
5. A moved or unreadable read-set, or an incomplete coverage, is `unknown` with no digest.

The legacy planner is not changed; its per-key unbounded reads are why the design caps the inputs first.

## 7. Limits and unknowns

- The 15-key census is dated and misaligned in generation with the 24 Nov dry run.
- The historical per-key cause of the zero cohort is unknown.
- Whether the repaired legacy pair is among the 15, and whether any undetected unmarked pair exists, is unknown.
- R2 prediction bodies were not checked; pointer existence is all that is established.
- The fixture proves classification, boundedness and fence logic. It proves nothing about any real key.
- The full-suite results are in the PR body.

## 8. Decision boundary

No bridge, rename, promotion, backfill, activation, flag, Task, migration or production read is authorized or performed. ADR 0184 and the [runbook](../../runbooks/letterboxd-claim-backfill.md) are unchanged; a contract clarification would need a proven result of a private preflight first.
