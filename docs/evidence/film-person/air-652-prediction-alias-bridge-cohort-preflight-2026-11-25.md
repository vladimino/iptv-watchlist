# AIR-652: offline RCA and preflight design for the historical bridge-only prediction keys

Date: **25 November 2026**. Scope: **offline only** (repository code, synthetic fixtures, dated evidence already recorded). No production read, no write, no flag, no Task, no production adapter. Card: [AIR-652](https://trello.com/c/WLBx05Y9) (ADR 0216 delivery step 7). Source finding: the [AIR-627 census comment](https://trello.com/c/IOERZ9GI#comment-6b06a0deb3fbeaeb5f93f8b2). Existing proof and writer: [AIR-559](https://trello.com/c/733sRAxu), [ADR 0184](../../adr/0184-ratings-confirmed-letterboxd-claim-on-existing-film.md) (unchanged). Downstream: [AIR-653](https://trello.com/c/YSPVkb1M).

**Verdict.**
- The backfill's **candidate source is a proven mechanism** that can hide a key outside the current published run. It does **not** prove why each of the 15 historical keys was absent from the earlier dry run.
- **No key is called eligible.** The strongest offline state is `eligible_in_scope`: a planner `pass` plus a negative witness inside a stated, validated evidence scope. That is not proven production eligibility.
- An executable, **bounded offline design** is pinned by tests: a budgeted capture, the unchanged planner as an offline oracle over a private snapshot, and a two-pass read-set fence. **A live run is blocked** by the explicit blockers in §6. This report grants no authorization and starts nothing.

The 15 keys, 4 Films without another pointer, 11 with a second pointer and 5 with a different value are the AIR-627 dated census (Film/Person g2, EPG P519, ratings g4442, predictions g46576, 25 Nov 2026), not live counts.

## 1. The AIR-559 zero cohort: mechanism proven, per-key cause unknown

| Fact | Source |
| --- | --- |
| The backfill takes candidates **only** from lids of the current published programme run that hold no trusted `letterboxd` claim. | `CANDIDATE_SQL`, `src/letterboxd-claim-backfill.js` |
| Its dry run on 24 Nov 2026 saw publication generation **518** and ratings generation **4371**: `already_current`, cohort 0, no blockers. | [activation preflight](../d1-migration/air-559-claim-activation-preflight-2026-11-24.md) |
| The AIR-627 census a day later saw EPG **P519** and ratings **g4442**. | the census comment linked above |
| A run-scoped source never lists a key outside the run, whatever the ADR 0184 verdict (tested: the same lid inside the run becomes a candidate at once). | `tests/prediction-alias-bridge-cohort.mjs`, section 10 |

A zero cohort proves that, **in the run observed on 24 Nov**, no lid lacking a claim was a member. The 15 keys were found against a later run and later generations. It is therefore **not** shown that each was outside the earlier run, nor that no producer ever offered it. The exact historical cause per key is **unknown** without evidence aligned to one generation. The mechanism is enough for the forward question: this source cannot reach keys outside the published run. The natural producers offer only pairs they verified in that step; the 24 Nov Ratings run considered 0 ids.

## 2. Why "all 15 are candidates" is not "eligible", and the repaired legacy pair

AIR-627 checked the live link index. The planner `planLetterboxdClaim` also requires the fact record (same lid and movie, not a redirect, not mid-migration, no `identity` mark, no `inferredPairs` entry), the `ratings_view` corroboration and the canonical side. The census does not state those readings.

- A pair linked by the inferred import before AIR-559, on a record that already held facts, carries neither durable mark; in practice a **Diary-first `lb-<lid>` record**. The [audit of 23 Nov](../d1-migration/air-559-legacy-inferred-pair-audit-2026-11-23.md) found **one** such pair. It was **marked on 24 Nov 2026 at 05:39 UTC** and the independent readback answered `already_marked` / `ratings_link_inferred` ([apply evidence](../d1-migration/air-559-inferred-pair-repair-apply-2026-11-24.md)). It is **not** a current planner pass. Whether it is among the 15, and whether any **undetected** pair remains, is **unknown**.
- The fixture models the historical invariant (a Diary-first record with no mark and an inferred-import admission row) and the **post-repair control** (the same shape with `inferredPairs`), which the planner itself refuses.
- The **witness** is the `film_rated_admission` row of an inferred-import archive with the same lid and movie. A positive witness blocks (`inferred_admission_witness`). A negative one is only absence of that row **within the stated archive set**: canonical merges can move or delete admission rows, so it is looked up by movie across all Films and bound into the read-set. It is not proof of independent verified identity.
- The scope must be **valid** (the named invariant and a non-empty set of well-formed archive digests). A missing, empty or malformed scope gives `unknown` (`witness_scope_missing`). A scope naming another archive does not see the witness; the verdict is relative to the stated scope. A witness that cannot be read is a typed `unknown`.

## 3. The design: a budgeted capture, the planner as an offline oracle

The unchanged planner reads the link index and the record parts for every key and has no caps, so it is **never run against production**. The design separates the two:

1. **Bounded capture.** Exactly the planner's inputs are read through the AIR-647 read-only counted database, with **one shared budget** for statements and rows. Both are **charged before** the statement runs, across both passes and the repeated discovery.
2. **Private snapshot.** The captured rows are materialized into a private sqlite snapshot (triggers dropped; the evaluator never writes) and the real planner runs there.
3. **Two-pass fence.** The capture is repeated (same subjects), the discovery is repeated, and every section digest is compared. Any difference is `unknown` (`read_set_moved`, section named, **no digest**).

**Discovery.** `tmdb_`-spelled keys are one contiguous range of the pointer primary key, so two exclusive key ranges skip them. Pages are keyset pages (50), limited by what the inspection cap still allows **before** the read, then an indexed claim anti-join. Caps: inspected pointer rows (per pass), candidates, statements, rows. A cap hit is `incomplete`, never partial. It selects every non-`tmdb_` pointer key without a trusted claim: a **superset** of the 15 historical keys, not their reproduction. The fixture keeps keys with no bridge and no canonical Film as unresolved controls.

**Documents.** The AIR-647 atomic parts/bytes statement (checked verbatim against `src/film-aggregate.js`) measures server-side and joins the body only within the caps (40 parts and 2.4 MB for the link index, 8 parts and 480 KB per record, 50,000 index entries). Tested: an oversized link part, too many link parts, an oversized record part, a mixed-etag document, and an oversized replacement **after** the first capture; none is materialized.

**What is captured (the read-set), each list `LIMIT cap+1` over an indexed predicate.**

| Section | Rows |
| --- | --- |
| `markers` | Film/Person (authority, CAS, baseline, schema contract), ratings and prediction authority |
| `documents` | part, etag and body digest of the link index and of each consumed record |
| `claims` | every `letterboxd` claim of the lids and `tmdb` claim of the movies, **and every `tmdb`/`letterboxd` claim of each owner Film** |
| `owner` | the owner Films (existence, `canonical_identity`), their **`canonical_revision`**, redirects, and the retirement ledger by movie |
| `views` | `ratings_view` by alias and by fact key |
| `witness` | the admission rows by movie |
| `pointers` | the candidate pointers and `tmdb_<n>` siblings |

**Differential proof.** The planner over the snapshot gives the same verdict as over the live fixture for every key in six worlds, including a rival alias on a fact key, a different trusted lid on an owner, a second trusted movie claim, a changed owner identity, and another Film claiming the lid. So the token binds the **exact consumed data**: what the planner cannot see was not captured, and the test would differ. A mutation of the `owner` section is caught by the review's own counterexample.

**Movement tests (all `unknown`, no digest, section named).** The owner identity changed after a key passed; a different trusted lid inserted on an owner with no pointer; a second `tmdb` claim; the owner revision; a new redirect; a competing claim of the lid; a projection disagreement; a rival alias; a pointer change; a replaced fact record; ratings, prediction and Film/Person marker moves; a new pointer key; the admission witness inserted, deleted and moved; and the **link index replaced between its read and the rest of the capture**.

**Empty cohort.** It is certified only on the same terms: the markers read, evaluated by the real authority reader on a snapshot, the ratings domain `d1`/`open`, then the discovery and the markers repeated and equal. A held marker, a ratings domain that is not `d1`, a marker move or a new candidate between the reads is `unknown`, never a certified empty cohort.

## 4. Measured work, and what is and is not bounded

| Fixture | Pointer rows inspected (both discoveries) | Statements | Rows charged in advance | Rows actually returned |
| --- | ---: | ---: | ---: | ---: |
| 15 keys, full classification | 30 | 64 | 3,254 | not measured |
| 3,304 pointers, 4 candidates | 608 | 66 | 2,990 | 1,270 |

- The bulk run inspects **304 of 3,304** pointer rows per discovery. The same cohort with **5,000 more unrelated** Films, claims and projection rows returns the **same** number of rows and uses the same statements.
- Budget exhaustion is tested at exactly the needed statements (passes) and one fewer (`budget_exhausted`, no digest), and the same for the row ledger. Cap and cap+1 are tested for the inspection cap, the candidate cap and a list row cap.
- The statement and row counts are **fixture measurements, not a general bound**. The charged rows are an upper bound reserved before each statement.
- The unchanged planner remains unbounded; it runs only on the private snapshot, where its reads are bounded by the capture.

**Multiplicity** is reconciled by **resolved canonical ownership**, over the captured rows: the owner is the one Film that holds the movie as its unique trusted claim, **exists, is not a redirect source, is not retired and holds no untrusted or conflicting claim**. Anything else is an **unresolved owner**, a weaker metric named as such. Keys and distinct Films are counted separately. Over the 13 bridge-resolved fixture keys: 10 distinct Films, 4 bridge-only, 6 with a second pointer (4 differing), 3 unresolved owners (a redirected owner, a retired owner, a movie with no Film). Duplicate Film or movie targets are refused (`cohort_duplicate_target`), as `deriveBackfillCohort` does. The candidate digest is information, **not a frozen write cohort**: [AIR-653](https://trello.com/c/YSPVkb1M) must re-prove every key at write time under its own GO.

## 5. Fixture and accounting

`tests/prediction-alias-bridge-cohort.mjs` (core suite; `AIR652_REPORT=1` prints the work numbers). Synthetic ids, sqlite3-CLI D1 stand-in over the full migration chain, the **real** `planLetterboxdClaim` and `deriveBackfillCohort`, no apply path imported (asserted statically), 17 tables asserted unchanged.

| Class | Keys | Reasons |
| --- | ---: | --- |
| `eligible_in_scope` | 3 | planner `pass` and negative witness in the stated scope (one with `canonical_identity` NULL) |
| `ineligible` | 9 | `inferred_admission_witness`, `ratings_link_inferred` (post-repair control and the identity mark), `ratings_link_ambiguous`, `ratings_record_not_settled`, `film_redirected`, `tmdb_retired`, `canonical_identity_mismatch`, `lid_claimed_elsewhere` |
| `unknown` | 3 | `ratings_movie_link_missing_or_ambiguous`, `ratings_link_absent`, `film_absent` |
| **Total** | **15** | sources: 0 direct, 13 bridge-resolved, 2 bridge-unresolved |

These are the fixture's designed outcomes, **not a prediction of the production result**. Infrastructure states (a held Film/Person marker, a ratings domain that is not `d1`) are `unknown`.

## 6. No-live-run blockers

A bounded capture cannot yet be specified for these, so a live run is **blocked**, not a risk to accept. Every answer of the design carries them.

1. **`ratings_view` by fact key has no index.** The planner corroborates the projection by `fact_key`; the capture must too, and the test shows its plan is a **scan** whose size is not capped (AIR-627 saw such a predicate time out). It needs an index or a proven table-size cap first.
2. **The retirement ledger index.** The ledger is read by movie id; the index is migration 0040, whose production apply and readback are a prerequisite (AIR-667, and the aggregate activation). A superseding decision is assumed to name the same movie id, as the resolver does (`supersedes_seq` has no index).
3. **The planner is unbounded on a live database** and must be evaluated only on a private snapshot.

If these are resolved and the owner authorizes a run, the plan is the tested design with its caps, a private archive digest and the invariant of §2, counts per class and reason only (never a lid, movie, key, rating or document body), and `unknown` on any movement. **Nothing here executes it.**

## 7. Limits and unknowns

- The 15-key census is dated and misaligned in generation with the 24 Nov dry run; the historical per-key cause is unknown.
- Whether the repaired legacy pair is among the 15, and whether any undetected unmarked pair exists, is unknown.
- R2 prediction bodies were not checked; pointer existence is all that is established.
- The fixture proves classification, boundedness and fence logic on stand-in data. It proves nothing about any real key or about production index plans other than those listed.
- The full-suite results are in the PR body.

## 8. Decision boundary

No bridge, rename, promotion, backfill, activation, flag, Task, migration or production read is authorized or performed. ADR 0184 and the [runbook](../../runbooks/letterboxd-claim-backfill.md) are unchanged; a contract clarification would need a proven result of a private preflight first.
