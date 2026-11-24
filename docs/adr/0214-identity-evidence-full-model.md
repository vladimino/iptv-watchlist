# ADR 0214: The full identity evidence model: each domain step writes its own evidence under its own fence, bare sightings stay in their domains, and history is mapped record by record

**Status:** Proposed  
**Original decision date:** not decided (owner choices 0214-1 to 0214-7 are open)  
**Recorded at:** 2026-11-24  
**Approval source:** not yet decided. The owner approved the roadmap card on 24 Nov 2026 ([AIR-616](https://trello.com/c/DZNk9uMJ)); that is not an architecture decision.  
**Related work:**
- [AIR-616](https://trello.com/c/DZNk9uMJ), card EP of [ADR 0207](0207-letterboxd-admissions-coordinated-in-d1-only.md) decision 7, requested by owner choice 0213-4 = A ([consolidated owner choices](https://github.com/vladimino/iptv-watchlist/pull/975#issuecomment-7140090124)). It is not a prerequisite of [AIR-275](https://trello.com/c/4x7hH0gI).
- The initial slice: [AIR-601](https://trello.com/c/Pl6RUDI9) (E1).
- The cards this record plans: [AIR-617](https://trello.com/c/IfAZDYDj) (E2a), [AIR-618](https://trello.com/c/4RqJUcyf) (E2b), [AIR-619](https://trello.com/c/eXzl5TI8) (E2c), [AIR-620](https://trello.com/c/Zq9KsXPr) (E2d), [AIR-621](https://trello.com/c/xTwNtXbc) (E3a), [AIR-622](https://trello.com/c/cOVFfEYd) (E3b), [AIR-623](https://trello.com/c/ogwMreGD) (E4a), [AIR-624](https://trello.com/c/g3Ka7qFa) (E4b), [AIR-625](https://trello.com/c/ibrRmnwA) (E5).

**Supersedes:** None. If accepted, it amends [ADR 0213](0213-film-identity-evidence-ledger.md) in two places only:
- decision 4 gains a second write path (decision 1 below);
- decision 6 step 3 imports through a dedicated path instead of the `identity_evidence` operation (decision 7 below, choice 0214-6).

Every other decision of ADR 0213 applies unchanged.  
**Superseded by:** None

## Context

### What ADR 0213 left to this record

ADR 0213 (Accepted) defines the ledger and its initial slice: Film-bound rows from the Letterboxd admission routes of ADR 0207 (cards E1, then A1). Its decision 7 moves the rest of the model to this planning record:
- unbound observations made before a Film exists, with their write path, target and fence;
- the future writers: Discovery admission (E2a), the ADR 0184 claim unit (E2b), owner identity actions (E2c) and TMDB retirement (E2d);
- the historical mapping of families (b), Discovery, and (c), claim history, with the order of dry runs and imports;
- readers, each as its own later amendment (E4a, E4b).

Nothing here is implemented. This record fixes the design so that the cards can be detailed. Each card keeps its implementation GO, and each operation keeps its production GO.

### Sources and writers today (code at `main` `cb1fb88`, 24 Nov 2026)

**Table 1. Identity routes, the step that performs each check, and what it leaves behind.**

| Route | Step | Durable record today | Fence today | Can an insert join its batch? |
| --- | --- | --- | --- | --- |
| Discovery TMDB detail check | The decision write: `writeDecisionDelta` (`src/discovery-authority.js:1359`) on the chunk path and `writeDecisions` (`:509`) on the document path, both with history writer `resolver_chunk`. A real TMDB detail fetch, then `detail_verified`: accepted id, title, year within one, runtime against the observed durations, no rival edition | `discovery_decision` (one mutable row per observation) and `discovery_decision_history` (one row per change, append-only by convention: no trigger). The payload keeps `identitySource: 'tmdb_detail'`, `checkedAt`, `evidenceKey`, `provenance` (`authority`, `searchHit`, `movieId`, `runtime`, `releaseYear`, `matchedTitle`, `programmeRunId`) and `scoring` | `discovery_authority` (`d1`, `open`, generation), `discovery_lease`, the evidence-key fence of the decision write | Yes, within `STATEMENT_CAP` 40 |
| Discovery known alias | The same writer. **No TMDB call**: every retained slot matched one catalog-only Film whose movie titles include the slot title ([ADR 0158](0158-epg-title-alias-provenance.md); `src/discovery.js:916,1376`) | The same tables. The payload is only `{status, filmId, tmdbId, identitySource, checkedAt}`: no provenance, scoring or evidence key | As above | Yes |
| Discovery admission | `upsertAdmissions`, then `admitDiscoveryFilms` → `mutateFilm` with a trusted `tmdb` row `{source: 'discovery', verified: true}` and a `film_mutation` receipt of origin `discovery` | Three separate batches: admission, canonical claim, decision (`src/discovery.js:1027-1040`). The claim carries no observation key, decision hash or `identitySource`. `discovery_admission.observation_key` is null on every production row (below) | Discovery fence for the admission; Film/Person marker, revision and receipt for the claim | The claim batch is canonical |
| Discovery owner action | `commitOwnerWrite` (`src/discovery-authority.js:2476`): fence, history row, compare-and-swap of the decision, intent receipt, in **one** batch | `discovery_intent` holds the command and the receipt in one row. An assign records `ownerIdentity {effect, tmdbId, basis, at, requestId, programmeRunId, …}`. A reject adds the id to `rejectedTmdbIds`. A revoke names one earlier intent by its key ([ADR 0178](0178-identity-correction-revoke-event-contract.md)). Owner actions from before the D1 activation exist only as R2 objects under `admin/actions/` | Discovery fence, `running` intent, decision hash | Yes |
| Catalog policy exclusion | History writer `catalog_policy_exclude`; supersedes the admission | `rejectedTmdbIds` without an owner marker; no intent row | Discovery fence | Yes, but it states no identity (decision 5) |
| ADR 0184 claim unit | `planLetterboxdClaim` + `applyFilmExternalIds` (`src/canonical-letterboxd-claim.js`, `src/canonical-film-external-ids-producer.js`); also the owner MCP backfill | A trusted `letterboxd` row `{source: 'ratings_alias_bridge', tmdb, adr: '0184'}` plus a `film_external_ids` receipt of origin `letterboxd_claim`. The refusals `not_proved`, `conflict` and `already` leave no D1 record | Film/Person marker, revision, receipt, nine re-asserted guards | Yes (canonical) |
| TMDB retirement | `recordRetirementDecision` (`src/tmdb-retirement-decisions.js`): fenced, moves the Film revision. **Not bundled into the Worker and called by nothing** | `tmdb_retirement_decision`: append-only (triggers), owner confirmation required by a CHECK; four rows from the earlier load. No applier at `open` | Film/Person marker and revision | Only once a live writer exists |
| Merge | `mergeFilms`: no runtime caller | `film_redirect` (`from_id`, `to_film_id`, `at`): no reason, evidence, actor or request; path compression overwrites earlier targets | — | — |
| Letterboxd sightings (unbound) | The Watchlist scan and promotion (`publishSnapshot`), the Diary phase, the archive registration | Watchlist members and changes (pruned to 8 versions), the never-deleted admission ledger `watchlist_admission_pending`, the fact record's `watchlist` observation (latest value plus one replaced), the never-deleted Diary history (lid, slug, `firstObservedAt`), never-deleted slot events (capped at 100 films), and the R2 archive candidate documents | Watchlist authority with the Sync epoch; Ratings authority with `epochFence`; R2 ETag only for archive candidates | Watchlist and Ratings: yes. Archive candidates: no D1 batch until the ADR 0207 marker |
| Letterboxd admissions (initial slice) | ADR 0207 at mode `d1` | Film-bound rows of ADR 0213 | Film/Person marker, admission marker, receipts | Yes (canonical) |

**Two hard constraints.**
- **A canonical receipt can only target a Film or a Person.** `canonical_write_receipt.target_kind` is `CHECK IN ('film','person')` and `target_id` must match `film:?*` or `person:?*` (`migrations/0019_canonical_write_receipt.sql`). Its applied tail requires the target's revision to move by one (`src/canonical-mutations.js:32`). So a receipt for an observation, a lid or a TMDB id needs a table rebuild, and every receipted evidence-only write moves a Film's compare-and-swap revision.
- **`film_external_id` has no history.** It has no time, request or source column. It is upserted, deleted and re-inserted (by the retired projector, by merges, by `removeExternalIds`), and `provenance_json` is null on the legacy rows.

### Production L0 read (24 Nov 2026, 20:40-21:05 UTC)

Aggregate `SELECT` statements only, on the production D1 database. Every query reported 0 changes and 0 rows written. No identifier, title or payload was exported. Schema version 38; the ledger table does not exist yet.

**Table 2. Cohorts the mapping must cover.**

| Record | Count | Note |
| --- | --- | --- |
| `film` | 13,292 | |
| Trusted `tmdb` on its minting Film (`film:tmdb:<n>`) | 10,459 null provenance; 2,424 `discovery`; 3 `letterboxd_rated_admission` | definitional (decision 3) |
| Trusted `tmdb` on another Film | 402, all null provenance | method not recorded |
| Trusted `letterboxd` on its minting Film (`film:<lid>`) | 406, null provenance | definitional |
| Trusted `letterboxd` from the claim unit | 9, `ratings_alias_bridge` | E2b history |
| Trusted `tmdb_tv` / untrusted retired `tmdb` | 4 / 4 | applications of the retirement decisions |
| Untrusted `letterboxd_slug` | 406 | a slug is never identity ([ADR 0052](0052-letterboxd-slug-film-alias.md)) |
| `tmdb_retirement_decision` | 4 | |
| `film_redirect` | 15 | |
| 0001 `identity_assertion`, `identity_application`, `identity_rule_version` | 0, 0, 0 | |
| `discovery_observation` | 82,004 | |
| `discovery_decision` (current) | 52,024 | verified, all `movie`: `tmdb_detail` 11,551; `known_epg_alias` 4,653; `known_alias_year_runtime` 11; **no `identitySource`** 1,851 (only `checkedAt`, `filmId`, `status`, `tmdbId`) |
| `discovery_decision_history` | 169,916 | verified, distinct (observation, movie) pairs: `tmdb_detail` 11,708; `known_epg_alias` 4,701; `known_alias_year_runtime` 11; no `identitySource` 1,866. Deferral-only rows 12,132; policy exclusions 174; owner corrections 2. Rows of writer `import` (4 Nov 2026) are the R2-to-D1 load: their `written_at` is the load time, their payload `checkedAt` is the decision's own time |
| `discovery_intent` | 2 | both `identity_reject`, state `receipt` |
| `discovery_admission` | 12,536 | `observation_key` null in **all** rows |
| `canonical_write_receipt` | discovery `film_mutation` 2,424; `letterboxd_claim` `film_external_ids` 9; others for admissions, retention, EPG and metadata | all `applied` |
| `film_rated_admission` | 714 | family (a), card E3a |

### Minting ids

`localFilmId()` mints `film:tmdb:<n>` from a TMDB movie and `film:<lid>` from a Letterboxd id. Such a Film holds that id **by construction**: the id is the Film's definition, not a claim made later about it. The large null-provenance cohorts above are almost entirely minting ids (12,886 `tmdb` and 406 `letterboxd`). The 402 trusted TMDB ids on Films minted from something else are the claims whose justification is genuinely missing.

## Decision

### 1. Two write paths, chosen by where the step's own effect lives (choice 0214-1)

**Canonical path, unchanged from ADR 0213 decision 4.** A row that accompanies a canonical effect (an admission, a claim, a retirement applied to a Film) is written in the same fenced batch as that effect, with its canonical receipt. A genuine Film-bound check without an effect uses the receipted `identity_evidence` operation.

**Domain path, new.** A row that documents a step of a domain whose own effect stays in that domain (a Discovery decision, a Discovery owner intent) is written:
- **in the same D1 batch as that domain's own durable record of the step**: the decision history row, or the intent receipt. Neither exists without the other;
- **under that domain's fence**: its marker mode and generation, and its lease or epoch where the step has one. For Discovery that is `discovery_authority` (`d1`, `open`, generation), `discovery_lease`, the evidence-key fence of the decision write and, for an owner write, the `running` intent and the decision hash of `commitOwnerWrite`;
- **with no canonical receipt and no Film revision move**;
- **idempotently**: `evidence_key` is unique and an insert of an existing key is a no-op. A lost response is settled by the domain's own readback: once the domain record of the step is committed while the writer is active, the row with that key exists, inserted by the same batch or already present.

**Rules for the domain path.**
- **No cross-store write.** A domain whose step does not run in a D1 batch writes no domain-path row. The rated archive candidates stay out until their coordination is in D1 (the ADR 0207 marker).
- **Atomic when active, silent when not.** While its writer is not active (decision 4), a step writes no row and is otherwise unchanged. While it is active, a failed insert rolls back the domain batch, exactly as a failed receipt tail rolls back a canonical batch.
- **No Film target.** A domain-path row names no receipted target. It names a Film only as the subject of `film_has_id`, and no domain-path writer in this record writes that relation.
- **Requirements on the E1 table.** Its triggers refuse `UPDATE` and `DELETE` and check the row's shape. They must not require a Film target, a canonical receipt or the Film/Person marker generation for an insert: fencing belongs to the writer's batch. If E1 is delivered with a stricter trigger, the first domain-path card adds a forward migration. Nothing is relaxed silently.

**Why not a canonical receipt for these rows.** A decision about an observation is not a Film mutation. Receipting it would need a rebuilt receipt table with a new target kind and a revision for something that has none. Discovery wrote between 208 and 964 verified decision rows a day from 14 to 24 Nov 2026 and holds some 16,400 historical pairs, so tying each to a Film revision would also make every other producer's compare-and-swap on that Film fail and replan for no reason.

### 2. Bare sightings stay in their domains (choice 0214-2)

- **No writer in this record writes `exists` rows.** The relation stays in the vocabulary, reserved and unused.
- **Why.** Every sighting already has a durable home: the fact record's Watchlist observation, the never-deleted Diary history and admission ledger, the slot events, the Discovery observations. A ledger copy would duplicate them. A root per Watchlist snapshot would mean up to 5,000 rows per changed version (`maxFilms` 5,000, up to four slots a day). The archive candidates have no D1 batch at all.
- **What the owner asked for is covered by relations.** Evidence about entities before any Film exists is written as relations on the domain path: an observation as a candidate for a movie, and an owner's refutation of such a candidate (decision 5). Neither needs a Film.
- **Revisit trigger.** A reader that needs a cross-domain index of sightings that no domain record can serve, for example a global catalog listing source entities not yet admitted. Such a reader brings its own decision, including the route, method and root of an `exists` row.

### 3. Minting ids carry no evidence row

- A Film's minting id (see "Minting ids" in the Context) gets **no `film_has_id` row**, live or reconstructed.
- Its justification is the evidence of the step that admitted the Film:
  - the Discovery `candidate_for` rows for that movie;
  - the Letterboxd `same_work` rows of ADR 0207;
  - for a Film minted from a Watchlist lid, the Watchlist membership itself, kept in its own domain.
- Readers never require a row for a minting id.
- An id added to a Film that was **not** minted from it does need evidence: a lid on a `film:tmdb:` Film (the claim unit), a `tmdb_tv` after a retirement, a TMDB id on a `film:<lid>` Film.

### 4. Each new writer is activated on its own, with a recorded coverage boundary (choice 0214-4)

- **One durable control row per writer** in a new D1 table, `identity_evidence_writer`: `writer` (primary key), `mode` (`off` or `on`), `generation`, `coverage_from`, `updated_at`. An append-only `identity_evidence_writer_change` keeps every transition. An absent row means `off`.
- **Writers:** `discovery_decision` (E2a), `discovery_owner` (E2c), `claim_alias_bridge` (E2b) and `tmdb_retirement` (E2d). The key is the writer, not the route, because one route (`owner_action`) has two writers.
- **The insert is conditional inside the writer's own batch**: it inserts only while that writer's row says `on`. A D1 batch is one transaction, so every batch committed after a switch to `on` has its row (written by that batch or already present), and no batch before it wrote one. `coverage_from` is therefore exact.
- **Turning a writer on** is an owner-approved production operation with a readback, after its card is merged and deployed. **Turning it off** stops new rows and is the rollback of the activation. A later `on` starts a new coverage interval; the gap stays visible in the change table.
- **The initial slice is not governed here.** ADR 0207's writers are gated by the admission marker, and their coverage starts at the A2 flip.

### 5. Writer mapping (E2a-E2d)

Vocabulary as in ADR 0213 decisions 1-3. Under the recommended options, no new route, method or relation value is needed.

**Table 3. What each future writer writes.**

| Writer (card) | Step | Row | Polarity | Route | Method | `source_root` | Path and batch | Observation time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `discovery_decision` (E2a) | A decision becomes `verified` with `identitySource: 'tmdb_detail'`, including the revalidation that turns a known alias into a detail check | `candidate_for(discovery_observation:<observation key>, tmdb_movie:<tmdbId>)` (`tmdb_tv` if the media kind is TV) | `asserts` | `discovery_scan` | `tmdb_detail_check` | the observation key | domain; the decision write's batch | `checkedAt` |
| `discovery_decision` (E2a) | `verified` with `known_epg_alias` | the same proposition | `asserts` | `discovery_scan` | `title_only` (choice 0214-3) | the observation key | domain | `checkedAt` |
| `discovery_decision` (E2a) | `verified` with `known_alias_year_runtime` | the same proposition | `asserts` | `discovery_scan` | `title_year` (choice 0214-3) | the observation key | domain | `checkedAt` |
| `discovery_decision` (E2a) | any other status, a deferral, a policy exclusion, the admission and its minting claim | no row | — | — | — | — | — | — |
| `discovery_owner` (E2c) | an owner intent with an assign effect (confirm, correct, each child of a group assign) | `candidate_for(discovery_observation, tmdb_movie)` | `asserts` | `owner_action` | `owner_statement` | the intent's idempotency key (`ownerIdentity.requestId`) | domain; `commitOwnerWrite` batch | `ownerIdentity.at` |
| `discovery_owner` (E2c) | `identity_reject` | `candidate_for(discovery_observation, tmdb_movie)` for the rejected id | `refutes` | `owner_action` | `owner_statement` | the intent key | domain | the intent's `confirmedAt` |
| `discovery_owner` (E2c) | `identity_revoke` | the revoked intent's proposition, with `scope_evidence_key` = that intent's row key (decision 6) | `refutes` (scoped) | `owner_action` | `owner_statement` | the revoke's intent key | domain | the intent's `confirmedAt` |
| `discovery_owner` (E2c) | reconsider | no row: it reopens resolution and states no identity | — | — | — | — | — | — |
| `claim_alias_bridge` (E2b) | `pass/proved`, then the write (Diary link, Watchlist link or owner backfill) | `film_has_id(film:<id>, letterboxd_lid:<lid>)` | `asserts` | `ratings_alias_bridge` | `alias_bridge` | **inherited**: the root of the live `asserts same_work(letterboxd_lid, tmdb_movie)` `page_check` row the bridge rests on, when one exists; otherwise null | canonical; the `film_external_ids` batch with its receipt | the batch time |
| `claim_alias_bridge` (E2b) | `already`, `not_proved`, `conflict` | no row: nothing was concluded | — | — | — | — | — | — |
| `tmdb_retirement` (E2d) | an owner `retire` decision | `film_has_id(film, tmdb_tv:<T>)` and `same_work(tmdb_movie:<M>, tmdb_tv:<T>)` | `asserts` | `owner_action` | `owner_statement` | the decision's `request_id` | canonical; the `recordRetirementDecision` batch | `confirmation.at` |
| `tmdb_retirement` (E2d) | an owner `restore` | one scoped row per row of the retire it reverses | `refutes` (scoped) | `owner_action` | `owner_statement` | the restore's `request_id` | canonical | `confirmation.at` |

**Notes on the mapping.**
- **A row only for a step that checked.** The Discovery writer inserts its row under the same condition as its history row: only when the decision write records a new decision (a new decision hash). A run that leaves a verified decision unchanged performed no new check and writes nothing (ADR 0213 decision 4, "no verification, no evidence").
- **One EPG label is one source.** The Discovery root is the observation key (normalized title and year), as ADR 0213 decision 2 already names it. A re-check of the same pair writes nothing (same key). A known-alias row and a detail-check row of the same observation share a root, so they never count as independent of each other.
- **A derived bridge is never independent of what it derives from.** The claim unit concludes from a verified Ratings link plus canonical TMDB ownership. Its root is the root of the page check behind that link. When that check has no row (links made before ADR 0207's A2 flip), the root is null, and a null root is never independent.
- **Rejections that are not identity statements write nothing.** A detail check that does not accept a candidate is not a refutation (ADR 0213 decision 3 lets only an owner or a verified page contradiction refute). Neither is a catalog policy exclusion: it says that a movie is not wanted in the catalog, not that an observation is not that movie.
- **E2d is parked.** No live retirement writer exists: `recordRetirementDecision` is not bundled and nothing calls it. E2d can be implemented only together with, or after, an approved live retirement writer, which is a separate product decision not made here. The four existing decisions are covered by reconstruction (decision 7, c4).
- **The claim side of an owner revoke (choice 0214-5).** E2c records the scoped withdrawal only, and the canonical claim stays as it is today: an ADR 0178 revoke changes the Discovery decision and its assigned rows, never `film_external_id`. A Discovery claim cannot be attributed to one assign: it carries no observation key, and `discovery_admission.observation_key` is null on every row. Changing a claim on a revoke would be a decision of its own, with its own writer and readers.
- **Merges write nothing** (ADR 0213 decision 1). Readers resolve Film subjects through `film_redirect`.

### 6. Conflicts, withdrawal and supersession

- **Conflicting `asserts` rows coexist**, for example one observation verified against two movies at different times. No writer deletes or overrides another row.
- **Only an owner or a verified contradiction refutes** (ADR 0213 decision 3). Discovery non-matches never refute.
- **Scoped withdrawal.** A row with `scope_evidence_key` withdraws exactly the named row:
  - its polarity is always `refutes`, and it says nothing else about the proposition;
  - the revoke of an assign and the revoke of a reject are both scoped rows of this kind;
  - it may name a key that is not stored yet (a forward reference): keys are deterministic, so a revoke of an intent made before its writer was active names the exact key that the reconstruction of that intent will write. Readers apply the withdrawal whenever the key is present;
  - a reinstatement is a new `asserts` row from a new owner intent, so it has a new root.
- **Supersession** (`supersedes_key`) stays as ADR 0213 decision 5 defines it: the same proposition, route and scope with a new root. Discovery and owner rows have stable roots, so they never supersede.

### 7. Historical reconstruction: families (b) and (c), and the import path (choice 0214-6)

The rules of ADR 0213 decision 6 apply unchanged: nothing is invented, unknowns stay unknown, reconstruction provenance on every row, polarity copied and never upgraded, no proof inferred from historical or inferred data, and a live row counts as coverage only with the same proposition, polarity, method, scope and a known, equal root. A reconstructed row uses the same mapping as its live writer (Table 3), so live and reconstructed rows of the same fact get the same key whenever the root is known.

**Table 4. Family (b), Discovery history.**

| # | Source record | Row | Unknowns and limits | Size (L0) |
| --- | --- | --- | --- | --- |
| b1 | `verified` decisions and history rows with `identitySource: 'tmdb_detail'` | as E2a; time from the payload `checkedAt`, never from `written_at` | the TMDB response, the matched TMDB title and the durations compared are not stored, and the row needs none of them | 11,708 distinct pairs |
| b2 | `verified` with `known_epg_alias` or `known_alias_year_runtime` | as E2a (choice 0214-3) | which slot and alias confirmed the match; decisions that rested on an alias key other than the Film's title or original title (222 of 3,790 on 17 Nov 2026, ADR 0158) cannot be told apart from the rest, so all get the same weak method | 4,701 + 11 pairs |
| b3 | `verified` with no `identitySource` (the R2-era decisions loaded on 4 Nov 2026) | **no row**: method not recorded | reported by count | 1,866 pairs |
| b4 | owner history rows (`discovery_identity_correct`, `discovery_identity_revoke`) and intent receipts | as E2c; root is the intent key, so the history row and the intent receipt of one action give one row | none expected: both carry the key | 2 (rejects) |
| b5 | owner actions from before the D1 activation: R2 `admin/actions/discovery_identity_correct/v1/` | as E2c, only when the object states the effect, the movie, the observation and its key; otherwise no row | the count is unknown until the dry run lists the prefix (an L0 R2 list) | unknown |
| b6 | policy exclusions, reconsiders, deferrals, non-verified statuses | no row: not identity statements | — | 174 + 12,132 + … |
| b7 | observations, `confirmed_tmdb_id`, admissions | no row: an observation is referenced, never copied; an admission is not a check | `discovery_admission.observation_key` is null on every row | 82,004; 12,536 |

**Table 5. Family (c), canonical claim history.**

| # | Source record | Row | Unknowns and limits | Size (L0) |
| --- | --- | --- | --- | --- |
| c1 | trusted minting ids | no row (decision 3) | — | 12,886 `tmdb` + 406 `letterboxd` |
| c2 | trusted `tmdb` on a Film not minted from it, null provenance | **no row**: method and route not recorded | reported by count; these are the claims whose justification matters most (Follow-ups) | 402 |
| c3 | trusted `letterboxd` from the claim unit | as E2b, with a **null root** (the Ratings link behind it is not kept with the claim), keyed by `reconstructed_from` (the claim row's identity) | time from the matching receipt's `settled_at` when it matches by target and a recomputed digest; otherwise null | 9 |
| c4 | `tmdb_retirement_decision` | as E2d | time is `confirmation.at`; `recorded_at` of a loaded row is the load time | 4 |
| c5 | the retired `tmdb` and trusted `tmdb_tv` rows | no row: they apply c4 | — | 4 + 4 |
| c6 | `letterboxd_slug` rows | no row: a slug is never identity (ADR 0052) | — | 406 |
| c7 | canonical receipts on their own | no row: a receipt keeps a digest, not a proposition; used only to date c3 | — | — |
| c8 | `film_redirect` | no row: a merge is not evidence | no reason or actor is recorded | 15 |
| c9 | the 0001 assertion tables | nothing | empty | 0 |

Family (a), the 714 admissions, keeps the mapping of ADR 0213 decision 6 (card E3a). Only its import path changes, below.

**Import path (choice 0214-6 = A, recommended).** Every family imports through one dedicated, run-fenced, chunk-receipted path, family (a) included:
- one reconstruction run row per family import: the family, the digest of the reviewed dry-run report, the state and a lease;
- each chunk is one D1 batch that:
  - asserts that the run is live and holds its lease;
  - re-derives its rows from the source records;
  - compares them with the dry-run digest of that chunk; a source that moved stops the chunk as `source_moved`, and the owner re-runs the dry run;
  - inserts the rows with `origin = reconstruction`, `reconstruction_run` and `reconstructed_from`;
  - appends its chunk receipt;
- a replay writes nothing: chunk receipts and unique `evidence_key` values make every step idempotent;
- no Film revision moves and no canonical receipt is written.

This replaces "through the `identity_evidence` operation" in ADR 0213 decision 6 step 3, because that operation targets a Film and moves its revision. Most family (b) rows have no Film, and family (a) would move 714 Film revisions for history alone. The rest of decision 6 is unchanged: a dry run, an owner review of its report, then one import per family under its own production GO.

**Order.** Families (b) and (c) import after their matching live writers are active (E2a and E2c; E2b), so that each history row is checked against live coverage first. The retirement history (c4) needs no live writer.

### 8. The reader contract (E4)

Nothing reads the ledger to decide anything until that reader's own amendment is accepted (ADR 0213 decision 8). E4a (the ADR 0170 inventory) and E4b (the ADR 0184 planner) stay as listed there. A global catalog identity reader would be a decision of its own. Every amendment follows these rules:
1. **Strength** comes from the method ranking of ADR 0213 decision 3. Owner rows come first, and a `restricts` row blocks proof use unless an owner or a verified method asserts the proposition.
2. **Independence** counts distinct known roots. A null root is never independent.
3. **Scoped withdrawals** apply as decision 6 defines them.
4. **Film subjects** are resolved through `film_redirect`.
5. **Absence means nothing outside coverage.** A reader may read a missing row as "not checked by that writer" only inside that writer's coverage interval (decision 4; for the initial slice, from the A2 flip), and before it only for source records that the family's import report lists as covered.
6. **Minting ids need no row** (decision 3).
7. **A reconstructed row counts as proof only if the reader's own amendment says so.**
8. **Reads are bounded and indexed, and a GET or MCP read never writes** ([ADR 0107](0107-get-head-read-side-effect-boundary.md)).

### 9. Delivery graph (choice 0214-7)

Each card is one atomic outcome. **Dormant** means that merging and the automatic deploy activate nothing. None of these cards is an AIR-275 prerequisite.

**Table 6. Cards.**

| Card | Outcome | Depends on | Boundary | Gate |
| --- | --- | --- | --- | --- |
| **EC** (new) | The writer control table and change table (a migration file), the conditional-insert helper and its tests | this record accepted; E1 | dormant (no row = `off`) | implementation GO |
| **ECM** (new) | Apply the EC migration | EC merged and deployed; M1 (the ledger table applied) | no behaviour change | production GO; may be one apply operation with another apply card |
| **E2a** ([AIR-617](https://trello.com/c/IfAZDYDj)) | The Discovery decision writer (domain path), then its activation and natural acceptance | E1, EC; activation needs M1 and ECM | dormant until its control row is `on` | implementation GO, then production GO to turn it on |
| **E2c** ([AIR-619](https://trello.com/c/eXzl5TI8)) | The Discovery owner writer (domain path): assign, reject, scoped revoke | E1, EC; activation needs M1 and ECM | as E2a | as E2a |
| **E2b** ([AIR-618](https://trello.com/c/4RqJUcyf)) | The claim unit writer (canonical path), with the inherited root | E1, EC; activation needs M1 and ECM | as E2a | as E2a |
| **E2d** ([AIR-620](https://trello.com/c/Zq9KsXPr)) | The retirement writer | **parked**: a live retirement writer, which needs its own product decision | — | — |
| **ER** (new) | The reconstruction import path: run and chunk tables (a migration file), the operator, its tests | this record accepted; E1 | dormant | implementation GO |
| **E3a** ([AIR-621](https://trello.com/c/xTwNtXbc)) | Family (a): dry run and report, then import through ER | E1, M1, A2; ER and its applied migration for the import | the dry run writes nothing | dry run: production read approval; import: owner decision and production GO (L3) |
| **E3b** ([AIR-622](https://trello.com/c/cOVFfEYd), narrowed to Discovery) | Family (b): dry run and report, then import | E2a and E2c active; ER | as E3a | as E3a |
| **E3c** (new, split from AIR-622) | Family (c): dry run and report, then import | E2b active (for c3); ER | as E3a | as E3a |
| **E4a**, **E4b** ([AIR-623](https://trello.com/c/ogwMreGD), [AIR-624](https://trello.com/c/g3Ka7qFa)) | Reader amendments | active writers of the routes they read and, where they read history, the matching import | reader switch | owner decision (ADR amendment) |
| **E5** ([AIR-625](https://trello.com/c/ibrRmnwA)) | Retire the unused 0001 tables | — | schema cleanup | owner decision |

- **Within each E3 card,** the dry run and the import stay separate steps with separate approvals. The coordinator may split them into cards when detailing.
- **Migration apply order** follows ADR 0207 decision 7: D1 applies pending files in number order, every table here is inert until its writer is switched on, and each apply card names the exact files it applies.
- **No dual writer.** Every writer adds rows under an existing authority. None changes a Discovery decision, an admission, a canonical claim or a retirement decision.

## Alternatives considered

- **0214-1 B. One canonical receipt for every row, with a new target kind.** It needs a rebuilt `canonical_write_receipt` (SQLite cannot alter a CHECK) and a revision for things that have none, and it moves Film revisions for Discovery's decisions. Not recommended.
- **0214-1 C. Film-bound rows only.** No row for an observation that never becomes a Film and no owner rejection. It drops exactly the evidence before a Film exists that the owner asked to plan. Not recommended.
- **0214-2 B. First-sighting `exists` rows** for Watchlist and Diary lids, written in the promotion batch and the fact batch. It needs a new route (`watchlist_scan`) and a new method (`listing`), duplicates durable domain records, and still cannot cover the archive candidates. A reasonable later step if a reader needs it; not recommended now.
- **0214-3 B. A new method `known_alias`.** More precise than `title_only`, but it extends the closed method list for the same strength tier. **C. No row** for a known alias: it loses the fact that 4,700 decisions rest on title matches alone.
- **0214-4 B. A Worker environment flag per writer.** It needs a removal card per flag, is not visible in D1, and records no coverage boundary. **C. Active from deploy.** It contradicts the dormant-then-activate shape of the E2 cards and gives no clean coverage start.
- **0214-5 B. A revoke also removes the claim.** The Discovery claim carries no observation key and every admission's `observation_key` is null, so a revoke cannot know whether a claim rests on the revoked assign. It would also make an evidence writer a canonical writer. Not recommended.
- **0214-6 B. The dedicated path only for families without a Film;** family (a) keeps the `identity_evidence` operation. Two import mechanisms, and 714 revision moves for history.

## Consequences

- **The ledger covers the identity routes that exist,** each from a known coverage start, with every gap stated: the unrecorded-method cohorts (1,866 decisions, 402 claims), the parked retirement writer and the unknown pre-D1 owner actions.
- **New durable contracts:** the domain path, the writer control with coverage boundaries, scoped withdrawal with forward references, the root inheritance of a derived bridge, the minting rule and the reconstruction import path.
- **Cost:** two additive migrations (EC, ER), one conditional insert per new verified Discovery decision, owner action or claim write, and a bounded import per family.
- **Growth:** live Discovery rows grow only with new (observation, movie, method) combinations, so at most with the 208 to 964 verified decision writes a day seen from 14 to 24 Nov 2026; a re-check of a known pair writes nothing. Owner, claim and retirement rows are rare. A full historical import adds about 16,400 Discovery rows plus a few dozen others.
- **Risk:** more code writes the ledger. It is mitigated by the per-writer control, by the atomic batch and by tests on the real caller paths.
- **Unchanged:** every current decision, admission, claim and retirement rule. No reader changes.

## Recovery and migration boundary

- EC and ER are additive. Before any writer uses them, they can be dropped by a forward migration.
- Turning a writer `off` is the rollback of its activation. Rows already written stay: they are history and are never deleted. A wrong row is answered by a scoped `refutes` from an owner.
- Each import is idempotent and needs its own owner decision and production GO. Stopping a run mid-way leaves the chunks already imported, and a resumed run writes nothing twice.
- This ADR, even when Accepted, authorizes no migration apply, writer activation, dry run against production, import, flag, Task or cleanup.

## Evidence

- **Code surveys** for this record, read-only, `main` `cb1fb88` (24 Nov 2026), cited by file in the Context.
- **Production L0 read**, 24 Nov 2026, 20:40-21:05 UTC: aggregate `SELECT` statements only, each reporting 0 rows written (Table 2).
- **Uncertainty:**
  - the number of pre-D1 owner actions in R2 (b5);
  - whether E1's triggers admit domain-path inserts (decision 1);
  - receipt matching for c3 dating, which a dry run must prove.

## Owner choices (open)

| # | Choice | Options | Recommendation |
| --- | --- | --- | --- |
| 0214-1 | Write path for evidence of a domain step | **A** domain path under the domain's fence; **B** canonical receipt with a new target kind; **C** Film-bound rows only | **A** |
| 0214-2 | Bare sightings (`exists`) | **A** not stored now, relation reserved, revisit trigger stated; **B** first-sighting rows for Watchlist and Diary lids | **A** |
| 0214-3 | Discovery known-alias decisions | **A** existing weak methods (`title_only`, `title_year`), never proof; **B** new method `known_alias`; **C** no row | **A** |
| 0214-4 | Activation of each new writer | **A** a D1 control row per writer with a coverage boundary; **B** Worker flags; **C** active from deploy | **A** |
| 0214-5 | Claim side of an owner revoke | **A** evidence only, the canonical claim unchanged; **B** the revoke also removes the claim | **A** |
| 0214-6 | Reconstruction import path | **A** one dedicated path for every family; **B** dedicated path only for families without a Film | **A** |
| 0214-7 | Delivery graph | **A** as Table 6: new EC, ECM, ER and E3c; E3b narrowed; E2d parked | **A** |

## Follow-ups

**On acceptance.**
- Create the EC, ECM, ER and E3c cards. Narrow AIR-622 to Discovery and park AIR-620 with its reason.
- Add each card's real prerequisites as bare URLs in native checklists.
- Copy the relevant rows of Tables 3-5 into each E2 and E3 card.

**Candidate follow-ups, not selected.**
- A bounded live re-verification of the 402 non-minting TMDB claims by the page check of ADR 0166, which would give them `page_check` evidence.
- A global catalog identity reader (decision 2's revisit trigger).

**Observed, not changed here.**
- `discovery_decision_history` has no append-only trigger.
- `discovery_admission.observation_key` is never set.
- The retirement writer is not bundled.
