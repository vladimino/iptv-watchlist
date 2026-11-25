# ADR 0218: Film lifecycle dimensions: persist only control state, derive facts and readiness from their authorities

**Status:** Proposed  
**Original decision date:** pending owner disposition  
**Recorded at:** 2026-11-25, from `main` `6123890`; revised after the [independent review](https://github.com/vladimino/iptv-watchlist/pull/997#issuecomment-7162637848) of `8b7cabf` against `main` `961c045`  
**Approval source:** not yet decided  
**Related work:** [AIR-644](https://trello.com/c/nFBGvvnU). Builds on Accepted [ADR 0211](0211-catalog-enrichment-producer.md), [ADR 0213](0213-film-identity-evidence-ledger.md), [ADR 0214](0214-film-metadata-per-field-provenance.md), [ADR 0215](0215-identity-evidence-full-model.md) and [ADR 0216](0216-canonical-film-lifecycle-and-unified-read-contract.md). Coordinated with PV1 [AIR-631](https://trello.com/c/i8td3wu0) and PVE [AIR-636](https://trello.com/c/0jJADYxg).  
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

- **F1. Two dimensions are frozen copies.** `fingerprint` and `prediction` rows are written only by the offline importer (W2) and read by nobody at runtime. Their truth is the prediction domain: `prediction_fingerprint` and the fingerprint compatibility verdict for fingerprints; `prediction_pointer`, `prediction_lineage` and immutable R2 bodies for predictions (ADR 0216 §5). Schema v1 `fingerprint_payload` and `prediction_current` are not authorities either. Any value they hold is a snapshot of the last offline import and diverges silently.
- **F2. Processing fields have no runtime meaning.** `last_error`, `failure_reason`, `retry_at`, `attempts` and `next_action` reach D1 only through W2 (or W1 if a producer ever passed sealed dimensions). No runtime code reads them. Producer process state already lives in receipts, the producer outcome store ([ADR 0208](0208-producer-outcome-events-delivery-store.md)) and the queues.
- **F3. The metadata status is not a coverage fact.** `film_metadata` columns are the values (and, once PV1 lands, `film_metadata_field` their per-field provenance, ADR 0214; not live today); `film_sync_state` holds historical sync clocks, which say when a sync ran, not that a value is bound to a source. The row's `status` and whole-row `provenance_json` are replaced by other writers (ADR 0211 decision 1) and are read for nothing but the lock.
- **F4. The identity status duplicates the claims.** Trusted, non-conflicting `film_external_id` rows, redirects and retirements decide identity (ADR 0213/0215, ADR 0216 §3). The row is still load-bearing for two things that are not status: the `titleSource` rank and the `strong()` protection of `canonical_identity` / `original_title`.
- **F5. The effective localization is a projection with a staleness gap (to be proven by fixture).** The effective value is the row; candidates are in `film_localization_source`. W1 recomputes the row when it is given `localization.sources`, but the metadata-sync producer records sources through W5, which never recomputes it. A candidate that the existing resolver (`resolveLocalization`, `src/localization-sources.js:45-58`: owner > reviewed > automatic; within automatic the fixed order `letterboxd > tmdb > wikidata > epg > discovery`, then the newer observation, then the source name) would make effective can therefore stay invisible to every display reader. The metadata-sync receipt readback (`planSources`, `src/canonical-metadata-sync-producer.js:177-190`) checks source rows only, so a replayed source write proves nothing about the projection. `TITLE_SQL` reads only `provisional` rows. Whether this affects production rows is **not verified** and is not claimed here.
- **F6. Owner and reviewed state is partly only in the rows.** Owner titles also exist in `owner_review_entry`, and reviewed dictionary titles in `data/film-titles.json`, but the applied reviewed/owner localization value with its provenance, an owner-authority identity row, `titleSource` and the metadata dimension lock exist only as dimension rows. Legacy rows may also carry `authority` or `status` values no current writer produces (offline import); their meaning is unknown until classified. Mechanical deletion would lose authority and history.
- **F7. The offline import deletes before it writes.** W2 runs `DELETE FROM film_dimension WHERE film_id=? AND dimension<>'localization'` (or the `identity`/`metadata` pair for the enrichment owner) before reinserting (`src/canonical-repository.js:171-174`). Stopping its `fingerprint`/`prediction` inserts alone would still delete those rows, and identity/metadata control rows (`titleSource`, lock) are overwritten unconditionally. W2 is not a serving-path writer at `open`, but it remains a code path for offline import, backfill and fixtures.


## Decision

**Principle.** A fact is read from its domain authority, through the sections and verdicts of [ADR 0216](0216-canonical-film-lifecycle-and-unified-read-contract.md). A `film_dimension` row is kept only for state with no other durable home: an applied owner or reviewed decision, the ADR 0214 metadata lock, `titleSource`, or the effective-localization projection kept for read cost. Readiness and coverage are derived; processing state belongs to producers. This ADR adds no new precedence, identity or prediction rule: every derivation below reuses an existing accepted rule and names it.

### 1. Per-column disposition

"Control" means the column is authority and is kept; "copy" means another store is authoritative and the column is not read for a decision; "unknown" means legacy content not produced by any current writer.

| Dimension | `status` | `source`, `source_version` | `provenance_json` | `value` | `authority` | `last_error`, `failure_reason`, `retry_at`, `attempts`, `next_action` | `updated_at` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| identity | copy (verdict comes from ADR 0216 §3); `reviewed` is control (`strong()`) | copy | control: `titleSource`; other keys copy (correction provenance, also in claim rows) | unused | control when `owner` | copy, offline only | control for the ranked title clock (`titleSource.at`); otherwise informational |
| metadata | control **only** as the lock predicate `status='reviewed' OR authority='owner'` (ADR 0214 decision 5); otherwise copy | copy | copy (replaced whole by writers, ADR 0211 decision 1) | unused | control when `owner` | copy, offline only | informational |
| localization | control: tier (`reviewed` / `provisional`) | control | control (applied provenance; dictionary `sources`) | control: the effective value | control (`owner`, `dictionary`) | unused at runtime | control (projection clock) |
| fingerprint | copy | copy | copy | unused | unknown if set | copy | copy |
| prediction | copy | copy | copy | unused | unknown if set | copy | copy |

Actual consumers today: runtime readers in the [inventory](#inventory-readers); offline: `readFilm` (`src/canonical-repository.js:230`), the importer verify (`src/offline-importer.js:688,823,963`), `scripts/tmdb-tv-identity-plan.mjs:62-68`, `scripts/epg-producer-m2b.mjs:216`, `scripts/film-person-e6-measure.mjs`, `scripts/epg-producer-m2b-reader.mjs`. Every change below moves those consumers in the same card as the writer change.

### 2. Derived facts: authorities and typed results

Every derived fact uses the ADR 0216 status vocabulary (`present`, `absent`, `unknown`, `unavailable`, `partial`, `conflict`) and its section tokens and fences (E1). A missing dimension row is never a negative.

| Fact | Authority (ADR 0216 §5) | Rule |
| --- | --- | --- |
| identity verdict | identity read-set of §3 (claims, redirects, retirements, competing claims) | the full ADR 0216 verdict, including `retired`, `conflict`, `ambiguous`; never "at least one trusted claim" |
| metadata value per field | `film_metadata` and, once PV1 lands, `film_metadata_field` | `present` when the value is bound to a source; `absent` only when provenance records an explicit null; otherwise `unknown`. Before PV1 every field without per-field provenance is `unknown` provenance, never `fresh` |
| metadata freshness | per-field provenance and value binding (ADR 0214) | `fresh` only from per-field provenance within the 30-day window; `film_sync_state` clocks alone never prove freshness (they report when a sync ran); explicit null and unknown stay distinct |
| effective localization | the existing resolver of decision 3 | unchanged precedence |
| fingerprint state | prediction domain `prediction_fingerprint`, fingerprint compatibility verdict | `present`/`absent` per the prediction domain; `unavailable` when its marker is held |
| prediction state | `prediction_pointer`, `prediction_lineage`, immutable R2 bodies; candidate coverage of ADR 0216 §6b (G1) | `none` only under ADR 0216's negative proof (no pointer on every authorized storage id **and** complete coverage); never from `prediction_current`; `partial`/`conflict` as §6b |
| availability | pinned published EPG generation | `none` only from the pinned generation (ADR 0216 §5); absence of optional data is never `none` |

### 3. Effective localization (choice D)

The effective localization row stays a projection of `owner_review_entry` (owner), the applied reviewed row (dictionary/owner) and `film_localization_source` (automatic), computed by the **existing** `resolveLocalization` with its fixed source order, observation time and source-name tie break. No newest-wins rule is introduced. Under D1:

- **Same batch.** Every accepted source write recomputes the projection in the same D1 batch, from the source rows as they will stand after the write plus the stored reviewed/owner state, behind the existing `strong()` guard and SQL `WHERE`, under the snapshot revision CAS. A lower tier never replaces a higher one.
- **Receipt.** The operation digest covers the source content; the readback proves both the source rows **and** the projection (the effective row equals the resolver output on the read rows). A replay of a source row written before the fix finds the projection missing and recomputes it; it never reports success from source rows alone.
- **No-op.** When the resolver output equals the stored row (`sameDimension`, ignoring `updated_at`), no projection statement is issued.
- **Stale and concurrent.** An older `observed_at` loses as today (monotonic upsert). A reviewed or owner write between plan and write fails the CAS and replans.
- **Existing stale projections** (no new source write will arrive; or an owner change only in `owner_review_entry`) are fixed by a separate bounded reconciliation writer that reuses the same recompute, with a per-run cap, receipts and a dry-run report. It is a production write and needs its own L2 contract or L3 owner GO; this ADR authorizes none.
- `person_dimension` shares W5. This ADR changes the Film path only; the Person path keeps today's behavior and is out of scope.

### 4. Readiness

The AIR-42 domain predicates (`src/domain/film-person.js:227-237`) read dimension statuses. This ADR **replaces** them for every D1 consumer with predicates over ADR 0216 sections; the in-memory domain predicates remain for the offline lifecycle reader and parity only, until that reader is retired.

- `displayReady`: identity verdict is resolved (not `retired`, `conflict`, `ambiguous` or `absent`), or the Film holds a verified `letterboxd_lid` claim; **and** a preferred title is `present` (effective localization, else original title). A title alone never proves display readiness. `unknown` when the identity section is `unavailable`.
- `catalogReady`: a stable id (verified lid, or a trusted non-conflicting TMDB claim under the verdict) **and** at least one of the core metadata fields `present`. Freshness is reported, not required.
- `predictionReady`: fingerprint `present` and compatible, **and** prediction `present` and compatible, per the prediction domain. `unknown` when either section is `unavailable` or `partial`.

Consumers: the ADR 0216 aggregate, admin diagnostics and parity. No route, producer planner or eligibility rule gates on readiness; prediction eligibility stays with the prediction domain ([ADR 0154](0154-prediction-eligibility-independent-of-epg.md)). Readiness never gates Film existence.

The AIR-42 transition rules that stay accepted: reviewed localization never becomes provisional; `applyAutomaticLocalization` cannot set reviewed; the `strong()` guard; profile changes make a prediction stale without invalidating the fingerprint (now a prediction-domain verdict). The rules this ADR retires for D1: the identity, metadata, fingerprint and prediction **status graphs** as stored state, since those statuses become derived.

### 5. Identity row (choice C)

Under C1 the row stays as the carrier of `titleSource` and of owner/reviewed protection. W1 creates a minimal identity row (`status` taken from the current verdict, `provenance_json={titleSource}`) on a ranked title write when none exists, in the same batch and under the same CAS, so `no_identity_row` no longer drops a rank. The row's `status` is never read for a decision.

### 6. Metadata lock (choice B)

Under B1 the row shape and the lock predicate are unchanged: `status='reviewed' OR authority='owner'` on `(film_id, 'metadata')`. Lock transitions are owned by the explicit review/owner paths of ADR 0214 decision 9 only; no producer, importer, merge or retirement creates, clears or rewrites a locked row. Consequences for every writer:

- **W1:** passes `dimensions.metadata` only for an owner path; producers keep ADR 0211 decision 1 (they do not pass it).
- **W2:** its delete predicate becomes `dimension IN (<dimensions it writes>) AND NOT (status='reviewed' OR authority='owner')`, and it never rewrites the `titleSource` key or a locked row (decision 7).
- **W4 merge:** unchanged refusal of differing rows; a lock on either side is kept on the survivor (ADR 0214 decision 11 inserts the release row for moved fields).
- **Retirement:** never deletes a row matching the lock predicate.

The ADR 0214 triggers are not live today; PV1 reads the same predicate when it lands, so PV1 needs no change. Under B2 the lock moves to its own table, which requires an owner-approved amendment of ADR 0214 decisions 5, 9 and 11 and a revised PV1 graph **before** any conflicting implementation; PVE is unaffected either way.

### 7. Writer, reader and retirement stages

1. **Offline parity reader.** For each Film: derived facts (decision 2) vs stored row, classified `agree`, `stale_copy`, `control` (kept), `unknown_legacy`. Parity compares derivation outputs with stored control columns only; it does not expect stale copies to equal current facts.
2. **W2 safe delete.** Change W2's delete and insert so it preserves control rows, locks and `titleSource`, and stops writing `fingerprint`/`prediction` rows and processing fields; move its offline readers and verify, and the export/import fixtures, in the same change. Old importer against new schema: refused by a contract version check, not silently run.
3. **D1 and C1 writers.** The localization recompute and the identity-row creation of decisions 3 and 5. These **write persistent data**: code rollback does not remove the rows they wrote (they are valid projections under the old code too, which reads the same columns).
4. **Reader switch.** Readiness consumers move to decision 4, behind the delivered ADR 0216 aggregate; prerequisites: stage 1 parity on fixtures and an offline copy, aggregate delivered.
5. **Retirement (L3).** Only rows classified `stale_copy` by stage 1 with a safe-delete predicate: `dimension IN ('fingerprint','prediction')` (A1), and `dimension='metadata' AND NOT lock` (B1), and never a row with an `owner`/`reviewed`/unknown `authority` or a `titleSource`. `unknown_legacy` rows are retained and reported. A pre-image export precedes the delete.

## Owner choices

Each choice is independent; the Coordinator presents them one ADR at a time under the [facilitation protocol](../process/agent-workflow.md#adr-decision-facilitation-protocol). Recommendations are the Executor's.

**A. Fingerprint and prediction rows.**
- **A1 (recommended):** stop writing them (stage 2), derive from the prediction domain, retire the `stale_copy` rows after parity (stage 5). Removes a silently diverging copy.
- A2: keep as a projection refreshed by the prediction writers. Adds writes to the prediction pipeline for no reader.
- A3: keep frozen and unread. No cost now; leaves a false source that a future reader may adopt.

**B. Metadata row.**
- **B1 (recommended):** keep the row only as the lock carrier (decision 6); derive coverage and freshness. ADR 0214 and PV1 unchanged.
- B2: dedicated lock table; retire the row. Requires an ADR 0214 amendment and a revised PV1 graph before PV1's triggers land.
- B3: keep as today.

**C. Identity row.**
- **C1 (recommended):** keep as `titleSource` and owner/reviewed carrier; create it on a ranked title write (decision 5).
- C2: move `titleSource` and the owner flag to `film` columns and retire the row; migrates every rank and `strong()`.

**D. Effective localization.**
- **D1 (recommended):** keep the persisted projection; recompute in the same batch with the existing resolver and a projection-aware receipt (decision 3); a separate bounded reconciliation for existing stale rows.
- D2: compute at read time from sources, reviewed rows and `owner_review_entry`. No projection to drift, but five readers change and the programme/watchlist title read (about 6.7k Films per request, 5 chunked statements) gains joins and per-Film resolution.

## Alternatives considered

- **Persist and refresh all five.** Every writer maintains rows no reader uses (F1–F3). Not recommended.
- **Derive all, delete `film_dimension`.** Loses applied reviewed/owner state, locks and `titleSource` (F6). B2 and C2 are its controlled forms.
- **Hybrid (recommended).**

## Examples

| Case | Today | After (recommended options) |
| --- | --- | --- |
| New Film, no dimension rows, metadata-sync writes a `tmdb` title source | effective row not written (F5); rank `no_identity_row` | projection written in the same batch (`provisional`, `tmdb`); identity row created with `titleSource` |
| Sources `letterboxd` (older) and `tmdb` (newer) disagree | resolver picks `letterboxd` | unchanged: `letterboxd` (fixed order first) |
| Owner title in `owner_review_entry`, later automatic source | reviewed/owner row kept | unchanged |
| Replay of a source write stored before the fix | receipt readback succeeds on source rows | readback finds projection missing, recompute runs |
| Legacy `fresh` metadata row, empty fields, no per-field provenance | row says `fresh` | fields `unknown` provenance; freshness `unknown`; lock state unchanged |
| Metadata lock and a producer write | not checked in code (ADR 0214 pending) | per ADR 0214 once PV1 lands: refused `owner_kept`; row untouched by W2, merge, retirement |
| Merge with a reviewed localization on the retired Film | refused | unchanged |
| Prediction producer failed, pointer present | dimension row may say `failed` (offline import) | prediction `present`; failure only in producer outcomes |
| Profile change, fingerprint unchanged | domain: prediction stale | prediction-domain compatibility verdict; fingerprint unaffected |
| No pointer on authorized ids, candidate coverage incomplete | — | `partial`, never `none` |
| No shows in the pinned generation | — | availability `none`; Film displayed if `displayReady` |
| Identity `retired`, title present | domain displayReady may be true | `displayReady` false; Film still exists |
| Offline import of a Film with a locked metadata row and `titleSource` | both deleted and rewritten | both preserved |

## Synthetic test plan

Real SQLite fixtures in `tests/`, one test per case, plus the cases above:

- Localization: cross-source disagreement (order vs time); owner and reviewed overlay; concurrent review between plan and write (CAS replan); stale `observed_at`; replay of a pre-fix source row; no-op; reconciliation of a stale projection with no new source and after an owner change; rollback of the code leaving projections readable by old readers.
- Identity: `no_identity_row` rank write; retired, conflict and ambiguous verdicts vs display readiness.
- Metadata: legacy fresh without fields; explicit null vs unknown; lock preserved through W2, merge and retirement predicates.
- Prediction/fingerprint: authorized aliases, held marker (`unavailable`), incomplete coverage (`partial`), known conflict.
- Import: old importer against new schema refused; new importer preserves control rows; parity classifications for every class; retirement predicate never matches a control or unknown row; pre-image export and fenced restore.
- Concurrency: merge and import racing a W1 write (revision CAS).

## Cost

Estimated from code, not measured in production:

- D1: at most one guarded upsert per source write that changes the effective value; zero on no-op. Reconciliation is capped per run.
- C1: at most one insert per Film, once.
- Derivation reuses ADR 0216 section reads; readiness adds no D1 statement.
- A1/stage 2: removes two inserts per Film from the offline importer.

D1 `rows_read`/`rows_written` are measured on fixtures by each implementation card as measurements, not GO/NO-GO thresholds.

## Compatibility with accepted ADRs and the PV graph

- **ADR 0214 / PV1 (AIR-631):** under B1 the lock row shape and predicate are unchanged and protected from W2, merge and retirement (decision 6); PV1 proceeds unchanged. B2 needs an amendment and revised PV1 graph first.
- **ADR 0211:** producers still do not pass `dimensions.metadata`; source precedence is reused unchanged.
- **ADR 0216:** all derivations reuse its sections, verdicts, tokens and negative proofs; no new authority.
- **ADR 0213/0215:** no evidence rule changes.
- **PVE (AIR-636):** unaffected; stays the prerequisite of AIR-614/615.
- No native prerequisite change under the recommended options.

## Delivery graph (no card is created by this ADR)

1. Parity reader and fixtures (offline, stage 1).
2. W2 safe delete and offline consumers (stage 2).
3. D1 localization recompute with projection-aware receipt; C1 identity row (stage 3). Persistent writes: normal code review, no production operation.
4. Localization reconciliation writer: code card, then a separate L2/L3 operation.
5. Readiness reader switch after the ADR 0216 aggregate is delivered (stage 4).
6. Retirement migration (stage 5, L3, owner GO, pre-image export).

## Rollback and fencing

- Stages 1, 2 and 4 are code-only and roll back by deploy.
- Stage 3 rows persist after a code rollback; they are valid under the old readers (same columns, same resolver), so no data rollback is needed. A reconciliation run is reversible from its dry-run report and receipts.
- Stage 5 restore re-inserts a pre-image row only when the `(film_id, dimension)` slot is still empty and the Film's revision has not moved past the export's revision; otherwise the restore reports the row and leaves the newer state. All writes keep the canonical marker, revision CAS and receipt fences.

## Out of scope

`person_dimension` (shares W5; its path is unchanged), production census or repair, any schema apply, backfill, flag, Task, TMDB or model call, authority switch, and any change to source precedence, identity or prediction rules.

## Consequences

Removes two silently diverging copies and the localization staleness gap, protects locks and `titleSource` from the offline import, and makes readiness one derived contract over ADR 0216. Costs: a parity stage, a projection-aware receipt, one reconciliation writer and a staged retirement.

## Evidence

- **Original decision:** pending.
- **Implementation:** none.
- **Dated verification:** code inventory at `main` `6123890`, revised at `961c045`, 2026-11-25; static analysis, no production reads.
- **Uncertainty:** production row contents (F5 impact, legacy `authority`/`status` values) not measured; whether any sealed document carries `dimensions`; `mergeFilms` has no caller today.
