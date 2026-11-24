# ADR 0213: Identity evidence is a ledger of typed, source-aware propositions beside the canonical claims

**Status:** Proposed (no owner decision on this record; each choice below is separate and awaits an explicit, ADR-specific Product Owner decision)  
**Original decision date:** not decided  
**Recorded at:** 2026-11-24. Revised the same day after the [design review of the package](https://github.com/vladimino/iptv-watchlist/pull/975#pullrequestreview-6039232220), its [re-review](https://github.com/vladimino/iptv-watchlist/pull/975#pullrequestreview-6040005516) and the [second re-review](https://github.com/vladimino/iptv-watchlist/pull/975#pullrequestreview-6040703398).  
**Approval source:** not decided. Requested as the companion of [ADR 0207](0207-letterboxd-admissions-coordinated-in-d1-only.md) by the owner's disposition 5C on [PR #975](https://github.com/vladimino/iptv-watchlist/pull/975#issuecomment-7131137347): "источник источнику рознь, нужно отличать доказательства для записи в программе с названием без года от фильма с полноценным LID (из архива, оценок или watchlist)". That chose the direction; it does not accept this design.  
**Related work:** [AIR-555](https://trello.com/c/JPgjoBzK), under [AIR-275](https://trello.com/c/4x7hH0gI). [ADR 0207](0207-letterboxd-admissions-coordinated-in-d1-only.md) (Proposed) uses the initial slice (decision 7).  
**Supersedes:** None. It amends nothing by itself. Every reader change is a separate later decision (decision 8).  
**Superseded by:** None

## Context

### What exists (main `26cfd115`, 24 Nov 2026)

- **The canonical identity decision** is the trusted, non-conflicting `film_external_id` row: one per `(scheme, value)`, enforced by a unique index. Its `provenance_json` is free-form and null on some legacy rows. `film.canonical_identity` and the `identity` row of `film_dimension` repeat it.
- **Discovery keeps its own evidence**, linked from the canonical side only through `discovery_admission.observation_key`. It has:
  - observations: normalized title, nullable year, evidence key, `confirmed_tmdb_id`;
  - decisions with an append-only history: `identitySource` of `tmdb_detail`, `known_epg_alias` or `owner`, and `provenance`, `scoring` and `anchor` payloads;
  - owner intents (`identity_assign`, `identity_reject`, `identity_revoke`) with their commands and receipts.
- **What the canonical claim does not record.** Every Discovery admission reaches the canonical claim as the same `{source:'discovery', verified:true}`. An `identity_revoke` or a policy exclusion changes the Discovery decision and the published shows, but never the canonical claim.
- **Letterboxd routes:**
  - The inferred import marks the pair on the Ratings record (`identity`, `inferredPairs`). The ADR 0184 planner reads that as "never a proof".
  - The Diary and Watchlist admission paths share one page check (ADR 0166, generalized by ADR 0186 decision 5).
  - The rated archive is checked by ADR 0087 and 0090.
  - In D1 all three end up as `film_rated_admission` rows without a kind, plus a trusted `tmdb` claim.
- **ADR 0170** proves a verified archive candidate by an exact `archive_sha256` + `source_code` join on `film_rated_admission`. Keep-first (ADR 0207) means a second archive that verifies the same pair cannot be proved this way.
- **Merges.** `mergeFilms` deletes the retired `film` row and writes a `film_redirect` row. Several Film-id columns elsewhere have no foreign key (Discovery, predictions, publication). `mergeFilms` has no runtime caller today.
- **Unused tables.** The 0001 offline tables `identity_assertion`, `identity_application` and `identity_rule_version` have no runtime writer.

### What the owner's distinction requires

A source can identify **different things**, and a row about one of them must not be read as a row about another:
- A title-only programme row identifies nothing.
- A Letterboxd id (lid) or a short code identifies **a Letterboxd entity**, not a TMDB movie.
- A title and year search links a lid to a movie **as a guess**.
- A page check proves that **a lid or short code and a TMDB movie are the same work**.
- A canonical Film holding a TMDB id is a **canonical decision**, which evidence may justify but is not.

Each of these is a different proposition, and a source may support one without saying anything about the others.

## Decision (proposed)

### 1. Evidence records typed propositions about typed subjects, not rows about a Film

An evidence row states one **proposition** about a **subject** and, for relations, an **object**:

| Field | Values |
| --- | --- |
| `subject_kind`, `subject_value` | `letterboxd_lid`, `letterboxd_short_code`, `tmdb_movie`, `tmdb_tv`, `discovery_observation`, `film` |
| `relation` | `same_work` (two source entities are the same work), `film_has_id` (a canonical Film holds an external id), `candidate_for` (an observation is a candidate for a movie), `exists` (a source entity was observed) |
| `object_kind`, `object_value` | as for the subject; empty for `exists` |

- **The model admits evidence before a Film exists, but the first implementation does not store it.** A lid observed on a Watchlist (`letterboxd_lid … exists`) or a short code in an archive needs no Film and no canonical id, and storing it would never create, admit or merge a Film. Canonical receipts and fences target a Film or a Person, and an unbound observation has neither, so its receipted write path is later work (decision 7). Until then, unbound observations stay in their own domains: the Watchlist snapshot and ledger, the Ratings records, the archive candidate documents and the Discovery observations.
- **Discovery observations are referenced, not copied.** They stay in the Discovery domain (ADR 0085). The ledger refers to them by `observation_key` only when a canonical route uses them.
- **A Film is a subject only for `film_has_id`.** It is referenced by id with no foreign key, like the Discovery and prediction tables. A merged Film's rows keep the id they were written for, and readers resolve them through `film_redirect` to the surviving Film.
- **A merge is not a refutation of anything.** A merge writes no evidence; the redirect is its record.

### 2. Route and method are separate fields

- **`route`** says where the evidence came from:
  - `epg_programme`, `discovery_scan`;
  - `letterboxd_export_import`, `letterboxd_rated_archive`;
  - `ratings_diary`, `watchlist_admission`;
  - `ratings_alias_bridge`;
  - `owner_action`.
- **`method`** says how it was established:
  - `title_only`, `title_year`, `title_year_search`;
  - `tmdb_detail_check`, `page_check`, `alias_bridge`;
  - `owner_statement`.
- **`source_root`** is the identity of the underlying source content, independent of who observed it: the page-check evidence digest, the archive digest, the Discovery observation key or the owner intent key. The Diary caller and the Watchlist caller checking the same page share one `source_root`.
- **`source_ref`** is the route's own reference to its observation of that root, for example the snapshot id or the chunk.
- **`source_scope`** is the part a reader filters on, for example the archive digest, so that **per-archive proof** is a direct query, not a dependency on the first admission's digest.

`page_check` from the Diary, from the Watchlist admission and from the rated archive is one method with three routes. The routes are no longer collapsed.

### 3. Three polarities, not "negative support"

- **`asserts`**: the method supports the proposition.
- **`restricts`**: the proposition is recorded as **unverified and not usable as proof**. It is not a refutation.
  - The inferred import writes `restricts` on `same_work(lid, tmdb_movie)`, route `letterboxd_export_import`, method `title_year_search`.
  - This is the ledger's form of the ADR 0184 rule. The Ratings marks stay the authority that the claim planner reads.
- **`refutes`**: the proposition is false.
  - Only `owner_action` and a verified contradiction (a `page_check` naming another movie) refute.
  - A refutation may be scoped to a single earlier row (`scope_evidence_key`), for example the revoke of one owner assignment, or to the proposition as a whole.

The ledger stores no strength column. A reader derives strength from `method` with a fixed ranking:
- `owner_statement` first;
- then `page_check`, `tmdb_detail_check` and `alias_bridge`;
- then `title_year`;
- `title_year_search` is never proof: it appears only in `restricts` rows;
- then `title_only`.

### 4. Identity, idempotence and the evidence-only operation

- **Evidence key: one row per observation route.** `evidence_key = sha256(normalized proposition, polarity, route, method, source_root, source_scope, scope_evidence_key)`. It is `UNIQUE`, so an insert of an existing key is a no-op.
  - **Normalized proposition.** For the symmetric `same_work`, the two sides are ordered canonically by `kind:value` before hashing, so A–B and B–A are one proposition. The directed relations (`film_has_id`, `candidate_for`) keep their direction.
  - **Same route, same root:** the same row, so a replay writes nothing.
  - **Another route, same root:** another row. The Watchlist check of a page that the Diary check already verified is recorded as its own observation, with the common `source_root`.
  - **Independence.** Rows that share a `source_root` are **never** counted as independent corroboration.
  - **`source_scope` is in the key,** so two independently verified archives never collide.
- **Atomic with a canonical effect.** When evidence accompanies a canonical effect (an admission or a claim), it is written in **the same fenced batch** as that effect. Neither exists without the other.
- **Evidence without a canonical effect.** A genuine new verification may have no canonical effect: the pair is already admitted (keep-first), or a second archive verifies the same pair. It is recorded by a new receipted canonical operation `identity_evidence`:
  - it runs under the Film/Person fence (marker generation);
  - its request id derives from the evidence key;
  - it is a no-op on an existing key.

  This lets a later archive's proof be recorded without rewriting the original admission.
- **No verification, no evidence.** A retry that answers `present` from the admission row without fetching the source writes **no** evidence. A row may come only from a step that actually performed its method.

### 5. Lifecycle, ordering and precedence

- **Append-only.** Triggers refuse UPDATE and DELETE. A monotonic `seq` orders rows causally.
- **No "latest row" rule.** Rows from different `source_ref` values are all kept. Two archives give two rows, and two conflicting assertions coexist until a reader or an owner decides.
- **Supersession is explicit.** A row may name `supersedes_key` only for an existing row with the same normalized proposition, route and `source_scope`, for example a re-check of the same page with new content and therefore a new `source_root`. `supersedes_key` is part of the new row's identity, through `scope_evidence_key` or its own column in the key. A unique index allows each row to be superseded at most once, so a chain of supersessions is linear.
- **Revocation and reinstatement** are new owner rows: a scoped `refutes`, then a later `asserts`. The higher `seq` wins within the owner tier.
- **Precedence for readers.**
  - Owner rows outrank all others.
  - A `restricts` row blocks the proof use of its proposition unless an owner or a verified method asserts it.
  - **Independence** counts distinct `source_root` values, not routes or methods. Rows derived from the same page digest are one source, even when the Diary and the Watchlist check both wrote them.
- **No completeness claim.** The ledger is observational first. It holds the evidence of the writers that exist. It is complete only for a route whose writer exists and, for earlier history, only after a backfill (decision 6). Until then it records evidence and decides nothing.

### 6. Backfill

- **(i) None for AIR-275 (recommended).** Rows exist from each writer's activation onward. Earlier admissions have no rows, and readers treat that as "legacy, unknown".
- **(ii) Bounded backfill of the 714 admissions**, a separate owner L3 decision. It would reconstruct:
  - 703 `restricts` from the Ratings marks and the frozen R2 object;
  - 6 `page_check` rows, Diary or Watchlist, whose route is **not** recoverable from the stored receipt, so it is recorded as unknown;
  - 5 `page_check` rows from the rated archive, route `letterboxd_rated_archive`.
- **(iii) Discovery and claim history** is not proposed. It would be a reconstruction from Discovery decision history, left to the later Discovery writer.

### 7. Initial slice (AIR-275) versus the future catalog model

**Initial slice.** These are the only writers required by ADR 0207. Every row is **Film-bound**: its receipted target is the admitted or existing Film.
- the table, its triggers, the `identity_evidence` operation (receipted, with the Film as target) and the writer helper;
- the admission routes at ADR 0207 mode `d1`:
  - `restricts` from the inferred import;
  - `asserts same_work` by `page_check` with route `ratings_diary`, `watchlist_admission` or `letterboxd_rated_archive`, written in the admission batch, or through `identity_evidence` when keep-first makes the admission a no-op.

`exists` rows and every other unbound observation are **not** in the initial slice (decision 1).

**Future catalog model.** Each is a separate card and decision:
- Discovery admission rows (`candidate_for` and `tmdb_detail_check`, referencing observation keys);
- the ADR 0184 claim unit (`alias_bridge`);
- owner identity actions, including the claim side of an ADR 0178 revoke, which today touches no canonical claim;
- retirement.

### 8. Readers and amendments (each a separate later decision)

- **Nothing reads the ledger to decide anything when it is introduced.** ADR 0184 keeps the Ratings marks, ADR 0170 its exact join, and the catalog and Discovery their reads.
- **Optional amendments:**
  - ADR 0170: the inventory may accept an `asserts same_work` `page_check` row whose `source_scope` is the candidate's archive.
  - ADR 0184: the claim planner may also read `restricts` rows.
  - The unused 0001 assertion tables may be retired.
- Accepting this record accepts none of them.

### 9. Acceptance scenarios

Scenarios 1-8 and 11 are the **initial slice** (cards E1 and A1). Scenarios 9, 10 and 12 test the **future** owner, merge and supersession writers (cards E2c-d); they are listed here so that the schema already admits them.

1. A Watchlist lid observed before any Film exists: no ledger row in the initial slice. The observation stays in the Watchlist domain, and no Film, admission or claim appears.
2. An inferred import: `restricts same_work`. The claim planner still answers `not_proved`.
3. A Diary page check that admits: `asserts same_work` (`ratings_diary`, `page_check`) in the admission batch.
4. The same page later checked by the Watchlist caller, with the same digest: one new row (route `watchlist_admission`) with the same `source_root`. It does not count as independent corroboration. The same caller again: no new row.
5. A pair admitted by the inferred import and later verified by a page: no-op admission plus one `identity_evidence` row; the `restricts` row stays, the proof now exists.
6. A second archive verifying an admitted pair: one new row with that archive's `source_scope`; the admission is unchanged.
7. A retry answering `present` without fetching: no row.
8. Two concurrent verifications of the same pair from the same route and root: one row. From different archives: two rows with different `source_scope`. Symmetric order: one row.
9. *(future)* An owner revoke of one assignment, then a reinstatement: scoped `refutes`, then `asserts`, in `seq` order.
10. *(future)* A merge: no evidence row; reads through the redirect find the survivor.
11. A replay of any of the above, including a lost response of `identity_evidence` (settled through ADR 0207 decision 3 under the key `evidence:<evidence_key>`): no new row.
12. *(future)* A supersession: the new row names its predecessor; a second supersession of the same predecessor is refused.

## Alternatives considered

- **The previous revision: Film-scoped rows with a strength column.**
  - Against: it cannot hold evidence before a Film exists, cannot encode a relation between two source entities, collapses routes into one kind, and treated "unverified" as a negative strength.
- **Extend `provenance_json` on `film_external_id`.**
  - Against: one mutable value per claim, no history, and overwritten by merges.
- **An identity-kind column on `film_rated_admission` (ADR 0207 option B′).**
  - Against: it covers one route only.
- **Revive the 0001 assertion tables.**
  - Against: they model owner rules for the offline EPG repository and have no runtime writer.
- **Copy Discovery observations into the ledger.**
  - Against: it duplicates the Discovery domain's evidence. A reference is enough.

## Consequences

- One model that keeps the owner's distinctions apart: subject, relation and object; route and method; polarity.
- An additive migration (one table, its triggers and indexes on `evidence_key`, the subject, the object and `source_scope`), one new canonical operation kind, and one or two statements per admission batch.
- No reader changes. The ledger cannot alter a current decision.
- Growth: about one to three rows per admission or verification. It is append-only like the receipts. Retention is a later owner decision.

## Recovery and migration boundary

- Before any writer uses it, the table can be dropped by a forward migration.
- After that, rows are history and are never deleted. A wrong row is answered by a scoped `refutes`.
- Backfill and reader amendments are separate owner decisions.
- This ADR, even when Accepted, authorizes no migration apply, write or backfill.

## Evidence

- The AIR-555 audit (PR #972) and its reviews.
- Code surveys made for this record (24 Nov 2026), summarized in the Context.
- Production L0 read, 24 Nov 2026 12:21 UTC.

## Owner choices in this record

| # | Choice | Recommended |
| --- | --- | --- |
| 0213-1 | The typed proposition model of decisions 1-3 (subjects, relation, object, route and method, three polarities) | yes |
| 0213-2 | The `identity_evidence` operation for verification without a canonical effect (decision 4) | yes |
| 0213-3 | Backfill (decision 6) | (i) none for AIR-275 |
| 0213-4 | The initial slice as the AIR-275 part (decision 7) | yes |
| 0213-5 | Each reader amendment and the 0001 cleanup (decision 8) | separate, later |
