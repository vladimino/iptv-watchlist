# ADR 0214: Each `film_metadata` field carries provenance bound to its value; one writer rule protects owner values and replaces an automatic value only with a higher-ranked observation

**Status:** Accepted  
**Original decision date:** 2026-11-25 ([Product Owner final disposition](https://github.com/vladimino/iptv-watchlist/pull/988#issuecomment-7154541718): «Принимаю», after the [final technical review](https://github.com/vladimino/iptv-watchlist/pull/988#pullrequestreview-6052637302) of `c9b8ea2`).  
**Recorded at:** 2026-11-24. Revised:
- after the [first independent review](https://github.com/vladimino/iptv-watchlist/pull/988#pullrequestreview-6047546598) of `05509e8`;
- after the [second review](https://github.com/vladimino/iptv-watchlist/pull/988#pullrequestreview-6047797014) of `5897652`;
- after the [third review](https://github.com/vladimino/iptv-watchlist/pull/988#pullrequestreview-6052309399) of `72a9bcd`.

  The section [Review findings](#review-findings-and-where-each-is-answered) maps those reviews to the decisions. On 2026-11-25 the record was rewritten to the owner's selected direction, including 0214-1 = B and 0214-8 = B.

**Approval source:** [Product Owner final disposition of 25 Nov 2026](https://github.com/vladimino/iptv-watchlist/pull/988#issuecomment-7154541718), accepting this record as reviewed at `c9b8ea2`, with the choices selected on 2026-11-25 ([transcription](https://trello.com/c/Nc89nzGD#comment-6b06751ce89afc2aa91d3630)): 0214-1 = B, 0214-2 = A, 0214-3 = A, 0214-4 = B, 0214-5 = A, 0214-6 = A, 0214-7 = A, 0214-8 = B. Architecture acceptance only; no implementation, migration, activation or production GO.  
**Related work:**
- [AIR-613](https://trello.com/c/Nc89nzGD), card PF of the [ADR 0207 delivery graph](0207-letterboxd-admissions-coordinated-in-d1-only.md#7-delivery-graph-7c). It is **not** a prerequisite of [AIR-275](https://trello.com/c/4x7hH0gI).
- [ADR 0211](0211-catalog-enrichment-producer.md), owner choice 0211-1 = A: fill-only now, with option B (per-field provenance and a safe refresh and overwrite rule) planned as this record.
- [ADR 0213](0213-film-identity-evidence-ledger.md), the identity evidence ledger. This record neither reads nor writes it.
- [ADR 0120](0120-canonical-film-writers-identity-metadata-membership.md), the canonical Film writer. Its rules R1 (blank values, outside the sync clocks) and R5 (the `film_metadata` merge) are still draft.

**Supersedes:**
- in part, **only while the provenance mode is `enforce`** (decision 11):
  - ADR 0211 decision 1 (fill-only);
  - the ADR 0211 decision 2 rule that a later answer of an earlier source never overwrites;
  - the ADR 0211 decision 3b rule that values written under a superseded anchor are never overwritten;
- settles ADR 0120 rule R5 (metadata part) and rule R1 for the six fields of decision 1. Everything else in ADR 0120 is unchanged.

**Superseded by:** None

**Amended by ADR 0224:** Amended in part by [ADR 0224](0224-russian-first-catalog-metadata.md) (Accepted 2026-11-27, decisions 2–5, 7–9 and 11 only: language/evidence basis in value-bound provenance and comparator, history/merge/revert and dormant compatibility; [owner disposition](https://github.com/vladimino/iptv-watchlist/pull/1045#issuecomment-7221071584)); original status and approval retained. All other clauses remain binding.  
**Amended by AIR-636 (decision 15, the PVE drain interval only):** Amended on 2026-11-28 by the Product Owner's selected option B, a continuous interval of compatible deployments ([owner decision recorded by the Coordinator](https://github.com/vladimino/iptv-watchlist/pull/1067#issuecomment-7235886540); [amendment](#amendment-the-pve-drain-interval-air-636-28-november-2026)); original status and approval retained. All other clauses remain binding.

## Context

### What exists (main `cb1fb88`, 24 Nov 2026)

**One writer, several callers.** `writeFilmFacts` (`src/canonical-film-writers.js`) is the only writer of `film_metadata`. Every write asserts the marker generation, the Film revision and no redirect, and bumps the Film revision. So a plan and its commit are atomic against any other write of the same Film.

| Caller | What it writes | How it merges | Status |
| --- | --- | --- | --- |
| EPG Producer `film_facts` (`filmFactsOf`, `src/canonical-producer-workflow.js:73`) | the published Watchlist film record, stamped `metadataAt`, with a separate `synopsisFetchedAt` | `mergeMetadata`: a non-blank incoming value overwrites the stored one | active |
| `metadata_sync` (`src/canonical-metadata-sync-producer.js`) | the record of the EPG metadata stage, refreshed after 30 days (`src/worker.js:1343`) | the same merge | the stage fetches nothing while the Watchlist marker pins the run (ADR 0186) |
| ADR 0211 catalog-enrichment producer (card C1) | Letterboxd and TMDB values through their anchors | fill-only, one blank guard per field | designed, not implemented |
| `mergeFilms` (`src/canonical-mutations.js:184`, `reconcile` at `:279`) | the whole row of one of the two Films, by an explicit choice | whole-row move | no runtime caller |
| a `metadata: null` clear (`planFilmFacts`, `canonical-film-writers.js:212`) | deletes the row | — | in the planner's contract, but no runtime caller found on `cb1fb88`; the retired projector repository has the same clear (`canonical-repository.js:181`) |

**No per-field source.** `film_metadata` (migration 0001) holds `year`, `runtime`, `synopsis`, `poster`, `url`, `genres_json`, `people_version`, `payload_json`, `r2_key`, `content_sha256` and `updated_at`. Nothing says which source supplied which field, when, or through which identity.

**The EPG callers have no per-field lineage either.**
- `mergeWatchlistFilm` (`src/metadata-cache.js:16`) overlays the Watchlist listing on the cached `parseFilm` record, field by field.
- The synopsis has its own clock.
- The cached record stores no per-field origin.
- `metadata_sync` may reach the Film through the TMDB claim or a spelled Film id (`resolveExistingFilmId`, `canonical-metadata-sync-producer.js:55`).

So a Film holding a trusted Letterboxd claim does not prove that its six values came from that Letterboxd entity, in one observation.

**What looks like provenance, but is not per field:**
- the `metadata` row of `film_dimension` is a Film-level lifecycle status with one `source`, and other writers replace its `provenance_json` whole (ADR 0211 decision 1);
- `r2_key` and `content_sha256` describe the projection that wrote the row, not the fields.

**Protection.**
- The writer protects reviewed and owner **dimension rows** (`strong()`, `canonical-film-writers.js:45,179`).
- It does **not** check any lock before it merges a `film_metadata` value. ADR 0211 C1 adds a guard on the dimension lock, for its own writes only.
- **No route lets the owner set, pin or correct a metadata field.**

**The merge compares bookkeeping only.** `reconcile` decides whether two rows differ by `payload_json` and `content_sha256` alone (`canonical-mutations.js:282-290`).
- In production every row has `payload_json = '{}'`, and 413 of 414 have `content_sha256` NULL.
- So two rows with a different `year` or `synopsis` compare equal, and one of them is deleted without a choice.

**Patterns this record reuses:**
- the title's provenance key `titleSource` and its order (ADR 0120 R3, R3b);
- per-source localization rows under owner and reviewed values (ADR 0099);
- one-way and transition triggers on marker tables (migrations 0013, 0031, 0034), and immutable-row triggers (0031);
- receipted units. `canonical_write_receipt` (migration 0019, ADR 0119) keys a unit by `request_id`. Its applied tail requires `planned_revision + 1` to equal the entity revision after the batch (`canonical-mutations.js:32`), and it has no outcome field.

**Freshness.** `film_sync_state` holds four Film-level clocks (ADR 0070). No field has its own observation time.

**Production L0 read** (24 Nov 2026 20:51 UTC, aggregate `SELECT`s only, `rows_written` 0):

| Measure | Value |
| --- | --- |
| Films | 13,292 (15 redirects) |
| `film_metadata` rows | 414 |
| Fields set among them | `year` 414, `runtime` 410, `synopsis` 414 (266 characters on average), `poster` 414, `url` 414, `genres` 414 |
| `payload_json` | `{}` in all 414 rows |
| `r2_key` | `metadata.json` in 406 rows and NULL in 8; `content_sha256` is NULL in 413 |
| `metadata` lifecycle row of those 414 Films | `source = letterboxd` for 406, `source = tmdb` for 8 |
| `metadata` lifecycle rows in all | 10,865. So 10,451 Films have a lifecycle row and no `film_metadata` row |
| `metadata` lifecycle rows with reviewed status, or owner or dictionary authority | **0** |
| `film_rated_admission` rows | 714 |
| D1 database size | 2,563,719,168 bytes |

### The problem

1. **Fill-only cannot correct anything.** A value from the ADR 0211 fallback stays after the preferred source recovers. So does a value written under an identity that was later corrected. A stale value is never refreshed.
2. **The EPG merge can go backwards.** A non-blank EPG value overwrites any stored value, including a newer, checked one.
3. **The owner cannot protect or correct a field.**
4. **Unknown and known values look the same.**
5. **A merge can discard values silently**, because it compares bookkeeping, not the fields.

### Settled decisions this record keeps

- The ADR 0211 anchors and page agreement contract.
- The ADR 0211 per-field precedence.
- The 72 h transport-only fallback, which fills blank fields only (0211-7 = B, kept by 0214-4 = B).
- "A known disagreement blocks every automatic write".
- **Hints never become proof** (ADR 0211 decision 2, ADR 0213).
- **No stored candidates and no proof snapshots** (0207 direction 4A).
- **A blank never overwrites** (ADR 0120 R1).
- **Scope widening stays separate.** C3a and C3b are unchanged.
- **`mergeFilms` stays dormant.** This record changes its contract and tests; it does not activate it.
- **No change to the AIR-275 scope or to its prerequisites.**

## Decision

### 1. Scope: six fields of `film_metadata`

- **In scope:** `year`, `runtime`, `synopsis`, `poster`, `url` and `genres`, the `core` part of ADR 0211.
- **Out of scope, and why:**
  - `people_version`, `payload_json`, `r2_key`, `content_sha256`, `schema_version` and `updated_at` are bookkeeping and keep today's semantics.
  - `film.original_title` has its own accepted provenance (ADR 0120 R3, R3b).
  - Localization already has per-source rows (ADR 0099).
  - Credits are add-only under ADR 0211.
  - The `film_sync_state` clocks.
  - Metadata stores outside `film_metadata`.

### 2. A normalized provenance row per field, bound to the value (0214-1 = B)

Provenance lives in its own typed table, keyed by Film and field. It is not stored in `film_metadata` and contains no JSON:

```sql
CREATE TABLE film_metadata_field (
 film_id TEXT NOT NULL,
 field TEXT NOT NULL CHECK (field IN ('year','runtime','synopsis','poster','url','genres')),
 tier TEXT NOT NULL CHECK (tier IN ('owner','automatic','released')),
 source TEXT NOT NULL CHECK (source IN ('letterboxd','tmdb','owner','unattributed')),
 origin TEXT NOT NULL CHECK (origin IN ('catalog_enrichment','owner_route')),
 anchor_scheme TEXT CHECK (anchor_scheme IS NULL OR anchor_scheme IN ('letterboxd','tmdb')),
 anchor_value TEXT,
 anchor_digest TEXT CHECK (anchor_digest IS NULL OR (length(anchor_digest) = 64 AND anchor_digest NOT GLOB '*[^0-9a-f]*')),
 agreement TEXT CHECK (agreement IS NULL OR agreement IN ('confirmed','not_required','unconfirmed')),
 observed_at TEXT NOT NULL,
 checked_at TEXT NOT NULL,
 value_digest TEXT NOT NULL CHECK (length(value_digest) = 64 AND value_digest NOT GLOB '*[^0-9a-f]*'),
 write_key TEXT NOT NULL,
 written_revision INTEGER NOT NULL CHECK (written_revision >= 1),
 updated_at TEXT NOT NULL,
 PRIMARY KEY (film_id, field),
 CHECK ((anchor_scheme IS NULL) = (anchor_value IS NULL)),
 CHECK ((tier = 'automatic') = (agreement IS NOT NULL)),
 CHECK (tier <> 'automatic' OR (anchor_scheme IS NOT NULL AND anchor_digest IS NOT NULL)),
 CHECK (source NOT IN ('owner','unattributed') OR (origin = 'owner_route' AND tier IN ('owner','released') AND anchor_scheme IS NULL)),
 CHECK (source <> 'owner' OR anchor_digest IS NOT NULL)
) STRICT, WITHOUT ROWID;
```

The DDL is the contract's shape. The exact constraint text belongs to card PV1, and it is reviewed there.

**Keys and columns.**
- The primary key is the only index. Every read takes one Film's rows, at most six, through its prefix.
- There is no foreign key. Consistency comes from the single writer, the binding and the triggers below, and no cascade can silently move or delete a row.
- The semantic columns are `tier`, `source`, `anchor_*`, `agreement`, `observed_at` and `value_digest`. They decide ranks (decision 3) and converge (decision 6).
- The audit columns are `origin`, `checked_at`, `write_key`, `written_revision` and `updated_at`. They may differ between arrival orders and are never compared.
- **Owner authority is separate from observation lineage.** `tier` says who protects the value; `source` and the anchor columns say where it came from, and are never invented:
  - a pinned automatic value keeps its `source` and anchor columns, with `tier = 'owner'`;
  - a value the owner typed has `source = 'owner'`, no anchor, and `anchor_digest` = the Film's digest at the `set`, which records the identity under which the owner asserted it (decision 9);
  - a pin of an `unknown` value (legacy, or written by an undeclared writer) has `source = 'unattributed'`, no anchor and `anchor_digest` NULL, because its identity is not known. It is protected like any pin; its release leaves `tier = 'released'` with `source = 'unattributed'`, which ranks `unknown`;
  - a blank field cannot be locked (`rejected: blank_field`); `set` is the way to give it an owner value.

**Invalidation on every raw value change.** Database triggers on `film_metadata` delete the non-owner field rows that a raw change makes stale, atomically with the change, whatever code issues it:
- `film_metadata_field_invalidate_update`, `AFTER UPDATE OF year, runtime, synopsis, poster, url, genres_json`: for each column whose value changed (`NEW.x IS NOT OLD.x`), it deletes that field's row when `tier <> 'owner'`. Unchanged fields are untouched;
- `film_metadata_field_invalidate_delete`, `AFTER DELETE`, and `film_metadata_field_invalidate_move`, `AFTER UPDATE OF film_id`: they delete every non-owner field row under the old `film_id`;
- `film_metadata_field_invalidate_insert`, `AFTER INSERT`: it deletes every non-owner field row already present for that `film_id` (orphans of an earlier delete or move).

The new writer orders its batch accordingly: it changes the value first (the trigger removes the stale row), then writes the new field row. An equal value raises no trigger, so adoption updates the row in place. A merge writes the moved rows explicitly after the move. Pins are never deleted by these triggers; their protection is decision 11. So an old A → B → A sequence, a delete and identical re-insert, or a move and re-create, leaves the field `unknown`, never resurrecting an earlier occurrence's provenance.

**Binding.** A second, independent check:
- A field row counts only while its `value_digest` equals the SHA-256 of the canonical JSON of the stored value. Otherwise the field reads as `unknown`, and the mismatch is reported as `provenance_mismatch`.
- So a path that changes or moves a value without its field row can never make an old row describe a new value. Such paths are old code, a restore, the offline importer or a manual repair.
- The writer compares digests when it plans. The Film revision fence makes the plan and the commit atomic.

**Absence means unknown.**
- A field with no row is `unknown`. That covers today's 414 rows, every value written before activation, and every undeclared write (decision 4).
- **Nothing is backfilled, and nothing is inferred from hints.**

**History.** An append-only, typed table, `film_metadata_history`.

| Column | Meaning |
| --- | --- |
| `id INTEGER PRIMARY KEY` | — |
| `film_id`, `field` | which value |
| `reason` | `replaced`, `cleared`, `merge_discarded`, `owner_set`, `owner_lock`, `owner_release` or `owner_revert` |
| `old_value_text` | the old value, as the canonical JSON text of one scalar or array (a value, not a provenance store) |
| `old_tier`, `old_source`, `old_anchor_scheme`, `old_anchor_value`, `old_anchor_digest`, `old_agreement`, `old_observed_at` | the old field row's semantic columns, each NULL when the old value was `unknown` |
| `new_value_digest`, `new_tier`, `new_source`, `new_anchor_digest` | what replaced it |
| `write_key`, `at` | — |
| `merged_from` | the retired Film, for `merge_discarded` |

- `UNIQUE (film_id, field, write_key)`, so a replay never duplicates a row.
- A row is written in the same batch as the change. A fill of a blank field and an adoption (decision 5) add no row.
- The trigger `film_metadata_history_append_only` refuses `UPDATE` and `DELETE`. Nothing cascades into the table, so history outlives a deleted row or Film.
- Retention is indefinite. Pruning would be a separate decision.

### 3. Confidence and rank

Confidence is derived at read time from the field row and the Film's current anchors:

| Rank | Confidence | When |
| --- | --- | --- |
| 5 | `owner` | `tier = 'owner'`, or every field while the Film's `metadata` dimension row is reviewed or owner-authority (the dimension lock) |
| 4 | `confirmed` | `anchor_digest` equals the Film's **current** anchor digest, and `agreement` is `confirmed` or `not_required` |
| 3 | `superseded` | an automatic row whose `anchor_digest` no longer equals the current digest (decision 7) |
| 2 | `unconfirmed` | `anchor_digest` is current and `agreement = 'unconfirmed'`: the ADR 0211 fallback, or a stale agreement |
| 1 | `unknown` | no row, a digest mismatch, or `tier = 'released'` |

**The writer derives `agreement`, not the caller.**
- `not_required` only when the anchor set the writer computed holds no Letterboxd anchor.
- `confirmed` only when the caller's `agreedAnchorDigest` (ADR 0211's `agreed_anchor_digest`) equals the writer's digest for the current set.
- Otherwise `unconfirmed`, counted as `agreement_stale`.

**The anchor digest** is the ADR 0211 3b digest of the Film's whole anchor set. The writer computes it from `film_external_id` and `tmdb_retirement_decision`.

**The rank of an automatic value** is the tuple below, compared lexicographically:
1. confidence;
2. the ADR 0211 precedence of its source for the field (`letterboxd` before `tmdb`);
3. `observed_at`;
4. `value_digest`, as the last tie-break.

**Confidence never degrades automatically.**

**Provenance is not identity.** The anchor columns record which claim a write relied on. They are never a claim, an evidence row or an anchor for another write.

### 4. One rule in the single writer, for every caller (0214-2 = A)

The rule lives in `writeFilmFacts`, so it covers the EPG `film_facts`, `metadata_sync`, C1, the owner route and any future writer.

**Declared writes: C1 and the owner route.**
- A declared write names `source`, `anchor`, `observedAt` and, for Letterboxd-anchored Films, `agreedAnchorDigest`, per field.
- `observedAt` must be an instant no later than the write clock plus 60 s; otherwise the write is `film_person_invalid`.

**Undeclared writes: the EPG callers, older plans and receipt replays from before activation.** An undeclared write ranks `unknown`. The code gives the EPG callers no per-field lineage (Context), and a Film-level claim or clock is not a field's origin. An undeclared write:
- fills a blank field;
- replaces an `unknown` value with a history row: today's EPG refresh of its own legacy rows, unchanged;
- **never** replaces an attributed value, a locked field or an owner value;
- in mode `hold`, only fills;
- deletes the field row of a field it changes, in the same batch, so the value reads `unknown`.

Candidate card PV4 may give the EPG metadata stage real lineage; until then, its writes stay undeclared.

**Locks for everyone.**
- A write to an `owner` field, or to any field while the dimension lock holds, is skipped with `owner_kept`, unless it carries owner authority (decision 9).
- The skip never refuses the batch.
- This is enforced from activation, for every caller, and by the triggers of decision 11 for code that predates this record.

**Blank never clears.** A blank incoming value keeps the stored one. When it comes from the stored value's own source, it is counted as `source_absent`.

**Fences in the batch.** Beside the existing marker, Film revision and no-redirect fences:
- **every metadata batch**, a fill included, asserts the control row's `mode` and `revision` that the plan read, whenever the control table exists. No batch planned under one mode commits under another; the producer's ordinary retry replans it;
- **every declared batch** (fill, adoption or replacement) also asserts the planned anchor set: every planned anchor still holds by its exact `(scheme, value)`, and no other trusted `letterboxd` or `tmdb` anchor of the Film exists. This is the writer's own compound assertion, not one of the caller's 12 guards. A competing claim or a retirement fails it;
- **every automatic declared batch** (today only C1; the rule is C1's, as agreed, and undeclared EPG writes stay allowed) also asserts that the Film has no `identity_disagreement` on its ADR 0211 film row (an absent table or row means none). So a known disagreement blocks every C1 write, fills included;
- **an owner batch** asserts the mode, the revision and the Film revision, and nothing about disagreement, so a manual correction during a disagreement works (decision 9 adds the revert's anchor assertion);
- **an undeclared batch** asserts the mode and the revision only. It is not blocked by a disagreement: the EPG chain resolves its target through the canonical claims and reads no C1 state. Its values stay `unknown`, visible in the owner view, and are adopted or replaced by confirmed observations later.

**C1 keeps every guard of ADR 0211**: the anchor set, the epoch, the lock, the lease and the control generation. In `enforce`, its per-field *blank* guards are replaced by the Film revision fence, which already proves the planned state at commit.

### 5. The replacement rule (0214-3 = A)

In mode `enforce`, a declared incoming value V for field F, with stored value S, goes through one comparator. The first matching row applies:
1. **Refused, `owner_kept`:** F is `owner`, or the dimension lock holds.
2. **Refused, `disagreement`:** the Film is in `identity_disagreement`.
3. **Refused, `anchor_changed`:** V's anchor set does not hold at commit. The batch fails, and the caller replans.
4. **S is blank:** V fills F.
5. **V and S have equal values:**
   - `rank(V) > rank(S)`: **adoption**. The field row takes V's semantic columns. No history.
   - otherwise: nothing changes but `checked_at`, and that only when V's source and confidence equal S's and V is newer. Counted as `agreed`.
6. **Different values, `rank(V) > rank(S)`:** V replaces S, with a history row, **if V is `confirmed`** (0214-4 = B). An `unconfirmed` V never replaces a different non-blank value, which keeps the accepted fallback blank-only. This covers:
   - an `unknown` S (decision 8);
   - a `superseded` S (decision 7);
   - a higher confidence, or a higher precedence at equal confidence;
   - a **refresh**: the same source and confidence, a later `observed_at`;
   - equal confidence, source and `observed_at`: the digest decides, deterministically, and the case is listed as `same_rank_conflict`.
7. **Different values, otherwise:** refused, `stored_differs`.

Some writes never happen:
- a write that clears a value;
- one that replaces an `owner` field;
- one that writes across a known disagreement;
- one that lowers confidence;
- one that replaces a value with an older observation of the same rank;
- an `unconfirmed` write over a non-blank value.

In modes `off` and `hold`, declared writers only fill and adopt, as ADR 0211 delivers them. At `off` nothing about provenance is written at all (decision 11).

### 6. Convergence

**What converges.** In mode `enforce`, for a fixed set of `confirmed` automatic observations of one field, with the field's owner protection fixed, the semantic projection of the field ends the same in every order of arrival. The projection is the value plus the semantic columns. This holds provided the Film's anchors and locks stay the same.

**Why.** Every replacement and every adoption strictly raises the rank. The rank is a total order: the digest tie-break makes it total. So the final state is the maximum of the set.

**What is not claimed.**
- **Owner actions are not observations.** They are commands ordered by the Film revision (`expectedRevision`): two different `set`s apply in their command order, the later one winning, never by digest. An automatic observation never replaces an `owner` field, whatever its rank.
- `unconfirmed` observations only fill blanks (0214-4 = B). Among themselves, the first fill wins, as in ADR 0211. A `confirmed` observation then replaces whichever one landed.
- Undeclared writes rank `unknown` and claim no order.
- Mode `hold` claims no convergence.
- The audit columns and the history rows depend on the order of arrival, by design.

**Races.** The Film revision fences two writers; the loser replans. A late, older observation of the same rank is refused, so a field never regresses.

### 7. Identity changes and superseded values (0214-5 = A)

Every automatic field row whose `anchor_digest` no longer equals the current digest ranks `superseded`. That happens when an anchor value changes (lid L → L′, TMDB A → B), when a source is added or removed, or when a TMDB id is retired. A `superseded` row is distinct from an `unknown` one:
- it is replaced **only** by a `confirmed` observation under the current anchors, or by the owner;
- an `unconfirmed` observation and an undeclared write never replace it;
- an equal `confirmed` observation adopts it.

**What follows from an anchor change:**
- If the current sources confirm no value for the field, the old value **stays**. Once C1 has settled the `core` part under the new anchors, the field is listed as `superseded_kept` for owner review.
- Nothing is cleared automatically. A correction may retire a duplicate of the same work, where the old values are still right.
- `owner` fields are untouched.
- Credits stay held as `superseded_credits` under ADR 0211.

### 8. Legacy and unknown values (0214-4 = B)

`unknown` is the lowest rank. For a legacy value:
- an undeclared write replaces it with history, as today;
- an equal declared observation adopts it;
- **only a `confirmed` observation replaces a different value**, with history.

The `unconfirmed` 72 h fallback stays blank-only, exactly as accepted in ADR 0211. In the initial C1 scope (new admissions, which have no legacy row), this changes nothing; it matters once C3a or C3b widens the scope.

**Owner data is safe:**
- no code path has ever written `film_metadata` with owner authority;
- the L0 read shows no reviewed or owner-locked `metadata` row;
- history keeps every replaced value.

### 9. Owner protection, corrections and destructive paths (0214-6 = A)

**The authorized exception.** The metadata input of `writeFilmFacts` gains `authority: 'owner'`, the title's existing convention (`canonical-film-writers.js:144`).
- With it, and only with it, the writer may change `owner` fields and dimension-locked fields.
- The writer refuses it from any origin other than `owner_route` (`film_person_invalid`).
- The route sets it only after verifying, in the Worker, the Access JWT and the owner subject (ADR 0211 decision 6, `mcpVerifyAccess`). It also checks the Worker's own `Origin`, the `X-IPTV-Admin-Action` header and a JSON content type.

**Read.** `GET /api/admin/films/<id>/metadata` returns:
- each value, with its field row and its effective rank;
- the locks;
- the Film's C1 conflicts and hints;
- its history, including the history of Films redirected into it (one hop), **paginated**: newest first, at most 50 rows per page, with a cursor on `(at, id)`.

It is a pure read, registered in the GET write baseline.

**Write.** `POST /api/admin/films/<id>/metadata` takes `{action, field?, value?, historyRef?, expectedRevision, expectedRows?, requestId}`:

| Action | Effect |
| --- | --- |
| `set` | writes an owner value (`tier = 'owner'`, `source = 'owner'`, `anchor_digest` = the current digest) after validating the field's type and bounds; history |
| `lock` | pins the current value: an attributed value keeps its source and anchor columns, an `unknown` one is pinned as `source = 'unattributed'`; a blank field is `rejected: blank_field`; history |
| `release` | keeps the value and its lineage columns, `tier = 'released'`, so it ranks `unknown`; history. Under a dimension lock the field stays protected, and the readback says `dimension_locked: true` |
| `revert` | restores one history row's old value and semantic columns, then pins it; history |
| `refresh` | raises the C1 `core` refresh epoch through the ADR 0211 `retry` mechanism (its `expectedRows` compare-and-swap, epoch and lease fences). Epoch-only: no metadata, no history, no Film revision bump. `not_in_scope` when the Film has no state rows |

Every metadata action is one `writeFilmFacts` batch with owner authority, the fences of decision 4, and a compare-and-swap on `expectedRevision`. The route refuses writes at mode `off` and when the schema is absent. The dimension lock is never changed by this route; the review routes own it.

**The command record.** Every committed command, `refresh` and no-ops included, inserts one row of `film_metadata_owner_command`:

| Column | Meaning |
| --- | --- |
| `request_id` | `PRIMARY KEY` |
| `film_id` | — |
| `action` | — |
| `command_digest` | SHA-256 of the normalized command: `filmId` as received, `action`, `field`, canonical `value`, `historyRef`, `expectedRevision`, and for `refresh` the sorted `expectedRows` (`part`, `source`, `status`, `updated_at`, `refresh_epoch`) |
| `outcome` | `applied` or `noop` |
| `applied_revision` | the Film revision after the batch; NULL for `refresh` |
| `at` | — |

How the record behaves:
- **Atomic.** It is inserted in the same batch as the effect. A metadata command, a no-op included, bumps the Film revision, so `applied_revision` is real.
- **Refresh.** `refresh` writes only the C1 state rows and this row. Its batch asserts the C1 epochs and `expectedRows`, and also the control row's `mode` and `revision` (not `off`), that the Film exists and is not redirected, and the ADR 0211 control generation, so the route's pre-read is not the only activation or identity check.
- **Immutable.** `film_metadata_owner_command_immutable` refuses `UPDATE` and `DELETE`, and the primary key refuses a second insert.

**Replay and failures.** The route reads the command row before anything else:
- **Same key, different digest:** `rejected: request_mismatch`, for any field or action.
- **Same key, same digest:** `already_applied`, with the stored `outcome` and `applied_revision`, without a batch. That holds whatever was written, merged or redirected since.
- **No row:** the command **has not committed yet**. It does not prove that an earlier attempt still in flight can never commit. A resend is nevertheless safe: the command row's primary key is inserted in the same batch as the effect, so of two concurrent attempts at most one commits, and the other fails on the key and answers from the row it then reads. A route answering `uncertain` (503, `outcome: unknown`) tells the caller to read again or resend the same command.
- **Rejections are not recorded**, because they commit nothing: validation, a stale `expectedRevision` or `expectedRows`, `foreign_history`, `anchor_changed`, `identity_unknown`, a refused mode. Each is recomputed deterministically on a retry. Revisions and epochs only grow, so a stale command stays stale.

**`historyRef` and identity.**
- The history row's `film_id` must be the Film, or a Film redirected into it. Otherwise the revert is `rejected: foreign_history`.
- A revert is applied only when `old_anchor_digest` equals the Film's current digest. Otherwise it is `rejected: anchor_changed`.
- When `old_anchor_digest` is NULL, the old value's identity is unknown, and the revert is `rejected: identity_unknown`. The old value is still shown.
- In both refusals the owner may `set` the value instead, which is an explicit assertion under the current identity.
- **At commit,** the revert batch asserts the anchor set whose digest matched at plan time, so a competing claim or a retirement in between fails it. It does not assert the absence of a disagreement.

**Destructive paths.**
- **Clear (`metadata: null`).**
  - Refused (`film_metadata_locked`) while any field is `owner` or the dimension lock holds, unless the write carries owner authority.
  - Refused (`film_metadata_attributed`) for an automatic caller while any field row is attributed.
  - Refused (`film_metadata_hold`) for an automatic caller while the mode is `hold`. The clear batch asserts the mode it planned under, so an older plan committing after a switch to `hold` fails.
  - Otherwise allowed. Each non-blank value gets a history row (`cleared`), and the Film's field rows are deleted in the same batch.
- **Merge (`reconcile`, dormant).** The comparison is field-wise: the six values plus their field rows. The result is assembled field by field, and the retired Film's history stays under its own id.
  - Equal value and equal row: the survivor's row is kept.
  - Equal value, different rows, neither `owner`: the higher-ranked row is kept, and the other goes to history (`merge_discarded`).
  - **Equal value, a pin on one side: the pin is preserved by default.** With pins on both sides, the survivor's pin is kept and the retired pin goes to history.
  - Different values, no pin: `resolve.metadata` is required, else `film_person_data_conflict`. Discarded values go to history.
  - Different values with a pin: a per-field `resolve.metadataFields[field]` is required, else `film_person_data_conflict`.
  - **Dimension rows** follow the existing `reconcile` lifecycle rule (`canonical-mutations.js:297-316`): a lone retired lock moves, and two different rows need `resolve.metadataState`.
  - The retired Film's field rows are moved (`UPDATE film_metadata_field SET film_id`) or deleted in the same batch as its `film_metadata` row.
  - A merge with a pin or a dimension lock on either side inserts the release row of decision 11 for the moved or deleted rows.
  - The merge stays within the statement cap of 60, or it is refused as `film_person_bounded`; PV1 measures it. No activation is requested.
- **History is never deleted.** A `revert` reaches history through a redirect.

### 10. Refresh triggers (0214-7 = A)

There is no time-based refresh and no periodic sweep. In mode `enforce`, C1 reopens the `core` part of a Film in its scope, within its existing bounds and fairness, on:
1. **fallback recovery**: the earlier source answers;
2. **a source-set change** (decision 7);
3. **an identity correction**;
4. **unknown or superseded fields met in a fetch** that is due anyway;
5. **an owner `refresh`.**

`observed_at` and `checked_at` are stored, so a later periodic policy (card PVT) needs no migration.

### 11. Rollout, the mode and the permanent protections (0214-8 = B)

One durable row, `film_metadata_provenance_control(id = 1, mode, revision, updated_at, updated_by)`, is created by the migration at `off`.

| Mode | Behaviour |
| --- | --- |
| schema absent | today's behaviour; no lock can exist; the owner route answers `schema_absent` |
| `off` | today's rows, plus the mode assertion; no field row is written; the owner route refuses writes; only before activation |
| `enforce` | everything in decisions 4-10 |
| `hold` | protections P1-P4 below, and **no automatic replacement or clear**: every automatic writer, declared or not, only fills and adopts, and an automatic clear is refused. The owner route works. Nothing is deleted except through owner authority |

**Transitions**, enforced by triggers on the control row:
- `film_metadata_provenance_one_way`: once the mode leaves `off`, it never returns;
- `film_metadata_provenance_transition`: only `off → enforce`, `enforce → hold` and `hold → enforce`, each raising `revision`.

Each transition is an owner production operation with a readback.

**Permanent protections, from activation.** Once the mode leaves `off`, in `enforce` and in `hold`:
- **P1, locks:** an `owner` field, and every field under the dimension lock, changes only through owner authority;
- **P2, no degradation:** an attributed value is never replaced by an undeclared or lower-ranked write;
- **P3, history:** every replacement, clear or merge discard writes its history row in the same batch;
- **P4, fences:** the mode, the anchor and the disagreement assertions of decision 4.

**Triggers for code that predates this record.** P1, the history and the command record are also enforced in the database:
- `film_metadata_owner_value_locked`, `BEFORE UPDATE OF year, runtime, synopsis, poster, url, genres_json ON film_metadata`. It aborts with `film_metadata_owner_locked` when a changed column's field row has `tier = 'owner'`, or when the Film's `metadata` dimension row is reviewed or owner-authority, unless `film_metadata_owner_release` holds a row for the Film;
- `film_metadata_owner_row_locked`, `BEFORE DELETE` and `BEFORE UPDATE OF film_id ON film_metadata`. It aborts on the same condition, so a delete and a merge move are both covered;
- `film_metadata_field_owner_locked`, `BEFORE UPDATE` and `BEFORE DELETE ON film_metadata_field`. It aborts when `OLD.tier = 'owner'` without a release row, so a pin cannot be overwritten, deleted or moved away;
- `film_metadata_history_append_only` and `film_metadata_owner_command_immutable`.

**The release row.** `film_metadata_owner_release(film_id PRIMARY KEY)` is normally empty. Only an owner-authority batch (decision 9), or a merge with pins, inserts it, as the first statement of the batch, and deletes it as the last. An abort rolls back the whole batch, so it never stays.

**Code that predates PV1** never writes `film_metadata_field`. Its side effects are bounded:
- it cannot touch a pin, a dimension-locked Film or history, because of the triggers;
- a value it changes reads `unknown` through the binding;
- a value it changes, a row it deletes and a row it moves have their non-owner field rows removed by the invalidation triggers (decision 2), so they read `unknown`;
- so nothing is ever wrongly attributed.

**Fail-safe.** Each of these fails the metadata write closed with `film_person_unavailable`, and the unit retries:
- an unreadable control row;
- an absent control row while the control table is present;
- an unreadable field table;
- an anchor digest that cannot be computed.

**Rollback.**
- `enforce → hold` stops every automatic replacement at once, without a code revert. In-flight replacement batches fail on the control revision, and their producers replan them as fills.
- `off` is unreachable, so the old merge never returns under this code.
- Replaced values stay. There is **no automatic bulk rollback**. History shows each decision. The owner corrects a field by `revert` (same identity) or `set` (any identity).
- A code revert past PV1 is not a rollback. It is an owner L3 operation whose plan accepts the bounded side effects above.

**Consequence of the direct switch.** There is no pre-activation recording. Values written before PVE, including C1's first fills after C2, start as `unknown`. They are adopted or replaced when C1 next fetches them, through one of the triggers of decision 10. A `complete` part is not reopened by itself, so some of them stay `unknown`, visible in the owner view, until such an event or an owner `refresh`. A bulk adoption would be its own owner decision.

### 12. Mapping to the ADR 0211 C1 contracts

| C1 element | Modes `off` and `hold` | Mode `enforce` |
| --- | --- | --- |
| fill-only (decision 1) | unchanged | the comparator of decision 5 |
| per-field blank guards | unchanged | replaced by the Film revision fence |
| anchor-set, epoch, lock, lease and control-generation guards | unchanged | unchanged |
| `identity_disagreement` | blocks the Film | blocks the Film; the writer also asserts it |
| precedence and the 72 h fallback | unchanged | unchanged; a fallback value is `unconfirmed`, blank-only, and replaced when the earlier source confirms |
| `agreed_anchor_digest` | passed at `hold`; ignored at `off` | passed; the writer derives `agreement` |
| `stored_differs` | unchanged | refusals only; replacements are counted as `replaced` |
| `fallback_fill`, `unconfirmed_agreement`, `written_under_superseded_anchor` | unchanged | still listed; derivable from the field rows |
| `superseded_credits`, write intents, receipts, identity hints | unchanged | unchanged |
| `refresh_epoch` | unchanged | also raised by triggers 2 and 5 of decision 10 |
| the owner `retry` | unchanged | reused by `refresh` |

### 13. Visibility and acceptance counts

The C1 tick outbox and the EPG producer outcome count, per field:
- fills, adoptions and replacements;
- refusals, broken down into `owner_kept`, `stored_differs`, `disagreement` and `anchor_changed`;
- `source_absent`, `superseded_kept`, `same_rank_conflict`, `agreement_stale` and `provenance_mismatch`;
- the history rows written.

`GET /api/admin/settings` (ADR 0211) shows the totals, the mode, the revision and the history count. These counts are the evidence for PVE's natural acceptance. There is no new Monitor alert.

### 14. Worked examples

1. **Fallback recovery.**
   - TMDB fills runtime 112 through the 72 h fallback; the value is `unconfirmed`.
   - Letterboxd recovers with 110, and its agreement is recorded: `confirmed` replaces 112, and history keeps 112.
2. **Owner correction.**
   - The owner sets year 2000 over 1999.
   - A later Letterboxd 1999 is refused as `stored_differs`.
   - An EPG 1999 is skipped as `owner_kept`, and old code aborts on the trigger.
3. **An older cache.**
   - C1's confirmed synopsis is stored.
   - An EPG replay of October text is undeclared, so it is refused.
4. **Identity correction.**
   - TMDB 100 becomes 200, with the lid unchanged. All automatic rows become `superseded`.
   - TMDB 200 confirms year 1987, which replaces 1985.
   - No runtime is confirmed, so the old runtime stays, listed as `superseded_kept`.
   - A fallback could not have replaced either value.
5. **Legacy.**
   - The same text is adopted, with no history.
   - A different text is replaced by a `confirmed` observation, with history.
   - An `unconfirmed` observation leaves it alone.
6. **Hold.**
   - The owner switches `enforce → hold`.
   - In-flight replacements fail on the revision and replan as fills.
   - Pins, history and data stay.

### 15. Delivery graph

None of these cards is required for AIR-275 or for the ADR 0207 A2 flip.

| Card | Outcome | Depends on | Boundary | Gate |
| --- | --- | --- | --- | --- |
| **PV1** | Schema file: `film_metadata_field`, `film_metadata_history`, `film_metadata_owner_command`, `film_metadata_owner_release`, the control row at `off`, and the triggers of decision 11.<br>`writeFilmFacts`: declarations, binding, locks, owner authority, the comparator behind the mode, history and the fences.<br>**C1 declarations** on its existing writes, with no planning change; the EPG callers explicitly undeclared.<br>Field-wise `reconcile` and the clear rule.<br>Offline tests on real SQLite | ADR 0214 accepted; C1 merged | dormant: the schema absent, or mode `off`, writes today's rows | implementation GO |
| **PV2** | C1 planning under the rule: the triggers of decision 10, outbox counts, totals in `/api/admin/settings` | PV1 | dormant until `enforce` | implementation GO |
| **PV3** | The owner route of decision 9, with the command record | PV1 | refuses writes at `off` | implementation GO |
| **PVU** | Admin UI for PV3, with visual QA | PV3 | UI only | implementation GO; owner visual check |
| **PVM** | Apply the PV1 migration file | PV1 merged and deployed | no behaviour change at `off` | production GO |
| **PVE** | `off → enforce`. Preflight: PVM applied; PV1, PV2 and PV3 deployed in the running version; the control row at `off`; and a **drain**: the deployed version, within a continuous interval of proven compatible deployments at 100 % that is longer than the longest unit or Workflow step bound (the amendment below, 28 Nov 2026), no Workflow instance or producer unit of an older version still running, and no unsettled receipt planned by an older version (the ADR 0207 A2 pattern), because a deployed version does not prove that an older in-flight batch cannot commit later. A late pre-PV1 batch is still harmless: the invalidation triggers turn its value changes into `unknown`, and the lock triggers stop it at pins. Then a readback of the mode. Then natural acceptance in `Верификация`, on the counts of decision 13: replacements, refusals, conflicts and history. Rollback is `hold` | PVM; PV1, PV2 and PV3 deployed | the irreversible step is leaving `off`; `hold` stops replacements | production GO (owner L3) |
| **PVT** | A periodic refresh policy | measured C2 and PVE costs | its own decision | owner decision |
| **PV4** (candidate, parked) | EPG per-field lineage | PV1; its own decision | — | owner decision |

**Migration apply order.** PVM applies pending files in number order and states the exact files it applies, like every apply card of ADR 0207 decision 7.

#### Amendment: the PVE drain interval (AIR-636, 28 November 2026)

The PVE preflight above read the drain rule as one exact version standing at 100 % for longer than the bound, so that every deployment of `main` restarted the clock. **Product Owner decision, 28 November 2026, option B:** the clock is a **continuous interval of proven compatible deployments**. The change is to the drain interval of the PVE row only.

- **The rule.** The preflight is satisfied when (1) every deployment from `T0` to the final pin is a single version at 100 % that is **proven compatible**, (2) the interval from `T0` to the evidence time is longer than the longest unit or Workflow step bound `B` of the writers that reach `film_metadata`, (3) the old-work inventory is complete and empty (no nonterminal Workflow instance, no producer unit and no unsettled receipt of an older version, the in-flight HTTP and owner paths checked by their own fence and commit-time assertion), and (4) the final pinned deployment and the control revision are rechecked inside the brief window of the flip and its readback.
- **Proven compatible** means the deployed commit contains the writer rule and its guards (PV1, PV2, PV3 and the language-aware writer of ADR 0224), **checked by the actual writer and guard contract** (the control-row assertion at commit, the locks, history and invalidation behaviour), not by ancestry alone. A deployment whose compatibility cannot be shown, a rollback to an incompatible version and a split-traffic rollout break the continuity; `T0` then restarts at the next proven deployment.
- **`B`** is the nominal step retry envelope where a Workflow step passes no configuration of its own. It measures the length of the interval; it is **not** an additional wait once the interval and the inventory are satisfied, and it is **not** applied to HTTP requests, which Cloudflare does not hard-bound and which are fenced and asserted at commit instead.
- **Final pin.** The owner GO still names the exact deployment, commit and control revision. A deployment after the GO that is proven compatible keeps `T0`, but is a new pin: it requires a re-pin and replan, never an ambiguous permission to use either version.
- **Not changed.** The one-way `off`, the modes, the transitions, the protections and the rollback; no deployment freeze; no new card or control infrastructure. This amendment is not a production authorization: the live preflight and the operation-specific owner L3 GO remain required.

**Selected option and decision date:** B, 2026-11-28. **Approval source for this amendment:** [Owner decision recorded by the Coordinator, PR #1067 comment](https://github.com/vladimino/iptv-watchlist/pull/1067#issuecomment-7235886540).

### 16. Tests

**PV1: writer, schema and triggers (on real SQLite)**
- **Schema absent.** The statements are byte-identical to today's for every caller.
- **`off`.** Today's rows, plus the mode assertion; no field rows.
- **Binding, invalidation and declaration:**
  - a digest mismatch reads `unknown` and reports `provenance_mismatch`;
  - raw old-code statements: A → B → A, a delete and identical re-insert, and a move and re-create each leave the field `unknown`; only the changed field's row is removed; a pinned row survives (or the statement aborts, decision 11); a roll-forward writer re-attributes only through a real observation;
  - an undeclared write fills a blank, replaces an `unknown` value with history, deletes the field row, and never replaces an attributed or locked value;
  - EPG mixed clocks, a synopsis-only refresh and a TMDB-resolved `metadata_sync` input are all undeclared;
  - a future `observedAt` is `film_person_invalid`.
- **Identity gates and races:**
  - a C1 fill planned under anchor set A fails after A → B, after a competing claim and after a retirement;
  - a disagreement blocks a C1 fill, an adoption and a replacement, but not an undeclared fill or an owner `set`;
  - a batch planned at `off` fails on the revision after `off → enforce`, and so does one planned at `enforce` after `enforce → hold`; both replan;
  - on the real C1 path, the first declared write after activation is attributed; on the real EPG path, it stays undeclared;
  - 0214-4 = B: an `unconfirmed` value fills a blank and adopts an equal value, and never replaces a non-blank one.
- **Locks and triggers:**
  - an `owner` field is skipped by every caller, including a replay of an older plan;
  - the dimension lock covers every field and lets owner authority pass;
  - old-code raw statements are aborted: an `UPDATE` of a pinned column, a `DELETE`, an `UPDATE OF film_id` under a pin and under a dimension lock, and an `UPDATE` or `DELETE` of an owner field row;
  - the same statements pass inside a batch that holds the release row;
  - the history and command tables refuse `UPDATE` and `DELETE`;
  - an aborted batch leaves no release row.
- **The comparator:**
  - every rank row of decision 3;
  - adoption and `agreed`;
  - the refresh;
  - an older observation of the same rank refused;
  - confidence never degrades;
  - a lower precedence refused;
  - **convergence:** every permutation of a set of `confirmed` automatic observations, with owner protection held fixed, including equal times with different values and equal values of different ranks, ends with the same projection.
- **Anchors:**
  - `not_required` and `confirmed` derived by the writer, and `agreement_stale`;
  - both own-source changes (lid L → L′, TMDB A → B);
  - a source added and a source removed;
  - a superseded value replaced by `confirmed`, refused for `unconfirmed`, adopted when equal.
- **Modes:**
  - only the three legal transitions succeed;
  - a return to `off` is aborted;
  - `hold` fills and adopts only;
  - the fail-closed cases of decision 11;
  - pins and confirmed values survive `enforce → hold → enforce`.
- **Destructive paths:**
  - the clear rules, with history and the field rows deleted;
  - the merge:
    - equal bookkeeping with different values requires a choice;
    - equal values with the retired side pinned keep the pin;
    - two pins with equal values keep the survivor's pin;
    - different values with a pin need the per-field disposition;
    - dimension rows follow the lifecycle rule;
    - field rows move or are deleted with the row;
    - the batch stays within the cap or is refused as `film_person_bounded`;
  - an old-code delete or move removes the non-owner field rows through the invalidation triggers, and they read `unknown`.
- **Bounds:** the caller's guards stay at most 12, and real `core`, owner and merge batches stay within 60 statements.

**PV2: C1**
- fallback recovery replaces the fallback value;
- a recovery before 72 h fills first;
- source-set growth makes values `superseded`, then re-confirms them;
- an identity correction ends in `replaced` and `superseded_kept`;
- unknown and superseded fields are met in a due fetch;
- an owner refresh races a live tick;
- the counts of decision 13.

**PV3: the route**
- each action and its validation;
- owner authority refused from any other origin;
- editing a pinned value;
- `release` under a dimension lock;
- a stale `expectedRevision` or `expectedRows`;
- **replay:**
  - the same key with the same command answers `already_applied`, after later writes and after a merge;
  - the same key with a different command answers `request_mismatch`, on any field, for any action and for `refresh`;
  - a no-op is recorded as `noop` and bumps the revision;
  - a lost response is settled by reading the command row; no row means not committed, and a resend applies once;
  - a rejection writes no row and is recomputed on retry;
- **revert:**
  - `foreign_history`;
  - `anchor_changed`, also for an anchor set that changes between the plan and the commit;
  - `identity_unknown`;
  - `set` works where revert is refused;
- `refresh` writes no metadata and no history; a `refresh` planned before the mode or the Film changed fails on its fences; two concurrent resends of one command commit once;
- `lock` and `release` of a legacy value (`unattributed`, no invented source); `lock` of a blank field refused; `set`, `lock` and `revert` of owner values, and every DDL constraint on each transition;
- two different `set`s apply in revision order;
- an automatic clear refused during `hold`, also for a plan made before the switch;
- the history read paginates;
- `not_in_scope`;
- refusal at `off` and when the schema is absent;
- the JWT and owner checks;
- the GET write audit.

## Storage and write cost

Workers Paid is the baseline. These are measurements, not gates.

**`film_metadata_field`:**
- A row is about 250 to 350 bytes, including its primary-key entry: two 64-character digests, the anchor, three instants and the write key.
- Today, 414 Films with six fields: 2,484 rows, under 1 MB.
- At today's full catalog, 13,292 Films × 6: 79,752 rows, about 20 to 28 MB. That is about 1% of the current 2.56 GB database and about 0.3% of D1's 10 GB limit, within the 5 GB of storage included.

**Rows written per write** (each row plus its primary-key entry; the table has no secondary index, `WITHOUT ROWID`):
- a full `core` write adds 6 field rows: **12 rows written**;
- a replacement adds a history row, its primary key and its unique index: **3 rows written per replaced field**;
- an owner command adds its command row (2), plus the release row's insert and delete (4).

A fully replaced Film therefore costs up to about 30 rows written beyond today. At the ADR 0211 starting bound of 2 Films per hourly tick, that is at most about 1,500 rows a day, against 50 million a month included.

**History grows without a bound, by design:**
- one row per replaced, cleared or discarded value, or owner action, typically 0.3 to 1 KB;
- a full churn of today's 414 rows: about 2,500 rows, about 2.5 MB;
- a one-time replacement of all fields in today's catalog: about 80,000 rows, under 80 MB;
- the EPG chain adds a row only when a legacy value changes.

**Statements per batch** (the writer's cap is 60):
- a `core` batch adds up to 6 field upserts or deletes, up to 6 history inserts, and three fence assertions (mode, anchor set, disagreement): about **37** with today's statements;
- an owner batch adds the command row and the release row's insert and delete: about **25**;
- a merge adds up to 12 field-row moves or deletes, 12 history rows and 2 release statements on top of `mergeFilms`. It must stay within 60, or it is refused as `film_person_bounded`; PV1 measures it.

The caller's guards stay within 12.

**Reads:** one primary-key prefix read of at most 6 rows per plan, plus the bounded anchor read of ADR 0211.

**Unknown provenance costs nothing.** There is no backfill.

## Alternatives considered

- **0214-1 A, a JSON column on `film_metadata`** (the previous recommendation). Not chosen by the owner: provenance is rarely read, and should live apart, normalized.
- **0214-1 C, columns per field on `film_metadata`.** Against: at least 24 columns.
- **A JSON object inside the side table.** Rejected by the owner's direction: typed columns only.
- **Per-source candidate rows**, the localization pattern. Against: they store candidates (4A).
- **The dimension row's `provenance_json`.** Against: it is Film-level, and other writers replace it.
- **Declaring EPG writes from the Film-level claim and clocks.** Against: a hint would become proof.
- **0214-8 A, `off → record → observe → enforce`** (the previous recommendation). Not chosen by the owner: every bad decision can be analysed and rewritten through history, `hold` and owner corrections.
- **A fill exemption from the identity gates.** Against: a declared fill claims the current anchors.
- **A numeric confidence score.** Against: it is arbitrary.
- **A full observation log.** Against: it is a candidate store under another name.

## Consequences

- Once `enforce` is on, the accepted ADR 0211 precedence also applies to filled fields, through confirmed observations.
- The EPG chain can no longer overwrite an owner or an attributed value. Its refresh of its own legacy values is unchanged and now leaves history.
- A source-set change makes attributed values `superseded` until they are re-confirmed.
- The owner can set, pin, release, revert and refresh each field. Today, none of that exists.
- A merge can no longer discard differing or pinned values silently.
- Values written before activation, including C1's early fills, start `unknown` (decision 11).
- **New durable contracts:**
  - four tables;
  - the control row;
  - the triggers;
  - the owner route and its command record;
  - the declared-provenance and owner-authority inputs of `writeFilmFacts`;
  - the field-wise merge.
- **Residual risk.** After a code revert past PV1, unlocked values may be replaced without history until the roll-forward. They then read `unknown`, never wrongly attributed. Pins, history and command records stay protected by the triggers.

## Recovery and migration boundary

- **The schema change is additive only:** four tables, a control table and the triggers. No existing row is rewritten, and nothing is backfilled.
- **Leaving `off` is the irreversible step.** Its rollback is `hold`, which stops automatic replacements without deleting anything.
- **No automatic bulk rollback.** History records every replaced, cleared or discarded value, so each decision can be analysed. The owner corrects a field with `revert` (same identity) or `set`. A bulk correction would be its own owner decision.
- **A code revert past PV1** is an owner L3 operation (decision 11).
- **Authorizes nothing.** Even accepted, this record authorizes no implementation, migration apply, mode change, refresh, merge activation or write.

## Evidence

- **Code reads on `main` `cb1fb88f`**, 24 Nov 2026:
  - `src/canonical-film-writers.js`;
  - `src/canonical-producer-workflow.js:73`;
  - `src/metadata-cache.js:16`;
  - `src/canonical-metadata-sync-producer.js:55`;
  - `src/worker.js:1325-1390`;
  - `src/canonical-mutations.js:13,32,184-316`;
  - `src/canonical-receipts.js`;
  - migrations 0001, 0005, 0013, 0014, 0019, 0031 and 0034.
- **Production L0 read**, 24 Nov 2026 20:51 UTC: two aggregate `SELECT`s. `rows_written` was 0.
- **Cloudflare D1 limits and pricing**, read on 24 Nov 2026.
- **Owner choices:** the [consolidated owner choices of 25 Nov 2026](https://trello.com/c/Nc89nzGD#comment-6b06751ce89afc2aa91d3630), as transcribed by the coordinator.
- **Uncertainty:**
  - row sizes and merge statement counts are estimates, measured in PV1;
  - historical manual edits to `metadata.json` cannot be ruled out;
  - SQLite firing `UPDATE` triggers from an upsert's `DO UPDATE` is verified in PV1 tests on real SQLite, not assumed.

## Review findings and where each is answered

| Finding | Answer |
| --- | --- |
| First review 1: rollback and mode fencing | Decision 11: protections P1-P4 from activation; `hold`; a one-way `off`; the triggers; the mode assertion in every batch |
| First review 2: convergence | Decisions 3, 5 and 6: one total comparator; the convergence claim limited to `confirmed` and owner observations in `enforce` |
| First review 3: identity change | Decisions 3 and 7: a `superseded` rank; a whole-set digest; a writer-derived agreement |
| First review 4: per-field lineage | Decision 4: the EPG callers are undeclared; PV4 is parked |
| First review 5: destructive paths | Decision 9: a field-wise merge; history; release rows |
| First review 6: owner actions | Decision 9: owner authority; dimension-lock semantics; `refresh` as an epoch-only mutation |
| First review: cost | Storage and write cost, recalculated for the side table |
| Second review 1: fill exemption | Decision 4: the anchor and disagreement gates apply to every declared batch; owner batches are separate; the fallback stays blank-only (0214-4 = B) |
| Second review 2: activation boundary | Decision 15: the C1 declarations are in PV1; the PVE preflight requires PV1, PV2 and PV3 |
| Second review 3: receipts | Decision 9: the command record |
| Second review 4: merge, locks, history identity | Decisions 9 and 11: pins kept on equal values; triggers on moves and deletes, and on the field table; `old_anchor_digest`; `identity_unknown` |
| Third review | Decision 9: an immutable command record, independent of `canonical_write_receipt`; durable `noop`; rejections not recorded; a revert's anchor set asserted at commit |
| Fourth review | Decision 2: owner authority separated from lineage (`unattributed` pins, owner-set digest, blank lock refused), invalidation triggers against stale attribution; decision 6: owner commands ordered by revision, outside convergence; decision 9 and 11: automatic clear refused in `hold`, refresh batch fences, honest missing-row semantics, paginated history, C1-specific disagreement rule; decision 15: PVE drain |
| Owner direction of 25 Nov 2026 | Decision 2: the normalized typed table, with the binding, triggers, merge, moves, history and command record reworked for it. Decision 11: only `off → enforce ⇄ hold`; PVR, PVO, `record` and `observe` removed. The cost is recalculated |

## Owner choices

Selected on 2026-11-25 ([transcription](https://trello.com/c/Nc89nzGD#comment-6b06751ce89afc2aa91d3630)) and accepted with this record ([final disposition](https://github.com/vladimino/iptv-watchlist/pull/988#issuecomment-7154541718)). No choice remains open.

| # | Choice | Selected |
| --- | --- | --- |
| 0214-1 | Where provenance is stored | **B**: a normalized, typed side table keyed by Film and field, with no JSON |
| 0214-2 | Which writers follow the rule | **A**: every caller, in `writeFilmFacts`; the EPG callers are undeclared |
| 0214-3 | The replacement rule | **A**: the rank comparator |
| 0214-4 | Legacy values | **B**: only a `confirmed` observation replaces a different value; the fallback stays blank-only |
| 0214-5 | Superseded values | **A**: replaced only by a confirmed value under the current anchors; otherwise kept and listed |
| 0214-6 | Owner protection | **A**: the authenticated route, the owner-authority exception and explicit dispositions |
| 0214-7 | Refresh triggers | **A**: events plus owner refresh; no periodic sweep |
| 0214-8 | Rollout | **B**: `off → enforce`, with `hold` as the rollback |

## Follow-ups

- **On acceptance:** the coordinator creates the cards of decision 15 with their gates.
- **When PV1 is delivered**, the maintained contracts change in that PR:
  - `docs/reference/data/d1-schema.md`;
  - `docs/reference/domain/film-person.md`;
  - `docs/architecture/film-person-lifecycle.md`, with rendered Mermaid QA if a diagram changes;
  - `docs/reference/api/admin.md`, and the read side-effect baseline (PV3).
- **Candidates, not selected:**
  - PV4;
  - per-credit provenance;
  - provenance for stores outside `film_metadata`;
  - a bulk adoption after activation.
