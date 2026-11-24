# ADR 0214: Each `film_metadata` field carries provenance bound to its value; one writer rule protects owner values and replaces an automatic value only with a higher-ranked observation

**Status:** Proposed  
**Original decision date:** not decided  
**Recorded at:** 2026-11-24  
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

**One writer, several callers.** `writeFilmFacts` (`src/canonical-film-writers.js`) is the only writer of `film_metadata`. Every write asserts the marker generation, the Film revision and no redirect, and bumps the Film revision.

| Caller | Fields it writes | How it merges | Status |
| --- | --- | --- | --- |
| EPG Producer `film_facts` (`filmFactsOf`, `src/canonical-producer-workflow.js:73`) | the metadata of the published Watchlist film, observed at `metadataAt` | `mergeMetadata`: a non-blank incoming value overwrites the stored one | active |
| `metadata_sync` (`src/canonical-metadata-sync-producer.js`) | the Letterboxd film page parsed by the EPG metadata stage, refreshed after 30 days (`src/worker.js:1343`) | the same merge | the stage fetches nothing while the Watchlist marker pins the run (ADR 0186) |
| ADR 0211 catalog-enrichment producer (card C1) | Letterboxd and TMDB values through their anchors | fill-only, one blank guard per field | designed, not implemented |
| `mergeFilms` (`src/canonical-mutations.js:279-296`) | the whole row of one of the two Films, by an explicit choice | whole-row move | no runtime caller |

- **No per-field source.** `film_metadata` (migration 0001) holds `year`, `runtime`, `synopsis`, `poster`, `url`, `genres_json`, `people_version`, `payload_json`, `r2_key`, `content_sha256` and `updated_at`. Nothing says which source supplied which field, when, or through which identity.
- **What looks like provenance, but is not per field:**
  - the `metadata` row of `film_dimension` is a Film-level lifecycle status with one `source`, and other writers replace its `provenance_json` whole (ADR 0211 decision 1);
  - `r2_key` and `content_sha256` describe the projection that wrote the row, not the fields.
- **Protection.**
  - The writer protects reviewed and owner **dimension rows** (`strong()`, `canonical-film-writers.js:45,179`).
  - It does **not** check any lock before it merges a `film_metadata` value. ADR 0211 C1 adds a guard on the dimension lock for its own writes only.
  - **No route lets the owner set, pin or correct a metadata field.** ADR 0211 says a wrong value "is corrected by the owner and review routes", but for metadata no such route exists.
- **Accepted provenance patterns elsewhere:**
  - the title: `original_title` carries `titleSource {source, at}` inside the identity provenance, ranked by an accepted order (ADR 0120 R3, R3b);
  - localization: one row per automatic source in `film_localization_source`, with owner and reviewed values above them (ADR 0099).
- **Freshness.** `film_sync_state` holds four Film-level clocks (ADR 0070). No field has its own observation time.

**Production L0 read** (24 Nov 2026 20:51 UTC, aggregate `SELECT`s only, `rows_written` 0):

| Measure | Value |
| --- | --- |
| Films | 13,292 (15 redirects) |
| `film_metadata` rows | 414 |
| Fields set among them | `year` 414, `runtime` 410, `synopsis` 414 (266 characters on average), `poster` 414, `url` 414, `genres` 414 |
| `payload_json` | `{}` in all 414 rows |
| `r2_key` | `metadata.json` in 406 rows, NULL in 8 |
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

### Settled decisions this record keeps

- The ADR 0211 anchors, the page agreement contract, the per-field precedence, the 72 h transport-only fallback (0211-7 = B), and "a known disagreement blocks every automatic write".
- **Hints never become proof** (ADR 0211 decision 2, ADR 0213). Metadata never proves identity.
- **No stored candidates and no proof snapshots** (0207 direction 4A, "Не надо усложнять"; ADR 0211 decision 2).
- **A blank never overwrites** (ADR 0120 R1).
- **Scope widening stays separate.** C3a and C3b are not changed by this record.

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

**Recommended: 0214-1 = A.** One additive nullable column, `film_metadata.field_provenance_json`, holds one object per field. It is written in the **same row write** as the value. So a merge, a clear or a retirement that moves or deletes the row moves or deletes the provenance with it, with no second path to keep consistent.

Each field object has:

