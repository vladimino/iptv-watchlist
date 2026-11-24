# ADR 0213: Identity evidence is a ledger of typed, source-aware propositions beside the canonical claims

**Status:** Proposed. The owner selected the direction of each choice on 2026-11-24 ([consolidated owner choices](https://github.com/vladimino/iptv-watchlist/pull/975#issuecomment-7140090124): 1 = A, 2 = A, 3 = iii, 4 = A with a separate planning card for the full model, 5 = A). This revision implements those selections and awaits independent review and an explicit, ADR-specific final disposition. It is not Accepted.  
**Original decision date:** not decided  
**Recorded at:** 2026-11-24. Revised the same day after the [design review of the package](https://github.com/vladimino/iptv-watchlist/pull/975#pullrequestreview-6039232220), its [re-review](https://github.com/vladimino/iptv-watchlist/pull/975#pullrequestreview-6040005516) and the [second re-review](https://github.com/vladimino/iptv-watchlist/pull/975#pullrequestreview-6040703398). Renumbered from 0210 (#979 took that number first). Revised again after the [consolidated owner choices](https://github.com/vladimino/iptv-watchlist/pull/975#issuecomment-7140090124).  
**Approval source:** not decided. Requested as the companion of [ADR 0207](0207-letterboxd-admissions-coordinated-in-d1-only.md) by the owner's disposition 5C on [PR #975](https://github.com/vladimino/iptv-watchlist/pull/975#issuecomment-7131137347): "источник источнику рознь, нужно отличать доказательства для записи в программе с названием без года от фильма с полноценным LID (из архива, оценок или watchlist)". That chose the direction; it does not accept this design. The consolidated choices select options; they are not an acceptance of unseen text, an implementation GO or a production GO.  
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
  - `owner_action`;
  - `unknown`, only on reconstructed rows (decision 6).
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

- **Evidence key: one row per observation route.** `evidence_key = sha256(normalized proposition, polarity, route, method, source_root, source_scope, scope_evidence_key)`. It is `UNIQUE`, so an insert of an existing key is a no-op. For a reconstructed row without a root, `reconstructed_from` takes the place of `source_root` (decision 6).
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
- **No completeness claim.** The ledger is observational first. It holds the evidence of the writers that exist. It is complete only for a route whose writer exists and, for earlier history, only as far as the reconstruction of decision 6 reports coverage. Until then it records evidence and decides nothing.

### 6. Historical reconstruction (owner choice 3 = iii), planned outside AIR-275

The owner chose the broad direction: earlier identity history is reconstructed **explicitly and visibly**, not left as an unexplained gap and not silently folded into the admission activation. It is planned and gated on its own, off the AIR-275 critical path (cards EP, E3a and E3b of ADR 0207 decision 7). The choice is a direction, not an import GO.

**Source families.**
- **(a) The 714 legacy admissions:** 703 inferred pairs from the Ratings marks and the frozen R2 object; 6 Diary or Watchlist page checks; 5 rated-archive page checks.
- **(b) Discovery history:** observations, the append-only decision history (`identitySource` `tmdb_detail`, `known_epg_alias`, `owner`), and the owner intents with their commands and receipts.
- **(c) Canonical claim history:** `film_external_id` rows and their `provenance_json`, the ADR 0184 claim units and receipts, and the TMDB retirement decisions.

**Rules. Nothing is invented.**
- **A row is reconstructed only from a durable source record** that states its proposition, polarity and method. A mapping that the source does not support (for example a Discovery decision whose evidence payload is missing) produces **no row**; it is counted in the coverage report with its reason.
- **Unknowns stay explicit.**
  - A route that the record does not carry is stored as `unknown`. Example: the 6 Diary or Watchlist checks, whose caller the receipt does not keep. `unknown` is allowed only on reconstructed rows.
  - An observation time that is not recorded stays null. `seq` then orders the load, not the history.
  - A missing `source_root` stays null. A row without a root is **never** counted as independent of any other row.
  - **Deduplication without a root.** The `evidence_key` then uses the durable source record instead: `reconstructed_from` takes the place of `source_root` in the key. The reconstruction run is never part of the key. So two distinct source records with unknown roots stay two rows, and a repeated import of the same record writes nothing.
- **Reconstruction provenance on every row.** Three nullable columns, present from the E1 schema so no later table change is needed:
  - `origin`: `live` or `reconstruction`;
  - `reconstruction_run`: the run that wrote it;
  - `reconstructed_from`: the exact source record, such as the R2 key with its ETag, or the D1 table, row key and receipt id.
- **Polarity is copied, never upgraded.**
  - An inferred pair becomes `restricts`, never `asserts`.
  - No reconstructed row is a proof by itself. A later reader amendment (decision 8) decides separately whether, and how, a reconstructed row may count. **No proof is inferred from historical or inferred data.**
- **No duplicate of a live row.** Reconstruction reports a source record as covered, and writes nothing for it, only if a live row has the same normalized proposition, polarity, method, `source_scope` and a known, equal `source_root`. A row that differs in any of these is written, and a null root never matches.

**Procedure for each family.**
1. **Dry run.** A read-only reconstruction writes nothing. It produces a dated coverage report under `docs/evidence/`:
   - rows that can be reconstructed, by proposition, polarity and method;
   - rows with an unknown route, time or root;
   - source records that cannot be reconstructed, with the reason;
   - conflicts with existing rows.
2. **Owner review of the report.**
3. **Import.** One fenced, receipted import per family through the `identity_evidence` operation, with `origin = reconstruction`. It is idempotent by `evidence_key`, so a replay writes nothing. Each import needs its own owner decision and production GO (L3).

**Ordering.**
- Family (a) follows the A2 activation, when the frozen object and the D1 rows no longer change through R2.
- Families (b) and (c) follow the planning card EP. EP defines the live Discovery, claim, owner and retirement writers, so reconstructed and live rows use one proposition mapping.

### 7. Initial slice (AIR-275, owner choice 4 = A) versus the full model (a separate planning card)

**Initial slice.** These are the only writers required by ADR 0207. Every row is **Film-bound**: its receipted target is the admitted or existing Film.
- the table, its triggers, the `identity_evidence` operation (receipted, with the Film as target) and the writer helper;
- the admission routes at ADR 0207 mode `d1`:
  - `restricts` from the inferred import;
  - `asserts same_work` by `page_check` with route `ratings_diary`, `watchlist_admission` or `letterboxd_rated_archive`, written in the admission batch, or through `identity_evidence` when keep-first makes the admission a no-op.

`exists` rows and every other unbound observation are **not** in the initial slice (decision 1).

**The full model (option C) is planned on its own roadmap card, EP**, as the owner asked. It is outside the AIR-275 critical path and is not silently included in A2. EP plans:
- **Unbound observations before a Film exists:** a Watchlist lid (`exists`), a short code in an archive, and a Discovery observation. It covers their receipted write path, their target (they have no Film or Person) and their fence.
- **Future writers,** each a separate card and decision:
  - Discovery admission rows (`candidate_for` and `tmdb_detail_check`, referencing observation keys);
  - the ADR 0184 claim unit (`alias_bridge`);
  - owner identity actions, including the claim side of an ADR 0178 revoke, which today touches no canonical claim;
  - retirement.
- **Historical reconstruction** (decision 6): the proposition mapping for families (b) and (c), and the order of the dry runs and imports.
- **Readers** (decision 8), as separate amendments.

### 8. Readers and amendments (each a separate later decision)

- **Nothing reads the ledger to decide anything when it is introduced.** ADR 0184 keeps the Ratings marks, ADR 0170 its exact join, and the catalog and Discovery their reads.
- **Owner choice 5 = A: readers and the 0001 cleanup are separate, later decisions.** The initial slice switches no decision-making reader.
- **Possible amendments:**
  - ADR 0170: the inventory may accept an `asserts same_work` `page_check` row whose `source_scope` is the candidate's archive.
  - ADR 0184: the claim planner may also read `restricts` rows.
  - The unused 0001 assertion tables may be retired.
- Accepting this record accepts none of them.

### 9. Acceptance scenarios

Scenarios 1-8 and 11 are the **initial slice** (cards E1 and A1). Scenario 9 tests the future owner writer (card E2c). Scenarios 10 and 12 test reads through a merge and a supersession by future writers that card EP plans; no card writes them yet. Scenarios 13-15 test the **reconstruction** (cards E3a-b). They are listed here so that the schema already admits them.

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
13. *(reconstruction)* An inferred legacy pair: one `restricts` row with `origin = reconstruction` and its `reconstructed_from`; never `asserts`.
14. *(reconstruction)* A legacy Diary or Watchlist page check: `asserts same_work` with route `unknown` and a null time. Its `source_root` is set only if the stored record keeps the page-check digest; otherwise it is null and never counted as independent. No reader treats it as proof without an amendment.
15. *(reconstruction)* A dry run writes nothing and reports coverage. A repeated import writes no new row. Two records with unknown roots stay two rows. A live row counts as coverage only with the same proposition, polarity, method, scope and known root.

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
- An additive migration (one table, its triggers and indexes on `evidence_key`, the subject, the object and `source_scope`, with the nullable reconstruction columns), one new canonical operation kind, and one or two statements per admission batch.
- History becomes explicit over time: the reconstruction reports say what is known, unknown and missing, instead of a silent "legacy" gap.
- No reader changes. The ledger cannot alter a current decision.
- Growth: about one to three rows per admission or verification. It is append-only like the receipts. Retention is a later owner decision.

## Recovery and migration boundary

- Before any writer uses it, the table can be dropped by a forward migration.
- After that, rows are history and are never deleted. A wrong row is answered by a scoped `refutes`.
- Each reconstruction import and each reader amendment is a separate owner decision.
- This ADR, even when Accepted, authorizes no migration apply, write, dry run against production, or import.

## Evidence

- The AIR-555 audit (PR #972) and its reviews.
- Code surveys made for this record (24 Nov 2026), summarized in the Context.
- Production L0 read, 24 Nov 2026 12:21 UTC.

## Owner choices in this record

The owner selected these on 2026-11-24 ([consolidated owner choices](https://github.com/vladimino/iptv-watchlist/pull/975#issuecomment-7140090124)). The final disposition of this record follows the independent review of this revision.

| # | Choice | Owner selection |
| --- | --- | --- |
| 0213-1 | The typed proposition model of decisions 1-3: subjects, relation and object, route and method, three polarities, append-only | **A**, adopted |
| 0213-2 | The receipted `identity_evidence` operation for a genuine check without a canonical effect (decision 4) | **A**, adopted |
| 0213-3 | History (decision 6) | **iii**: broad historical reconstruction, planned explicitly with dry runs and coverage reports; no import GO |
| 0213-4 | Scope (decision 7) | **A**: the Letterboxd initial slice for AIR-275, plus a separate planning card EP for the full model (option C) |
| 0213-5 | Readers and the 0001 cleanup (decision 8) | **A**: separate, later; no decision-making reader switch in the initial slice |
