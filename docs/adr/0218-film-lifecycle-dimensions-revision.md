# ADR 0218: Film lifecycle dimensions: persist only control state, derive facts and readiness from their authorities

**Status:** Proposed  
**Original decision date:** pending owner disposition  
**Recorded at:** 2026-11-25, from `main` `6123890`; revised after the [independent review](https://github.com/vladimino/iptv-watchlist/pull/997#issuecomment-7162637848) of `8b7cabf` against `main` `961c045`, and after the [second review](https://github.com/vladimino/iptv-watchlist/pull/997#issuecomment-7163011485) of `91284c9`  
**Approval source:** not yet decided. Owner selections A1, B1, C1, D1 recorded on 2026-11-25 ([handoff](https://github.com/vladimino/iptv-watchlist/pull/997#issuecomment-7164184360)); final disposition pending re-review  
**Related work:** [AIR-644](https://trello.com/c/nFBGvvnU). Builds on Accepted [ADR 0211](0211-catalog-enrichment-producer.md), [ADR 0213](0213-film-identity-evidence-ledger.md), [ADR 0214](0214-film-metadata-per-field-provenance.md), [ADR 0215](0215-identity-evidence-full-model.md) and [ADR 0216](0216-canonical-film-lifecycle-and-unified-read-contract.md). Coordinated with PV1 [AIR-631](https://trello.com/c/i8td3wu0) and PVE [AIR-636](https://trello.com/c/0jJADYxg).  
**Supersedes:** In part, the AIR-42 D1 status and readiness rules listed in [decision 4](#4-readiness) (the stored identity, metadata, fingerprint and prediction status graphs and the domain readiness predicates, for D1 consumers). It amends no other accepted ADR.  
**Superseded by:** None

## Context

AIR-42 defined five independent Film lifecycle dimensions (`identity`, `metadata`, `localization`, `fingerprint`, `prediction`) as a storage-neutral domain contract ([reference](../reference/domain/film-person.md#lifecycle-dimensions-and-transition-rules)). Schema v1 stored them as rows of `film_dimension` (`migrations/0001_schema_v1.sql:113`): one row per `(film_id, dimension)` with `status`, `source`, `source_version`, `provenance_json`, `value`, `authority`, `last_error`, `failure_reason`, `retry_at`, `attempts`, `next_action` and `updated_at`. `status` is free text. No migration after 0001 adds a trigger, index or CHECK on the table.

Since then each dimension's facts gained their own D1 authority: identity claims and redirects (`film_external_id`, `film_redirect`, retirement decisions, ADR 0213/0215), metadata values (`film_metadata`; per-field provenance `film_metadata_field` once ADR 0214 PV1 lands; `film_sync_state` holds historical sync clocks), automatic localization candidates (`film_localization_source`, migration 0014), fingerprints and predictions (the prediction domain: `prediction_fingerprint`, `prediction_pointer`, `prediction_lineage` and immutable R2 bodies, ADR 0216 §5; schema v1 `fingerprint_payload`, `prediction_current` and `prediction_history` are legacy copies, not authorities). This ADR inventories what the dimension rows still do in code, and decides which of them stay persisted, which are derived and how the transition is staged.

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
| identity verdict | identity read-set of §3 (claims, redirects, retirements, competing claims) | the full ADR 0216 verdict set (`found`, `redirected`, `absent`, `retired`, `conflict`, `unverified`, `cycle`, `unavailable`, not resolved); never "at least one trusted claim". Under the fatal identity fence a failed verdict yields no sections |
| metadata value per field | `film_metadata` values; provenance from `film_metadata_field` once PV1 lands | **Value presence and provenance confidence are separate.** A non-null value is `present` whatever its provenance; legacy and unattributed values stay readable (ADR 0214), with confidence `unattributed`. A null value is `absent` only when provenance records an explicit null, otherwise `unknown`. The core field set is ADR 0214's six core fields (`year`, `runtime`, `synopsis`, `poster`, `url`, `genres`) |
| metadata freshness | per-field provenance, anchor and value binding, owner pins (ADR 0214) | reported, never inferred from `film_sync_state` clocks alone. This ADR sets **no** freshness window: the periodic policy is ADR 0214's separate PVT decision; until it exists freshness is `unknown` unless ADR 0214 binding states it |
| effective localization | the existing resolver of decision 3 | unchanged precedence |
| fingerprint state | prediction domain `prediction_fingerprint`, fingerprint compatibility verdict | `present`/`absent` per the prediction domain; `unavailable` when its marker is held |
| prediction state | `prediction_pointer`, `prediction_lineage`, immutable R2 bodies; candidate coverage of ADR 0216 §6b (G1) | `none` only under ADR 0216's negative proof (no pointer on every authorized storage id **and** complete coverage); never from `prediction_current`; `partial`/`conflict` as §6b |
| availability | pinned published EPG generation | `none` only from the pinned generation (ADR 0216 §5); absence of optional data is never `none` |

### 3. Effective localization (choice D)

The effective localization row stays a projection of `owner_review_entry` (owner), the applied reviewed row (dictionary/owner) and `film_localization_source` (automatic). It is computed by the **existing** `resolveLocalization`, with its fixed source order, observation time and source-name tie break. No newest-wins rule is introduced. Under D1:

- **New writes, same batch.** A source write issued by new code recomputes the projection in the same D1 batch. The recompute uses the source rows as they will stand after the write, plus the stored reviewed and owner state, behind the existing `strong()` guard and SQL `WHERE`. The batch binds two fences:
  - the Film revision CAS;
  - the owner-review authority and content token of the `owner_review_entry` rows it consumed: marker generation plus the rows' content digest.

  `owner_review_entry` is an independent domain, so the Film CAS alone does not cover it. A change of either fence between plan and commit refuses the batch, and the operation replans. A lower tier never replaces a higher one.
- **New receipt kind.** The projection-aware write is a new operation kind with its own digest. The digest covers the source content and the resolver inputs. Its readback proves both the source rows and the projection: the effective row equals the resolver output on the rows read back.
- **Historical receipts stay terminal.** An existing `applied` source receipt is returned as-is (`src/canonical-receipts.js:578`) and skipped by reconciliation (:158). It is never replayed as a projection write under its request identity, and equal content never proves causality. An unsettled old receipt (`pending`, `failed`, `unknown`) keeps today's settlement rules and evidence, including its source-only readback. It settles as the old operation, not as a projection write.
- **No-op.** When the resolver output equals the stored row (`sameDimension`, ignoring `updated_at`), no projection statement is issued.
- **Stale.** An older `observed_at` loses, as it does today (monotonic upsert).
- **Existing stale projections are reconciled separately.** This covers historical applied receipts, Films with no new source write, and owner-only changes in `owner_review_entry`. A separately identified bounded reconciliation writer handles them, with:
  - its own fresh request ids and receipts;
  - the same two fences;
  - a per-run cap;
  - a dry-run report.

  Its rollback is a fenced pre-image restore: the writer stores the pre-image row and the exact post-write Film revision. Restore applies only while the Film is still at that revision, and the alternative is a forward correction through the same writer. The reconciler is a production write and needs its own L2 contract or L3 owner GO; this ADR authorizes none.
- **Person path unchanged.** `person_dimension` shares W5. This ADR changes the Film path only; the Person path keeps today's behavior and is out of scope.

### 4. Readiness

The AIR-42 domain predicates (`src/domain/film-person.js:227-237`) read dimension statuses. For every D1 consumer this ADR **supersedes** them with predicates over ADR 0216 sections. The in-memory domain predicates remain for the offline lifecycle reader and parity only, until that reader is retired.

Each predicate returns exactly one of `true`, `false`, `unknown` or `not_applicable`. The rules are evaluated **in order; the first match wins**, so the cases are exhaustive and mutually exclusive. `false` means the authoritative section proves the negative; `unknown` means it cannot; every non-`true` result carries a reason.

**Usable values.** A title is usable when it is a string that is non-empty after trimming. A core field (ADR 0214's six: `year`, `runtime`, `synopsis`, `poster`, `url`, `genres`) is usable when it is well-typed and not a default:
- `year` and `runtime` are positive integers;
- `synopsis`, `poster` and `url` are non-blank strings;
- `genres` is a non-empty array of non-blank strings.

An empty string, `0`, `[]`, an unparsable `genres_json` or a wrong type is **not usable**. It counts as `unknown`, never as `present` and never as proved absent. A field is proved absent only by an explicit-null provenance row (ADR 0214).

**Priority of positives over partial coverage.**
- For `displayReady` and `catalogReady`, a usable positive value wins over partial coverage, because another source cannot negate a present title or field.
- For `predictionReady`, it does not: an unseen candidate could hold a conflicting pointer (ADR 0216 §6b), so incomplete coverage keeps the result `unknown`.

Gate rules, applied first to every predicate:

| # | Condition | Result |
| --- | --- | --- |
| G1 | identity section `unavailable` | `unknown` (`identity_unavailable`) |
| G2 | verdict `absent`, `retired`, `conflict`, `unverified` or `cycle` | `not_applicable` (the verdict) |
| G3 | verdict `found` or `redirected` | continue |

A verified lid never bypasses the gate. A conflicting or retired request that carries a lid is `not_applicable`.

`displayReady`:

| # | Condition | Result |
| --- | --- | --- |
| D1 | a usable preferred title: effective localization, else `original_title` | `true` |
| D2 | display section `unavailable` | `unknown` (`display_unavailable`) |
| D3 | every title source is proved absent (no localization row or source row, and `original_title` explicitly null) | `false` (`no_title`) |
| D4 | otherwise | `unknown` (`title_unknown`) |

`catalogReady`:

| # | Condition | Result |
| --- | --- | --- |
| C1 | the verdict's survivor has no stable alias: no verified `letterboxd_lid` and no trusted non-conflicting `tmdb` movie claim (for example a `tmdb_tv`-only Film) | `false` (`no_stable_alias`) |
| C2 | at least one usable core field | `true` |
| C3 | display section `unavailable` | `unknown` (`display_unavailable`) |
| C4 | all six core fields proved absent | `false` (`no_core_metadata`) |
| C5 | otherwise (unknown, unusable or partially read fields) | `unknown` (`metadata_unknown`) |

`predictionReady`:

| # | Condition | Result |
| --- | --- | --- |
| P1 | predictions or fingerprint section `unavailable` (marker held, unreadable token) | `unknown` (`prediction_unavailable`) |
| P2 | a known conflict between authorized storage ids, whatever the coverage | `unknown` (`conflict`) |
| P3 | the prediction domain proves no fingerprint on every authorized storage id and coverage is complete | `false` (`fingerprint_absent`) |
| P4 | prediction `none` under ADR 0216's full negative proof | `false` (`prediction_absent`) |
| P5 | the fingerprint or the prediction is proved incompatible by the prediction-domain verdict | `false` (`incompatible`) |
| P6 | fingerprint and prediction present, both compatible, coverage complete | `true` |
| P7 | otherwise (compatibility unknown, coverage incomplete, section partial) | `unknown` (with that reason) |

Freshness and provenance confidence are reported beside readiness, never required by it.

Consumers: the ADR 0216 aggregate, admin diagnostics and parity. Diagnostics distinguish `unknown` from `not_applicable`. No route, producer planner or eligibility rule gates on readiness. Prediction eligibility stays with the prediction domain ([ADR 0154](0154-prediction-eligibility-independent-of-epg.md)). Readiness never gates Film existence, and nothing here changes identity authorization.

**AIR-42 rules that stay accepted:**

- reviewed localization never becomes provisional;
- `applyAutomaticLocalization` cannot set reviewed;
- the `strong()` guard;
- a profile change makes a prediction stale without invalidating the fingerprint (now a prediction-domain verdict).

**AIR-42 rules superseded for D1:**

- the identity, metadata, fingerprint and prediction status graphs as stored state;
- the readiness predicates `displayReady`, `catalogReady` and `predictionReady` (replaced by the table above);
- the 30-day metadata threshold as a readiness input. Freshness policy belongs to ADR 0214 PVT.

### 5. Identity row (choice C)

Under C1 the row stays as the carrier of `titleSource` and of owner/reviewed protection. On a ranked title write where no identity row exists, W1 creates a minimal one in the same batch and under the same CAS. That row has the current verdict as `status` and `provenance_json={titleSource}`, so `no_identity_row` no longer drops a rank.

Read rules for this row:

- `status='reviewed'` and `authority='owner'` stay control inputs of `strong()`.
- Every other `status` value is informational and is never read for a decision.

### 6. Metadata lock (choice B)

Under B1 the row shape and the lock predicate are unchanged: `status='reviewed' OR authority='owner'` on `(film_id, 'metadata')`.

**Lock ownership.** The explicit **review routes** create and clear a lock. ADR 0214 decision 9's metadata owner-command route never changes it ("the review routes own it"). The only other path that moves a lock is the authorized merge of ADR 0214 decision 9 (dormant `reconcile`, with the release row of decision 11), which this ADR keeps exactly. No producer, owner-command route, importer or retirement creates, clears, transfers or rewrites a locked row. This ADR changes no lock policy.

Consequences for every writer:

- **W1:** producers keep ADR 0211 decision 1 and do not pass `dimensions.metadata`. W1 refuses a `dimensions.metadata` input that would change a locked row unless it comes from a review route.
- **W2:** governed by decision 7.
- **W3 offline `retireFilm`:** it deletes the whole retired Film including its dimension rows. It is fenced: it refuses when the retired Film holds any control row (a lock, a `reviewed`/`owner` row, a `titleSource`) or an `unknown_legacy` row, until a review route has settled it.
- **W4 merge:** the ADR 0214 merge contract applies unchanged:
  - a lone retired lock (the survivor has no metadata row) moves to the survivor;
  - two different metadata rows need `resolve.metadataState`, else the merge refuses with `film_person_data_conflict`;
  - a merge with a pin or a lock on either side inserts the release row of ADR 0214 decision 11, and writes the history rows.

  A merge that does not follow that path refuses. `mergeFilms` has no caller, and no live merge is authorized here.
- **Stage-6 retirement:** it never deletes a row matching the lock predicate.

The ADR 0214 triggers are not live today. PV1 reads the same predicate when it lands, so PV1 needs no change. The W1 and W3 refusals above are coordinated with the PV1 card, so that the two do not implement the lock twice. This is coordination, not a new prerequisite of PV1. PVE is unaffected.

### 7. Writer, reader and retirement stages

1. **Offline parity reader.** For each Film, it compares the derived facts (decision 2) with the stored row and classifies the row as `agree`, `stale_copy`, `control` (kept) or `unknown_legacy`. Parity compares derivation outputs with stored control columns only; it does not expect stale copies to equal current facts.
2. **W2 safe import.** W2 today overwrites `film.original_title` and `film.canonical_identity` (`src/canonical-repository.js:165`) before it deletes and reinserts dimensions. The change:
   - writes the title and identity through the same guarded rule as W1: a `strong()` identity row keeps the stored values, and a ranked `titleSource` is respected, so a kept `titleSource` never ranks a value it did not bind;
   - deletes and rewrites only the `identity` and `metadata` rows it imports, and only when they are neither control nor `unknown_legacy`; it inserts only into empty slots or over such rows;
   - stops inserting `fingerprint`/`prediction` rows and processing fields, and **no longer deletes** `fingerprint`/`prediction` rows or any other retirement candidate: they stay untouched until the separately authorized stage 6;
   - moves its offline readers, verify and export/import fixtures in the same change.

   Before any mutation, W2 reads the target schema contract version and refuses when the importer predates it. An old importer is refused on the actual target, not trusted to check itself.
3. **D1 and C1 writers.** The localization recompute and the identity-row creation of decisions 3 and 5. These write persistent data: a code rollback does not remove the rows they wrote. The rows stay valid under the old code, which reads the same columns with the same resolver. Coordinated with the PV1 card for the W1 lock refusal.
4. **Reconciler code.** The bounded reconciliation writer of decision 3, delivered as code under normal review. Delivering the code runs nothing.
   - **Reconciliation operation (separate).** Running the reconciler against production is its own L2 contract or L3 owner-approved plan, with dry-run, cap and pre-image. It is not part of the code card.
5. **Reader switch.** Readiness consumers move to decision 4, behind the delivered ADR 0216 aggregate. Prerequisites: stage 1 parity on fixtures and on an offline copy, and the aggregate delivered.
6. **Retirement (L3).** It deletes only rows classified `stale_copy` by stage 1 that also match a safe-delete predicate:
   - `dimension IN ('fingerprint','prediction')` (A1);
   - `dimension='metadata'` and not locked (B1).

   It never deletes a row with an `owner`, `reviewed` or unknown `authority`, or a row carrying a `titleSource`. `unknown_legacy` rows are retained and reported. A pre-image export precedes the delete.

## Selected options

The Product Owner selected A1, B1, C1 and D1 on 25 November 2026, 14:42 Europe/Madrid, without qualifications, for reviewed HEAD `eae7cad` ([consolidated handoff](https://github.com/vladimino/iptv-watchlist/pull/997#issuecomment-7164184360)). These selections are recorded here. They are not yet the final ADR disposition, which follows the independent re-review of this revision. The design above is normative for them.

| Choice | Selected | Normative content | Not selected, and why |
| --- | --- | --- | --- |
| A. Fingerprint and prediction rows | **A1** | stop inserting them (stage 2, without deleting them); derive from the prediction domain (decision 2); retire only `stale_copy` rows proven safe by parity, in the separately authorized stage 6 | A2 (projection refreshed by prediction writers): writes on the prediction pipeline for no reader. A3 (keep frozen): leaves a false source a future reader may adopt |
| B. Metadata row | **B1** | the row stays only as the ADR 0214 lock carrier; predicate, review-route ownership and the decision 9/11 merge contract unchanged (decision 6); coverage and freshness derived | B2 (dedicated lock table): needs an ADR 0214 amendment and a revised PV1 graph. B3 (keep as today): leaves F3 |
| C. Identity row | **C1** | the row carries `titleSource` and owner/reviewed control; created on a ranked title write; other status informational (decision 5) | C2 (move to `film` columns): migrates every rank and `strong()` for no reader gain |
| D. Effective localization | **D1** | persisted projection recomputed in the same batch by the existing resolver, with a new projection-aware receipt kind and the owner-review fence; historical receipts terminal; separate bounded reconciler (decision 3) | D2 (compute on read): five readers change, and the programme/watchlist title read (about 6.7k Films, 5 chunked statements) gains per-Film resolution |

## Alternatives considered

- **Persist and refresh all five.** Every writer maintains rows no reader uses (F1–F3). Not selected.
- **Derive all, delete `film_dimension`.** Loses applied reviewed/owner state, locks and `titleSource` (F6). B2 and C2 are its controlled forms.
- **Hybrid.** Selected, through A1, B1, C1 and D1.

## Examples

| Case | Today | After (selected options) |
| --- | --- | --- |
| New Film, no dimension rows, metadata-sync writes a `tmdb` title source | effective row not written (F5); rank `no_identity_row` | projection written in the same batch (`provisional`, `tmdb`); identity row created with `titleSource` |
| Sources `letterboxd` (older) and `tmdb` (newer) disagree | resolver picks `letterboxd` | unchanged: `letterboxd` (fixed order first) |
| Owner title in `owner_review_entry`, later automatic source | reviewed/owner row kept | unchanged |
| Applied source receipt from before the fix, stale projection | — | receipt stays terminal; the bounded reconciler (own receipt, own GO) fixes the projection |
| Legacy `fresh` metadata row, values present, no per-field provenance | row says `fresh` | values `present` with confidence `unattributed`; freshness `unknown`; lock state unchanged |
| Metadata lock and a producer write | not checked in code (ADR 0214 pending) | per ADR 0214 once PV1 lands: refused `owner_kept`; row untouched by W1, W2, W3, merge, retirement |
| Merge with a reviewed localization on the retired Film | refused | unchanged |
| Prediction producer failed, pointer present | dimension row may say `failed` (offline import) | prediction `present`; failure only in producer outcomes |
| Profile change, fingerprint unchanged | domain: prediction stale | prediction-domain compatibility verdict; fingerprint unaffected |
| No pointer on authorized ids, candidate coverage incomplete | — | `partial`, never `none` |
| No shows in the pinned generation | — | availability `none`; Film displayed if `displayReady` |
| Identity `retired` or `conflict`, title and a verified lid present | domain displayReady may be true | readiness `not_applicable` (verdict reason); the Film still exists |
| Offline import of a Film with a locked metadata row and `titleSource` | both deleted and rewritten, title overwritten | rows and the ranked title preserved |

## Synthetic test plan

Real SQLite fixtures in `tests/`, one test per case, plus the cases above:

- Localization: cross-source disagreement (order vs time); owner and reviewed overlay; concurrent dictionary review and an owner-only `owner_review_entry` change between plan and commit (fence refuses, replan); stale `observed_at`; a historical applied source receipt stays terminal and is not replayed; an unsettled old receipt settles under the old rules; no-op; reconciliation of a stale projection with no new source and after an owner change, with pre-image restore against the post-write revision; code rollback leaving projections readable by old readers.
- Identity: `no_identity_row` rank write; every ADR 0216 verdict (`found`, `redirected`, `absent`, `retired`, `conflict`, `unverified`, `cycle`, `unavailable`) vs readiness, including a conflicting or retired request carrying a verified lid (not ready).
- Metadata: legacy fresh without fields; legacy unattributed value stays `present`; explicit null vs unknown; no freshness window applied; lock preserved through W1, W2, W3 and retirement; merge per ADR 0214: a lone retired lock moves with the release row and history, two different metadata rows without `resolve.metadataState` refuse, a merge outside that path refuses.
- Import: W2 keeps `original_title`/`canonical_identity` under a strong row and a ranked `titleSource`; preserves control and unknown legacy rows on delete and insert; refuses an old importer against the target contract before mutation; W3 refuses a Film with control or unknown rows.
- Readiness: one fixture per rule G1-G3, D1-D4, C1-C5 and P1-P7, asserting that exactly one rule matches. This includes a `tmdb_tv`-only Film (`no_stable_alias`), a proved-absent fingerprint, a held marker, unknown compatibility, incomplete coverage with a present prediction (`unknown`), and a known conflict plus incomplete coverage (`conflict`). Core-field usability: an empty string, `0`, `[]`, malformed `genres_json` and a wrong type are not usable; an explicit-null provenance row is proved absent.
- Stage 2: an import over a Film with `fingerprint`/`prediction` rows leaves them byte-identical.
- Retirement: parity classifications for every class; the predicate never matches a control or unknown row; restore against the recorded post-delete revision.
- Concurrency: merge and import racing a W1 write (revision CAS).

## Cost

Estimated from code, not measured in production:

- D1: at most one guarded upsert per source write that changes the effective value; zero on no-op. Reconciliation is capped per run.
- C1: at most one insert per Film, once.
- Derivation reuses ADR 0216 section reads; readiness adds no D1 statement.
- A1/stage 2: removes two inserts per Film from the offline importer.

D1 `rows_read`/`rows_written` are measured on fixtures by each implementation card as measurements, not GO/NO-GO thresholds.

## Compatibility with accepted ADRs and the PV graph

- **ADR 0214 / PV1 (AIR-631):** under B1 the lock row shape, predicate and review-route ownership are unchanged and protected from W1, W2, W3, merge and retirement (decision 6); PV1 proceeds unchanged, coordinated on the W1/W4 refusals. B2 needs an amendment and revised PV1 graph first.
- **AIR-42 contract:** superseded in part for D1 consumers (decision 4); the reference is updated at disposition.
- **ADR 0211:** producers still do not pass `dimensions.metadata`; source precedence is reused unchanged.
- **ADR 0216:** all derivations reuse its sections, verdicts, tokens and negative proofs; no new authority.
- **ADR 0213/0215:** no evidence rule changes.
- **PVE (AIR-636):** unaffected; stays the prerequisite of AIR-614/615.
- No native prerequisite change under the selected options: PV1 [AIR-631](https://trello.com/c/i8td3wu0) gets coordination, not a new architecture blocker; PVE [AIR-636](https://trello.com/c/0jJADYxg) stays the prerequisite of mass enrichment AIR-614/615; AIR-275 is unchanged.

## Delivery graph (no card is created by this ADR)

1. Parity reader and fixtures (offline, stage 1).
2. W2 safe import, W3 fence and offline consumers (stage 2).
3. D1 projection-aware writer with owner-review fence; C1 identity row; W1/W4 lock refusals coordinated with PV1 [AIR-631](https://trello.com/c/i8td3wu0) (stage 3). Persistent writes: normal code review, no production operation.
4. Localization reconciliation writer: code card, then a separate L2/L3 operation (stage 4).
5. Readiness reader switch after the ADR 0216 aggregate is delivered (stage 5).
6. Retirement migration (stage 6, L3, owner GO, pre-image export).

## Rollback and fencing

- Stages 1, 2 and 4 are code-only and roll back by deploy.
- Stage 3 rows persist after a code rollback; they are valid under the old readers (same columns, same resolver), so no data rollback is needed.
- Reconciliation (stage 4) is undone only by a fenced pre-image restore against the exact post-write revision it recorded, or by a forward correction; a dry-run report and receipts alone are not a pre-image.
- Retirement (stage 6) records the Film revision **after** its own delete (including its own revision bump). Restore re-inserts a pre-image row only when the `(film_id, dimension)` slot is empty and the Film is still at that recorded post-delete revision; otherwise it reports the row and leaves the newer state. All writes keep the canonical marker, revision CAS and receipt fences.

## Out of scope

`person_dimension` (shares W5; its path is unchanged), production census or repair, any schema apply, backfill, flag, Task, TMDB or model call, authority switch, and any change to source precedence, identity or prediction rules.

## Consequences

Removes two silently diverging copies and the localization staleness gap, protects locks and `titleSource` from the offline import, and makes readiness one derived contract over ADR 0216. Costs: a parity stage, a projection-aware receipt, one reconciliation writer and a staged retirement.

## Evidence

- **Original decision:** pending.
- **Implementation:** none.
- **Dated verification:** code inventory at `main` `6123890`, revised at `961c045` and against `main` `3b4db68` for the owner selections, 2026-11-25; static analysis, no production reads.
- **Uncertainty:** production row contents (F5 impact, legacy `authority`/`status` values) not measured; whether any sealed document carries `dimensions`; `mergeFilms` has no caller today.
