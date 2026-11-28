# ADR 0215: The full identity evidence model: each domain step writes its own evidence under its own fence, bare sightings stay in their domains, and history is mapped record by record

**Status:** Accepted  
**Original decision date:** 2026-11-25 ([final owner disposition](https://trello.com/c/DZNk9uMJ#comment-6b068bb6a944a15be3f7ca46): «принимаю»). The owner selected the nine choices the same day ([consolidated owner choices](https://github.com/vladimino/iptv-watchlist/pull/989#issuecomment-7154757622)) and Q1 = Q1-a ([owner choice](https://github.com/vladimino/iptv-watchlist/pull/989#issuecomment-7155532290)).  
**Recorded at:** 2026-11-24. Renumbered from 0214 the same day, because [PR #988](https://github.com/vladimino/iptv-watchlist/pull/988) took that number first.  
**Approval source:** [Product Owner final disposition of 25 Nov 2026](https://trello.com/c/DZNk9uMJ#comment-6b068bb6a944a15be3f7ca46), accepting this record after the [final independent review](https://github.com/vladimino/iptv-watchlist/pull/989#pullrequestreview-6053326537) (technical PASS on `2726025a`; `3d9e0b89` adds only the requested editorial corrections). Selections: 0215-1 = A, 2 = A, 3 = B, 4 = A, 5 = A, 6 = A, 7 = A, 8a = A, 8b = C, Q1-a. This is an architecture acceptance only, with no implementation, migration, activation, import or production GO.  
**Amendment of decision 7 (PROPOSED, AIR-622):** a D1 source record of the reconstruction manifest may name the further rows it depends on, [amendment below](#amendment-proposed-air-622-28-november-2026-a-source-record-may-name-the-rows-it-depends-on). The owner selected this option (A) on 28 November 2026 in the AIR-622 session; **it is not Accepted until the Delivery Controller records that decision as a comment on [PR #1076](https://github.com/vladimino/iptv-watchlist/pull/1076) and an `Approval source` link to it is added here and in the registry** (ADR merge gate). Until then it stays Proposed and PR #1076 must not merge. The rest of this record is unchanged and remains Accepted.  
**Related work:**
- [AIR-616](https://trello.com/c/DZNk9uMJ), card EP of [ADR 0207](0207-letterboxd-admissions-coordinated-in-d1-only.md) decision 7, requested by owner choice 0213-4 = A ([consolidated owner choices](https://github.com/vladimino/iptv-watchlist/pull/975#issuecomment-7140090124)). It is not a prerequisite of [AIR-275](https://trello.com/c/4x7hH0gI).
- The initial slice: [AIR-601](https://trello.com/c/Pl6RUDI9) (E1).
- The cards this record plans: [AIR-617](https://trello.com/c/IfAZDYDj) (E2a), [AIR-618](https://trello.com/c/4RqJUcyf) (E2b), [AIR-619](https://trello.com/c/eXzl5TI8) (E2c), [AIR-620](https://trello.com/c/Zq9KsXPr) (E2d), [AIR-621](https://trello.com/c/xTwNtXbc) (E3a), [AIR-622](https://trello.com/c/cOVFfEYd) (E3b), [AIR-623](https://trello.com/c/ogwMreGD) (E4a), [AIR-624](https://trello.com/c/g3Ka7qFa) (E4b), [AIR-625](https://trello.com/c/ibrRmnwA) (E5).

**Supersedes:** None. If accepted, it amends [ADR 0213](0213-film-identity-evidence-ledger.md) explicitly, and only here:
- decision 2 gains a method value, `known_alias`, and decision 3 ranks it by method **and** `source_scope` together: with `known_epg_alias` alongside `title_only`, with `known_alias_year_runtime` alongside `title_year`, never proof (decision 5, choice 0215-3 = B and Q1 = Q1-a);
- decision 4 gains a second write path (decision 1 below); an `alias_bridge` row is written only with a causal root and uses the standard rooted key (decision 5, choice 0215-8b = C);
- decision 5: owner precedence follows the source's own causal order within one causal scope, never the ledger `seq` (decision 6 below, choice 0215-8a);
- decision 6 step 3 imports through a dedicated, manifest-bound path instead of the `identity_evidence` operation (decision 7 below, choice 0215-6).

Every other decision of ADR 0213 applies unchanged. [ADR 0178](0178-identity-correction-revoke-event-contract.md) is not changed: its fences stay in Discovery.  
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

### 1. Two write paths, chosen by where the step's own effect lives (choice 0215-1)

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
- **Every path that can commit an eligible step carries the insert.** In Discovery that is `writeDecisionDelta` (one batch per change: 5 or 6 statements today), `writeDecisions` (the document and reconcile path, not used for chunks under D1 authority; several decisions per batch, 2 or 3 statements each, flushed before `pending + addition + 2` would exceed the cap), `commitOwnerWrite` (7 or 8 statements) and `ownerPolicyExclude` (which writes no row, decision 5).
- **Two statements per evidence row: an insert and an assertion.**
  - The insert is `INSERT … SELECT … WHERE` the writer is `pending` or `on`, `ON CONFLICT (evidence_key) DO NOTHING`.
  - The assertion does not test `changes() = 1`, because a valid duplicate changes nothing. It asserts: the writer is `off` or absent, **or** a row with that `evidence_key` exists whose semantic identity (proposition, polarity, route, method, root or its substitute, `source_scope`, `scope_evidence_key`, and `source_order` for owner rows) equals the planned one, so a matching owner row with a different causal position is a mismatch. So it passes for `off`, absent, a new row and a valid duplicate, and fails for a missing or mismatching row, which rolls the domain batch back.
- **Budgets with the extra statements,** against `STATEMENT_CAP` 40 and D1's 100 binds per statement (an insert binds about 15 values):
  - `writeDecisionDelta`: 5-6 + 2 = 7-8 per batch;
  - `writeDecisions`: 4-5 per decision; the existing flush rule counts them, so a batch carries fewer decisions, never more statements;
  - `commitOwnerWrite`: 7-8 + 2 = 9-10 for one row; 7-8 + 4 = 11-12 for a replacement (its row and the scoped withdrawal, decision 6).

  Each card tests both the covered (duplicate) path and the new-row path at the largest of these counts.
- **Requirements on the E1 table.** Its triggers refuse `UPDATE` and `DELETE` and check the row's shape. They must not require a Film target, a canonical receipt or the Film/Person marker generation for an insert: fencing belongs to the writer's batch. If E1 is delivered with a stricter trigger, the first domain-path card adds a forward migration. Nothing is relaxed silently.

**Why not a canonical receipt for these rows.** A decision about an observation is not a Film mutation. Receipting it would need a rebuilt receipt table with a new target kind and a revision for something that has none. Discovery wrote between 208 and 964 verified decision rows a day from 14 to 24 Nov 2026 and holds some 16,400 historical pairs, so tying each to a Film revision would also make every other producer's compare-and-swap on that Film fail and replan for no reason.

### 2. Bare sightings stay in their domains (choice 0215-2)

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

### 4. Each new writer is activated on its own; coverage is claimed only for a drained, unbroken interval (choice 0215-4)

**The control.**
- One durable row per writer in a new D1 table, `identity_evidence_writer`: `writer` (primary key), `state` (`off`, `pending`, `on`), `generation`, `coverage_from` (null unless `on`), `updated_at`. An absent row means `off`. An append-only `identity_evidence_writer_change` keeps every transition with its reason, the deployed version and the operator's evidence link.
- Writers: `discovery_decision` (E2a), `discovery_owner` (E2c), `claim_alias_bridge` (E2b), `tmdb_retirement_decision` and `tmdb_retirement_application` (E2d). The key is the writer, not the route, because one route (`owner_action`) has several writers.
- The insert is conditional inside the writer's batch: it inserts while the row is `pending` or `on`, and writes nothing while it is `off` or absent.

**Why a row alone is not enough.** A batch is written by code. A deployed or still-running version that predates the writer commits the same domain step with no insert, whatever the row says. This holds for a code rollback, for mixed versions during a deploy, and for a Discovery Workflow instance, which keeps running the version it was created on until its own rollover (ADR 0164, ADR 0189).

**Activation protocol.** Each step is an owner-approved production operation with a readback.
1. `off → pending`, compare-and-swap on `generation`. New code now inserts rows, but no completeness is claimed.
2. **Drain.** Record evidence that only versions containing the writer can commit the step: one deployment at 100% built from a commit that contains it, no Discovery Workflow instance and no other Workflow or request of an older version still running (the ADR 0207 decision 1 drain and the ADR 0189 H0 proof are the patterns). An elapsed interval alone is not evidence.
3. `pending → on`, compare-and-swap on `generation`, setting `coverage_from` to the time of this flip. Coverage starts here, not at step 1.

**Deactivation and breaks.**
- `on → off` ends the interval at that flip.
- **A code rollback to a version without the writer is prohibited while the writer is `pending` or `on`.** Switch it `off` first, which records the end of coverage.
- If such a rollback happens anyway, the interval is broken from the deployment of that version. The operator records the break in the change table, from the deployment history, and sets the writer `off`. A later activation starts again at step 1.
- An authority hold of the domain needs no step: a held Discovery batch commits nothing, so nothing is missed.

**What coverage means.** The ledger records propositions once per key, not occurrences. For the bridge writer, only a claim write with a handed-over root is eligible; a claim write without one is outside coverage by definition. Coverage is therefore a guarantee about eligible commits and row existence, not a per-interval observation log:
- **Guarantee.** Every eligible commit (a new decision, intent receipt or claim write by that writer's step, decision 5) committed while the writer was `on` has its row present, written by that batch or already present under the same key.
- **Negative, per key.** If no row with key K exists at read time, then no eligible commit for K happened during any unbroken `on` interval of that writer. That is the only negative a reader may draw; it is a statement about one key, never an event query over an interval.
- **Not provided.** A row's `seq` or time does not say which interval saw the proposition: a key first inserted before an interval and committed again inside it gets no new row. A reader may not filter rows by time to conclude anything about one interval. A per-interval or per-occurrence record would be a new decision.
- **Not "not checked".** A missing row never means that nothing was checked. A decision verified before any interval and never rewritten has no live row; that is inherited state, reported by the reconstruction (decision 7) or as unknown.

**Tests (EC and each E2 card):** a schema without the EC tables (the writer reads it as `off` and inserts nothing; the domain batch is unchanged); recovery from a `pending` left by an interrupted activation (`pending → off`, or `pending → on` only with drain evidence; a repeated `off → pending` is a no-op); absent, `off`, `pending` and `on`; a compare-and-swap race on the control row; a batch of the previous version committing during `pending` (no row, no coverage claimed); a rollback with and without the recorded break; a repeated unchanged decision (no batch, no row); a duplicate key (no second row, assertion passes); a mismatching row under the same key (batch rolls back); a key first inserted before an interval and committed again inside it; an `off`/`on` flip racing a domain batch; each statement count under the cap, on the duplicate and the new-row path.

### 5. Writer mapping (E2a-E2d)

Vocabulary as in ADR 0213 decisions 1-3, plus one method value, `known_alias` (choice 0215-3 = B). Adding it is a forward change of the ledger's method CHECK, key helper and tests, delivered by card EC, never by changing E1.

**Table 3. What each future writer writes.**

| Writer (card) | Step | Row | Polarity | Route | Method | `source_root` | Path and batch | Observation time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `discovery_decision` (E2a) | A decision becomes `verified` with `identitySource: 'tmdb_detail'`, including the revalidation that turns a known alias into a detail check | `candidate_for(discovery_observation:<observation key>, tmdb_movie:<tmdbId>)` (`tmdb_tv` if the media kind is TV) | `asserts` | `discovery_scan` | `tmdb_detail_check` | the observation key | domain; the decision write's batch | `checkedAt` |
| `discovery_decision` (E2a) | `verified` with `known_epg_alias` | the same proposition | `asserts` | `discovery_scan` | `known_alias`, `source_scope` = `known_epg_alias` | the observation key | domain | `checkedAt` |
| `discovery_decision` (E2a) | `verified` with `known_alias_year_runtime` | the same proposition | `asserts` | `discovery_scan` | `known_alias`, `source_scope` = `known_alias_year_runtime` | the observation key | domain | `checkedAt` |
| `discovery_decision` (E2a) | any other status, a deferral, a policy exclusion, the admission and its minting claim | no row | — | — | — | — | — | — |
| `discovery_owner` (E2c) | an owner intent with an assign effect (confirm, correct, each child of a group assign) | `candidate_for(discovery_observation, tmdb_movie)` | `asserts` | `owner_action` | `owner_statement` | the intent's idempotency key (`ownerIdentity.requestId`) | domain; `commitOwnerWrite` batch, with `source_order` = the history revision (decision 6) | `ownerIdentity.at` |
| `discovery_owner` (E2c) | `identity_reject` | `candidate_for(discovery_observation, tmdb_movie)` for the rejected id | `refutes` | `owner_action` | `owner_statement` | the intent key | domain | the intent's `confirmedAt` |
| `discovery_owner` (E2c) | `identity_revoke` | the revoked intent's proposition, with `scope_evidence_key` = that intent's row key (decision 6) | `refutes` (scoped) | `owner_action` | `owner_statement` | the revoke's intent key | domain | the intent's `confirmedAt` |
| `discovery_owner` (E2c) | reconsider | no row: it reopens resolution and states no identity | — | — | — | — | — | — |
| `claim_alias_bridge` (E2b) | `pass/proved`, then the write (Diary link, Watchlist link or owner backfill) | `film_has_id(film:<id>, letterboxd_lid:<lid>)` | `asserts` | `ratings_alias_bridge` | `alias_bridge` | the page-check digest handed over by the caller with the link; **no row without it** (choice 0215-8b = C) | canonical; the `film_external_ids` batch with its receipt | the batch time |
| `claim_alias_bridge` (E2b) | `already`, `not_proved`, `conflict`; or a write without a handed-over root (backfill, replay, pre-A2 link) | no row: nothing concluded, or the write is ineligible for bridge evidence | — | — | — | — | — | — |
| `tmdb_retirement_decision` (E2d) | an owner `retire` decision is recorded | `same_work(tmdb_movie:<M>, tmdb_tv:<T>)` | `asserts` | `owner_action` | `owner_statement` | the decision's `request_id` | canonical; the `recordRetirementDecision` batch | `confirmation.at` |
| `tmdb_retirement_decision` (E2d) | an owner `restore` is recorded | one scoped row withdrawing the `same_work` row of the retire named by `supersedes_seq` | `refutes` (scoped) | `owner_action` | `owner_statement` | the restore's `request_id` | canonical; the same batch | `confirmation.at` |
| `tmdb_retirement_application` (E2d) | an applier installs the trusted `tmdb_tv` claim for a recorded `retire` | `film_has_id(film, tmdb_tv:<T>)` | `asserts` | `owner_action` | `owner_statement` | the applied decision's `request_id` | canonical; **only the applier's own fenced batch**, the one that writes the claim | the batch time |

**Notes on the mapping.**
- **A row only for a step that checked.** The Discovery writer inserts its row under the same condition as its history row: only when the decision write records a new decision (a new decision hash). A run that leaves a verified decision unchanged performed no new check and writes nothing (ADR 0213 decision 4, "no verification, no evidence").
- **One EPG label is one source.** The Discovery root is the observation key (normalized title and year), as ADR 0213 decision 2 already names it. A re-check of the same pair writes nothing (same key). A known-alias row and a detail-check row of the same observation share a root, so they never count as independent of each other.
- **Known aliases keep their own method (choice 0215-3 = B).** Alternative known titles carry real weight with localized EPG titles, so they are not folded into `title_only` or `title_year`.
  - Both variants use `method = known_alias`. The variant is kept in `source_scope` (`known_epg_alias` or `known_alias_year_runtime`), so the two stay distinct rows, are reported separately and can be filtered.
  - `known_alias` is **never proof**, like every title method.
  - The row records only what the decision stores: no alias text is invented, because the decision does not keep which alias or slot matched, and no root other than the observation key is set.
  - **Rank (Q1 = Q1-a).** For this method, strength derives from method and `source_scope` together: `known_epg_alias` ranks alongside `title_only`, and `known_alias_year_runtime` alongside `title_year`. A missing or unknown scope never defaults to a stronger tier; it ranks with `title_only`. Neither variant is proof, and a known-alias row never counts as independent of a detail-check row with the same root (the observation key). The evidence key is unchanged.
  - Nothing here changes the Discovery algorithm or its alias store.
- **A bridge root is never guessed.** `linkEvidence` (`src/canonical-letterboxd-claim.js:43`) returns the current authoritative fact key, not the check that established the link, and several checks of one pair may exist. So a root exists only by **explicit causal hand-over**: the Diary or Watchlist caller that has just verified and linked the pair passes the page-check digest of that very check with the link event (`src/letterboxd-diary-identity.js:225`, `src/letterboxd-facts.js:693`). A matching `same_work` row is never looked up to fill the root.
- **A bridge row only with that root (choice 0215-8b = C).**
  - With the hand-over, the claim batch writes one row under the standard ADR 0213 key, root included.
  - Without it (the backfill, a replay, a link made before the ADR 0207 A2 flip, an event without the hand-over), the canonical claim write is unchanged and **ineligible for bridge evidence**. It writes no row. That is neither a refutation nor a coverage failure.
  - **Receipts are unchanged.** The claim content digest covers the claim content, not the page digest, so the request id and the content digest are the same with or without the hand-over. The evidence insert only joins the batch.
  - **Lost hand-over on retry.** The first committed attempt decides. If it committed with the hand-over, the row exists. If an uncertain first attempt is settled by the receipt protocol (ADR 0207 decision 3) and the claim was applied without a row, no root is attributed later to that applied claim: the write stays ineligible.
  - **Re-add.** A re-add whose link event, target and content equal an applied receipt is short-circuited by receipt idempotence: no batch, so no new row. A re-add through a different event that commits a claim batch with a hand-over writes its row under the rooted key; the same root gives the same key, so it adds nothing new.
  - Independence counts known roots only.
- **A retirement decision is not its application.** `recordRetirementDecision` records the decision and moves the Film revision; it writes no `film_external_id`, canonical identity or dimension (`src/tmdb-retirement-decisions.js:8`). So the decision writer records only what the owner stated: the TMDB movie and the TV entry are the same work. `film_has_id(film, tmdb_tv)` is the canonical effect, and only the batch that installs the claim may write it. A decision that is never applied, or whose application fails, has no `film_has_id` row.
- **E2d is parked.** No live retirement writer and no applier at `open` exist: `recordRetirementDecision` is not bundled and nothing calls it. E2d can be implemented only together with, or after, an approved live retirement writer and applier, which is a separate product decision not made here. The four existing decisions are covered by reconstruction (decision 7, c4 and c5).
- **The claim side of an owner revoke (choice 0215-5).** E2c records the scoped withdrawal only, and the canonical claim stays as it is today: an ADR 0178 revoke changes the Discovery decision and its assigned rows, never `film_external_id`. A Discovery claim cannot be attributed to one assign: it carries no observation key, and `discovery_admission.observation_key` is null on every row. Changing a claim on a revoke would be a decision of its own, with its own writer and readers.
- **Merges write nothing** (ADR 0213 decision 1). Readers resolve Film subjects through `film_redirect`.

### 6. Conflicts, withdrawal, replacement and owner chronology (choice 0215-8a)

- **Conflicting `asserts` rows coexist**, for example one observation verified against two movies at different times. No writer deletes or overrides another row.
- **Only an owner or a verified contradiction refutes** (ADR 0213 decision 3). Discovery non-matches never refute.
- **Scoped withdrawal.** A row with `scope_evidence_key` withdraws exactly the named row:
  - its polarity is always `refutes`, and it says nothing else about the proposition;
  - the revoke of an assign and the revoke of a reject are both scoped rows of this kind;
  - it may name a key that is not stored yet (a forward reference): keys are deterministic, so a revoke of an intent made before its writer was active names the exact key that the reconstruction of that intent will write. Readers apply the withdrawal whenever the key is present.
- **Replacement (ADR 0178 `command.supersedes`).** An assign or reject with `supersedes = {requestId, decisionHash}` writes its own row and, in the same batch, one scoped withdrawal of the superseded intent's row, named by its deterministic key. Same candidate or another candidate, the shape is the same. ADR 0213's `supersedes_key` stays reserved for a re-check of the same proposition, route and scope with a new root, so owner rows never use it.
- **Reinstatement** is a new `asserts` row from a new owner intent, with a new root.
- **Group assign.** Each child is its own intent with its own key, so each writes its own row in its own batch, and a partial group is a set of independent rows.

**Owner chronology: source order, not ledger order.** ADR 0213 decision 5 lets the higher `seq` win within the owner tier. That breaks once history is imported after live writers are active: a historical reject can get a higher `seq` than a later live assign. This record replaces that rule:
- **`seq` orders insertion only.** It never decides precedence.
- **Each owner row carries `source_order`,** the causal position in its own source, in a new nullable column added by card EC through a forward migration on the ledger table (E1 is not changed):
  - Discovery owner rows: the observation's `discovery_decision_history.revision` of the batch that wrote the action. That revision is MAX+1 per observation inside the same batch, so it totally orders every write to one observation;
  - retirement rows: the `seq` of `tmdb_retirement_decision`, which is the decision's own order.
- **`source_order` is comparable only within one causal scope:** one observation's history (Discovery owner rows of the same `observation_key`), or one Film's retirement stream (rows of the same `tmdb_retirement_decision.film_id`). Raw numbers from different scopes are never compared.
- **Precedence among owner rows** of one proposition compares `source_order` within its scope. The latest unwithdrawn owner row stands. Rows from incomparable scopes that disagree are an unresolved owner conflict.
- **Unknown order stays unresolved.** Rows without a source order (owner actions from before the D1 activation, kept only in R2) are not ordered by import. A reader reports them as an unresolved owner conflict when they disagree, and decides nothing.
- **The ledger is not the runtime decision-maker.** The ADR 0178 fences (the strict revoked-assign fence, the release conditions) stay in Discovery and keep deciding what Discovery may re-confirm.
- **A withdrawn assign is not a positive assertion, and its withdrawal promotes nothing.** It cannot turn weaker automatic evidence of the same pair into proof that would contradict the Discovery fence. Where a reader's result would differ from that fence, the reader reports it as unresolved. The proof policy belongs to the E4 amendments.

**Tests (E2c, E3b):** history imported after live actions, in both import orders, with the same result; a revoked reject and a revoked assign; a replacement of the same and of another candidate; group children with partial success; R2-era actions with unknown order reported, not ordered.

### 7. Historical reconstruction: families (b) and (c), and the import path (choice 0215-6)

The rules of ADR 0213 decision 6 apply unchanged: nothing is invented, unknowns stay unknown, reconstruction provenance on every row, polarity copied and never upgraded, no proof inferred from historical or inferred data, and a live row counts as coverage only with the same proposition, polarity, method, scope and a known, equal root. A reconstructed row uses the same mapping as its live writer (Table 3), so live and reconstructed rows of the same fact get the same key whenever the root is known.

**Table 4. Family (b), Discovery history.**

| # | Source record | Row | Unknowns and limits | Size (L0) |
| --- | --- | --- | --- | --- |
| b1 | `verified` decisions and history rows with `identitySource: 'tmdb_detail'` | as E2a; time from the payload `checkedAt`, never from `written_at` | the TMDB response, the matched TMDB title and the durations compared are not stored, and the row needs none of them | 11,708 distinct pairs |
| b2 | `verified` with `known_epg_alias` or `known_alias_year_runtime` | as E2a: method `known_alias`, variant in `source_scope` (choice 0215-3 = B) | which slot and alias confirmed the match is not stored and is never invented; decisions that rested on an alias key other than the Film's title or original title (222 of 3,790 on 17 Nov 2026, ADR 0158) cannot be told apart from the rest | 4,701 + 11 pairs |
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
| c3 | trusted `letterboxd` from the claim unit | **no row** (choice 0215-8b = C): the causal page check behind each claim is not kept with it, and it is never inferred from a receipt or from a matching `same_work` row. Each claim is reported with the reason `bridge_root_unavailable`. This is specific to bridge rows; null-root reconstruction under ADR 0213 stays allowed for other families | reported by count | 9 |
| c4 | `tmdb_retirement_decision` | as the E2d decision writer: `same_work(tmdb_movie, tmdb_tv)`, and a scoped withdrawal for a restore by `supersedes_seq` | time is `confirmation.at`; `recorded_at` of a loaded row is the load time | 4 |
| c5 | the trusted `tmdb_tv` rows | `film_has_id(film, tmdb_tv)` as the E2d application, **only** when the row's provenance matches one decision field by field (film, lid, TV id, link, confirmation); otherwise **no row, reported as unattributable**. The untrusted retired `tmdb` rows give no row | when and by which writer it was applied is not recorded: time null | 4 |
| c6 | `letterboxd_slug` rows | no row: a slug is never identity (ADR 0052) | — | 406 |
| c7 | canonical receipts on their own | no row: a receipt keeps a digest, not a proposition | — | — |
| c8 | `film_redirect` | no row: a merge is not evidence | no reason or actor is recorded | 15 |
| c9 | the 0001 assertion tables | nothing | empty | 0 |

Family (a), the 714 admissions, keeps the mapping of ADR 0213 decision 6 (card E3a). Only its import path changes, below.

**Import path (choice 0215-6 = A, recommended).** Every family imports through one dedicated path, family (a) included. Its unit of approval is an immutable manifest.

1. **Dry run → manifest with a bounded as-of cohort.** The dry run writes nothing in production. It extracts, per source, the exact list of source records at its extraction time and freezes **that list** as the cohort. No cross-store snapshot is claimed, and the sources need not be quiet:
   - append-only sources (Discovery history): every `(observation_key, revision)` read with `written_at` at or before the cohort time;
   - mutable sources (intents in `receipt` state, claim rows, retirement decisions): exactly the rows read, each with its guard fields.

   The manifest lists the ordered chunks, each with its source records, their guard fields, the rows to insert and their full semantic identity, `source_order` included. Every `evidence_key` appears once in the whole manifest: when two source records map to one key, the first in manifest order owns it and the others are listed as duplicates in the report. The manifest's SHA-256 is printed in the report. **The owner's import GO names that digest**; another digest needs another GO.
   - **Late arrivals are out of cohort.** A source record added after extraction is not imported by this run and does not stop it, even if its own timestamp is earlier (a late or backdated record). The post-import reconciliation lists such records, and a later run with its own cohort takes them, unless a live writer already covers them.
2. **Load and seal.** The import operator loads the approved manifest into staging tables (chunk membership, guards, rows), with `UPDATE` and `DELETE` refused by triggers and a unique index on `(run, evidence_key)`. It reads them back and recomputes the digest. The seal is one batch that asserts no seal exists yet and that the staged counts per chunk equal the manifest's, then writes the seal row with the digest. **After the seal, a trigger refuses every staging insert for that run**, so the sealed content cannot grow. The operator reads the staging back once more after the seal; any difference abandons the run. The run row names the sealed digest, and it must equal the digest of the owner's GO. No chunk runs without the seal.
3. **Chunks.** Each chunk is one D1 batch. It:
   - asserts the run (state, the live lease of this attempt, the sealed digest) and that `chunk_no` is the next one, as the chunk receipts of ADR 0202 do;
   - **asserts membership and content at commit:** for every staged source record of the chunk, the record exists with exactly its staged guard fields (field equality, including `json_extract` fields; D1 has no SQL hash). A changed or deleted listed record fails the chunk as `source_moved`;
   - inserts **from the staging rows**, not from caller values, with `ON CONFLICT (evidence_key) DO NOTHING`, `origin = reconstruction`, `reconstruction_run` and `reconstructed_from`;
   - **asserts, for every staged row, that the ledger row with that key now has the staged semantic identity**: proposition, polarity, route, method, root (or, for a null root, the `reconstructed_from` substitute), `source_scope`, `scope_evidence_key` and `source_order`. A different or unknown `source_order` on the same key is a collision. A collision fails the whole chunk, before any receipt, and stops the run for owner review;
   - appends its chunk receipt, create-only, with four counts computed in the batch from the actual outcome:
     - `inserted`: rows of this run and chunk;
     - `already_imported`: keys already present from an earlier reconstruction of the same source record (a replay of the same `reconstructed_from`), which is idempotent and never counted as corroboration;
     - `live_covered`: keys present from a live writer with the same semantic identity.
     - `reconstructed_equivalent`: keys present from an earlier reconstruction of a **different** source record with the same semantic identity, `source_order` included (for example, another representative chosen by an earlier cohort). Reported with both source records, never counted as corroboration, independence or coverage.

     The four counts must add up to the chunk's staged keys; the batch asserts it. A key present with a different semantic identity is a collision and fails the chunk (step above). In the dry run, duplicate inputs of one key must agree on the whole semantic identity, `source_order` included, before one representative is chosen; inputs that disagree make the key a reported conflict, and it is left out of the manifest.
4. **Coverage.** Only `live_covered` is coverage. A null-root row is never covered by another row (ADR 0213), and a rooted live row never covers a rootless historical record.
5. **Unknown outcome and resume.** After a lost response, the chunk receipt decides: present means done, absent means the same chunk is sent again, which is idempotent. A resumed attempt takes a new lease, and a chunk sent under a stale lease fails its run assertion. A listed source record that changed or disappeared stops the run: the owner re-runs the dry run and gives a new GO for the new digest.
6. **R2 sources cannot be asserted inside D1.** They are eligible only when frozen by contract: `verified-films.json` after the ADR 0207 A2 flip (its guard refuses every later write), and an `admin/actions/` owner record only in its terminal `applied` state, which no code rewrites. The dry run pins each object's ETag in the manifest; the operator re-reads it before the chunk that uses it and stops on a difference. The remaining window between that read and the D1 commit is stated per object in the report and the post-import readback, and is accepted as an individually approved residual risk, or the object is excluded, by the owner's GO. Non-terminal R2 records are excluded and reported.
7. **Bounds.** At most 50 source records and 200 rows per chunk, within D1's 2,000 statements per batch and 100 binds per statement. Imports refuse to start while the matching live writer is `pending`.

This replaces "through the `identity_evidence` operation" in ADR 0213 decision 6 step 3, because that operation targets a Film and moves its revision. Most family (b) rows have no Film, and family (a) would move 714 Film revisions for history alone. The rest of decision 6 is unchanged.

**Order.** Family (b) imports after E2a and E2c are `on`, so that each history row is checked against live coverage first. Family (c) needs no live writer: its claim part (c3) is report-only under 0215-8b = C, and its retirement part (c4, c5) has no live writer. If the E3c dry run finds an actual causal-root record for a historical claim, it is surfaced for explicit review before any import.

**Tests (ER):** a staging insert after the seal refused; a seal racing a late load; a key present twice in a manifest, and duplicate inputs with conflicting `source_order` (reported, left out); two cohorts with different source-record representatives of the same key (`reconstructed_equivalent`); counts that must add up to the staged keys; a replay of the same reconstructed record (`already_imported`); a live row of the same key (`live_covered`); a `source_order` mismatch on one key; a backdated record added after extraction; a guard failing for a changed or deleted listed record; a concurrent addition after the cohort time (not imported, run continues); two concurrent runs; a live insert of the same key during the import; tampering with staged rows before and after the seal; a collision rolling back the chunk with no receipt; a lost response at every step; resume with a stale lease; a manifest digest that differs from the approved one; an R2 ETag change and its residual-window line in the report; chunk bounds; an import attempt while the writer is `pending`.

#### Amendment (PROPOSED, AIR-622, 28 November 2026): a source record may name the rows it depends on

**Problem.** The manifest pins one source row per record (step 3 above). A row that consumes two source rows cannot have both asserted at commit. The Discovery owner reject and revoke linked to their history row consume the intent (the movie, the time) and the history row (the `source_order`), and the scoped withdrawal of a replacement consumes the superseded intent as well. With one pinned row they had to stay unresolved, so Table 4 would never be fulfilled for them.

**Decision (option A, owner selected 28 November 2026; recorded here as Proposed).** A D1 source descriptor may carry an optional, bounded `requires` list:
- each item is a pinned row of the **same closed guard allowlist** (`{table, key, guard}`, the key columns all present and non-null, one to 40 scalar guard fields), at most three per source, none equal to the source or to another, and none with a `requires` of its own (no chains);
- it is carried **inside the existing `guard_json` object** under the reserved key `$requires` (the column allows a JSON object of at most 4,000 characters): no new column, table, writer or flag, and an oversized descriptor is refused at the dry run;
- the items are sorted canonically, so the order never changes the digest; `requires` is part of the source descriptor, so **it is covered by the manifest digest**, and two inputs of one source that disagree on it are a reported source conflict;
- the chunk batch asserts **each required row by its own statement, in the same atomic batch**, and the diagnosis of a refused chunk names `source_moved` for a required row exactly as for the primary one;
- the bounds hold: at most 50 sources and 200 rows per chunk keep a chunk at most `5 + 50 × 4 = 205` statements (the limit is 2,000), and every assertion binds at most the key plus the guard fields (the limit is 100).

**Preserved, and tested against the code before the change.** A source without `requires` serializes, hashes and tokenizes byte for byte as before: the digest, the source tokens and the canonical guard JSON of a v1 manifest are unchanged, so every approved or imported manifest (family (c) included) keeps its digest. The source token names the row, not its dependencies. The staging seal, the immutable source membership, the closed allowlist and the 50-source and 200-row chunk limits are unchanged, and the staged descriptor round-trips exactly.

**What it settles.** Family (b) stages an owner action from its intent and **requires** its linked history row (the association and the revision), and a replacement requires its history row and the superseded intent; the rows keep their live keys and their chronology, and the same-key parity with live rows holds (a live row of the same key and identity is `live_covered`, one with another chronology is a collision). The receipt-to-payload hash association itself cannot be asserted (ER has no SQL hash): the pinned fields stand for it.

**Tests.** `tests/identity-evidence-import-requires.mjs` (the v1 golden values, the validation, the canonical order and the digest, the exact staging round trip, every required row mutated or deleted after the seal failing its chunk as `source_moved` with zero ledger rows and zero receipts, the statement and bind bounds) and the owner-action cases of `tests/identity-evidence-family-b.mjs`.

**Consequences.** One narrow, additive, optional field in a dormant import path; no migration, no production operation and no change of any accepted authority. It is not an import or a dry-run authorization: those keep their own owner decisions and GOs.

### 8. The reader contract (E4)

Nothing reads the ledger to decide anything until that reader's own amendment is accepted (ADR 0213 decision 8). E4a (the ADR 0170 inventory) and E4b (the ADR 0184 planner) stay as listed there. A global catalog identity reader would be a decision of its own. Every amendment follows these rules:
1. **Strength** comes from the method ranking of ADR 0213 decision 3, with one exception: `known_alias` is ranked by method and `source_scope` together (decision 5, Q1-a), and an unknown scope ranks with `title_only`. Owner rows come first, and a `restricts` row blocks proof use unless an owner or a verified method asserts the proposition.
2. **Independence** counts distinct known roots. A null root is never independent.
3. **Scoped withdrawals and owner chronology** apply as decision 6 defines them: precedence by source order, unknown order unresolved.
4. **Film subjects** are resolved through `film_redirect`.
5. **Absence is per deterministic key, "no qualifying evidence recorded", never "not checked".** A reader computes the key K of the proposition it asks about. If no row with K exists, no eligible commit for K happened in any unbroken coverage interval of that writer (decision 4; for the initial slice, from the A2 flip). The absence of a row in a selection filtered by time or `seq` means nothing, because a key first inserted earlier is not written again inside a later interval. Inherited state from before the interval, and every gap, is unknown unless the family's import report lists the record as covered.
6. **Minting ids need no row** (decision 3).
7. **A reconstructed row counts as proof only if the reader's own amendment says so.**
8. **Reads are bounded and indexed, and a GET or MCP read never writes** ([ADR 0107](0107-get-head-read-side-effect-boundary.md)).

### 9. Delivery graph (choice 0215-7)

Each card is one atomic outcome. **Dormant** means that merging and the automatic deploy activate nothing. None of these cards is an AIR-275 prerequisite.

**Table 6. Cards.** Offline implementation, migration apply, writer activation, dry run, import approval, import and verification are separate outcomes.

| Card | Outcome | Depends on | Boundary | Gate |
| --- | --- | --- | --- | --- |
| **EC** (new) | One forward migration on top of E1's table: the writer control and change tables, the ledger's `source_order` column, the `known_alias` method value in the method CHECK, and any trigger relaxation the domain path needs (decision 1); the key helper and its strength table for `known_alias` by scope (Q1-a); the conditional-insert and assertion helper; the activation and break operator; tests | this record accepted; E1 merged | dormant (no row = `off`) | implementation GO |
| **ECM** (new) | Apply the EC migration, including the trigger relaxation if any | EC merged and deployed; M1 (the ledger table applied) | no behaviour change | production GO; may be one apply operation with another apply card, naming the exact files |
| **E2a** ([AIR-617](https://trello.com/c/IfAZDYDj)) | The Discovery decision writer (domain path) in every decision path, dormant | E1, EC | dormant | implementation GO |
| **E2c** ([AIR-619](https://trello.com/c/eXzl5TI8)) | The Discovery owner writer (domain path): assign, reject, replacement, scoped revoke, `source_order`; dormant | E1, EC | dormant | implementation GO |
| **E2b** ([AIR-618](https://trello.com/c/4RqJUcyf)) | The claim unit writer (canonical path), with the causal root hand-over from both link callers, the standard rooted key, and no row without a root (0215-8b = C); dormant | E1, EC | dormant | implementation GO |
| **E2-activation** (one operation per writer, inside each E2 card or split by the coordinator) | `off → pending`, drain evidence, `pending → on`, readback, then natural acceptance in `Верификация` | the writer's card merged and deployed; M1; ECM | the first coverage interval | production GO per writer |
| **E2d** ([AIR-620](https://trello.com/c/Zq9KsXPr)) | The retirement decision and application writers | **parked**: a live retirement writer and applier, which need their own product decision | — | — |
| **ER** (new) | The reconstruction import path: run, manifest staging and chunk receipt tables (a migration file), the dry-run and import operators, tests | this record accepted; E1 and EC merged (its SQL writes `source_order` and may write `known_alias`); can be built in parallel with E2 | dormant | implementation GO |
| **ERM** (new) | Apply the ER migration | ER merged and deployed; M1; ECM | no behaviour change | production GO |
| **E3a** ([AIR-621](https://trello.com/c/xTwNtXbc)) | Family (a): dry run and dated report with the manifest digest, then the owner's import decision naming it, then the import, then a post-import readback of receipts, counts and parity | E1, M1, A2, ER; the import also ECM and ERM (the shared import SQL references `source_order`) | the dry run writes nothing | dry run: production read approval; import: owner decision and production GO (L3) naming the digest |
| **E3b** ([AIR-622](https://trello.com/c/cOVFfEYd), narrowed to Discovery) | Family (b), the same four steps | ER; the import also ECM, ERM, and E2a and E2c `on` | as E3a | as E3a |
| **E3c** (new, split from AIR-622) | Family (c), the same four steps | ER; the import also ECM and ERM | as E3a | as E3a |
| **E4a**, **E4b** ([AIR-623](https://trello.com/c/ogwMreGD), [AIR-624](https://trello.com/c/g3Ka7qFa)) | Reader amendments | writers `on` for the routes they read and, where they read history, the matching import | reader switch | owner decision (ADR amendment) |
| **E5** ([AIR-625](https://trello.com/c/ibrRmnwA)) | Retire the unused 0001 tables | — | schema cleanup | owner decision |

- **E1 stays on its accepted scope.** Everything this record needs beyond the initial slice (the `source_order` column, the control tables, the import tables, and any trigger change for domain-path inserts) comes as forward migrations in EC or ER, never as a silent change to E1.
- **Within each E3 card,** the dry run, the owner's import decision, the import and its verification stay separate steps with separate approvals. The coordinator may split them into cards when detailing.
- **Migration apply order** follows ADR 0207 decision 7: D1 applies pending files in number order, every table here is inert until its writer or run starts, and each apply card names the exact files it applies.
- **No dual writer.** Every writer adds rows under an existing authority. None changes a Discovery decision, an admission, a canonical claim or a retirement decision.

### 10. Acceptance and test matrix

Each card proves its rows of this matrix on the real caller paths, offline. Natural acceptance after activation is separate.

| Area | Cases | Cards |
| --- | --- | --- |
| Domain atomicity | the row and the domain record commit together or not at all; a fence failure, a lease loss and a hold roll both back; the statement count stays under the cap | E2a, E2c |
| Activation | absent, `off`, `pending`, `on`; control compare-and-swap race; old-version commit during `pending`; rollback with and without a recorded break | EC, each E2 |
| Eligibility | a new decision writes a row; an unchanged or repeated decision writes none; a duplicate key writes none; policy exclusion and reconsider write none | E2a, E2c |
| Owner semantics | assign, reject, replacement of the same and of another candidate, revoke of an assign and of a reject, reinstatement, group children with partial success, forward-referenced withdrawal | E2c, E3b |
| Bridge rows | a rooted first commit writes one rooted row; a rootless first commit (backfill, replay, pre-A2 link, lost hand-over) writes none and leaves the claim write unchanged; a retry after a rooted commit writes nothing new; an uncertain first attempt settled without a row stays rootless; re-add with the same check writes nothing new; matching but unrelated, withdrawn, multiple and missing page checks never give a root; ambiguous history gives no row and a reported reason | E2b, E3c |
| Retirement | decision without application (no `film_has_id`); application failure; restore by `supersedes_seq`; unattributable historical application reported | E2d, E3c |
| Historical mapping | each row of Tables 4 and 5, including missing and ambiguous methods (b3, c2), exact owner intents, R2 records in non-terminal states excluded | E3a-E3c |
| Import | manifest digest bound to the GO; guard failures for changed and deleted listed sources; out-of-cohort additions that do not stop the run; concurrent live insert; collision; the four counts (`inserted`, `already_imported`, `live_covered`, `reconstructed_equivalent`) adding up; lost response and resume; bounds; R2 ETag change | ER, E3a-E3c |
| Readers | strength, including both `known_alias` ranks, an unknown scope never ranked higher, and both variants never proof; independence with null roots and same-root known-alias and detail-check rows, withdrawals, source order and unresolved order, redirects, absence inside and outside coverage, reconstructed rows not proof | E4a, E4b |
| Failure and recovery | writer `off` stops new rows and keeps old ones; a wrong row answered by an owner's scoped withdrawal; a stopped import resumed without duplicates | EC, ER |

## Alternatives considered

- **0215-1 B. One canonical receipt for every row, with a new target kind.** It needs a rebuilt `canonical_write_receipt` (SQLite cannot alter a CHECK) and a revision for things that have none, and it moves Film revisions for Discovery's decisions. Not recommended.
- **0215-1 C. Film-bound rows only.** No row for an observation that never becomes a Film and no owner rejection. It drops exactly the evidence before a Film exists that the owner asked to plan. Not recommended.
- **0215-2 B. First-sighting `exists` rows** for Watchlist and Diary lids, written in the promotion batch and the fact batch. It needs a new route (`watchlist_scan`) and a new method (`listing`), duplicates durable domain records, and still cannot cover the archive candidates. A reasonable later step if a reader needs it; not recommended now.
- **0215-3, selected B: a new method `known_alias`.** A: fold known aliases into `title_only` and `title_year` (loses the distinction the owner needs for localized titles). C: no row (loses the fact that 4,700 decisions rest on known titles alone).
- **0215-4 B. A Worker environment flag per writer.** It needs a removal card per flag, is not visible in D1, and records no coverage boundary. **C. Active from deploy.** It contradicts the dormant-then-activate shape of the E2 cards and gives no clean coverage start.
- **0215-5 B. A revoke also removes the claim.** The Discovery claim carries no observation key and every admission's `observation_key` is null, so a revoke cannot know whether a claim rests on the revoked assign. It would also make an evidence writer a canonical writer. Not recommended.
- **0215-6 B. The dedicated path only for families without a Film;** family (a) keeps the `identity_evidence` operation. Two import mechanisms, and 714 revision moves for history.
- **0215-8a B. Keep ADR 0213's "higher `seq` wins" among owner rows.** Import order would then decide owner precedence, so a historical action imported late would override a later live one. Not recommended.
- **0215-8a C. Import history before activating live writers, so `seq` happens to match time.** It forces a fixed order on every family, still fails for R2-era actions and for any re-import, and would make import order part of the meaning. Not recommended.
- **0215-8b, selected C: a bridge row only with a causal root.** Not chosen: A, keying by the receipt `request_id` (rootless live rows), and B below.
- **0215-8b B. Keep ADR 0213's key with the root for bridge rows.** The same occurrence would get a different key when a retry loses the hand-over, so one claim could produce two rows that look like two sources. Not recommended.
- **Consequence of C.** The backfill, replays, pre-A2 links and the nine historical claims have no bridge row. That is a stated, bounded gap, not a negative.
- **No null-root coverage exception.** Under every 0215-8b option, a rootless row never counts as covered by another row.

## Consequences

- **The ledger covers the identity routes that exist,** each from a known coverage start, with every gap stated: the unrecorded-method cohorts (1,866 decisions, 402 claims), the parked retirement writer and the unknown pre-D1 owner actions.
- **New durable contracts:** the domain path, the writer control with a drained activation and recorded breaks, scoped withdrawal with forward references, owner chronology by source order, the causal root hand-over and rooted-only bridge rows, the split between a retirement decision and its application, the minting rule and the manifest-bound import path.
- **Cost:** two additive migrations (EC, which also adds `source_order` to the ledger, and ER), two statements (an insert and an assertion) per domain evidence row, four for an owner replacement, which writes its row and a scoped withdrawal; and a bounded import per family. `source_scope` keeps the two known-alias variants apart.
- **Growth:** live Discovery rows grow only with new (observation, movie, method, `source_scope`) combinations, so at most with the 208 to 964 verified decision writes a day seen from 14 to 24 Nov 2026; a re-check of a known pair writes nothing. Owner, claim and retirement rows are rare. A full historical import adds about 16,400 Discovery rows plus a few dozen others.
- **Risk:** more code writes the ledger. It is mitigated by the per-writer control, by the atomic batch and by tests on the real caller paths. Coverage depends on a drain that is proven by operator evidence; a missed break would overstate coverage, which is why a rollback with the writer on is prohibited and every break is recorded.
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
  - whether any historical claim kept a causal root that the survey missed; the E3c dry run lists them, and only a found causal record could change c3.

## Owner choices

Selected by the owner on 25 Nov 2026 ([consolidated owner choices](https://github.com/vladimino/iptv-watchlist/pull/989#issuecomment-7154757622)); the record was accepted the same day ([final owner disposition](https://trello.com/c/DZNk9uMJ#comment-6b068bb6a944a15be3f7ca46)).

| # | Choice | Selected |
| --- | --- | --- |
| 0215-1 | Write path for evidence of a domain step | **A** domain path under the domain's fence |
| 0215-2 | Bare sightings (`exists`) | **A** not stored now; relation reserved; revisit trigger stated |
| 0215-3 | Discovery known-alias decisions | **B** a distinct method `known_alias`, never proof, variant kept in `source_scope` |
| 0215-4 | Activation of each new writer | **A** a D1 control row per writer, drained activation, recorded breaks |
| 0215-5 | Claim side of an owner revoke | **A** evidence only; the canonical claim unchanged |
| 0215-6 | Reconstruction import path | **A** one dedicated, manifest-bound path for every family |
| 0215-7 | Delivery graph | **A** Table 6: EC, ECM, ER, ERM and E3c; per-writer activation; E3b narrowed; E2d parked |
| 0215-8a | Owner chronology (amends ADR 0213 decision 5) | **A** precedence by `source_order` within one causal scope; unknown or incomparable order unresolved |
| 0215-8b | Bridge rows | **C** a row only with a causal page-check root, standard rooted key; no rootless live bridge rows |

**Q1 (raised by 0215-3 = B): the rank of `known_alias`.** Selected by the owner on 25 Nov 2026: **Q1-a** ([owner choice](https://github.com/vladimino/iptv-watchlist/pull/989#issuecomment-7155532290); verbatim on [AIR-616](https://trello.com/c/DZNk9uMJ#comment-6b06896594f5dce5863b9663)). The rank follows what each variant matched: `known_epg_alias` alongside `title_only`, `known_alias_year_runtime` alongside `title_year`. Not chosen: Q1-b (one tier between the two), Q1-c (one tier below `title_only`), Q1-d (unranked until E4).

## Follow-ups

**On acceptance.**
- Create the EC, ECM, ER, ERM and E3c cards. Narrow AIR-622 to Discovery and park AIR-620 with its reason.
- Add each card's real prerequisites as bare URLs in native checklists.
- Copy the relevant rows of Tables 3-5 into each E2 and E3 card.

**Candidate follow-ups, not selected.**
- A bounded live re-verification of the 402 non-minting TMDB claims by the page check of ADR 0166, which would give them `page_check` evidence.
- A global catalog identity reader (decision 2's revisit trigger).

**Observed, not changed here.**
- `discovery_decision_history` has no append-only trigger.
- `discovery_admission.observation_key` is never set.
- The retirement writer is not bundled.
