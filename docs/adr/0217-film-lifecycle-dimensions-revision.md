# ADR 0217: Film lifecycle dimensions: persist only control state, derive facts and readiness from their authorities

**Status:** Proposed  
**Original decision date:** pending owner disposition  
**Recorded at:** 2026-11-25, from `main` `6123890`  
**Approval source:** not yet decided  
**Related work:** [AIR-644](https://trello.com/c/nFBGvvnU). Builds on Accepted [ADR 0211](0211-catalog-enrichment-producer.md), [ADR 0213](0213-film-identity-evidence-ledger.md), [ADR 0214](0214-film-metadata-per-field-provenance.md), [ADR 0215](0215-identity-evidence-full-model.md) and ADR 0216 (canonical Film lifecycle and unified read contract, [PR #991](https://github.com/vladimino/iptv-watchlist/pull/991)). Coordinated with PV1 [AIR-631](https://trello.com/c/i8td3wu0) and PVE [AIR-636](https://trello.com/c/0jJADYxg).  
**Supersedes:** None. The recommended options amend no accepted decision (see [compatibility](#compatibility-with-accepted-adrs-and-the-pv-graph)).  
**Superseded by:** None

## Context

AIR-42 defined five independent Film lifecycle dimensions (`identity`, `metadata`, `localization`, `fingerprint`, `prediction`) as a storage-neutral domain contract ([reference](../reference/domain/film-person.md#lifecycle-dimensions-and-transition-rules)). Schema v1 stored them as rows of `film_dimension` (`migrations/0001_schema_v1.sql:113`): one row per `(film_id, dimension)` with `status`, `source`, `source_version`, `provenance_json`, `value`, `authority`, `last_error`, `failure_reason`, `retry_at`, `attempts`, `next_action` and `updated_at`. `status` is free text. No migration after 0001 adds a trigger, index or CHECK on the table.

Since then each dimension's facts gained their own D1 authority: identity claims and redirects (`film_external_id`, `film_redirect`, retirement decisions, ADR 0213/0215), metadata fields (`film_metadata`, `film_sync_state`, ADR 0214 per-field provenance), automatic localization candidates (`film_localization_source`, migration 0014), fingerprints and predictions (`fingerprint_payload`, `prediction_current`, `prediction_history`, the prediction authority). This ADR inventories what the dimension rows still do in code, and decides which of them stay persisted, which are derived and how the transition is staged.

This is code and contract analysis only (L0). It repeats no production census and uses no production data. Statements about production content are marked as not verified.

### Inventory: writers

| Id | Writer | Path | Dimensions | Guard |
| --- | --- | --- | --- | --- |
| W1 | `planFilmFacts` / `writeFilmFacts`, `src/canonical-film-writers.js:101-218`; upsert `dimensionUpsert` at :48 | runtime, fenced (`d1`/`open` marker, revision CAS, redirect refusal, receipt) | `identity`, `metadata` (only when the input carries `dimensions`), `localization` (`localization.state`, or the effective automatic value computed from `localization.sources`), `identity.provenance_json.titleSource` with the title it ranks (:182-189) | `strong()` (:45): a `reviewed` or `owner`-authority row is replaced only by owner-over-owner or a reviewed dictionary/owner write; the SQL `ON CONFLICT … WHERE` repeats it. A blank localization never replaces a value (:194) |
| W2 | `writeFilm`, `src/canonical-repository.js:165-187` | **offline** importer and backfill (`src/offline-importer.js`, `scripts/offline-import.mjs`, `scripts/d1-backfill.mjs`) | deletes and reinserts `identity`, `metadata`, `fingerprint`, `prediction` (:171); localization by guarded upsert | `guardReviewed` / `noteHeldLocalization` for localization only; the other four are replaced unconditionally |
| W3 | `retireFilm`, `src/canonical-repository.js:212` | offline | deletes every row of the retired Film | only a Film with no generation or EPG history |
| W4 | `mergeFilms` / `reconcile`, `src/canonical-mutations.js:184-325` | fenced, **no caller in `src` or `scripts`** | all; moves rows, records differing ones as `film_person_data_conflict` unless resolved; refuses to drop a reviewed/owner localization of the retired Film | merge resolution keys |
| W5 | `recordLocalizationSources`, `src/localization-sources.js:137-189` | runtime, from `src/canonical-metadata-sync-producer.js` (`applyLoc`) | **none**: writes `film_localization_source` only | monotonic `observed_at` |

Producers feeding W1: the dictionary producer (`src/canonical-dictionary-producer.js:121-129`, reviewed dictionary localization, `no_identity_row` when the identity row is absent at :104-118); the sealed-programme workflow (`src/canonical-producer-workflow.js:78-83`, passes `film.dimensions.identity/metadata` only if the sealed document carries them, which no builder in `src` was found to do); the metadata-sync producer (metadata and sync facts through W1, localization through W5).

### Inventory: readers

| Dimension | Runtime readers | What the row decides | Absent row |
| --- | --- | --- | --- |
| identity | `readFilmSnapshot` (W1 planning); dictionary producer; `d1IdentityFilms` (`src/catalog-d1.js:170`, admin Person identity route) | (1) `strong()` protects `canonical_identity` / `original_title`; (2) `titleSource` ranks which title source may replace the original title; (3) `identityStatus` shown on one admin route | the title is written but `titleSource` is skipped (`no_identity_row`); the dictionary producer sends no title; admin shows `identity: null` |
| metadata | `readFilmSnapshot` (only `strong()` and content equality); `reconcile` | nothing on a serving path. It is the carrier of the reviewed/owner **dimension lock** that ADR 0211 C1 and ADR 0214 decisions 5, 9 and 11 rely on (not yet implemented in code) | no lock |
| localization | `PAGE_FILM_SQL`, `STARTED_SQL`, `META_SQL`, `TITLE_SQL` (`src/canonical-catalog-reader.js`), `FILM_TITLE_SQL` (`src/catalog-d1.js:20`), `loadLocalizationInputs` | **the displayed localized title** on the film page, programme, watchlist, catalog and admin reads | no localized title; readers fall back to the original title |
| fingerprint | offline `readFilm` only | nothing at runtime | — |
| prediction | offline `readFilm` only | nothing at runtime | — |

Readiness (`displayReady`, `catalogReady`, `predictionReady`, `src/domain/film-person.js:227-237`) is computed only in the domain module, its diagnostics (`src/domain/film-person-diagnostics.js`) and the lifecycle parity reader. No route, producer planner, prediction eligibility or enrichment selection reads it or reads a dimension status from D1. Prediction eligibility is decided by the prediction domain ([ADR 0154](0154-prediction-eligibility-independent-of-epg.md)).

### Findings

- **F1. Two dimensions are frozen copies.** `fingerprint` and `prediction` rows are written only by the offline importer (W2) and read by nobody at runtime. Their truth is the prediction authority's D1 tables and R2 bodies. Any value they hold is a snapshot of the last offline import and diverges silently.
- **F2. Processing fields have no runtime meaning.** `last_error`, `failure_reason`, `retry_at`, `attempts` and `next_action` reach D1 only through W2 (or W1 if a producer ever passed sealed dimensions). No runtime code reads them. Producer process state already lives in receipts, the producer outcome store ([ADR 0208](0208-producer-outcome-events-delivery-store.md)) and the queues.
- **F3. The metadata status is not a coverage fact.** `film_metadata` columns (and, under ADR 0214, `film_metadata_field`) are the coverage; `film_sync_state` holds the freshness clocks. The row's `status` and whole-row `provenance_json` are replaced by other writers (ADR 0211 decision 1) and are read for nothing but the lock.
- **F4. The identity status duplicates the claims.** Trusted, non-conflicting `film_external_id` rows, redirects and retirements decide identity (ADR 0213/0215, ADR 0216 §3). The row is still load-bearing for two things that are not status: the `titleSource` rank and the `strong()` protection of `canonical_identity` / `original_title`.
- **F5. The effective localization is a projection with a staleness gap (to be proven by fixture).** The effective value is the row; candidates are in `film_localization_source`. W1 recomputes the row when it is given `localization.sources`, but the metadata-sync producer records sources through W5, which never recomputes it. A newer automatic candidate can therefore stay invisible to every display reader. `TITLE_SQL` reads only `provisional` rows. Whether this affects production rows is **not verified** and is not claimed here.
- **F6. Owner and reviewed authority lives in the rows and nowhere else.** Reviewed/owner localization values, the owner identity authority and the metadata dimension lock exist only as dimension rows. Mechanical deletion of `film_dimension` would lose authority and history.

## Decision

The principle: **a fact is read from its domain authority; a persisted row exists only for state that has no other durable home — an owner or reviewed decision, a lock, or a materialized projection kept for read cost.** Readiness and coverage are derived. Processing state belongs to producers. Per dimension (recommended options, see [owner choices](#owner-choices)):

| Dimension | Persisted | Derived (on read) | Disposition |
| --- | --- | --- | --- |
| identity | the row as the carrier of `titleSource` and of owner identity authority (C1) | status: `resolved` iff a trusted non-conflicting claim exists after redirects and retirements; `ambiguous` on a competing claim; else `unresolved` | stop writing processing fields; `status` becomes informational and is never read for a decision |
| metadata | the row **only** as the reviewed/owner dimension lock of ADR 0214 (B1); its status is frozen at what the lock needs | coverage per field from `film_metadata` / `film_metadata_field`; freshness from `film_sync_state` and field provenance; `partial`/`fresh`/`stale`/`missing` | non-lock rows retired after parity (stage 4) |
| localization | the effective value row, kept as a projection for display read cost; owner/reviewed rows are authority | effective value = owner > reviewed dictionary > newest automatic source, recomputed **in the same batch** as every source write (D1) | fix F5 in W5 |
| fingerprint | nothing | from the prediction authority (`fingerprint_payload`, compatibility verdict) | rows retired (A1) |
| prediction | nothing | from `prediction_current` / pointer, profile and fingerprint compatibility | rows retired (A1) |

Readiness (`display`, `catalog`, `prediction`) is computed by the unified read contract of ADR 0216 from the sections above, with its `present / absent / unknown / unavailable / partial` vocabulary. A missing dimension row never means absence of the Film or of a fact (**no false absence**): a new Film with no rows is `display`-ready when it has a title, and reads its facts from their authorities.

Four distinctions are kept apart in every reader:

1. **Existence:** the `film` row and its identity (ADR 0216 §1). Never inferred from a dimension row.
2. **Completeness:** derived coverage and freshness of a fact.
3. **Operational errors:** producer receipts and outcomes, not dimension rows.
4. **Eligibility:** decided by the consuming domain (prediction eligibility, enrichment selection), from facts, not from a stored readiness.

### Invariants

- **I1.** No migration, retirement or rewrite loses an owner or reviewed value, the owner identity authority, a metadata lock, `titleSource`, or merge-conflict history.
- **I2.** The `strong()` guard and the ADR 0214 lock semantics are unchanged; triggers planned by PV1 that read the lock keep reading the same row shape.
- **I3.** No reader maps an absent row to "missing fact" or "no Film".
- **I4.** No retirement step runs before readers and writers have moved and parity is proven on fixtures and on an offline copy.
- **I5.** No reader writes (ADR 0107).

### Examples

| Case | Today | After |
| --- | --- | --- |
| New Film from the metadata-sync producer, no dimension rows | localized title absent (F5); identity title rank skipped | localization row recomputed on the source write; `titleSource` written when the identity row is created by W1 on first title write (C1) |
| Legacy Film with a `fresh` metadata row and empty fields | row says `fresh` | coverage `partial`, derived from fields; lock state unchanged |
| Field with unknown provenance (ADR 0214 `unknown` tier) | not visible | freshness `unknown`, never `fresh` |
| Owner-reviewed title, then a newer automatic candidate | reviewed row kept | unchanged; candidate recorded, effective stays owner |
| Metadata lock (reviewed/owner) and a producer write | lock not checked in code | per ADR 0214: refused `owner_kept` (unchanged) |
| Merge with a reviewed localization on the retired Film | refused | unchanged |
| Producer failed, data present | row may say `failed` (offline only) | fact `present`; the failure is visible through the producer outcome, not readiness |
| Profile change, fingerprint unchanged | domain: prediction `stale`, fingerprint `current` | same verdicts, derived from the prediction authority |
| Film without shows, no optional data | — | `display`-ready; availability `none`; metadata `partial`/`missing`, never Film absence |

## Owner choices

Each choice is independent. Recommendations are the Executor's; the Coordinator presents them under the [facilitation protocol](../process/agent-workflow.md#adr-decision-facilitation-protocol).

**A. Fingerprint and prediction rows.**
- **A1 (recommended):** retire. Stop the offline writer (W2) writing them, derive from the prediction authority, then delete the rows in a fenced migration after parity. Removes a silently diverging copy (F1).
- A2: keep as a projection refreshed by the prediction writers. Adds writes on the hottest pipeline for no reader.
- A3: keep frozen. Zero cost now, but leaves a false source that readers may adopt later.

**B. Metadata row.**
- **B1 (recommended):** keep the row only as the dimension-lock carrier ADR 0214 already depends on; derive coverage and freshness. No change to ADR 0214 or PV1.
- B2: move the lock to a dedicated `film_metadata_lock` table and retire the row. Cleaner, but changes PV1 triggers and needs a superseding amendment of ADR 0214 decisions 5, 9 and 11 before PV1.
- B3: keep as today. Leaves F3.

**C. Identity row.**
- **C1 (recommended):** keep the row as the carrier of `titleSource` and owner identity authority; status derived from claims and never read for a decision. W1 creates the row on the first ranked title write, so `no_identity_row` stops dropping ranks.
- C2: move `titleSource` and the owner flag to `film` columns and retire the row. Needs a migration of every rank and of `strong()`.

**D. Effective localization.**
- **D1 (recommended):** keep the persisted effective row and make W5 recompute it in the same batch as each source write, with the existing guard. One fix point; readers unchanged.
- D2: derive the effective value at read time from the sources and reviewed rows. Removes the projection but changes five readers and adds a join on the hottest read path (about 6.7k Films per programme read).

## Alternatives considered

- **Persist everything, keep refreshing (status quo extended).** Every writer would maintain five rows; F1–F3 show the rows are not read. Rejected by the recommendation.
- **Derive everything, delete `film_dimension`.** Loses owner/reviewed authority, locks and `titleSource` (F6). Not acceptable without moving that state first; C2 and B2 are the controlled forms of it.
- **Hybrid (recommended):** persist control state, derive facts.

## Cost

Measured from code, not production:

- A1 removes two row writes per Film from the offline importer; runtime writes unchanged (none exist).
- D1 adds at most one guarded upsert per W5 batch that changes the effective value (no-op detection by `sameDimension`). Bounded by the sources already written; no new statement per read.
- Derivation on read uses the sections ADR 0216 already reads; no extra round trip for identity (claims are in its identity read-set) or metadata (fields are in the metadata section). Readiness is computed in memory.

Exact D1 `rows_read`/`rows_written` figures are to be measured on fixtures by each implementation card, as measurements and not as GO/NO-GO thresholds.

## Compatibility with accepted ADRs and the PV graph

- **ADR 0214 / PV1 (AIR-631):** with B1 the metadata row and its lock semantics are unchanged; PV1 proceeds as planned. B2 would require an ADR 0214 amendment **before** PV1's triggers land.
- **ADR 0211:** C1 producer does not pass `dimensions.metadata` (decision 1); unchanged.
- **ADR 0213/0215/0216:** identity derivation is exactly the ADR 0216 §3 resolution; no evidence rule changes.
- **PVE (AIR-636):** independent; it stays the prerequisite of mass enrichment AIR-614/615. Not affected by any option.
- No native prerequisite change is required under the recommended options. Under B2, AIR-631 gains this ADR's implementation card as a prerequisite.

## Delivery graph (no card is created by this ADR)

1. **Fixtures and parity reader (offline):** derived verdicts vs stored rows for all test cases below; no write.
2. **D1 fix (runtime, dormant-safe):** W5 recomputes the effective localization row; W1 creates the identity row on a ranked title write.
3. **Stop the processing writes:** W2 stops writing `fingerprint`/`prediction` rows and processing fields; readers of readiness move to derived sections (ADR 0216 aggregate).
4. **Retirement (L3, owner GO):** fenced migration deleting `fingerprint`/`prediction` rows and unlocked metadata rows after parity evidence, with a pre-image export for rollback.

Steps 1–3 are code PRs under normal review. Step 4 is a production data operation and needs its own owner-approved plan.

## Synthetic test plan

Real SQLite fixtures (`tests/`), one test per case: new Film without rows; legacy `fresh` row without fields; unknown provenance; owner lock and reviewed values (title and metadata); merge and revoke with reviewed localization on either side; producer failed but data available; profile change without fingerprint invalidation; absent optional data and no shows; W5 source write after a stale effective row (F5 regression); `no_identity_row` rank write (C1); parity of derived vs stored for every dimension; retirement pre-image round trip. Mutation anchors on the `strong()` guard stay.

## Rollback and fencing

Steps 1–3 are code-only and roll back with a deploy; no row is deleted before step 4. Step 4 exports the deleted rows first and restores them by an owner-approved script. All writes keep the canonical marker, revision CAS and receipt fences.

## Out of scope

`person_dimension` (same pattern; separate card if wanted), production census, any schema apply, backfill, repair, flag, Task, TMDB or model call, authority switch.

## Consequences

Removes two diverging copies and a staleness gap, keeps every owner decision, and makes readiness a single derived contract. Adds a parity step and, under D1, one guarded statement per changing source write.

## Evidence

- **Original decision:** pending.
- **Implementation:** none.
- **Dated verification:** code inventory at `main` `6123890`, 2026-11-25.
- **Uncertainty:** production row contents (F5 impact, legacy statuses) not measured; whether any sealed document carries `dimensions`; `mergeFilms` has no caller today.