| Key | Meaning |
| --- | --- |
| `tier` | `owner` (protected) or `automatic` or `released` (an owner value the owner released) |
| `source` | `letterboxd`, `tmdb` or `owner`. A pinned automatic value keeps its source and gets `tier = owner` |
| `origin` | the writer: `catalog_enrichment`, `epg_film_facts`, `metadata_sync` or `owner_route` |
| `anchor` | the exact anchor the value was written through (`letterboxd:<lid>`, `tmdb:<id>`), or null |
| `agreement` | `confirmed` or `unconfirmed` (decision 3); null for the owner |
| `observedAt` | when the source gave this value (the fetch, or the parse clock the caller already has); for the owner, the time of the action |
| `checkedAt` | the last time an equal observation of the same or a higher rank confirmed it |
| `valueDigest` | a digest of the stored value's canonical JSON |
| `writeKey`, `writtenRevision` | the unit's `operation_key` or request id, and the Film revision the write produced |

**Binding.** A field object counts only while its `valueDigest` equals the digest of the stored value. Otherwise the field reads as `unknown`, and the mismatch is reported as `provenance_mismatch`.
- A path that changes a value without restating its provenance can therefore never make the old provenance describe the new value. Such paths are an older code version, a restore, the offline importer or a manual repair.
- No SQL digest function is needed. The writer compares digests when it plans, and the Film revision fence makes the plan and the commit atomic.

**History.** An append-only table, `film_metadata_history`, gets one row whenever a non-blank value is replaced, or an owner action changes a field. The row holds the field, the old value and the old provenance (null when unknown), the new provenance, the reason and the write key.
- A fill of a blank field adds no history.
- It is written in the same batch as the change.
- Retention is indefinite. Pruning would be a separate decision.

**Absence means unknown.** A field with no object is `unknown`: today's 414 rows, and any value written before recording starts. **Nothing is backfilled, and nothing is inferred from hints**: not the lifecycle row's `source`, not `r2_key`, not the URL host, not the language of a synopsis.

