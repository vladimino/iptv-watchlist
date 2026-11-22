# ADR 0194: The batch_v2 auxiliary state (held stage, run sources, persisted manifest, event outbox) moves to D1 as one fenced cohort, built dormant behind its own authority marker

**Status:** Accepted (2026-11-22; [owner approval of 2026-11-22](https://github.com/vladimino/iptv-watchlist/pull/881#issuecomment-7075433159) following [independent design review at `607c6946`](https://github.com/vladimino/iptv-watchlist/pull/881#pullrequestreview-6010784233); authorizes dormant AIR-553 delivery, not AIR-554 production cutover)  
**Original decision date:** 2026-11-22 (prior storage disposition accepted on 2026-11-20 in [AIR-546](https://trello.com/c/1dRSJEbp))  
**Recorded at:** 2026-11-21, revised 2026-11-22  
**Approval source:** [AIR-546 evidence ledger](../evidence/d1-migration/air-546-mutable-r2-inventory-2026-11-20.md) and [AIR-275](https://trello.com/c/4x7hH0gI) storage disposition; [owner approval of 2026-11-22](https://github.com/vladimino/iptv-watchlist/pull/881#issuecomment-7075433159) of A / 2A / 3A / 4B and comparative performance acceptance after [independent design review at `607c6946`](https://github.com/vladimino/iptv-watchlist/pull/881#pullrequestreview-6010784233).  
**Related work:** [AIR-553](https://trello.com/c/ouMIBO00) (this design and the dormant implementation), [AIR-554](https://trello.com/c/UrS1gflv) (controlled cutover, separate owner L3 plan), [AIR-547](https://trello.com/c/99faXisC) (maintained docs); builds on [ADR 0122](0122-prediction-batch-runner-v2-dual-protocol.md), [0132](0132-prediction-assessment-artifact.md), [0136](0136-prediction-batch-manifest-size-and-spent-complete.md), [0146](0146-batch-v2-single-terminal-prediction-event.md), [0157](0157-batch-candidate-hold-and-honest-complete.md), [0162](0162-d1-only-authority-retire-rollback-toolchain.md), [0167](0167-retire-prediction-runner-v5.md), [0180](0180-skipped-predictions-start-is-a-neutral-event.md), [0188](0188-idempotent-keyed-batch-start-and-early-start-claim.md), [0189](0189-h0-checks-compatible-deployment-not-version-equality.md), [0190](0190-catalog-held-start-is-a-skipped-event.md) and [0193](0193-deferred-batch-start-with-server-issued-key.md) (its Proposed metadata is not touched here)  
**Supersedes:** None (no accepted decision is rewritten; this ADR only moves where the state lives)  
**Amended by:** [ADR 0196](0196-prediction-aux-admission-closed-state.md) (decision 1: the marker gains a pre-activation `closed` state; nothing else changes)  
**Superseded by:** None

## Context

Confirmed from `main` at `bfbc373` (21 Nov 2026), by reading `src/enrichment.js` and `src/prediction-d1.js`:

- The prediction profile, queue, runs, `latest-run` and the runner and writer leases are D1-owned (`prediction_*` tables, marker `prediction_domain_authority`, every write one fenced batch). Six families of the same batch_v2 flow are still R2 objects written by unconditional `saveJSON` or by an ETag compare-and-swap (`mergeStoredJSON`), and none is claimed by `PredictionD1.saveMutable` (`predictionMutableKey` knows only queue, profile, leases, run, latest, fingerprint and predictions):
  - `enrichment/batch-stage.json`: the transferable held results of earlier runs (read by the start, the drain, hold, submit and resume paths; changed by a merge-with-retry).
  - `enrichment/sources/<runId>.json`: the model input of each manifest film (`modelMetadata`), written at the start and rewritten by the hold and resume paths; read to rebuild a stop Event and to validate a submit.
  - `enrichment/batch-manifest/<runId>.json`: the exact start answer, written once at the end of `batchPersistRun`, served in parts to the live holder; for a deferred start it is the readiness boundary (ADR 0193 decision 7).
  - `enrichment/start-events/*`, `enrichment/stop-events/*` (including `skipped-<requestId>.json`) and `enrichment/event-outbox.json`: the delivery records of the Events journal and the index of failed deliveries.
- The AIR-546 ledger found that the manifest PUT is **not** create-only and not byte-checked, that the stage and the outbox index are split from the D1 lease that fences them, and that the outbox is mutable delivery state. Disposition accepted by the owner: migrate these to D1; large immutable content may stay in R2 behind a D1-owned reference.
- The existing D1 commit guard (`guardStatements` in `src/prediction-d1.js`) is one statement in each fenced batch: `UPDATE prediction_domain_cas SET ok=(SELECT count(*) FROM prediction_lease WHERE name='runner' AND expires_at>? AND runId=? AND epoch=? AND submitGate.token=?)`, with `ok` constrained to 1, so a stale lease, epoch or gate aborts the whole batch.
- `manifestHash` (`buildBatchManifest`) is a **semantic** hash of selected fields (profile hash, contract, per-film id, lane, plan, model metadata, fingerprint hash). It is not a digest of the persisted response (which also carries lease fields, extras and, after the drain, `drained` metadata), and it is part of the external contract.
- Bounds in the code today: manifest at most 100 films and 256 KiB (`BATCH_RUNNER.maxManifestBytes`; the 21 Nov `:30` manifest was 39,372 bytes, [evidence](../evidence/prediction/air-573-deferred-start-offline-2026-11-21.md)); one submit at most 10 items and 56 KiB; outbox drain 20 entries per authorized start, 3 journal attempts, quarantine after 8; one D1 statement is held to 100 KiB and 100 binds by `assertStatements` (UTF-8 and SQL literal bytes, `literalBytes`), and the queue splits text with the byte-aware `queuePieces` (40,000 characters is only its target, the byte check decides). **Not measured yet:** the size of a `sources` object for 100 films and of a full stage.
- `batch-start/<runId>.json` (terminal outcome) and `batch-start/attempt/<runId>.json` (the "instance exists" marker) are written only through `writeCreateOnly` (`onlyIf: etagDoesNotMatch '*'`).
- Retained and out of scope: the run diagnostics projection (`run-diagnostics/*`, `run-diagnostics-settle.json`); the Events journal (`events/items/*`); immutable prediction, fingerprint and profile version bodies; **the assessment sidecars of [ADR 0132](0132-prediction-assessment-artifact.md) under their prefix**, which keep their existing indefinite, history-linked retention and privacy contract.

Constraint carried from [AGENTS.md](../../AGENTS.md): the production default stays the current R2 path until a separate owner-approved activation (AIR-554); deploying code must need no new schema, create no second writer and enable no D1 live path.

## Decision (accepted; owner selection A / 2A / 3A / 4B)

### 1. One cohort, one marker, and what counts as "proved r2"

A new migration (number taken from the chain at implementation time; `0034` if nothing else claims it first) adds the marker `prediction_aux_authority` (one row, `mode` `r2`/`d1`, `generation`, `activated_at`), its fence table, and the data tables below. The marker is **separate** from `prediction_domain_authority`, so the dormant schema can be applied without touching the live prediction fence. One cohort: the four families flip together by one marker value; no per-family switch, no dual writer.

Reading the authority follows `readPredictionAuthority` and distinguishes four outcomes, never collapsing the last into the first:

- **Not installed (proved):** the schema contract was read successfully, its version is below the aux migration, or the contract was read and none of the aux tables exist while the version is below the aux migration. The Worker runs today's R2 code unchanged.
- **Explicit r2 (proved):** the contract version is at or above the aux migration, all aux tables are present and the marker row reads `r2`. The Worker runs today's R2 code.
- **d1:** marker `d1`: aux state is served only from D1.
- **Unavailable (fail closed):** a read error or an unanswering binding, a missing binding while `PREDICTION_DB_REQUIRED` is `on`, a partial table set, a version at or above the migration with tables or marker row missing, any marker value other than `r2`/`d1`. This is `prediction_aux_unavailable` (mapped like the existing `storage_error`), **never** r2: a transient error cannot prove r2.

Durable post-cutover evidence: the flip writes `mode='d1'`, `activated_at` and raises `generation`; triggers refuse an update of `mode` from `d1` to `r2` and refuse deleting the row (ADR 0162: a marker restored to `r2` after activation is refused, not read as the old objects; restoring a database to a pre-activation backup is an owner recovery operation, not a runtime path).

**A marker pre-read is not a cross-store fence.** An R2 PUT is not a D1 batch: a request that read `r2` before the flip can still land its R2 write after it, and a lease-free writer (skipped-event park, index entry, delivery and acknowledgement, an ordinary HTTP request) can be in flight with no runner lease and no non-terminal Workflow. D1 therefore cannot exclude old-authority writers by itself. The invariant this ADR states, and that the AIR-554 cutover contract must meet, is: before the marker flips, admission of **all** legacy auxiliary writers is closed (every writer of the four families, including skipped-event park/index/ack, event delivery and ordinary HTTP requests, not only the runner and the Workflow); the in-flight mutations of the old authority are drained or otherwise proven unable to land; the import and its verification run under that exclusion; only then does the marker flip; and the admitted writer afterwards is proven to be the new one. AIR-554 chooses the bounded procedure (this ADR prescribes no new control plane) and must test a **paused R2 write across the handover** (a write started before the close, completed after the flip, must not change the imported state or be acknowledged as delivered). The later retirement change removes the R2 writers from the code. Tests required for this ADR (offline): unavailable authority in each class above (binding error, partial tables, missing row, version at or above the migration without tables) fails closed on every aux read and write and never touches R2; the `d1`→`r2` update is refused; a D1 aux write whose request read an older generation fails its batch.

To avoid per-key redundant round trips the aux marker uses the existing request scope (`scopeRequest`, one read per request, dropped when the request's own database changes anything, and extended into the same one-batch authority read where the tables exist). A held read never authorizes a write by itself: every write batch asserts `mode='d1'` and the generation it read, so a stale read fails closed.

### 2. Guards that share the transaction

Every aux write is one D1 batch. The statements that guard it are in the **same** batch as the data statements (a failed guard aborts all of them); ownership is never checked only before an asynchronous write:

- **All writes:** the aux marker (`mode='d1'`, generation read).
- **Run-owned writes** differ by who legitimately owns the fence, and each class keeps today's behaviour; no class requires an expired predecessor to hold a live gate and none bypasses a fence:
  - *Normal live-run commits* (hold, submit, resume, stage drain under the run's own gate, sources, the stop row of the live run): the unchanged `COMMIT_GUARD` statement (runner lease unexpired, `runId`, `epoch`, `submitGate.token`), plus `protocol = batch_v2` of the lease document and the prediction domain marker (`mode='d1'`, writes authority) in the same batch.
  - *Keyless or synchronous preparation* (`batchPersistRun` without a claim, where a token exists only when the start is claimed): the fence is what the keyless path holds today, the current run's own lease (`runId`, `epoch`, unexpired) taken at acquisition, without inventing a gate token; the data statements are guarded by that lease check in the same batch. A claimed or deferred start uses the claim's token as above.
  - *Terminal, recovery and delivery mutations* (`recordRunStop`, `deliverPendingEvents`, finalizing an expired predecessor, delivering its outbox): the legitimate fence is the **current** writer, i.e. the current writer lease and the current run's lease/gate where one applies, plus a compare-and-swap on the **target's** own state or revision (the outbox row's `state`/`attempts`, the predecessor run row's status and `recoveredByRunId`), never a live gate of the expired target. Existing behaviour is preserved: a recovering run supersedes its predecessor's pending row, a finalization is idempotent, and the single terminal Event per run (ADR 0146) is unchanged.
  - *`startReady` (deferred start):* manifest rows and the readiness edit are one batch. The data statements are guarded by a check on the lease row that `runId`, `epoch`, the preparation gate token and the `prep` mark are present and unexpired; the last statement is the lease edit that removes gate and `prep`. A **legitimate client heartbeat** is not a lost lease: the guard accepts a row whose `heartbeatAt`, `clientAckAt`, acknowledged expiry and renewed `expiresAt` were advanced by a heartbeat (it checks identity, epoch, token and `prep`, not a frozen copy of the row), and the readiness edit preserves `clientAckAt` and the acknowledged expiry exactly as `startReady` does today (the short expiry is kept unless the client already renewed). Only a changed `runId`, `epoch`, gate token or a cleared `prep` (a takeover, a stale instance) aborts it, and then neither manifest nor readiness lands and the stale instance cannot release another lease.
  - Required offline tests: keyless start, claimed start, recovery of an expired predecessor under the current writer, delivery of a predecessor's outbox, terminal Event of a recovered run, and readiness racing a heartbeat (acknowledgement and expiry preserved).
- **Stage settlement (drain):** the deletion of a staged row is in the same batch as the film's prediction commit that settles it, under the drain gate's `COMMIT_GUARD` token, and matches `film_id` + `batch_item_digest` + `held_by_run_id`; a stale drop (profile or contract drift) deletes the row conditionally on the same digest.
- **Skipped-event admission (no lease):** only the aux marker (see 7).

### 3. Held stage (`prediction_batch_stage`)

Transferable, not run-scoped (not tied to a run); one row per held film (`film_id` primary key, `origin` provenance, `batch_item_digest`, `film_input_hash`, `held_by_run_id`, `held_at`, item body) and a **single head row** (`item_count`, `total_bytes`, `revision`) that carries the aggregate cap exactly as the current serialized stage has it: at most 10 items and the same aggregate serialized byte cap as today's stage document (56 KiB; the exact measure, the serialized size of the equivalent `items` array, is fixed at implementation from the code that enforces it now), **not** 10 rows each allowed 56 KiB. Insert/replace/delete change the rows and the head in one batch guarded by `UPDATE head … WHERE revision=?`; a CHECK on the head (`item_count BETWEEN 0 AND 10`, `total_bytes` between 0 and the cap) aborts an over-budget batch, so the count and total are enforced atomically and two concurrent inserts cannot both fit. A concurrent loser re-reads and retries (as `mergeStoredJSON` does). Same film and equal digest is a no-op; a different digest is `hold_conflict`; conditional deletion by `film_id` + digest. Required tests: exact boundary (cap and cap+1 byte, 10 and 11 items), concurrent insertion, digest replay, conditional delete. The drain commits the stored item through the existing submit path: no model work is repeated.

### 4. Sources: immutable revisions, CAS-advanced head

`prediction_run_source_revision(run_id, revision, source_hash, bytes, piece_count)` and `prediction_run_source_piece(run_id, revision, piece_no, text)` are **insert-only**: a rewrite by hold or resume inserts revision N+1 and **never updates or deletes** an earlier revision, so every historical model input stays readable. `prediction_run_source_head(run_id PRIMARY KEY, current_revision, source_hash)` is advanced by `UPDATE … WHERE current_revision=?` in the **same** batch as the new revision, its pieces and the run document's `sourceRevision`/`sourceHash` binding (the run is a D1 row, so the binding is atomic). A revision may add films or repeat equal entries; a changed entry for an existing film is `source_conflict`. Pieces come from the existing byte-aware splitting (`queuePieces` with `literalBytes` + statement overhead against `PREDICTION_STATEMENT_BYTES` and `assertStatements`), never from a character count alone. Readback is by primary key (head, then the pieces of one revision), bounded and indexed, never a scan of other runs.

### 5. Manifest: create-only, exact digest, bounded parts

`prediction_run_manifest(run_id PRIMARY KEY, manifest_hash, payload_digest, selected_ids, drained_json, bytes, piece_count, part_index)` plus insert-only pieces. `manifestHash` stays **unchanged** (the external, semantic hash). Two integrity levels, not one:
- **Whole payload (write, replay, import):** an internal `payload_digest`, the SHA-256 of the exact serialized persisted response (including `drained` metadata). A second write for the run id with the same digest is a no-op; a different one is `manifest_conflict` (never an overwrite). The importer and replay verify this digest over the whole body.
- **Partial readback:** a digest of the whole body cannot be checked from a byte range, so `part_index` records, bound to the immutable manifest row, a **digest per covering piece** (and per part: envelope, profile, contract, one film); a part read fetches only its covering pieces of one run and verifies each piece digest and the part's range. Only if measurement shows per-piece digests are not worth their cost may a bounded whole-body verification be used instead, and then its cost is measured and recorded, not assumed.
- **Live `hold` and `item` reads** stay what `ownedBatchManifestPart` does today: they come from the **transferable stage** (current state), not from frozen offsets in the manifest.
- **Selection identity:** the manifest's film ids are the **new work** of the run; `run.selectedIds` is mutable and can include committed drained held ids. The reader compares the manifest to the immutable selection and `drained` identity recorded with it (`manifest_hash`, `selected_ids`, `drained_json`, run id and epoch), never to equality with the mutable `run.selectedIds`.
- A missing, short, or mismatching row or piece is `manifest_unavailable` (fail closed, ADR 0193 decision 6). Written together with the readiness edit as in decision 2.
- Required offline tests: partial corruption (one piece altered; the other parts still verify, the altered one fails closed) and a readback after a held drain (drained ids in `run.selectedIds`, live `hold`/`item` from the stage).

### 6. Event outbox (`prediction_event_outbox`)

One row per delivery record, key `kind:identity` (`stop:<runId>`, `start:<runId>` for import of legacy rows only, `skipped:<requestId>`), holding the event JSON, the deterministic event id, the original `at` (which fixes the journal key), `state` (`pending`, `delivered`, `superseded`, `quarantined`), `attempts`, `since`, `last_attempt_at`, `settled_at`, `payload_digest`, `payload_compacted`. It replaces the three R2 shapes (record, index entry, parked skipped record). The Events journal stays R2 (`events/items/*`, key from event id and `at`, idempotent rewrite); `delivered` is set only after the journal write is proven (write returned, or a `head` of the journal key); an unknown outcome keeps the row `pending`; replay is safe; `superseded` is set by a recovering run as today. Drain keeps its contract: the latest run's rows first, then `WHERE state='pending'` oldest-first by an index on `(state, since, event_key)`, at most 20 per authorized start, 3 journal attempts per delivery, quarantine at 8 attempts, quarantined rows are counted and visible in status but never take a slot, no history listing, GET/status/manifest stay pure reads. Batch_v2 keeps exactly one terminal Event per run (ADR 0146); the stop row is created inside the fenced batch that finalizes the run, or reconstructed by the existing drain step as an insert-or-ignore (so it can never recreate a compacted identity). No new start Event is created.

### 7. Skipped events from a request without the lease; cap

A request that the runner lease turns away (`already_running`) or that the catalog gate refuses (`catalog_held`, ADR 0190) does not own the lease and must not touch it. Its registration is `INSERT … ON CONFLICT(event_key) DO NOTHING`, guarded by the aux marker only. It changes no lease, run, queue or film.

- **Identity and replay:** the key is `skipped:<requestId>`; the first insert fixes `at` (and with the event id the journal key). A replay of an existing key is a no-op that returns the stored `at`, **also at capacity and also after compaction** (a conflict never reaches the cap check).
- **Cap:** at most **256 active pending** skipped records. Quarantined skipped records, settled ones and all run-bound terminal events are **not** counted and never refused. Counting is race-safe and does not scan: a counter row (`kind='skipped'`, `active_pending`) with a CHECK `<= 256` is moved by triggers on insert of a pending skipped row and on its transition out of `pending`; a new row beyond the cap aborts that insert (the conflicting-key no-op fires no trigger), so two concurrent admissions near the cap cannot both pass.
- **Refusals:** a cap refusal is recorded in a bounded diagnostic row (count, last time) exposed by the status read; the original `already_running`/`catalog_held` response is unchanged, and the immediate best-effort journal delivery of an admitted record stays as today. A journal or D1 failure never changes the refusal answer.
- The whole outbox is **not** described as storage-bounded: settled identities and quarantined rows accumulate (see 8).

### 8. Retention (decision 2A) and cleanup

- **Sources and manifests:** every historical source revision and exact manifest is retained **indefinitely** in D1, including imported history. There is no newest-N deletion and no automatic archive or compaction of model inputs. Growth is measured; any archive mechanism needs new evidence and a new decision.
- **Held stage:** transferable until processed or stale-dropped.
- **Outbox:** pending and quarantined rows keep their payload until resolved. A settled (`delivered` or `superseded`) row's payload may be compacted **14 days after `settled_at`** (the settlement time, not creation), and only after the journal write is durably confirmed where one applies. Compaction keeps indefinitely the minimal identity: key, event id, original `at` and journal key, terminal state, `settled_at`, `payload_digest`, `attempts`, replay/conflict information. A compacted record is **never reconstructed or re-enqueued**. Cleanup is indexed and bounded: `WHERE state IN ('delivered','superseded') AND payload_compacted=0 AND settled_at<? ORDER BY settled_at LIMIT 20` (an index on those columns), run inside the drain.
- Prediction versions, ADR 0132 assessment sidecars (out of scope here) and the R2 Events journal keep their existing contracts.

### 9. Deferred-start receipts stay in R2 (decision 3A)

`batch-start/<runId>.json` and `batch-start/attempt/<runId>.json` are one-shot, create-only, never overwritten, and decide the typed terminal outcome precedence of ADR 0193 (`start_refused`/`start_failed` first, whatever the lease is doing), not just "instance exists". ADR 0193 semantics are unchanged. Readiness, preparation mark, gate and manifest are D1 after this ADR; a receipt cannot make a run ready or unready. Workflow instance state is not migrated.

### 10. Dormant means observable only

The deployed code carries the D1 adapters and branches behind the marker; with the marker `r2` or no tables they are unreachable. A bounded offline importer and dry run (reads the R2 families, builds rows and a per-family count/digest report, writes nothing unless an explicit owner-only apply, which AIR-553 never performs) feeds the AIR-554 cutover plan: quiesce, import history, verify, flip, retire the R2 writers in a later change. Code rollback is not state rollback; after the flip the R2 objects are a frozen pre-flip copy, not a fallback.

## Performance acceptance and evidence plan (a delivery requirement)

Source: the design review of PR #881 (owner selection). Atomicity and fewer cross-store operations are design reasons for A; they are **not** claimed to make execution faster. Acceptance requires measurement.

**AIR-553 (with the dormant implementation):**
- Compare the existing R2 auxiliary path (baseline) with the D1 candidate **on the same revision**, equivalent seeded queue, profile and catalog, for the S5, S7 and S10 workloads, in normal and in recovery/held/outbox cases; maximum-size inputs separately for resource limits.
- Repeated paired runs; document the reproducible workload, sample sizes, raw counts and p50/p95 where meaningful.
- Measure the complete storage/Worker cycle, not only repository microbenchmarks: receipt latency; deferred accept-to-ready/preparation latency with its stage breakdown (especially persist); bounded manifest part readback; hold, submit, complete; event delivery. Record R2 operations, D1 calls and batches, rows read/written and bytes, and the estimated total storage cost per successful prediction.
- Use and extend the existing `prediction_step_timing` (AIR-438/AIR-471) without added storage calls or payload logging; instrument the steps and the Workflow preparation that are not covered yet.
- Measure historical-table growth and representative aged databases so the hot path stays indexed and bounded.
- Separate deterministic operation/statement budgets (core tests: calls, batches, statement and bind bytes, no unbounded scan) from wall-clock measurements (non-functional evidence; no latency assertion on the CI runner). Local SQLite timings are not Cloudflare latency.
- Evidence ships with the dormant implementation. A material regression is optimized; if the architecture itself causes it, return to this design choice (alternative B) rather than accept it or raise the claim TTL. No new arbitrary millisecond threshold; the 180 s claim/ready TTL is not changed to hide cost.

**AIR-554 (at the cutover, under its own owner plan):**
- Capture a comparable natural production baseline before the approved cutover; after it compare normal existing Task runs with the same prompt, model and batch configuration; keep incident, EPG, catalog-hold and recovery cohorts separate and report confounders, sample counts, successful films per hour, completed/interrupted/skipped ratios, stage latency p50/p95 and storage cost per successful prediction.
- Assess preparation headroom against the 180 s claim TTL. No new Tasks and no manual model runs. A material regression blocks final performance acceptance (investigate, optimize, or revisit the architecture with the owner). No production acceptance claim comes from offline results.

## Alternatives considered

- **A. All four families inline in D1 (accepted owner selection).** For: one store, so marker, lease/epoch/gate guard and readiness commit **atomically**; no unknown-PUT outcome, orphan blob or pointer/body disagreement; the crash matrix collapses to "the batch happened or it did not". Against: unbounded historical growth under 2A (indexed, measured, not archived); a 256 KiB body is up to several byte-capped pieces per write; speed is unproven until the plan above is run.
- **B. D1 pointer plus immutable content-addressed R2 body for sources and manifest; D1 payload for stage and outbox.** For: no D1 growth for the large bodies. Against: reintroduces the cross-store window (payload then pointer, unknown PUT outcome, orphans needing a sweep, a pointer committed over an unreadable body); readiness stops being atomic; `sources` is rewritten by hold/resume, so each revision would be a new blob; R2 stays on the critical path of the 180 s preparation. It is the fallback if A shows a material regression the architecture causes.
- **C. Leave manifest and sources in R2 with a create-only PUT and a digest check; move only stage and outbox.** Contradicts the accepted AIR-546 disposition and leaves a split authority for the run. Rejected.
- **D. Aux tables under the existing `prediction_domain_authority` marker.** The dormant schema could not be applied without touching the live prediction fence. Rejected.
- **E. Per-family markers.** The families share the lease fence and the event identity; splitting recreates split authority. Rejected.
- **F. Newest-48 retention of sources/manifests (the first revision of this ADR).** Rejected by the owner (2A): model inputs and exact manifests are history to keep.

## Consequences

- No behaviour change for the Tasks, the API/MCP contract (including `manifestHash`), sizes, scores, retry counters, queue settlement, Events/status UX or the scheduler; the model, prompt, batch sizes, heartbeat and TTL are untouched.
- D1 grows without a ceiling from sources, manifests and settled outbox identities; only the outbox payloads of settled records are compacted. Hot paths stay primary-key or indexed and bounded; growth and aged-database behaviour are measured, and any archive is a later decision with evidence.
- A start's D1 work changes (stage, manifest and source batches replace R2 puts); whether the whole cycle is faster, equal or slower is **not known** and is decided by the paired measurements above, not assumed from atomicity.
- Deploying the dormant code requires no schema, creates no second writer and no new binding. Applying the migration is a separate owner GO (as 0024 → AIR-478); the cutover is AIR-554.
- Reads that need aux state (manifest part readback, status, skipped-event counts) stay pure reads and are added to the [read side-effect baseline](../reference/api/read-side-effects.md) check.

## Recovery and migration boundary

Reversible: the whole change until the migration is applied and the marker is flipped (code revert). Irreversible without a new owner-approved operation: the marker flip and the retirement of the R2 writers. This ADR authorizes no migration apply, import, flag, binding, Task change, manual batch, lease reset, workflow run or deletion. In-flight state at cutover (live runner lease, deferred instance in `preparing`, pending outbox rows, held stage) is a precondition list of the AIR-554 plan. Old R2 writers are excluded by that procedure (decision 1), not by D1.

## Evidence

- **Original decision:** AIR-546 disposition ([ledger](../evidence/d1-migration/air-546-mutable-r2-inventory-2026-11-20.md)); final decision: [owner approval of 2026-11-22](https://github.com/vladimino/iptv-watchlist/pull/881#issuecomment-7075433159), following [independent design review at `607c6946`](https://github.com/vladimino/iptv-watchlist/pull/881#pullrequestreview-6010784233).
- **Implementation:** none; this ADR precedes it.
- **Dated verification:** code read of `main` at `bfbc373` on 2026-11-21; no production read or write was made; no measurement was taken. Offline numbers quoted from the AIR-573 evidence note.
- **Uncertainty:** sizes of sources and of a full stage; D1 rows written and latency per cycle; growth under 2A; behaviour of the lease guard for a late runner after the flip. All are closed by the plan above, not by this ADR.

## Final owner decision (2026-11-22)

1. Storage shape: **A**. 2. Retention: **2A** as in decision 8. 3. Deferred-start receipts: **3A**, stay in R2. 4. Skipped-event cap: **4B**, 256 active pending. The owner accepts the ADR and authorizes merge of PR #881 after the required checks and dormant implementation of AIR-553. Production cutover, migration apply, import and other production mutations remain outside this authorization.

## Follow-ups

- Dormant schema, repositories, adapters, importer/dry run, tests, measurements and docs: [AIR-553](https://trello.com/c/ouMIBO00) after acceptance of this ADR.
- Controlled cutover, baseline and post-cutover comparison, retirement of the R2 writers: [AIR-554](https://trello.com/c/UrS1gflv), its own owner L3 plan.
- Maintained documentation reconciliation: [AIR-547](https://trello.com/c/99faXisC).
