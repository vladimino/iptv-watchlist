# ADR 0214: Each `film_metadata` field carries provenance bound to its value; one writer rule protects owner values and replaces an automatic value only with a higher-ranked observation

**Status:** Proposed  
**Original decision date:** not decided  
**Recorded at:** 2026-11-24. Revised the same day after the [independent review](https://github.com/vladimino/iptv-watchlist/pull/988#pullrequestreview-6047546598) of `05509e8` (six P1 findings and the cost clarification; the section [Review findings](#review-findings-of-2026-11-24-and-where-each-is-answered) maps them).  
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
  - one-way and transition triggers on marker tables (migrations 0013, 0031, 0034), and immutable-row triggers (0031).
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

**History.** An append-only table, `film_metadata_history(id, film_id, field, old_value_json, old_provenance_json, new_provenance_json, reason, write_key, anchor_digest, at)`, gets one row whenever a non-blank value is replaced, cleared or discarded by a merge, or an owner action changes a field.
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

**Fences in the batch, for every caller.** Beside the marker generation, the Film revision and no redirect (existing), a batch that **replaces** a value or carries owner authority also asserts:
- the control row's `mode` and `revision` the plan read (decision 11), so a mode change fails every in-flight replacement, and the loser replans;
- for a declared write, the planned anchor set: every planned anchor still holds by its exact `(scheme, value)` (trusted, non-conflicting, singly owned, not retired), and no other trusted `letterboxd` or `tmdb` anchor of the Film exists. This is the writer's own compound assertion, derived from the rows it read to compute `anchorDigest`; it is not one of the caller's 12 guards;
- no `identity_disagreement` on the Film's ADR 0211 film row (`catalog_enrichment_state`, `part = 'film'`); an absent table or row means none.

A **fill** needs none of these beyond the existing fences, because a fill is safe in every mode. The Film revision fence already makes the stored values the plan saw the values the commit sees, so the writer adds no per-field guard; C1's own blank guards remain its defence in `record` and `observe` and are dropped in `enforce` (decision 10).

Alternatives: B, only C1 and the owner route follow the rule, and the EPG callers keep today's merge but respect locks; C, the EPG callers become fill-only.

### 5. The replacement rule (0214-3)

**Recommended: 0214-3 = A.** In mode `enforce`, a declared incoming value V for field F, with stored value S, is handled by **one comparator**, the rank tuple of decision 3:
1. **Refused (`owner_kept`)** when F is `owner` or the dimension lock holds.
2. **Refused (`disagreement`)** when the Film is in `identity_disagreement`.
3. **Refused (`anchor_changed`)** when V's anchor does not hold at commit (the batch fails on the anchor-set assertion and the caller replans).
4. **Blank S:** V fills F.
5. **`rank(V) > rank(S)`:** V replaces S, with a history row. This covers:
   - an `unknown` S (decision 6);
   - a `superseded` S replaced by a `confirmed` V (decision 7). An `unconfirmed` V ranks below `superseded` and therefore never replaces it;
   - a higher confidence, or a higher precedence at equal confidence;
   - a **refresh**: the same confidence and source, a later `observedAt`, a different value;
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

**Modes other than `enforce`** apply only rows 1-4 and the undeclared-write rule of decision 4 (an `unknown` S may be replaced by any write, with history); declared writers stay fill-only, as ADR 0211 delivers them.

Alternatives: B, narrow (only values from the 72 h fallback are replaced when the preferred source recovers, plus owner-triggered refresh); C, fill-only plus owner edits only.

### 6. Convergence

**What converges.** For a fixed set of declared observations of one field, arriving in any order and any interleaving, the **semantic projection** of the field (the stored value and the semantic part of its provenance: `tier`, `source`, `anchor`, `anchorDigest`, `agreement`, `observedAt`, `valueDigest`) ends the same, provided the Film's anchors and locks are the same throughout.
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

**Recommended: 0214-4 = A.** `unknown` is the lowest rank. Any declared observation (`confirmed` or `unconfirmed`) replaces an unknown value, with a history row, or adopts it when equal. An undeclared write also replaces an unknown value, with history, as today (decision 4).
- This keeps today's behaviour of the EPG chain for the 414 rows it wrote itself.
- It lets C1 upgrade unknown values of Films in its scope.
- It invents no attribution.

**Why this is safe for owner data.**
- No code path has ever written `film_metadata` with owner authority.
- No `metadata` lifecycle row is reviewed or owner-locked (L0 above).
- The historical R2 `metadata.json` was the parse cache of the metadata stage.
- Manual historical edits cannot be ruled out. The history table makes every replacement reversible by the owner (decision 9).

Alternatives:
- **B**, only `confirmed` observations replace an unknown value; an `unconfirmed` one may only adopt an equal value. This freezes the EPG refresh of legacy rows.
- **C**, unknown values are protected until the owner releases them, which is fill-only for all legacy data.
- **D (not recommended)**, attribute legacy values from hints (the lifecycle row's `source`, `r2_key`). That would turn a hint into proof.

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
| `refresh` | raises the C1 `core` refresh epoch of the Film through the ADR 0211 `retry` mechanism (part `core`, its own `expectedRows` compare-and-swap, epoch and lease fences), whatever the rows' status. It is an epoch-only mutation: no metadata write, no history row. `not_in_scope` when the Film has no state rows |

- **Dimension lock.** The Film-level `metadata` dimension row that is reviewed or owner-authority locks all six fields for automatic writers. The route never changes that row; the review routes own it.
- **Replay and receipts.** `writeKey = requestId` on every field the action changes, and the history row is unique on `(film_id, field, write_key)`. A replay finds the key on the field or in history and answers `already_applied` without a batch. After an `uncertain` outcome the route reads the row back and matches the key.
- **Ownership of `historyRef`.** The row's `film_id` must be the Film or a Film redirected into it; otherwise `rejected: foreign_history`. A revert is applied only when the row's `anchor_digest` equals the Film's current digest; otherwise `rejected: anchor_changed`, and the owner may `set` the value instead. A value is therefore never reverted across identities.
- Every change is one `writeFilmFacts` call with owner authority, one batch, the fences of decision 4, a compare-and-swap on the Film revision, and a readback answering `applied`, `rejected` or `uncertain` (503, `outcome: unknown`).
- The route requires the authentication of ADR 0211 decision 6: an Access JWT verified in the Worker (`mcpVerifyAccess`), the owner subject, the Worker's own `Origin`, `X-IPTV-Admin-Action` and a JSON content type. It refuses every write while the mode is `off` or the schema is absent.

**The destructive paths.**
- **Clear (`metadata: null`).** Refused (`film_metadata_locked`) when any field is `owner` or the dimension lock holds, unless the input carries owner authority. Refused (`film_metadata_attributed`) for an automatic caller when any field is attributed. Allowed otherwise, and every non-blank value cleared gets a history row (`cleared`). No runtime caller clears today; the rule binds the planner's contract.
- **Merge (`reconcile`, dormant).** The comparison becomes field-wise: the six values and their field objects.
  - Identical: the survivor's row is kept; the retired Film's history stays under its own id and is read through the redirect.
  - Different, and no `owner` field on either side: `resolve.metadata` (`survivor` or `retired`, today's choice) is required, else `film_person_data_conflict`. The discarded side's non-blank values get history rows (`merge_discarded`, naming both ids).
  - An `owner` field on either side whose values differ: an explicit per-field disposition `resolve.metadataFields[field]` is required for each such field, else `film_person_data_conflict`. The resulting row is assembled field by field with the provenance of the chosen side.
  - The retired row's deletion carries the release row of decision 11, because the merge is an owner-authorized operation.
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
| `off` | today's behaviour, byte-identical; only before activation |
| `record` | every declared write records its field objects; the permanent protections below apply; declared writers stay fill-only; undeclared writers merge as today among `unknown` values, with history |
| `observe` | as `record`, plus each decision of the comparator is computed and counted (`would_replace`, `would_refuse`, `would_adopt`), per writer and field; `film_metadata` is written exactly as under `record` |
| `enforce` | the comparator of decision 5 applies to declared writers |
| `hold` | the permanent protections apply and **no automatic replacement at all** happens: every automatic writer, declared or not, only fills. The owner route works |

**Transitions**, enforced by triggers on the control row (the pattern of migrations 0013 and 0034):
- `film_metadata_provenance_one_way`: once the mode has left `off`, it never returns to `off`;
- `film_metadata_provenance_transition`: `off → record`, `record → observe`, `observe → enforce`, any active mode `→ hold`, `hold → observe` or `hold → enforce`, and `enforce → observe`; every change must raise `revision`.

**Permanent protections, from `record` on.** Recording and measurement are separable from protection; protection is not. Once the mode has left `off`:
- **P1, locks:** an `owner` field, and every field while the dimension lock holds, is changed only by an owner-authority write (decision 4);
- **P2, no degradation:** an attributed value is never replaced by an undeclared write or by a lower-ranked observation (decisions 4 and 5);
- **P3, history:** every replacement, clear or merge discard of a non-blank value writes its history row in the same batch (decision 2);
- **P4, fences:** every replacement or owner batch asserts the mode and revision it planned under, the planned anchor set and no disagreement (decision 4).

P1 and P3's append-only history are also enforced in the database, so they survive code that does not know this record:
- `film_metadata_owner_value_locked`, `BEFORE UPDATE OF year, runtime, synopsis, poster, url, genres_json ON film_metadata`: aborts (`film_metadata_owner_locked`) when a field whose stored `tier` is `owner`, or any field while the Film's `metadata` dimension row is reviewed or owner-authority, changes value while `field_provenance_json` is left as it was. The new writer always restates the provenance of a field it changes; old code never does;
- `film_metadata_owner_row_locked`, `BEFORE DELETE ON film_metadata`: aborts when any field is `owner` unless a release row for the Film exists in `film_metadata_owner_release`. Only an owner-authority batch inserts that row, immediately before the delete, and deletes it at the end of the same batch; the table is normally empty;
- `film_metadata_history_append_only` (decision 2).

**Fail-safe.**
- An unreadable or absent control row, with the column present, behaves as `hold`: fills only, protections on, no mode assertion needed because a fill never asserts the mode.
- An unreadable provenance column fails every metadata write closed (`film_person_unavailable`), because locks cannot be checked.
- A declared write that cannot compute the anchor digest (an unreadable claim table) is refused; it never falls back to `unknown`.

**Rollback.**
- The rollback of `enforce` is `hold` (or `observe`): replacements stop at once, without a code revert. There is no path back to the old merge; `record` is not a rollback target for `enforce`, and `off` is unreachable.
- Values already replaced stay. The owner can revert any field from history.
- **A code revert past PV1 is not a safe rollback once the mode has left `off`.** The triggers keep P1 and the append-only history in force under old code, but old code does not apply P2 and P4, so it could replace an unlocked attributed value without history; the digest binding then reads that field as `unknown`, never wrongly as attributed. Such a revert is an owner L3 operation whose plan accepts that, and it is followed by a roll-forward. The safe rollback is the mode.

Alternative: B, one step from `off` to `enforce`, with the same `hold`.

### 12. Mapping to the ADR 0211 C1 contracts

The C1 producer is delivered fill-only first. These are its contract elements, and how each behaves under this record:

| C1 element | Modes `off`, `record`, `observe`, `hold` | Mode `enforce` |
| --- | --- | --- |
| fill-only (decision 1) | unchanged | the replacement rule of decision 5 |
| per-field blank guards | unchanged; from `record` the batch also writes the field objects in the same row | dropped: the writer's Film revision fence proves the planned state; the cap of 12 is unaffected |
| dimension lock guard | unchanged | unchanged; per-field locks are enforced by the writer |
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
| **PV1** | Schema file (the provenance column, `film_metadata_history`, `film_metadata_owner_release`, the control row at `off`, the five triggers); `writeFilmFacts`: declared provenance, binding, locks, owner authority, the comparator behind the mode, history, the fences of decision 4; the field-wise `reconcile` of the dormant merge and the clear rule; offline tests | ADR 0214 accepted; C1 merged | dormant: an absent schema or mode `off` is byte-identical to today | implementation GO |
| **PV2** | C1 planning under the rule: `agreedAnchorDigest`, the triggers of decision 10, `observe` accounting, outbox counts, the totals in `/api/admin/settings` | PV1 | dormant until `observe` | implementation GO |
| **PV3** | The owner route of decision 9 (GET and POST) | PV1 | refuses writes at `off` | implementation GO |
| **PVU** | An admin UI section for PV3 on the film page, with visual QA | PV3 | UI only | implementation GO; owner visual check |
| **PVM** | Apply the PV1 migration file | PV1 merged and deployed | no behaviour change (mode `off`) | production GO |
| **PVR** | Mode `off → record`, with a readback | PVM | provenance recorded; protections P1-P4 on | production GO |
| **PVO** | Mode `record → observe`, then a dated report of would-be replacements, refusals and adoptions per writer and field | PVR; PV2 deployed | writes only what `record` writes | production GO |
| **PVE** | Mode `observe → enforce`, after the owner reviews the report | PVO report reviewed; PV3 deployed, so the owner can pin values first | replacements active; rollback is `hold` | production GO |
| **PVT** | A periodic refresh policy (decision 10) | measured C2 and PVE costs | its own record or amendment | owner decision |
| **PV4** (candidate) | Per-field lineage for the EPG metadata stage, making its writes declared `unconfirmed` where it parsed the page itself | PV1; its own decision | changes the EPG chain's record | owner decision |

**Migration apply order.** PVM applies pending files in number order, like every apply card of ADR 0207 decision 7. If PV1's file is numbered below a file of another stream, PVM states the exact files it applies.

### 16. Tests

**PV1, the writer and schema:**
- `off` and an absent column: statements byte-identical to today, for every caller.
- **Binding and declaration:**
  - a digest mismatch reads `unknown` and reports `provenance_mismatch`;
  - an undeclared write fills a blank, replaces an `unknown` value with history, removes the field object, and never replaces an attributed or locked value, in every mode;
  - an EPG `film_facts` input with mixed clocks (`metadataAt` and a later `synopsisFetchedAt`), and a synopsis-only refresh, are undeclared: they never attribute a field and never replace an attributed one;
  - a `metadata_sync` input resolved through the TMDB claim or a spelled id is undeclared the same way;
  - a declared write with an `observedAt` after the write clock plus 60 s is `film_person_invalid`.
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
  - an unreadable or absent control row behaves as `hold`; an unreadable column fails closed;
  - confirmed and pinned values survive `enforce → hold`, `hold → enforce`, and a simulated pre-PV1 code path (the raw upsert) for the pinned ones.
- **Destructive paths (decision 9):**
  - the clear refused for a locked or attributed row, allowed for an unknown row with history rows;
  - the merge: equal bookkeeping with different core values now requires a choice; owner fields on one side, on both sides with equal values, and on both sides with different values (per-field disposition required); the discarded values in history; the release row present only inside the batch;
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
- `foreign_history` and `anchor_changed` refusals of a revert;
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

- **Additive schema only:** one nullable column, two tables (history, release), one control table and five triggers. No existing value is rewritten by the migration, and there is no backfill.
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

## Owner choices (open)

| # | Choice | Options | Recommendation |
| --- | --- | --- | --- |
| 0214-1 | Where provenance is stored | **A** one JSON column on `film_metadata`, bound by a value digest, plus an append-only history; **B** a side table per field; **C** columns per field | A |
| 0214-2 | Which writers follow the rule | **A** every caller, in `writeFilmFacts`; the EPG callers are undeclared and rank `unknown`; **B** only C1 and the owner route (EPG keeps its merge, respects locks); **C** EPG becomes fill-only | A |
| 0214-3 | The replacement rule | **A** the rank comparator (owner > confirmed > superseded > unconfirmed > unknown, then precedence, then observation time, then digest; refresh; never clear or degrade; history); **B** narrow: only fallback values, plus owner refresh; **C** fill-only plus owner edits | A |
| 0214-4 | Legacy and unknown values | **A** lowest rank: replaceable or adoptable by any observation, with history; **B** only confirmed observations replace them; **C** protected until the owner releases them; **D** attribute them from hints (not recommended) | A |
| 0214-5 | Values under a superseded anchor set | **A** rank `superseded`: replaced only by a confirmed value under the current set, otherwise kept and listed; **B** hold for the owner only; **C** clear at once | A |
| 0214-6 | Owner protection | **A** per-field set, lock, release, revert and refresh through an authenticated route, with the owner-authority exception in the writer and explicit dispositions on clear and merge (UI separate); **B** lock and release only; **C** the Film-level lock only | A |
| 0214-7 | Refresh triggers | **A** events (fallback recovery, source-set change, identity change, unknown or superseded fields met) plus owner refresh, periodic later; **B** A plus a periodic refresh now; **C** owner refresh only | A |
| 0214-8 | Rollout | **A** `off → record → observe → enforce`, each an owner production step, a report before `enforce`, `hold` as the rollback, `off` one-way; **B** `off → enforce`, with the same `hold` | A |

## Follow-ups

- On acceptance: create the cards of decision 15 with their gates, and update this record and its registry row to the decided options.
- When PV1 is delivered, the maintained contracts change in that PR:
  - `docs/reference/data/d1-schema.md`;
  - `docs/reference/domain/film-person.md`;
  - `docs/architecture/film-person-lifecycle.md`, with rendered Mermaid QA if a diagram changes;
  - `docs/reference/api/admin.md` for PV3, and the read side-effect baseline.
- Candidate, not selected: PV4 (EPG lineage), per-credit provenance, and a provenance model for metadata stores outside `film_metadata`.