Alternatives: B, a side table `film_metadata_field` with one row per field; C, four or more columns per field on `film_metadata` (at least 24 columns). See [Alternatives](#alternatives-considered).

### 3. Confidence and rank

Confidence is a closed, ordered vocabulary, not a score:

| Rank | Confidence | When |
| --- | --- | --- |
| 4 | `owner` | `tier = owner`: an owner value, or an automatic value the owner pinned. The Film-level `metadata` dimension row that is reviewed or owner-authority locks every field the same way |
| 3 | `confirmed` | written through its source's own holding anchor, with every agreement that ADR 0211 requires for the Film's current anchors recorded. None is required when the Film holds no Letterboxd anchor |
| 2 | `unconfirmed` | written through its source's own anchor without that agreement: the ADR 0211 transport-only fallback (`unconfirmed_agreement`), or a writer that does not run the agreement check (the EPG metadata path, decision 4) |
| 1 | `unknown` | no field object, a digest mismatch, `tier = released`, or (by 0214-5) an anchor that no longer holds |

**The rank of an automatic value** is compared in this order:
1. confidence;
2. the accepted ADR 0211 precedence of its source for that field (`letterboxd` before `tmdb`);
3. `observedAt`.

**Confidence never degrades automatically.** A lower-confidence observation never replaces a higher-confidence value, even when it is newer.

**Provenance is not identity.** An anchor in a field object records which claim a write relied on. It is never a claim, an evidence row (ADR 0213) or an anchor for any other write. Agreement comes only from the ADR 0211 page agreement contract.

### 4. One rule in the single writer, for every caller (0214-2)

**Recommended: 0214-2 = A.** The rule lives in `writeFilmFacts`, so every caller is subject to it: the EPG `film_facts`, `metadata_sync`, the C1 producer, the owner route (decision 8) and any future writer.

- **Declared provenance.** Each caller declares, per field it writes:
  - `source`, `origin`, `anchor`, `agreement` and `observedAt`.
  - The EPG callers declare `source = letterboxd` and `agreement = unconfirmed`. The anchor is the trusted Letterboxd claim through which they resolved the target Film: the AIR-572 resolution for the Producer, the typed-claim rule for `metadata_sync`. The clock is the field's own: `synopsisFetchedAt` for a synopsis-only refresh, `metadataAt` otherwise.
  - An EPG write without a holding Letterboxd anchor ranks as `unknown`.
- **Undeclared and anchorless writes.** A field written without declared provenance ranks as `unknown`: an older plan, or a receipt replay of a plan made before recording started. So does a declared write whose anchor does not hold. In `record` and `observe` it merges as today; in `enforce` it may only fill a blank field. Either way its field object is removed, so the value reads `unknown`.
- **Locks for everyone.** A write to an `owner` field, or to any field while the dimension lock holds, is skipped with `owner_kept` (as the title is today). It is never refused whole. That is enforced from mode `record` on (decision 11), whatever the caller.
- **Blank never clears.** A blank or absent incoming value never clears a stored one (ADR 0120 R1). When it comes from the stored value's own source, it is recorded as `source_absent`.

Alternatives: B, only C1 and the owner route follow the rule, and the EPG callers keep today's merge but respect locks; C, the EPG callers become fill-only.

### 5. The replacement rule (0214-3)

**Recommended: 0214-3 = A.** In mode `enforce`, an incoming non-blank automatic value V for field F replaces the stored value S only if every condition holds:
1. F is not `owner` and the dimension lock does not hold;
2. V was written through an anchor that holds, and the Film is not in `identity_disagreement` in the ADR 0211 state (an absent state means none). The agreement decides V's confidence, not whether it may be written. C1 additionally keeps its own ADR 0211 gating (a recorded agreement, or the 72 h fallback) before it writes at all;
3. one of these holds:
   - S is `unknown` (decision 6, 0214-4);
   - S's anchor no longer holds (decision 7, 0214-5);
   - V's rank is higher than S's rank (decision 3);
   - V has the same source and confidence as S, a later `observedAt`, and a different value. That is a **refresh**.

Then:
- **When V equals S**, only the provenance changes, and only when V ranks higher or is newer (`checkedAt`, `observedAt`). This is **adoption**: an `unknown` value becomes attributed when a real observation matches it. No history row is added.
- **When V differs and may not replace S**, it is refused and recorded as `stored_differs`, as in ADR 0211.
- **Never:**
  - clear a value;
  - replace an `owner` field;
  - write across a known disagreement;
  - lower confidence;
  - replace a value with an older observation of the same rank.

**Ties and order.** Two writers that race are fenced by the Film revision. The loser replans against the winner's provenance. Every replacement strictly raises the rank, which is a total order over (confidence, precedence, `observedAt`, then the value digest as the last tie-break). So both arrival orders end with the same stored value. That is a required test.

Alternatives: B, narrow (only values from the 72 h fallback are replaced when the preferred source recovers, plus owner-triggered refresh); C, fill-only plus owner edits only.

### 6. Legacy and unknown values (0214-4)

**Recommended: 0214-4 = A.** `unknown` is the lowest rank. Any anchored automatic observation (`confirmed` or `unconfirmed`) may replace an unknown value (with a history row), or adopt it when equal.
- This keeps today's behaviour of the EPG chain for the 414 rows it wrote itself.
- It lets C1 upgrade unknown values of Films in its scope.
- It invents no attribution.

**Why this is safe for owner data.**
- No code path has ever written `film_metadata` with owner authority.
- No `metadata` lifecycle row is reviewed or owner-locked (L0 above).
- The historical R2 `metadata.json` was the parse cache of the metadata stage.
- Manual historical edits cannot be ruled out. The history table makes every replacement reversible by the owner (decision 8).

Alternatives:
- **B**, only `confirmed` observations replace an unknown value; an `unconfirmed` one may only adopt an equal value. This freezes the EPG refresh of legacy rows.
- **C**, unknown values are protected until the owner releases them, which is fill-only for all legacy data.
- **D (not recommended)**, attribute legacy values from hints (the lifecycle row's `source`, `r2_key`). That would turn a hint into proof.

### 7. Identity changes (0214-5)

ADR 0211 decision 3b detects an anchor value change (TMDB A to B, lid L to L'), invalidates the plan and lists the values written under the old anchor.

**Recommended: 0214-5 = A.** A field whose recorded `anchor` no longer holds ranks as `unknown`.
- The next confirmed observation under the current anchors replaces it, with a history row.
- If the current sources have no value for that field, the old value **stays** and is listed as `superseded_kept` for owner review.
- Nothing is cleared automatically. A correction may be a duplicate retirement of the same work, where the old values are still right, and the writer cannot tell that from a wrong match.
- `owner` fields are untouched.
- Credits stay held as `superseded_credits` (ADR 0211; credits are out of scope).
- "Holds" is the ADR 0211 anchor rule: trusted, non-conflicting, singly owned and, for TMDB, not retired. The in-batch anchor-set guard of ADR 0211 makes the evaluation atomic with the write.

Alternatives: B, hold every superseded value for the owner (today's ADR 0211 listing only); C, clear superseded values at once and refill.

### 8. Owner protection and corrections (0214-6)

**Recommended: 0214-6 = A.** An owner route, its UI a separate card:

**Read.** `GET /api/admin/films/<id>/metadata`: every field with its value, provenance, effective rank, lock, the C1 conflicts and hints of the Film, and its recent history. It is a pure read, registered in the GET write baseline.

**Write.** `POST /api/admin/films/<id>/metadata` takes `{action, field?, value?, historyRef?, expectedRevision, requestId}`:

| Action | Effect |
| --- | --- |
| `set` | writes an owner value (`tier = owner`, `source = owner`), after validating the field's type and bounds |
| `lock` | pins the current value (`tier = owner`, source kept) |
| `release` | keeps the value, `tier = released`, so it ranks as `unknown` |
| `revert` | restores the old value and provenance of one history row, then pins it, so the same refresh cannot immediately undo the revert |
| `refresh` | raises the C1 `core` refresh epoch of the Film (decision 9), if the Film is in the enrichment scope; otherwise it answers `not_in_scope`. It writes no metadata itself |

Every change is one `writeFilmFacts` call with owner authority and a history row. The route requires:
- the authentication of ADR 0211 decision 6: an Access JWT verified in the Worker (`mcpVerifyAccess`), the owner subject, the Worker's own `Origin`, `X-IPTV-Admin-Action` and a JSON content type;
- a compare-and-swap on the Film revision;
- a readback answering `applied`, `rejected` or `uncertain` (503, `outcome: unknown`).

It refuses every write while the mode is `off`.

Alternatives: B, per-field lock and release only, with no owner-entered values; C, no per-field control, only the Film-level dimension lock.

### 9. Refresh triggers and freshness (0214-7)

**Recommended: 0214-7 = A.** No time-based refresh yet. In mode `enforce`, C1 reopens the `core` part of a Film in its scope, within its existing bounds and oldest-first fairness, when:
1. **fallback recovery:** the earlier source of a fallback-filled field answers. C1 already keeps that source due; its answer now replaces the fallback value;
2. **source-set growth:** a newly applicable source precedes the stored source of a non-owner field. C1 reopens those fields too, not only the gaps;
3. **identity change:** decision 7;
4. **unknown fields met in a fetch:** whenever C1 fetches a part, unknown fields are compared and adopted or replaced. There is no separate sweep;
5. **owner refresh:** per Film, through the route of decision 8.

`observedAt` and `checkedAt` are stored now, so a later periodic refresh needs no migration. A periodic, time-based refresh is a separate decision after the ADR 0211 tick costs are measured (card PVT).

Alternatives: B, A plus a periodic refresh now (for example 180 days, after all due work); C, owner refresh only.

### 10. Mapping to the ADR 0211 C1 contracts

The C1 producer is delivered fill-only first. These are its contract elements, and how each behaves under this record:

| C1 element | Modes `off`, `record`, `observe` | Mode `enforce` |
| --- | --- | --- |
| fill-only (decision 1) | unchanged | the replacement rule of decision 5 |
| per-field blank guards | unchanged; `record` also writes the field objects in the same row | the guard asserts the field's planned state (blank, or the exact `writeKey`) instead of blank, still within the cap of 12 together with the Film revision fence |
| dimension lock guard | unchanged | unchanged; per-field locks are enforced by the writer |
| precedence and the 72 h fallback (decision 2) | unchanged | unchanged; a fallback value ranks `unconfirmed` and is replaced when the earlier source recovers with agreement |
| `stored_differs` | unchanged | only for refusals; a replacement is counted as `replaced`, with a history row |
| `fallback_fill`, `unconfirmed_agreement` | unchanged | kept as visibility lists; derivable from the field objects |
| `written_under_superseded_anchor` | unchanged | the superseded fields of decision 7: `replaced` or `superseded_kept` |
| `superseded_credits` | unchanged | unchanged |
| write intent and receipts (decision 3) | unchanged | unchanged; the provenance is written in the value's own batch, so nothing is reconstructed from intents |
| `refresh_epoch` | unchanged | also raised by triggers 2 and 5 of decision 9 |
| `core` completion | unchanged | unchanged; a reopened part is `due` with the reason `provenance_upgrade` |
| identity hints | unchanged | unchanged; never provenance |

### 11. Rollout and the mode (0214-8)

**Recommended: 0214-8 = A.** One durable row, `film_metadata_provenance_control(id, mode, revision, updated_at, updated_by)`. Each mode change is an owner production operation with a readback.

| Mode | Behaviour |
| --- | --- |
| absent column, absent row, or `off` | today's behaviour, byte-identical |
| `record` | every write records its field objects; locks are enforced for every caller (none exist until the owner sets one); merge behaviour otherwise unchanged |
| `observe` | as `record`, plus each decision of the rule is computed and counted (`would_replace`, `would_refuse`, `would_adopt`), per writer and field; `film_metadata` is written exactly as under `record` |
| `enforce` | the rule of decision 5 applies to every writer |

- **Fail-safe.**
  - An unreadable mode is treated as `record`, so there are no new replacements.
  - An unreadable provenance column fails a metadata write closed (`film_person_unavailable`), because locks cannot be checked.
  - An absent column is today's behaviour, because no lock can exist.
- **Rollback.**
  - `enforce` to `observe` or `record` stops replacements at once, without a code revert.
  - Values already replaced stay. The owner can revert any field from history.

Alternative: B, one step from `off` to `enforce`.

### 12. Visibility

- The C1 tick outbox and the EPG producer outcome count per field: fills, replacements, adoptions, refusals, `owner_kept`, `source_absent`, `superseded_kept` and `provenance_mismatch`.
- `GET /api/admin/settings` (ADR 0211) shows the totals.
- The route of decision 8 shows one Film.
- No new Monitor alert. A Monitor reader for repeated `provenance_mismatch` may be added with card PV2.

### 13. Worked examples

1. **Fallback recovery.**
   - Letterboxd answers 429 for 72 h, so TMDB fills `runtime` = 112 (`unconfirmed`).
   - On day 4, Letterboxd answers 110, and the agreement is recorded.
   - Today (ADR 0211): `stored_differs`, and 112 stays.
   - `enforce`: 110 replaces 112. History keeps 112 with its provenance.
2. **Owner correction.**
   - `year` is 1999 from Letterboxd; the owner sets 2000.
   - A later Letterboxd refresh saying 1999 is refused and listed as `stored_differs`.
   - An EPG write of 1999 is skipped with `owner_kept`.
3. **An older cache.**
   - C1 wrote a Letterboxd synopsis observed on 1 December (`confirmed`).
   - The EPG chain replays a cached synopsis observed on 1 October (`unconfirmed`).
   - Today the older text would overwrite it. Under `enforce` it is refused, being lower in confidence and older.
4. **Identity correction.**
   - TMDB 100 becomes TMDB 200. `year` 1985 was written through `tmdb:100`.
   - TMDB 200 says 1987, which replaces 1985.
   - TMDB 200 has no runtime, so the old runtime stays as `superseded_kept`.
5. **Legacy.**
   - An unknown synopsis is met by a C1 fetch.
   - The same text: adopted, so it is now attributed, and no history is added.
   - A different text: replaced, with a history row.

### 14. Delivery graph

The card names (PV…) are distinct from the choice labels (0214-…). None of these cards is required for AIR-275 or for the ADR 0207 A2 flip.

| Card | Outcome | Depends on | Boundary | Gate |
| --- | --- | --- | --- | --- |
| **PV1** | Schema file (the provenance column, `film_metadata_history`, the control row's table); `writeFilmFacts`: declared provenance, binding, locks, the rank rule behind the mode, history; declarations from every metadata caller (EPG `film_facts`, `metadata_sync`, C1); offline tests | ADR 0214 accepted; C1 merged | dormant: an absent schema or mode `off` is byte-identical to today | implementation GO |
| **PV2** | C1 planning under the rule: the triggers of decision 9, `observe` accounting, outbox counts, the totals in `/api/admin/settings` | PV1 | dormant until `observe` | implementation GO |
| **PV3** | The owner route of decision 8 (GET and POST) | PV1 | refuses writes at `off` | implementation GO |
| **PVU** | An admin UI section for PV3 on the film page, with visual QA | PV3 | UI only | implementation GO; owner visual check |
| **PVM** | Apply the PV1 migration file | PV1 merged and deployed | no behaviour change (no control row means `off`) | production GO |
| **PVR** | Mode `off → record`, with a readback | PVM | provenance recorded; locks enforced | production GO |
| **PVO** | Mode `record → observe`, then a dated report of would-be replacements and refusals per writer and field | PVR; PV2 deployed | writes only what `record` writes | production GO |
| **PVE** | Mode `observe → enforce`, after the owner reviews the report | PVO report reviewed; PV3 deployed, so the owner can pin values first | replacements active; rollback is `observe` or `record` | production GO |
| **PVT** | A periodic refresh policy (decision 9) | measured C2 and PVE costs | its own record or amendment | owner decision |

**Migration apply order.** PVM applies pending files in number order, like every apply card of ADR 0207 decision 7. If PV1's file is numbered below a file of another stream, PVM states the exact files it applies.

### 15. Tests

**PV1, the writer:**
- `off` and an absent column: statements byte-identical to today, for every caller.
- The binding:
  - a digest mismatch reads `unknown` and reports `provenance_mismatch`;
  - an undeclared or anchorless write removes the field object, and in `enforce` fills only a blank field;
  - an EPG write is never refused for a missing agreement; it ranks `unconfirmed`;
  - the Film in `identity_disagreement` blocks every automatic replacement, and an absent ADR 0211 state means none.
- Merge, clear and retirement move or delete the field objects with the row.
- Locks:
  - an `owner` field is skipped as `owner_kept` for each caller, including a receipt replay of an older plan;
  - the dimension lock locks every field.
- Blank incoming never clears; `source_absent` is recorded.
- The rule:
  - every row of the rank table of decision 3;
  - adoption;
  - the refresh;
  - an older same-rank observation refused;
  - confidence never degrades;
  - a lower precedence refused;
  - a disagreement blocks.
- Order independence: two writers in both orders end with the same value and provenance.
- The Film revision fence fails a stale plan.
- History is written for every replacement and owner action, and never for a fill.
- Bounds: at most 12 guards and the statement cap of 60.

**PV2, C1:**
- fallback recovery replaces the fallback value;
- a recovery before 72 h fills first, with no history;
- source-set growth reopens the fields the new source precedes;
- an identity correction, with `replaced` and `superseded_kept`;
- unknown fields adopted or replaced in a fetch;
- an owner refresh racing a live tick (epoch fence);
- `observe` writes nothing beyond `record`;
- the counts.

**PV3, the route:**
- each action and its validation;
- a stale `expectedRevision`;
- the `applied`, `rejected` and `uncertain` readbacks;
- refusal at `off`;
- `revert` pins;
- `refresh` outside the scope answers `not_in_scope`;
- the JWT and owner checks;
- the GET write audit.

**Modes:**
- an unreadable mode behaves as `record`;
- an unreadable column fails closed;
- `enforce → record` stops replacements.

## Storage and write cost

Workers Paid is the baseline. These are measurements, not gates.
- **The provenance column.** About 300 to 400 bytes per field object, so at most about 2.4 KB per row.
  - Today, 414 rows: about 1 MB.
  - Upper bound, every one of the 13,292 Films with all six fields: about 32 MB. That is about 1.3% of the current 2.56 GB database, and about 0.3% of the 10 GB limit of a D1 database. The account stays within the 5 GB of storage included.
  - It adds **no rows written**, because it is part of the row write.
- **History.** One row per replaced value or owner action, typically under 1 KB (the average synopsis is 266 characters).
  - A one-time replacement of all six fields of all 13,292 Films would be about 80,000 rows, under 80 MB.
  - Ordinary operation adds few rows.
- **Rows written.** At most 6 history rows per Film write (plus their primary-key index entries).
  - At the ADR 0211 starting bound of 2 Films per hourly tick, that is at most about 600 rows a day, against 50 million rows a month included.
- **Statements.** A `core` batch gains at most 6 history inserts, within the writer's cap of 60. Guards stay within 12.
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
- **A numeric confidence score.** Against: an arbitrary number; an ordered closed vocabulary is testable.
- **A full observation log** of every fetch. Against: cost, and it is a candidate store by another name.

## Consequences

- The accepted ADR 0211 precedence applies to **filled** fields too, once in `enforce`. For example, a synopsis filled by TMDB through the fallback is replaced by the Letterboxd synopsis when Letterboxd recovers. Changing a field's order would be a separate decision.
- The EPG chain can no longer overwrite an owner value or a better value. Its refresh of its own values is unchanged.
- The owner gets a way to set, pin, release, revert and refresh metadata per field. Today there is none.
- **New durable contracts:**
  - the provenance column and its binding;
  - the history table;
  - the mode row;
  - the owner route;
  - the declared-provenance input of `writeFilmFacts`.
- **Residual risk.** A code revert to a version before PV1 also removes lock enforcement in the writer. Before such a revert, the owner should know which fields are `owner` (from the route), and history allows restoring them.

## Recovery and migration boundary

- **Additive schema only:** one nullable column, one append-only table and one control table. No existing value is rewritten by the migration, and there is no backfill.
- **The mode is the rollback.** `enforce` to `record` stops replacements, and `record` to `off` stops recording.
- Field objects written before a return to `off` may become stale. The binding then reads them as `unknown`. They are never trusted wrongly.
- **Replaced values are recoverable** from history, per field, by the owner route's `revert`. A bulk revert would be a separate, owner-approved operation.
- **Nothing here is irreversible.** The migration is additive; replacements are recorded in history.
- This record, even when Accepted, authorizes no implementation, migration apply, mode change, refresh or write. Each card keeps its own GO.

## Evidence

- Code reads on `main` `cb1fb88f` (24 Nov 2026): `src/canonical-film-writers.js` (merge, locks, statement cap, revision bump), `src/canonical-producer-workflow.js:73` (`filmFactsOf`), `src/canonical-metadata-sync-producer.js`, `src/worker.js:1325-1390` (the metadata stage and its 30-day window), `src/canonical-mutations.js:279-296` (merge), `src/canonical-letterboxd-claim.js`, migrations 0001, 0005 and 0014.
- Production L0 read, 24 Nov 2026 20:51 UTC: two aggregate `SELECT`s on the D1 database `iptv`. The counts are in the Context table. `rows_written` was 0, and no payload or identifier was read out.
- Cloudflare D1 limits and pricing, read on 24 Nov 2026: 10 GB per database and 5 GB of storage included on Workers Paid; 50 million rows written a month included; an index adds a written row.
- **Uncertainty:**
  - per-object sizes are estimates, to be measured in PV1 tests;
  - whether any historical owner edit reached `metadata.json` cannot be proven either way, so history is the safeguard.

## Owner choices (open)

| # | Choice | Options | Recommendation |
| --- | --- | --- | --- |
| 0214-1 | Where provenance is stored | **A** one JSON column on `film_metadata`, plus history; **B** a side table per field; **C** columns per field | A |
| 0214-2 | Which writers follow the rule | **A** every caller, in `writeFilmFacts`; **B** only C1 and the owner route (EPG keeps its merge, respects locks); **C** EPG becomes fill-only | A |
| 0214-3 | The replacement rule | **A** the rank rule (owner > confirmed > unconfirmed > unknown, then precedence, then observation time; refresh; never clear or degrade; history); **B** narrow: only fallback values, plus owner refresh; **C** fill-only plus owner edits | A |
| 0214-4 | Legacy and unknown values | **A** lowest rank: replaceable or adoptable by any anchored observation, with history; **B** only confirmed observations replace them; **C** protected until the owner releases them; **D** attribute them from hints (not recommended) | A |
| 0214-5 | Values under a superseded anchor | **A** rank `unknown`: replaced by the current anchors' values, kept and listed if they have none; **B** hold for the owner only; **C** clear at once | A |
| 0214-6 | Owner protection | **A** per-field set, lock, release, revert and refresh, through an authenticated route (UI separate); **B** lock and release only; **C** the Film-level lock only | A |
| 0214-7 | Refresh triggers | **A** events (fallback recovery, source growth, identity change, unknown fields met) plus owner refresh, periodic later; **B** A plus a periodic refresh now; **C** owner refresh only | A |
| 0214-8 | Rollout | **A** `off → record → observe → enforce`, each an owner production step, with a report before `enforce`; **B** `off → enforce` | A |

## Follow-ups

- On acceptance: create the cards of decision 14 with their gates, and update this record and its registry row to the decided options.
- When PV1 is delivered, the maintained contracts change in that PR:
  - `docs/reference/data/d1-schema.md`;
  - `docs/reference/domain/film-person.md`;
  - `docs/architecture/film-person-lifecycle.md`, with rendered Mermaid QA if a diagram changes;
  - `docs/reference/api/admin.md` for PV3, and the read side-effect baseline.
- Candidate, not selected: per-credit provenance, and a provenance model for metadata stores outside `film_metadata`.
