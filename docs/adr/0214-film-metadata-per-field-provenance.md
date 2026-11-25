# ADR 0214: Each `film_metadata` field carries provenance bound to its value; one writer rule protects owner values and replaces an automatic value only with a higher-ranked observation

**Status:** Proposed  
**Original decision date:** not decided  
**Recorded at:** 2026-11-24. Revised the same day after the [independent review](https://github.com/vladimino/iptv-watchlist/pull/988#pullrequestreview-6047546598) of `05509e8` (six P1 findings and the cost clarification; the section [Review findings](#review-findings-of-2026-11-24-and-where-each-is-answered) maps them), and after the [second review](https://github.com/vladimino/iptv-watchlist/pull/988#pullrequestreview-6047797014) of `5897652` (four targeted P1 corrections, mapped in the same section).  
**Approval source:** not decided. The open choices are 0214-1 to 0214-8 ([Owner choices](#owner-choices-open)).  
**Related work:**
- [AIR-613](https://trello.com/c/Nc89nzGD), card PF of the [ADR 0207 delivery graph](0207-letterboxd-admissions-coordinated-in-d1-only.md#7-delivery-graph-7c). The owner approved the roadmap on 2026-11-24. It is **not** a prerequisite of [AIR-275](https://trello.com/c/4x7hH0gI).
- [ADR 0211](0211-catalog-enrichment-producer.md), owner choice 0211-1 = A: fill-only now, with option B (per-field provenance and a safe refresh and overwrite rule) planned as this record.
- [ADR 0213](0213-film-identity-evidence-ledger.md), the identity evidence ledger. This record neither reads nor writes it.
- [ADR 0120](0120-canonical-film-writers-identity-metadata-membership.md), the canonical Film writer. Its rules R1 (blank values, outside the sync clocks) and R5 (the `film_metadata` merge) are still draft.

**Supersedes:** None while Proposed. If Accepted, it would:
- supersede in part, **only while the provenance mode is `enforce`** (decision 11):
  - ADR 0211 decision 1 (fill-only);
  - the ADR 0211 decision 2 rule that a later answer of an earlier source never overwrites;
  - the ADR 0211 decision 3b rule that values written under a superseded anchor are never overwritten (by 0214-5 = A);
- settle ADR 0120 rule R5 (metadata part) and rule R1 for the six fields of decision 1. Everything else in ADR 0120 is unchanged.

**Superseded by:** None

## Context

### What exists (main `cb1fb88`, 24 Nov 2026)

**One writer, several callers.** `writeFilmFacts` (`src/canonical-film-writers.js`) is the only writer of `film_metadata`. Every write asserts the marker generation, the Film revision and no redirect, and bumps the Film revision, so a plan and its commit are atomic against any other write of the same Film.

| Caller | What it writes | How it merges | Status |
| --- | --- | --- | --- |
| EPG Producer `film_facts` (`filmFactsOf`, `src/canonical-producer-workflow.js:73`) | the published Watchlist film record, stamped `metadataAt`, with a separate `synopsisFetchedAt` | `mergeMetadata`: a non-blank incoming value overwrites the stored one | active |
| `metadata_sync` (`src/canonical-metadata-sync-producer.js`) | the record of the EPG metadata stage, refreshed after 30 days (`src/worker.js:1343`) | the same merge | the stage fetches nothing while the Watchlist marker pins the run (ADR 0186) |
| ADR 0211 catalog-enrichment producer (card C1) | Letterboxd and TMDB values through their anchors | fill-only, one blank guard per field | designed, not implemented |
| `mergeFilms` (`src/canonical-mutations.js:184`, `reconcile` at `:279`) | the whole row of one of the two Films, by an explicit choice | whole-row move | no runtime caller |
| a `metadata: null` clear (`planFilmFacts`, `canonical-film-writers.js:212`) | deletes the row | — | in the planner's contract; no runtime caller found on `cb1fb88` (the retired projector repository has the same clear at `canonical-repository.js:181`) |

- **No per-field source.** `film_metadata` (migration 0001) holds `year`, `runtime`, `synopsis`, `poster`, `url`, `genres_json`, `people_version`, `payload_json`, `r2_key`, `content_sha256` and `updated_at`. Nothing says which source supplied which field, when, or through which identity.
- **The EPG callers have no per-field lineage either.** `mergeWatchlistFilm` (`src/metadata-cache.js:16`) overlays the Watchlist listing on the cached `parseFilm` record field by field, the synopsis has its own clock, the cached record stores no per-field origin, and `metadata_sync` may reach the Film through the TMDB claim or a spelled Film id (`resolveExistingFilmId`, `canonical-metadata-sync-producer.js:55`). That a Film holds a trusted Letterboxd claim does not prove that all six values came from that Letterboxd entity at one observation.
- **What looks like provenance, but is not per field:**
  - the `metadata` row of `film_dimension` is a Film-level lifecycle status with one `source`, and other writers replace its `provenance_json` whole (ADR 0211 decision 1);
  - `r2_key` and `content_sha256` describe the projection that wrote the row, not the fields.
- **Protection.**
  - The writer protects reviewed and owner **dimension rows** (`strong()`, `canonical-film-writers.js:45,179`).
  - It does **not** check any lock before it merges a `film_metadata` value. ADR 0211 C1 adds a guard on the dimension lock for its own writes only.
  - **No route lets the owner set, pin or correct a metadata field.** ADR 0211 says a wrong value "is corrected by the owner and review routes", but for metadata no such route exists.
- **The merge compares bookkeeping only.** `reconcile` decides whether two rows differ by `payload_json` and `content_sha256` alone (`canonical-mutations.js:282-290`). In production every row has `payload_json = '{}'` and 405 of 414 have `content_sha256` NULL (L0 below), so two rows with different `year` or `synopsis` compare equal, and the retired Film's row is deleted without a choice (`:236-246`).
- **Accepted provenance patterns elsewhere:**
  - the title: `original_title` carries `titleSource {source, at}` inside the identity provenance, ranked by an accepted order (ADR 0120 R3, R3b);
  - localization: one row per automatic source in `film_localization_source`, with owner and reviewed values above them (ADR 0099);
  - one-way and transition triggers on marker tables (migrations 0013, 0031, 0034), and immutable-row triggers (0031);
  - receipted units: `canonical_write_receipt` (migration 0019, ADR 0119) keys a unit by `request_id`, with a `content_digest`, a target, planned and applied revisions and a state (`pending`, `applied`, `failed`, `unknown`, `abandoned`); the receipt tail is written in the unit's own batch, and a replay of an applied request id answers without a batch (`receiptedWrite`, `canonical-receipts.js:489`). ADR 0207 R1 adds the `operation_key`.
- **Freshness.** `film_sync_state` holds four Film-level clocks (ADR 0070). No field has its own observation time.

**Production L0 read** (24 Nov 2026 20:51 UTC, aggregate `SELECT`s only, `rows_written` 0):

| Measure | Value |
| --- | --- |
| Films | 13,292 (15 redirects) |
| `film_metadata` rows | 414 |
| Fields set among them | `year` 414, `runtime` 410, `synopsis` 414 (266 characters on average), `poster` 414, `url` 414, `genres` 414 |
| `payload_json` | `{}` in all 414 rows |
| `r2_key` | `metadata.json` in 406 rows, NULL in 8; `content_sha256` NULL in 413 |
| Their `metadata` lifecycle row | `source = letterboxd` for 406, `source = tmdb` for 8 |
| `metadata` lifecycle rows in all | 10,865. So 10,451 Films have a lifecycle row and no `film_metadata` row; their metadata, if any, lives outside `film_metadata` |
| `metadata` lifecycle rows that are reviewed or owner or dictionary authority | **0** |
| `film_rated_admission` rows | 714 |
| D1 database size | 2,563,719,168 bytes |

### The problem

1. **Fill-only cannot correct anything.** A value written by the ADR 0211 transport fallback stays after the preferred source recovers. A value written under an identity that was later corrected stays. A stale value is never refreshed. ADR 0211 records these as `stored_differs`, `fallback_fill` and `written_under_superseded_anchor` and leaves them to this record.
2. **The EPG merge can go backwards.** A non-blank value from the EPG chain overwrites any stored value. That includes a newer value that another writer fetched and checked, replaced by an older cached observation. Once C1 writes, this becomes a real regression path.
3. **The owner cannot protect or correct a field.** There is no per-field lock, and the existing dimension lock is not checked by the EPG merge.
4. **Unknown and known values look the same.** Nothing distinguishes the 414 legacy rows from values a future writer checked. So any overwrite rule would either treat all of them as trusted or all of them as disposable.
5. **A merge can discard values silently**, because it compares bookkeeping, not the fields.

### Settled decisions this record keeps

- The ADR 0211 anchors, the page agreement contract, the per-field precedence, the 72 h transport-only fallback (0211-7 = B), and "a known disagreement blocks every automatic write".
- **Hints never become proof** (ADR 0211 decision 2, ADR 0213). Metadata never proves identity.
- **No stored candidates and no proof snapshots** (0207 direction 4A, "Не надо усложнять"; ADR 0211 decision 2).
- **A blank never overwrites** (ADR 0120 R1).
- **Scope widening stays separate.** C3a and C3b are not changed by this record.
- `mergeFilms` stays dormant. This record changes its contract and tests; it requests no activation.

## Decision (proposed)

### 1. Scope: six fields of `film_metadata`

- **In scope:** `year`, `runtime`, `synopsis`, `poster`, `url` and `genres`, the `core` part of ADR 0211.
- **Out of scope, with the reason:**
  - `people_version`, `payload_json`, `r2_key`, `content_sha256`, `schema_version` and `updated_at`: bookkeeping, not facts about the film. They keep today's semantics.
  - `film.original_title`: it has its own accepted provenance and order (ADR 0120 R3, R3b).
  - Localization: it already has per-source rows and owner and reviewed tiers (ADR 0099).
  - Credits: add-only, under the ADR 0211 credits rule. Per-credit provenance would be a separate decision.
  - The `film_sync_state` clocks.
  - Metadata that lives outside `film_metadata` (the 10,451 Films above), including any future global catalog store.

### 2. A provenance record per field, bound to the value (0214-1)

**Recommended: 0214-1 = A.** One additive nullable column, `film_metadata.field_provenance_json`, holds one object per field. It is written in the **same row write** as the value. So a merge, a clear or a retirement that moves or deletes the row moves or deletes the provenance with it, with no second path to keep consistent. (That alone does not protect the values; decisions 4 and 9 do.)

Each field object has two parts.

**The semantic part**, which decision 5 compares and which converges (decision 6):

| Key | Meaning |
| --- | --- |
| `tier` | `owner` (protected), `automatic`, or `released` (an owner value the owner released) |
| `source` | `letterboxd`, `tmdb` or `owner`. A pinned automatic value keeps its source and gets `tier = owner` |
| `anchor` | the exact anchor the value was written through (`letterboxd:<lid>`, `tmdb:<id>`), or null |
| `anchorDigest` | the digest of the Film's **whole anchor set** at the write (decision 7), or null |
| `agreement` | `confirmed`, `not_required` or `unconfirmed` (decision 3); null for the owner |
| `observedAt` | when the source gave this value (the fetch, or the parse clock the caller already has); for the owner, the time of the action |
| `valueDigest` | SHA-256 of the canonical JSON of the stored value |

**The audit part**, which may differ between arrival orders and is never compared:

| Key | Meaning |
| --- | --- |
| `origin` | the writer: `catalog_enrichment`, `epg_film_facts`, `metadata_sync` or `owner_route` |
| `checkedAt` | the last time an observation of the same or a higher rank confirmed the value; only ever increases |
| `writeKey`, `writtenRevision` | the unit's `operation_key` or request id, and the Film revision the write produced |

**Binding.** A field object counts only while its `valueDigest` equals the digest of the stored value. Otherwise the field reads as `unknown`, and the mismatch is reported as `provenance_mismatch`.
- A path that changes a value without restating its provenance can therefore never make the old provenance describe the new value. Such paths are an older code version, a restore, the offline importer or a manual repair.
- No SQL digest function is needed. The writer compares digests when it plans, and the Film revision fence makes the plan and the commit atomic.

**History.** An append-only table, `film_metadata_history(id, film_id, field, old_value_json, old_provenance_json, new_provenance_json, reason, write_key, old_anchor_digest, new_anchor_digest, details_json, at)`, gets one row whenever a non-blank value is replaced, cleared or discarded by a merge, or an owner action changes a field.
- A fill of a blank field, and an adoption (decision 5), add no history.
- It is written in the same batch as the change.
- `(film_id, field, write_key)` is unique, so a replay never duplicates a row.
- A trigger (`film_metadata_history_append_only`) refuses every `UPDATE` and `DELETE` on it. No foreign key cascades into it, so deleting a `film_metadata` row or a Film leaves its history in place.
- Retention is indefinite. Pruning would be a separate decision.

**Absence means unknown.** A field with no object is `unknown`: today's 414 rows, and any value written before recording starts. **Nothing is backfilled, and nothing is inferred from hints**: not the lifecycle row's `source`, not `r2_key`, not the URL host, not the language of a synopsis.

Alternatives: B, a side table `film_metadata_field` with one row per field; C, four or more columns per field on `film_metadata` (at least 24 columns). See [Alternatives](#alternatives-considered).

### 3. Confidence and rank

Confidence is a closed, ordered vocabulary, not a score. It is **derived at read time** from the field object and the Film's current anchors, never stored as a fact:

| Rank | Confidence | When |
| --- | --- | --- |
| 5 | `owner` | `tier = owner`. The Film-level `metadata` dimension row that is reviewed or owner-authority locks every field the same way (decision 4) |
| 4 | `confirmed` | `anchorDigest` equals the Film's **current** anchor digest, and `agreement` is `confirmed` or `not_required` |
| 3 | `superseded` | an attributed value whose `anchorDigest` no longer equals the current digest: an anchor value changed, a source was added or removed, or a TMDB id was retired (decision 7) |
| 2 | `unconfirmed` | `anchorDigest` is current and `agreement` is `unconfirmed`: the ADR 0211 transport-only fallback (`unconfirmed_agreement`), or a declared write whose agreement was stale (below) |
| 1 | `unknown` | no field object, a digest mismatch, `tier = released`, or an undeclared write (decision 4) |

**How `agreement` is set.** The writer, not the caller, decides it:
- `not_required` only when the anchor set the writer computed holds no Letterboxd anchor;
- `confirmed` only when the caller's `agreedAnchorDigest` (ADR 0211's `agreed_anchor_digest`) equals the digest the writer computed for the current set;
- otherwise `unconfirmed`, recorded as `agreement_stale` when the caller claimed agreement for another set.

So an agreement recorded for one anchor set never covers another: with the lid unchanged and TMDB A → B, the digest differs, the stored values become `superseded`, and a new write is `confirmed` only after ADR 0211 confirms the agreement for the new set.

**The rank of an automatic value** is the tuple, compared lexicographically:
1. confidence;
2. the accepted ADR 0211 precedence of its source for that field (`letterboxd` before `tmdb`); `unknown` has none;
3. `observedAt`;
4. `valueDigest`, as the last tie-break.

**Confidence never degrades automatically.** A lower-ranked observation never replaces a higher-ranked value, even when it is newer.

**Provenance is not identity.** An anchor in a field object records which claim a write relied on. It is never a claim, an evidence row (ADR 0213) or an anchor for any other write. Agreement comes only from the ADR 0211 page agreement contract.

### 4. One rule in the single writer, for every caller (0214-2)

**Recommended: 0214-2 = A.** The rule lives in `writeFilmFacts`, so every caller is subject to it: the EPG `film_facts`, `metadata_sync`, the C1 producer, the owner route (decision 9) and any future writer.

**Declared and undeclared writes.**
- A **declared** write names, per field, `source`, `origin`, `anchor`, `observedAt` and, for Letterboxd-anchored Films, its `agreedAnchorDigest`. `observedAt` must parse as an instant and must not be later than the write clock plus 60 s; otherwise the write is `film_person_invalid`. Only C1 and the owner route are declared writers in this record.
- An **undeclared** write carries no per-field provenance and ranks `unknown`. **The EPG callers are undeclared**, because the code gives them no per-field lineage (Context). That is not a transitional shortcut: a Film-level claim or clock is not a field's origin, and declaring one would attribute values from hints. An older plan, and a receipt replay of a plan made before recording started, are undeclared too.
- An undeclared write:
  - fills a blank field;
  - replaces an `unknown` value in modes `record`, `observe` and `enforce`, which is today's behaviour for legacy data, now with a history row;
  - **never** replaces an attributed value (`confirmed`, `superseded` or `unconfirmed`), a locked field or an owner value;
  - in mode `hold`, only fills;
  - removes the field object of a field it changes, so the value reads `unknown`.
- A candidate follow-up, PV4 (decision 15), may give the EPG metadata stage real per-field lineage where it parses the page itself (`parseFilm(html)` in `metadataSyncStep`, `src/worker.js:1343`). Until a card decides that, EPG writes stay undeclared.

**Locks for everyone.** A write to an `owner` field, or to any field while the dimension lock holds, is skipped with `owner_kept` (as the title is today) unless the write carries owner authority (decision 9). The skip never refuses the batch whole. Enforced from mode `record` on, whatever the caller, and by the database triggers of decision 11 even for code that predates this record.

**Blank never clears.** A blank or absent incoming value never clears a stored one (ADR 0120 R1). When it comes from the stored value's own source, it is recorded as `source_absent`.

**Fences in the batch.** Beside the marker generation, the Film revision and no redirect (existing), **every** metadata batch, a fill included, asserts the control row's `mode` and `revision` the plan read (decision 11) whenever the control table exists, at `off` too. So no batch planned under one mode commits under another: a mode change fails every in-flight batch, and the producer's ordinary retry replans it. Without the control table (before PVM) the batch is today's, and no activation is possible yet.

A **declared** batch, whether it fills, adopts or replaces, also asserts:
- the planned anchor set: every planned anchor still holds by its exact `(scheme, value)` (trusted, non-conflicting, singly owned, not retired), and no other trusted `letterboxd` or `tmdb` anchor of the Film exists. This is the writer's own compound assertion, derived from the rows it read to compute `anchorDigest`, and it is not one of the caller's 12 guards. A competing claim by another Film, or a retirement, changes `holds` and therefore fails it;
- for an automatic declared writer, no `identity_disagreement` on the Film's ADR 0211 film row (`catalog_enrichment_state`, `part = 'film'`; an absent table or row means none).

So a C1 fill planned under anchor set A never commits after A → B, and a known disagreement blocks every C1 write, fills included, as ADR 0211 requires. Attribution and adoption are gated exactly like replacement, because each of them writes a field object that claims the current anchors.

**C1 keeps every guard of ADR 0211** in every mode: its anchor-set guard, its epoch guard, its lock guard, the lease and the control generation. The only change is in `enforce`, where its per-field *blank* guards are replaced by the Film revision fence, which already proves the planned state at commit, so the writer adds no per-field guard of its own (decision 12).

An **owner** batch (decision 9) asserts the mode, the revision and the Film revision, and nothing about anchors or disagreement: owner authority is separate from the automatic identity gates, so a manual correction during a disagreement is possible.

An **undeclared** batch asserts the mode and the revision, and otherwise only the existing fences. It is **not** blocked by a disagreement: the EPG chain resolves its target through the canonical claims (AIR-572) and reads no C1 state today, and an `unknown` value cannot launder a disagreement into attribution. A field it fills during a disagreement stays `unknown`, is visible as such in the owner view of that Film (decision 9), and is adopted or replaced by confirmed observations once the disagreement is resolved (decision 8).

Alternatives: B, only C1 and the owner route follow the rule, and the EPG callers keep today's merge but respect locks; C, the EPG callers become fill-only.

### 5. The replacement rule (0214-3)

**Recommended: 0214-3 = A.** In mode `enforce`, a declared incoming value V for field F, with stored value S, is handled by **one comparator**, the rank tuple of decision 3:
1. **Refused (`owner_kept`)** when F is `owner` or the dimension lock holds.
2. **Refused (`disagreement`)** when the Film is in `identity_disagreement`.
3. **Refused (`anchor_changed`)** when V's anchor does not hold at commit (the batch fails on the anchor-set assertion and the caller replans).
4. **Blank S:** V fills F.
5. **`rank(V) > rank(S)`:** V replaces S, with a history row, **subject to 0214-4**: under option B an `unconfirmed` V never replaces a *different* value of any rank; it only fills a blank and adopts an equal value, as the accepted ADR 0211 fallback does. The replacement covers:
   - an `unknown` S (decision 8): any declared V under 0214-4 = A, a `confirmed` V under B;
   - a `superseded` S replaced by a `confirmed` V (decision 7). An `unconfirmed` V ranks below `superseded` and therefore never replaces it;
   - a higher confidence, or a higher precedence at equal confidence;
   - a **refresh**: the same confidence and source, a later `observedAt`, a different value (under B, `confirmed` only);
   - at equal confidence, source and `observedAt`, a different value: the `valueDigest` decides, deterministically, and the case is listed as `same_rank_conflict` for review.
6. **`rank(V) = rank(S)`:** the digests are equal, so the values are equal. Nothing changes but `checkedAt`. Counted as `agreed`.
7. **`rank(V) < rank(S)`, equal value** (for example an `unconfirmed` observation matching a `confirmed` value): nothing changes, not even `checkedAt`. Counted as `agreed`.
8. **`rank(V) < rank(S)`, different value:** refused and recorded as `stored_differs`, as in ADR 0211.

**Adoption** is the equal-value case of row 5: an incoming value equal to S but of a higher rank replaces the semantic part of S's provenance (the value is unchanged), with no history row. That is how an `unknown` or `superseded` value becomes attributed when a real observation under the current anchors matches it.

**Never:**
- clear a value;
- replace an `owner` field;
- write across a known disagreement;
- lower confidence;
- replace a value with an older observation of the same rank.

**Modes other than `enforce`** apply only rows 1-4 and the undeclared-write rule of decision 4 (an `unknown` S may be replaced by an undeclared write, with history); declared writers stay fill-only, as ADR 0211 delivers them, and adopt equal values. The comparator decides replacements in `enforce` only.

Alternatives: B, narrow (only values from the 72 h fallback are replaced when the preferred source recovers, plus owner-triggered refresh); C, fill-only plus owner edits only.

### 6. Convergence

**What converges.** For a fixed set of declared observations of one field, arriving in any order and any interleaving, the **semantic projection** of the field (the stored value and the semantic part of its provenance: `tier`, `source`, `anchor`, `anchorDigest`, `agreement`, `observedAt`, `valueDigest`) ends the same, provided the Film's anchors and locks are the same throughout.

**Where it holds.** In mode `enforce` only: the fill-only modes keep ADR 0211's first-fill-wins behaviour and claim no convergence. Under 0214-4 = A it holds for every declared observation. Under 0214-4 = B it holds for the `confirmed` and owner observations; `unconfirmed` observations only fill and adopt, as the accepted fallback does, so among themselves the first fill wins (ADR 0211 decision 2), and a `confirmed` observation then replaces whichever of them landed.

- Every replacement strictly raises the rank tuple, which is a total order (the digest tie-break makes it total even for two different values with equal confidence, source and `observedAt`).
- Every adoption strictly raises the rank of the provenance without changing the value.
- So the final state is the maximum of the set under the tuple order, whatever the order of arrival.

**What does not converge, by design.** The audit part (`origin`, `checkedAt`, `writeKey`, `writtenRevision`) and the history rows depend on the order of arrival. They are never compared and never decide anything.

**Races.** Two writers are fenced by the Film revision. The loser replans against the winner's provenance. A declared write whose `observedAt` is older than the stored `observedAt` of the same source and confidence is refused (row 8), so a late arrival of an old observation never regresses a field.

### 7. Identity changes and superseded values (0214-5)

ADR 0211 decision 3b detects an anchor change (a value correction, a source-set change, a retirement) through the anchor digest, invalidates the plan and lists the values written under the old anchor.

**Recommended: 0214-5 = A.** Here, every attributed field whose `anchorDigest` no longer equals the current digest ranks `superseded` (decision 3). It is distinct from `unknown`:
- it is replaced **only** by a `confirmed` observation under the current anchors, or by the owner;
- an `unconfirmed` observation (a fallback, a stale agreement) and an undeclared write never replace it;
- an equal `confirmed` observation adopts it.

**On a change:**
- The next `confirmed` observation under the current anchors replaces the superseded value, with a history row.
- If the current sources have no value for that field, the old value **stays**. Once C1 has settled the Film's `core` part under the new anchors without re-confirming the field, it is listed as `superseded_kept` for owner review. A source-set growth that is re-confirmed at the next fetch is therefore transient and never listed.
- Nothing is cleared automatically. A correction may be a duplicate retirement of the same work, where the old values are still right, and the writer cannot tell that from a wrong match.
- `owner` fields are untouched.
- Credits stay held as `superseded_credits` (ADR 0211; credits are out of scope).

**Both cases of an own-source anchor are covered.** The digest is over the whole anchor set:
- lid L → L′ with TMDB unchanged: the Letterboxd values and the TMDB values are `superseded`, because the agreement that covered them was for the old set;
- TMDB A → B with the lid unchanged: the same;
- a source added (growth): every attributed field is `superseded` until re-confirmed under the grown set; C1 reopens the part;
- a source removed: its values are `superseded`; they stay unless the remaining sources confirm a value.

The writer computes the current digest from `film_external_id` and `tmdb_retirement_decision` for the Film (a bounded read, the ADR 0211 3b digest), and asserts the set in the batch (decision 4), for every declared writer, so a change between the plan and the commit fails the batch.

Alternatives: B, hold every superseded value for the owner (today's ADR 0211 listing only); C, clear superseded values at once and refill.

### 8. Legacy and unknown values (0214-4)

`unknown` is the lowest rank. Two things are settled, not chosen:
- an undeclared write replaces an `unknown` value with a history row, as today (decision 4), so the EPG chain's refresh of the 414 rows it wrote itself is unchanged;
- any declared observation equal to an `unknown` value **adopts** it (decision 5), so legacy values become attributed without inventing anything.

**The choice is which declared observations may replace a *different* `unknown` value.** It touches the accepted ADR 0211 fallback (0211-7 = B), which today fills **blank** fields only.
- **A**: any declared observation, `confirmed` or `unconfirmed`. This widens the accepted fallback from blank-only to blank-or-`unknown`: during a 72 h Letterboxd outage a TMDB value may replace a legacy value of unknown origin. Convergence then holds for every declared observation (decision 6).
- **B (recommended)**: only a `confirmed` observation. The `unconfirmed` fallback stays blank-only, exactly as accepted, and adopts an equal `unknown` value. A legacy value is replaced only by a value confirmed under the current anchors. Convergence holds for the confirmed and owner observations (decision 6). In the initial C1 scope (new admissions, which have no legacy row) A and B behave the same; they differ once C3a or C3b widens the scope.
- **C**: `unknown` values are protected until the owner releases them, which is fill-only for all legacy data, including the EPG chain's own refresh.
- **D (not recommended)**: attribute legacy values from hints (the lifecycle row's `source`, `r2_key`). That would turn a hint into proof.

**Why replacing legacy values is safe for owner data under A or B.**
- No code path has ever written `film_metadata` with owner authority.
- No `metadata` lifecycle row is reviewed or owner-locked (L0 above).
- The historical R2 `metadata.json` was the parse cache of the metadata stage.
- Manual historical edits cannot be ruled out. The history table makes every replacement reversible by the owner (decision 9), and under B nothing weaker than a confirmed observation replaces one.

### 9. Owner protection, corrections and the destructive paths (0214-6)

**Recommended: 0214-6 = A.** An owner route, its UI a separate card.

**The authorized exception.** The metadata input of `writeFilmFacts` gains `authority: 'owner'`, the convention the title already uses (`film.authority === 'owner'` with `source = 'owner'`, `canonical-film-writers.js:144`). With it, and only with it, the writer may change `owner` fields and fields under the dimension lock, and sets each written field's `tier` as the action says. The writer refuses owner authority from any receipt origin other than `owner_route` (`film_person_invalid`), and the route sets it only after the Worker-side JWT and owner-subject checks below. Automatic callers never carry it.

**Read.** `GET /api/admin/films/<id>/metadata`: every field with its value, provenance, effective rank, lock, the C1 conflicts and hints of the Film, and its history, including the history of Films redirected into it (one hop). It is a pure read, registered in the GET write baseline.

**Write.** `POST /api/admin/films/<id>/metadata` takes `{action, field?, value?, historyRef?, expectedRevision, requestId}`:

| Action | Effect |
| --- | --- |
| `set` | writes an owner value (`tier = owner`, `source = owner`), after validating the field's type and bounds; history |
| `lock` | pins the current value (`tier = owner`, source kept); history |
| `release` | keeps the value, `tier = released`, so it ranks `unknown`; history. Under a dimension lock the field stays protected, and the readback says `dimension_locked: true` |
| `revert` | restores the old value and provenance of one history row, then pins it, so the same refresh cannot immediately undo the revert; history |
| `refresh` | raises the C1 `core` refresh epoch of the Film through the ADR 0211 `retry` mechanism (part `core`, its own `expectedRows` compare-and-swap, epoch and lease fences), whatever the rows' status. It is an epoch-only mutation: no metadata write, no history row, no Film revision bump. `not_in_scope` when the Film has no state rows. Its command row (below) makes replay and lost responses deterministic |

- **Dimension lock.** The Film-level `metadata` dimension row that is reviewed or owner-authority locks all six fields for automatic writers. The route never changes that row; the review routes own it.
- **Receipts: every owner command, `refresh` and no-ops included, writes one row of an additive table `film_metadata_owner_command(request_id PRIMARY KEY, film_id, action, command_digest, outcome, applied_revision, at)` in its own batch.** The existing `canonical_write_receipt` is not used: its applied tail requires `planned_revision + 1` to equal the Film revision after the batch, and it has no outcome field, so it cannot record an epoch-only refresh or a no-op honestly.
  - `command_digest` = SHA-256 of the normalized command: `filmId` as the route received it, `action`, `field`, the canonical JSON of `value`, `historyRef`, `expectedRevision`, and for `refresh` the sorted `expectedRows` (`part`, `source`, `status`, `updated_at`, `refresh_epoch`).
  - `outcome` is `applied`, `noop` or `rejected:<reason>`, `applied_revision` the Film revision after the batch (NULL for `refresh` and for rejections). A metadata command bumps the Film revision through `writeFilmFacts`, a no-op included, so its `applied_revision` is real; `refresh` writes only the state rows and this row, and asserts the C1 epochs instead of a revision.
  - Before anything else the route reads the row by `request_id`: a **different** digest answers `rejected: request_mismatch`, on any field and any action; an equal digest answers the stored `outcome` and `applied_revision` as `already_applied`, without a batch, whatever was written, merged or redirected since. No row means the command never committed, because the row and the effect are one batch, so a lost response is settled by this single read and the command may be sent again.
  - `writeKey = requestId` on every field the command changes, and the history row is unique on `(film_id, field, write_key)`.
- **Ownership and identity of `historyRef`.** The row's `film_id` must be the Film or a Film redirected into it; otherwise `rejected: foreign_history`. A history row binds the **old** value's identity: `old_anchor_digest` is the replaced field object's `anchorDigest` (NULL when the old value was `unknown`), and `new_anchor_digest` the digest at the write. A revert is applied only when `old_anchor_digest` equals the Film's current digest; otherwise it is `rejected: anchor_changed`, and when `old_anchor_digest` is NULL it is `rejected: identity_unknown`, with the old value shown. In both cases the owner may `set` the value, which is an explicit assertion under the current identity. So a value written under an old or unknown identity is never pinned as if its identity were known. **The comparison is also asserted at commit:** a revert batch carries the anchor-set assertion of decision 4 for the set whose digest equalled `old_anchor_digest` at plan time, so a competing claim or retirement that changes the set between the plan and the commit fails the revert (`anchor_changed` after replan). Unlike automatic writes, it does not assert the absence of a disagreement.
- Every change is one `writeFilmFacts` call with owner authority, one batch, the fences of decision 4, a compare-and-swap on the Film revision, and a readback answering `applied`, `rejected` or `uncertain` (503, `outcome: unknown`).
- The route requires the authentication of ADR 0211 decision 6: an Access JWT verified in the Worker (`mcpVerifyAccess`), the owner subject, the Worker's own `Origin`, `X-IPTV-Admin-Action` and a JSON content type. It refuses every write while the mode is `off` or the schema is absent.

**The destructive paths.**
- **Clear (`metadata: null`).** Refused (`film_metadata_locked`) when any field is `owner` or the dimension lock holds, unless the input carries owner authority. Refused (`film_metadata_attributed`) for an automatic caller when any field is attributed. Allowed otherwise, and every non-blank value cleared gets a history row (`cleared`). No runtime caller clears today; the rule binds the planner's contract.
- **Merge (`reconcile`, dormant).** The comparison becomes field-wise: the six values and their field objects. The result is assembled field by field, never as a whole row, and the retired Film's history stays under its own id, read through the redirect.
  - Equal value and equal provenance: the survivor's field is kept.
  - Equal value, provenance differs, neither side `owner`: the higher-ranked provenance is kept (adoption, decision 5); the other goes to history (`merge_discarded`).
  - **Equal value, exactly one side `owner`: the pin is preserved by default.** The survivor's field takes the owner-tier provenance; the other provenance goes to history. Both sides `owner` with equal values: the survivor's pin is kept and the retired pin goes to history. Nothing is lost and no disposition is needed, because the value is the same.
  - Different values, no `owner` field: `resolve.metadata` (`survivor` or `retired`, today's choice) is required, else `film_person_data_conflict`. The discarded side's non-blank values get history rows (`merge_discarded`, naming both ids, each with its `old_anchor_digest`).
  - Different values and an `owner` field on either side: an explicit per-field disposition `resolve.metadataFields[field]` is required for each such field, else `film_person_data_conflict`.
  - **Dimension locks.** The `metadata` dimension rows follow the existing lifecycle-row rule of `reconcile` (`canonical-mutations.js:297-316`): a row only the retired Film has moves to the survivor, so a lone lock is preserved; two different rows need the explicit `resolve.metadataState` choice, so a lock is never silently dropped for a weaker row; two equal rows are one. A merge in which either Film has a dimension lock or an `owner` field inserts the release row of decision 11 before the retired row is moved or deleted, because the merge is an owner-authorized operation.
  - No activation of the dormant merge is requested.
- **Retirement** of the retired Film's row is the merge tail above.
- **History is never deleted** (the append-only trigger), so a deleted row's values stay recoverable, and `revert` reaches them through the redirect.

Alternatives: B, per-field lock and release only, with no owner-entered values; C, no per-field control, only the Film-level dimension lock.

### 10. Refresh triggers and freshness (0214-7)

**Recommended: 0214-7 = A.** No time-based refresh yet. In mode `enforce`, C1 reopens the `core` part of a Film in its scope, within its existing bounds and oldest-first fairness, when:
1. **fallback recovery:** the earlier source of a fallback-filled field answers. C1 already keeps that source due; its answer now replaces the fallback value;
2. **source-set change:** every attributed field is `superseded` (decision 7); C1 reopens the part and re-confirms or replaces;
3. **identity correction:** decision 7;
4. **unknown or superseded fields met in a fetch:** whenever C1 fetches a part, such fields are compared and adopted or replaced. There is no separate sweep;
5. **owner refresh:** per Film, through the route of decision 9.

`observedAt` and `checkedAt` are stored now, so a later periodic refresh needs no migration. A periodic, time-based refresh is a separate decision after the ADR 0211 tick costs are measured (card PVT).

Alternatives: B, A plus a periodic refresh now (for example 180 days, after all due work); C, owner refresh only.

### 11. Rollout, the mode and the permanent protections (0214-8)

**Recommended: 0214-8 = A.** One durable row, `film_metadata_provenance_control(id = 1, mode, revision, updated_at, updated_by)`, created by the migration at `off`. Each mode change is an owner production operation with a readback, and raises `revision`.

| Mode | Behaviour |
| --- | --- |
| absent column (migration not applied) | today's behaviour; no lock can exist; the owner route answers `schema_absent` |
| `off` | today's rows; the batch carries only the mode assertion of decision 4; only before activation |
| `record` | every declared write records its field objects; the permanent protections below apply; declared writers stay fill-only; undeclared writers merge as today among `unknown` values, with history |
| `observe` | as `record`, plus each decision of the comparator is computed and counted (`would_replace`, `would_refuse`, `would_adopt`), per writer and field; `film_metadata` is written exactly as under `record` |
| `enforce` | the comparator of decision 5 applies to declared writers |
| `hold` | the permanent protections apply and **no automatic replacement at all** happens: every automatic writer, declared or not, only fills. The owner route works |

**Transitions**, enforced by triggers on the control row (the pattern of migrations 0013 and 0034):
- `film_metadata_provenance_one_way`: once the mode has left `off`, it never returns to `off`;
- `film_metadata_provenance_transition`: `off → record`, `record → observe`, `observe → enforce`, any active mode `→ hold`, `hold → observe` or `hold → enforce`, and `enforce → observe`; every change must raise `revision`.
- **Under 0214-8 = B** the legal transitions are `off → enforce`, `enforce → hold` and `hold → enforce` only; `record` and `observe` never occur, and `off` stays one-way.

**Permanent protections, from `record` on.** Recording and measurement are separable from protection; protection is not. Once the mode has left `off`:
- **P1, locks:** an `owner` field, and every field while the dimension lock holds, is changed only by an owner-authority write (decision 4);
- **P2, no degradation:** an attributed value is never replaced by an undeclared write or by a lower-ranked observation (decisions 4 and 5);
- **P3, history:** every replacement, clear or merge discard of a non-blank value writes its history row in the same batch (decision 2);
- **P4, fences:** every batch asserts the mode and revision it planned under; a declared batch also asserts the planned anchor set, and an automatic declared batch no disagreement (decision 4).

P1 and P3's append-only history are also enforced in the database, so they survive code that does not know this record:
- `film_metadata_owner_value_locked`, `BEFORE UPDATE OF year, runtime, synopsis, poster, url, genres_json ON film_metadata`: aborts (`film_metadata_owner_locked`) when a field whose stored `tier` is `owner`, or any field while the Film's `metadata` dimension row is reviewed or owner-authority, changes value while `field_provenance_json` is left as it was. The new writer always restates the provenance of a field it changes; old code never does;
- `film_metadata_owner_row_locked`, `BEFORE DELETE ON film_metadata` and `BEFORE UPDATE OF film_id ON film_metadata`: aborts when any field is `owner`, or the Film's `metadata` dimension row is reviewed or owner-authority, unless a release row for the Film exists in `film_metadata_owner_release`. So a delete and a merge move are both covered, for field pins and for dimension-wide locks. Only an owner-authority batch inserts that row, immediately before the delete or move, and deletes it at the end of the same batch; the table is normally empty;
- `film_metadata_history_append_only` (decision 2).

**Fail-safe.**
- An unreadable or absent control row, with the control table present, fails every metadata write closed (`film_person_unavailable`), because the writer cannot assert a mode it did not read. That is today's behaviour for any unreadable part of the Film snapshot: the unit retries. The migration creates the row, so an absent row is an anomaly, never a mode.
- An unreadable provenance column fails every metadata write closed the same way, because locks cannot be checked.
- A declared write that cannot compute the anchor digest (an unreadable claim table) is refused; it never falls back to `unknown`.

**Rollback.**
- The rollback of `enforce` is `hold` (or `observe`): replacements stop at once, without a code revert. There is no path back to the old merge; `record` is not a rollback target for `enforce`, and `off` is unreachable.
- Values already replaced stay. The owner can revert any field from history.
- **A code revert past PV1 is not a safe rollback once the mode has left `off`.** The triggers keep P1 and the append-only history in force under old code, but old code does not apply P2 and P4, so it could replace an unlocked attributed value without history; the digest binding then reads that field as `unknown`, never wrongly as attributed. Such a revert is an owner L3 operation whose plan accepts that, and it is followed by a roll-forward. The safe rollback is the mode.

Alternative: B, one step from `off` to `enforce`, with the same `hold` and the transition list above. It skips the `record` and `observe` measurements, so the comparator's first production decisions are real replacements.

### 12. Mapping to the ADR 0211 C1 contracts

The C1 producer is delivered fill-only first. These are its contract elements, and how each behaves under this record:

| C1 element | Modes `off`, `record`, `observe`, `hold` | Mode `enforce` |
| --- | --- | --- |
| fill-only (decision 1) | unchanged | the replacement rule of decision 5 |
| per-field blank guards | unchanged; from `record` the batch also writes the field objects in the same row | dropped: the writer's Film revision fence proves the planned state; the cap of 12 is unaffected |
| dimension lock guard | unchanged | unchanged; per-field locks are enforced by the writer |
| anchor-set guard, epoch guard, lease and control generation (ADR 0211 decisions 3, 5 and 6) | unchanged | unchanged, in every mode (decision 4) |
| `identity_disagreement` stops the Film (ADR 0211 decision 2) | unchanged | unchanged; the writer asserts it for every declared automatic batch too |
| precedence and the 72 h fallback (decision 2) | unchanged | unchanged; a fallback value ranks `unconfirmed` and is replaced when the earlier source recovers with agreement |
| `agreed_anchor_digest` | passed as `agreedAnchorDigest`; the writer derives `agreement` | the same |
| `stored_differs` | unchanged | only for refusals; a replacement is counted as `replaced`, with a history row |
| `fallback_fill`, `unconfirmed_agreement` | unchanged | kept as visibility lists; derivable from the field objects |
| `written_under_superseded_anchor` | unchanged | the `superseded` fields of decision 7: `replaced` or `superseded_kept` |
| `superseded_credits` | unchanged | unchanged |
| write intent and receipts (decision 3) | unchanged | unchanged; the provenance is written in the value's own batch, so nothing is reconstructed from intents |
| `refresh_epoch` | unchanged | also raised by triggers 2 and 5 of decision 10 |
| `core` completion | unchanged | unchanged; a reopened part is `due` with the reason `provenance_upgrade` |
| the owner `retry` action | unchanged | reused by the route's `refresh` (decision 9) |
| identity hints | unchanged | unchanged; never provenance |

### 13. Visibility

- The C1 tick outbox and the EPG producer outcome count per field: fills, replacements, adoptions, refusals, `owner_kept`, `source_absent`, `superseded_kept`, `same_rank_conflict`, `agreement_stale` and `provenance_mismatch`, and the history rows written.
- `GET /api/admin/settings` (ADR 0211) shows the totals, the mode and revision, and the history row count.
- The route of decision 9 shows one Film.
- No new Monitor alert. A Monitor reader for repeated `provenance_mismatch` may be added with card PV2.

### 14. Worked examples

1. **Fallback recovery.**
   - Letterboxd answers 429 for 72 h, so TMDB fills `runtime` = 112 (`unconfirmed`).
   - On day 4, Letterboxd answers 110, and the agreement is recorded.
   - Today (ADR 0211): `stored_differs`, and 112 stays.
   - `enforce`: 110 (`confirmed`, higher precedence) replaces 112. History keeps 112 with its provenance.
2. **Owner correction.**
   - `year` is 1999 from Letterboxd; the owner sets 2000.
   - A later Letterboxd refresh saying 1999 is refused and listed as `stored_differs`.
   - An EPG write of 1999 is skipped with `owner_kept`, in every mode from `record`, and under old code by the trigger.
3. **An older cache.**
   - C1 wrote a Letterboxd synopsis observed on 1 December (`confirmed`).
   - The EPG chain replays a cached synopsis from October. It is undeclared, so it ranks `unknown` and can never replace an attributed value: refused, `stored_differs`. Today the older text would overwrite it.
4. **Identity correction.**
   - TMDB 100 becomes TMDB 200; the lid is unchanged. `year` 1985 was written under the old anchor set.
   - Every attributed field is `superseded`. TMDB 200 says 1987, under agreement for the new set: `confirmed` replaces `superseded`, with history.
   - TMDB 200 has no runtime, so the old runtime stays, and after C1 settles the part it is listed as `superseded_kept`.
   - A fallback value (`unconfirmed`) could not have replaced the superseded year.
5. **Legacy.**
   - An unknown synopsis is met by a C1 fetch.
   - The same text: adopted, so it is now attributed, and no history is added.
   - A different text: replaced, with a history row.
6. **Rollback.**
   - The owner switches `enforce → hold`. In-flight replacement batches fail on the control revision and replan as fills. Locks and history stay. Nothing returns to the old merge.

### 15. Delivery graph

The card names (PV…) are distinct from the choice labels (0214-…). None of these cards is required for AIR-275 or for the ADR 0207 A2 flip.

| Card | Outcome | Depends on | Boundary | Gate |
| --- | --- | --- | --- | --- |
| **PV1** | Schema file (the provenance column, `film_metadata_history`, `film_metadata_owner_release`, `film_metadata_owner_command`, the control row at `off`, the five triggers); `writeFilmFacts`: declared provenance, binding, locks, owner authority, the comparator behind the mode, history, the fences of decision 4; **the C1 declarations**: C1 passes `source`, `origin`, `anchor`, `observedAt` and `agreedAnchorDigest` on its existing fill-only writes, with no planning change, and the EPG callers are explicitly undeclared; the field-wise `reconcile` of the dormant merge and the clear rule; offline tests | ADR 0214 accepted; C1 merged | dormant: an absent schema or mode `off` writes today's rows | implementation GO |
| **PV2** | C1 planning under the rule: `agreedAnchorDigest`, the triggers of decision 10, `observe` accounting, outbox counts, the totals in `/api/admin/settings` | PV1 | dormant until `observe` | implementation GO |
| **PV3** | The owner route of decision 9 (GET and POST) | PV1 | refuses writes at `off` | implementation GO |
| **PVU** | An admin UI section for PV3 on the film page, with visual QA | PV3 | UI only | implementation GO; owner visual check |
| **PVM** | Apply the PV1 migration file | PV1 merged and deployed | no behaviour change (mode `off`) | production GO |
| **PVR** | Mode `off → record`, with a readback. Its preflight verifies that the deployed Worker includes PV1, so C1 writes are declared from the first recorded write | PVM; PV1 deployed | provenance recorded; protections P1-P4 on | production GO |
| **PVO** | Mode `record → observe`, then a dated report of would-be replacements, refusals and adoptions per writer and field | PVR; PV2 deployed | writes only what `record` writes | production GO |
| **PVE** | Mode `observe → enforce`, after the owner reviews the report | PVO report reviewed; PV2 and PV3 deployed, so the owner can pin values first | replacements active; rollback is `hold` | production GO |
| **PVT** | A periodic refresh policy (decision 10) | measured C2 and PVE costs | its own record or amendment | owner decision |
| **PV4** (candidate) | Per-field lineage for the EPG metadata stage, making its writes declared `unconfirmed` where it parsed the page itself | PV1; its own decision | changes the EPG chain's record | owner decision |

**Minimum writer integration before `record`.** PV1 is that minimum, and it includes the C1 declarations. A `record` activation on a Worker without them would record C1 values as undeclared `unknown`, repairable only by adoption at a later fetch, which a `complete` part never makes on its own. So PVR refuses to proceed unless the deployed version includes PV1, and the activation-boundary tests run through the real C1 and EPG paths. Each production GO stays separate. **Under 0214-8 = B** there is no PVR and no PVO: PVE applies `off → enforce` once PV1, PV2 and PV3 are deployed, and its rollback is `hold`.

**Migration apply order.** PVM applies pending files in number order, like every apply card of ADR 0207 decision 7. If PV1's file is numbered below a file of another stream, PVM states the exact files it applies.

### 16. Tests

**PV1, the writer and schema:**
- An absent column: statements byte-identical to today, for every caller. `off` with the control table present: today's rows plus the mode assertion.
- **Binding and declaration:**
  - a digest mismatch reads `unknown` and reports `provenance_mismatch`;
  - an undeclared write fills a blank, replaces an `unknown` value with history, removes the field object, and never replaces an attributed or locked value, in every mode;
  - an EPG `film_facts` input with mixed clocks (`metadataAt` and a later `synopsisFetchedAt`), and a synopsis-only refresh, are undeclared: they never attribute a field and never replace an attributed one;
  - a `metadata_sync` input resolved through the TMDB claim or a spelled id is undeclared the same way;
  - a declared write with an `observedAt` after the write clock plus 60 s is `film_person_invalid`.
- **Identity gates, activation boundary and races:**
  - a declared C1 fill planned under anchor set A fails on the anchor-set assertion after A → B, after another Film takes the same value (a competing claim) and after a retirement, and C1 replans;
  - a known disagreement blocks a C1 fill, an adoption and a replacement; an undeclared fill lands and stays `unknown`; an owner `set` during the disagreement is applied;
  - a batch planned at `off` fails on the control revision after `off → record` and its producer retries it under `record`; the same for every later transition;
  - through the real C1 path, the first declared fill after `off → record` records `confirmed` with its agreement; through the real EPG path, a write across the boundary stays undeclared;
  - 0214-4: under B an `unconfirmed` observation fills a blank, adopts an equal `unknown` value and never replaces a different `unknown` or attributed value; under A it replaces an `unknown` value with history.
- **Locks (P1):**
  - an `owner` field is skipped as `owner_kept` for each caller, including a receipt replay of an older plan;
  - the dimension lock locks every field for automatic writers and passes owner authority;
  - on real SQLite: the upsert's `DO UPDATE` fires `film_metadata_owner_value_locked`; an `UPDATE` by code that leaves the provenance column unchanged is aborted for an owner field and for a dimension-locked Film, and passes for an unlocked field; `DELETE` is aborted without a release row and passes inside a batch that holds one; the history table refuses `UPDATE` and `DELETE`.
- **The comparator (decisions 5 and 6):**
  - every row of the rank table of decision 3, including `superseded` versus `unconfirmed` and versus `confirmed`;
  - adoption of an equal value of higher rank, no history;
  - `agreed` for an equal value of equal or lower rank;
  - the refresh;
  - an older same-rank observation refused;
  - confidence never degrades;
  - a lower precedence refused;
  - a disagreement blocks a replacement and not a fill;
  - **convergence:** every permutation of a fixed set of observations, including identical `observedAt` with different values and equal values of different ranks, ends with the same semantic projection; the audit part is asserted only for shape.
- **Agreement and anchors (decision 7):**
  - `not_required` only without a Letterboxd anchor, derived by the writer, not the caller;
  - `confirmed` only when `agreedAnchorDigest` equals the writer's digest; a stale one is `unconfirmed` with `agreement_stale`;
  - lid unchanged with TMDB A → B, and TMDB unchanged with lid L → L′: every attributed field is `superseded`;
  - a source added and a source removed;
  - a superseded field replaced by `confirmed`, refused for `unconfirmed`, adopted by an equal `confirmed`;
  - an anchor change between the plan and the commit fails the batch on the anchor-set assertion.
- **Modes, rollback and fences (decision 11):**
  - every legal transition succeeds and every other, including any return to `off`, is aborted by the trigger;
  - a replacement planned at `enforce` lands after a switch to `hold` or `observe` and fails on the control revision; a fill planned at the same time lands;
  - `hold` lets every automatic writer only fill;
  - an unreadable or absent control row, and an unreadable column, fail every metadata write closed, and the unit retries;
  - confirmed and pinned values survive `enforce → hold`, `hold → enforce`, and a simulated pre-PV1 code path (the raw upsert) for the pinned ones.
- **Destructive paths (decision 9):**
  - the clear refused for a locked or attributed row, allowed for an unknown row with history rows;
  - the merge: equal bookkeeping with different core values now requires a choice; equal values with the retired side pinned keep the pin by default, with the survivor's automatic provenance in history; both sides pinned with equal values keep the survivor's pin; different values with a pin need the per-field disposition; a lone retired dimension lock moves; a weak survivor row against a strong retired row needs `resolve.metadataState`; the discarded values in history with their `old_anchor_digest`; the release row present only inside the batch, and a merge move (`UPDATE OF film_id`) without it aborted under a field pin and under a dimension lock;
  - history readable through a redirect after the merge; a revert onto the survivor allowed only with an equal `anchor_digest`.
- Blank incoming never clears; `source_absent` is recorded.
- History is written for every replacement, clear and merge discard, and never for a fill or an adoption.
- Bounds: the caller's guards stay at most 12, and the batch stays within the statement cap of 60 with six history inserts and the release row.

**PV2, C1:**
- fallback recovery replaces the fallback value;
- a recovery before 72 h fills first, with no history;
- source-set growth makes the fields `superseded`, the part reopens, and the fields are re-confirmed or replaced;
- an identity correction, with `replaced` and `superseded_kept` only after the part settles;
- unknown and superseded fields adopted or replaced in a fetch;
- an owner refresh racing a live tick (epoch fence);
- `observe` writes nothing beyond `record`, and its counts match what `enforce` would do;
- the counts.

**PV3, the route:**
- each action and its validation;
- owner authority from any other origin refused;
- editing a pinned value; `release` under a dimension lock (`dimension_locked: true`, field still protected);
- a stale `expectedRevision`;
- the `applied`, `rejected` and `uncertain` readbacks; a replay after `uncertain` answers `already_applied` and writes no second history row;
- the same `requestId` with a different command answers `request_mismatch`, on the same field, on another field and for `refresh`; a replay after later writes, and after a merge of the Film, answers `already_applied` from the command row; a no-op command bumps the revision, commits `outcome = noop` and replays as such; a lost response of `refresh` is settled by reading the command row; a refresh row commits only with its epoch writes, never alone;
- a revert whose anchor set changes between plan and commit (a competing claim, a retirement) fails on the anchor-set assertion;
- `foreign_history`, `anchor_changed` and `identity_unknown` refusals of a revert: a superseded value replaced under corrected anchors cannot be reverted, a legacy value with a NULL `old_anchor_digest` cannot be reverted, and `set` works in both cases;
- `revert` pins;
- `refresh` writes no metadata and no history, raises the `core` epoch, and answers `not_in_scope` without state rows;
- refusal at `off` and at an absent schema;
- the JWT and owner checks;
- the GET write audit.

## Storage and write cost

Workers Paid is the baseline. These are measurements, not gates.
- **The provenance column, at the current scale.** About 400 to 500 bytes per field object, so at most about 3 KB per row.
  - Today, 414 rows: about 1.2 MB.
  - Upper bound at today's catalog, every one of the 13,292 Films with all six fields: about 40 MB. That is about 1.6% of the current 2.56 GB database, and about 0.4% of the 10 GB limit of a D1 database. The account stays within the 5 GB of storage included.
  - It adds **no rows written**, because it is part of the row write.
- **History, unbounded by design.** One row per replaced, cleared or discarded value or owner action, typically 0.3 to 1 KB (the average synopsis is 266 characters). It grows with value changes, including the EPG chain's refreshes of `unknown` values from `record` on.
  - A churn of every field of every one of today's 414 rows would be about 2,500 rows, about 2.5 MB. Real churn is a small fraction of that per EPG pass, because a row is written only when a value changes.
  - A one-time replacement of all six fields of all 13,292 Films would be about 80,000 rows, under 80 MB.
  - The row count is reported (decision 13). Pruning is a separate decision.
- **Rows written.** At most 6 history rows per Film write, each with its primary-key and unique-index entries, so about 18 rows written per fully replaced Film beside the row itself.
  - At the ADR 0211 starting bound of 2 Films per hourly tick, that is at most about 900 rows a day, against 50 million rows a month included.
  - The EPG chain adds history rows only when a legacy value changes.
- **Statements.** A `core` batch gains at most 6 history inserts, and an owner batch at most 2 more for the release row, within the writer's cap of 60. The caller's guards stay within 12.
- **Unknown provenance costs nothing.** There is no backfill.

## Alternatives considered

- **0214-1 B, a side table `film_metadata_field`** with one row per field and CHECK constraints on the vocabulary.
  - For: plain SQL guards and constraints.
  - Against:
    - a second row set that every merge, clear and retirement path must move or delete in the same batch;
    - six extra rows written per full write.
  - The value binding would still be needed for paths outside the writer.
- **0214-1 C, columns per field** (source, observed time, anchor, agreement: at least 24 columns). Against: schema width, and a migration for every new attribute.
- **Per-source candidate rows resolved at read**, the localization pattern of ADR 0099. Against:
  - it stores candidates, against 4A and ADR 0211 decision 2;
  - it duplicates every synopsis;
  - the genre vocabularies differ between sources.
- **The `metadata` dimension's `provenance_json`.** Against: it is Film-level, and other writers replace it whole (ADR 0211 decision 1).
- **Declaring the EPG writes from the Film-level claim and clocks.** Against: a target identity and a Film-level clock are not a field's origin (Context), and declaring them would attribute values from hints. Rejected by this revision.
- **`record` as the rollback target of `enforce`.** Against: it would let undeclared or lower-ranked writes regress a field once more. Replaced by `hold`.
- **Blocking undeclared EPG fills during a disagreement.** Against: it would change the EPG chain's behaviour for a Film whose target the Producer resolved through the canonical claims, for no gain, because an `unknown` value cannot launder a disagreement into attribution; the fills stay visible as `unknown`.
- **A fill exemption from the identity gates** (the previous revision). Against: a declared fill writes a field object that claims the current anchors, so it needs the same anchor and disagreement checks as a replacement.
- **A numeric confidence score.** Against: an arbitrary number; an ordered closed vocabulary is testable.
- **A full observation log** of every fetch. Against: cost, and it is a candidate store by another name.

## Consequences

- The accepted ADR 0211 precedence applies to **filled** fields too, once in `enforce`. For example, a synopsis filled by TMDB through the fallback is replaced by the Letterboxd synopsis when Letterboxd recovers. Changing a field's order would be a separate decision.
- The EPG chain can no longer overwrite an owner value or an attributed value. Its refresh of its own legacy values is unchanged, and now leaves history.
- A source-set change makes a Film's attributed values `superseded` until they are re-confirmed, so C1 refetches them once. That is the cost of never trusting an agreement across anchor sets.
- The owner gets a way to set, pin, release, revert and refresh metadata per field. Today there is none.
- A merge can no longer discard differing or pinned values silently.
- **New durable contracts:**
  - the provenance column and its binding;
  - the history table, append-only;
  - the mode row and its one-way and transition triggers;
  - the owner-lock triggers on `film_metadata` and the release row;
  - the owner route;
  - the declared-provenance and owner-authority inputs of `writeFilmFacts`;
  - the field-wise merge comparison.
- **Residual risk.** Old code after a code revert past PV1 (decision 11): unlocked attributed values may be replaced without history until the roll-forward; they then read as `unknown`, never wrongly as attributed. Pinned values and history are protected by the triggers.

## Recovery and migration boundary

- **Additive schema only:** one nullable column, three tables (history, release, owner commands), one control table and five triggers. No existing value is rewritten by the migration, and there is no backfill.
- **The mode is the rollback.** `enforce` to `hold` stops every automatic replacement. `off` is unreachable after activation, so the old merge never returns under this code.
- Field objects written under any mode keep their binding; a value changed by a path that does not restate provenance reads as `unknown`. They are never trusted wrongly.
- **Replaced, cleared and discarded values are recoverable** from history, per field, by the owner route's `revert`, within the same identity. A bulk revert would be a separate, owner-approved operation.
- **Nothing here is irreversible** except the mode leaving `off`, which is reversible in effect through `hold`. A code revert past PV1 is an owner L3 operation (decision 11).
- This record, even when Accepted, authorizes no implementation, migration apply, mode change, refresh, merge activation or write. Each card keeps its own GO.

## Evidence

- Code reads on `main` `cb1fb88f` (24 Nov 2026): `src/canonical-film-writers.js` (merge, locks, the owner-authority convention of the title, statement cap, revision bump, the clear), `src/canonical-producer-workflow.js:73` (`filmFactsOf`), `src/metadata-cache.js:16` (`mergeWatchlistFilm`), `src/canonical-metadata-sync-producer.js:55` (`resolveExistingFilmId`), `src/worker.js:1325-1390` (the metadata stage, its 30-day window and the synopsis-only refresh), `src/canonical-mutations.js:184-296` (`mergeFilms`, `reconcile`, the retirement tail), migrations 0001, 0005, 0013, 0014, 0031 and 0034 (trigger patterns).
- Production L0 read, 24 Nov 2026 20:51 UTC: two aggregate `SELECT`s on the D1 database `iptv`. The counts are in the Context table. `rows_written` was 0, and no payload or identifier was read out.
- Cloudflare D1 limits and pricing, read on 24 Nov 2026: 10 GB per database and 5 GB of storage included on Workers Paid; 50 million rows written a month included; an index adds a written row.
- The [independent review of `05509e8`](https://github.com/vladimino/iptv-watchlist/pull/988#pullrequestreview-6047546598), answered by this revision (below).
- **Uncertainty:**
  - per-object sizes are estimates, to be measured in PV1 tests;
  - whether any historical owner edit reached `metadata.json` cannot be proven either way, so history is the safeguard;
  - that SQLite fires `UPDATE` triggers from an upsert's `DO UPDATE` is relied on and is a PV1 test on real SQLite, not an assumption of this record.

## Review findings of 2026-11-24 and where each is answered

| Finding | Answer |
| --- | --- |
| 1. Rollback and mode fencing | Decision 11: permanent protections P1-P4 from `record` on, separate from measurement; `hold` as the rollback target; `off` one-way; database triggers for the owner locks and the history; the in-batch mode and revision assertion of decision 4; the code-revert constraint; tests of transitions, races and unreadable states |
| 2. Convergence | Decisions 3, 5 and 6: one comparator (confidence, precedence, `observedAt`, `valueDigest`), a deterministic tie with `same_rank_conflict`, adoption, `agreed`, monotonic `observedAt` and `checkedAt`, and the semantic projection that converges versus the audit part that does not; permutation tests |
| 3. Identity change | Decisions 3 and 7: `superseded` is its own rank, replaced only by `confirmed` or the owner; `anchorDigest` over the whole set and `agreement` derived by the writer, so an agreement never covers another set; the anchor set and the disagreement asserted in every replacement batch; both own-source cases tested |
| 4. Per-field lineage | Context and decision 4: the EPG callers are undeclared, rank `unknown`, and never attribute a field; lineage is candidate card PV4; mixed-snapshot and synopsis-only tests |
| 5. Destructive paths | Decision 9: field-wise `reconcile` with explicit dispositions, history for discarded and cleared values, the release row for deletes, append-only history reachable through redirects, reverts only within an identity; no merge activation |
| 6. Owner actions and receipts | Decision 9: the owner-authority exception on the writer input, dimension-lock semantics, `requestId` replay through `writeKey` and the unique history key, `historyRef` ownership, and `refresh` as an epoch-only mutation through the ADR 0211 retry |
| Cost | Storage and write cost: the column at the current scale versus the unbounded history, EPG-originated history included |
| Second review, 1: the fill exemption and the identity gates | Decision 4: every batch asserts the mode and revision; every declared batch, fill, adoption and replacement alike, asserts the anchor set, and an automatic declared batch no disagreement; C1's ADR 0211 guards kept explicitly; owner batches free of the automatic identity gates; undeclared fills defined across a disagreement; the reach of the accepted fallback over legacy values made an explicit choice (0214-4, decisions 5, 6 and 8, recommendation B); race and boundary tests |
| Second review, 2: activation before PV2 | Decision 15: the C1 declarations are part of PV1; PVR verifies PV1 deployed; PVE needs PV2 and PV3; the alternative B transition list (decision 11); convergence in `enforce` only (decision 6) |
| Second review, 3: command receipts | Decision 9: every owner command, `refresh` included, is a receipted unit of the existing receipt table with a content digest; `request_mismatch`, `already_applied`, no-op and lost-response readback defined; tests |
| Third review: receipt mechanics and revert at commit | Decision 9: an additive owner-command table instead of `canonical_write_receipt` (whose tail needs a revision bump and has no outcome), the normalized digest including `refresh`'s `expectedRows`, durable `noop`, replay after later writes; the revert's anchor comparison asserted in the batch |
| Second review, 4: merge, dimension locks and history identity | Decision 9: equal values with a pin keep the pin by default, a per-field disposition for differing pinned values, dimension rows under the existing lifecycle rule; the row-lock trigger covers deletes and moves under field pins and dimension locks (decision 11); history binds the old value's identity (`old_anchor_digest`), and NULL refuses a revert as `identity_unknown` |

## Owner choices (open)

| # | Choice | Options | Recommendation |
| --- | --- | --- | --- |
| 0214-1 | Where provenance is stored | **A** one JSON column on `film_metadata`, bound by a value digest, plus an append-only history; **B** a side table per field; **C** columns per field | A |
| 0214-2 | Which writers follow the rule | **A** every caller, in `writeFilmFacts`; the EPG callers are undeclared and rank `unknown`; **B** only C1 and the owner route (EPG keeps its merge, respects locks); **C** EPG becomes fill-only | A |
| 0214-3 | The replacement rule | **A** the rank comparator (owner > confirmed > superseded > unconfirmed > unknown, then precedence, then observation time, then digest; refresh; never clear or degrade; history); **B** narrow: only fallback values, plus owner refresh; **C** fill-only plus owner edits | A |
| 0214-4 | Which declared observations may replace a *different* legacy `unknown` value (adoption of an equal value and the EPG chain's own refresh are settled) | **A** any declared observation, which widens the accepted 72 h fallback from blank-only to blank-or-`unknown`; **B** `confirmed` only, the fallback stays blank-only as accepted; **C** protected until the owner releases them; **D** attribute them from hints (not recommended) | B |
| 0214-5 | Values under a superseded anchor set | **A** rank `superseded`: replaced only by a confirmed value under the current set, otherwise kept and listed; **B** hold for the owner only; **C** clear at once | A |
| 0214-6 | Owner protection | **A** per-field set, lock, release, revert and refresh through an authenticated route, with the owner-authority exception in the writer and explicit dispositions on clear and merge (UI separate); **B** lock and release only; **C** the Film-level lock only | A |
| 0214-7 | Refresh triggers | **A** events (fallback recovery, source-set change, identity change, unknown or superseded fields met) plus owner refresh, periodic later; **B** A plus a periodic refresh now; **C** owner refresh only | A |
| 0214-8 | Rollout | **A** `off → record → observe → enforce`, each an owner production step, a report before `enforce`, `hold` as the rollback, `off` one-way; **B** `off → enforce` directly (transitions `off → enforce`, `enforce → hold`, `hold → enforce`; no `record` or `observe`) | A |

## Follow-ups

- On acceptance: create the cards of decision 15 with their gates, and update this record and its registry row to the decided options.
- When PV1 is delivered, the maintained contracts change in that PR:
  - `docs/reference/data/d1-schema.md`;
  - `docs/reference/domain/film-person.md`;
  - `docs/architecture/film-person-lifecycle.md`, with rendered Mermaid QA if a diagram changes;
  - `docs/reference/api/admin.md` for PV3, and the read side-effect baseline.
- Candidate, not selected: PV4 (EPG lineage), per-credit provenance, and a provenance model for metadata stores outside `film_metadata`.
