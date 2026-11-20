# ADR 0185: The EPG run checkpoint `sync.json` and the watchlist ingest status `watchlist-ingest.json` become one D1 authority, written only through fenced batches

**Status:** Proposed  
**Original decision date:** not decided (Proposed; owner acceptance pending)  
**Recorded at:** 2026-11-20  
**Approval source:** not documented. The storage strategy (migrate the EPG checkpoints to D1, keep archives and independent operational state in R2) is the owner disposition recorded on [AIR-275](https://trello.com/c/4x7hH0gI) on 2026-11-20; the design below is **not** accepted by that disposition and needs its own owner acceptance before any behavior change.  
**Related work:** [AIR-550](https://trello.com/c/xMTEtaLp) (this design, then a dormant implementation); [AIR-551](https://trello.com/c/YAVPlcAe) (separate controlled production cutover); [AIR-546 ledger](../evidence/d1-migration/air-546-mutable-r2-inventory-2026-11-20.md); [AIR-547](https://trello.com/c/99faXisC) (maintained-docs alignment); [ADR 0175](0175-epg-priority-holds-until-run-complete.md); [ADR 0100](0100-epg-cloudflare-workflow-executor.md); [ADR 0092](0092-resumable-bounded-ledger-seal.md); [ADR 0144](0144-epg-seal-successor-workflow-instance.md); [ADR 0145](0145-epg-seal-publication-only-staging.md); [ADR 0162](0162-d1-only-authority-retire-rollback-toolchain.md)  
**Supersedes:** None. If accepted, it **qualifies decision 4 of ADR 0175** (the cross-store ordering) for the `d1` checkpoint mode only; ADR 0175 stays Accepted for everything else and for the `r2` mode.  
**Superseded by:** None

## Context

Confirmed from code on `main` `6349e8d`; sizes and production behavior are **not** measured here.

1. `sync.json` is the working checkpoint of one EPG run: `runId`, `startedAt`, the frozen Madrid `runKey`, `stage` (`metadata`, `epg`, `seal`, `complete`), `seal.phase` (`ledger`, `catalog`, `publish`, `finalize`, `queue`) with its units and attempts, cursors, the whole `watchlist` array (one entry per film, mutated in place by the metadata step), `pending`, `failures`, `events`, the removal hand-over (`removalRefs`, `removalLookups`), the ratings attempt marker, `scanOutcome`, `error` and the completion receipt. `watchlist` and `pending` are deleted when the run completes. One R2 object holds exactly one run.
2. Every write is `saveJSON(env,'sync.json',run)`: an **unconditional** R2 PUT preceded by `epgStepGuard`, a separate D1 read of the mode revision and the step lease. The check and the write are not one transaction. Single flight comes from the step lease alone. A write after a lost lease is possible in the window between the guard and the PUT.
3. `beginSync` writes `sync.json` and then `watchlist-ingest.json` as two separate unconditional PUTs. A crash between them leaves a new run without its success mark. Its failure branch reads `sync.json` and `watchlist-ingest.json`, then replaces the ingest document. The ingest document (`{schemaVersion:1, failedAt, code, lastSuccessAt}`) has one writer and one diagnostic reader (the enrichment diagnostics snapshot).
4. Run creation is the only place where the run is replaced. A carried hand-over (`removalRefs`, `removalLookups`) and `ratingObservedAt` are copied from the previous run into the new one.
5. In `sealQueueStep` the order is: `queue` attempted, `prepareEpgCompletion`, `sync.json` saved with `stage=complete` (R2), then the certificate batch of ADR 0175 (mode-revision fence, in-batch step-lease fence, CAS on `published_epg_authority`, pause clear), then the event flushes, which may save `sync.json` again. A crash after the R2 save and before the certify batch is repaired by `EpgOrchestration.certifyComplete` on the hourly `ensure`.
5a. **There are two routes to `stage=complete`.** `sealQueueStep` (above) and the single-call route `completeWithRatings` → `finishSync` (reached on replay of an already committed run and on the unstaged commit path). `finishSync` saves `complete` first, then attempts the queue refresh, and **never calls the certificate batch**; such a run is certified only by the hourly `certifyComplete` repair. The order `queue attempted → complete → certificate` therefore holds today on the seal route only.
6. The staged seal payload and publication (`epg/seal/<run>/payload.json`, `publication.json`) are R2 staging objects of ADR 0145 and are not part of this decision.
7. The AIR-546 ledger classifies both objects as **migrate** (recommended, owner-accepted storage strategy): `sync.json` as the EPG working checkpoint co-located with D1 control and the publication certificate, `watchlist-ingest.json` together with it, preserving independent ingest-failure reporting.
8. D1 limits constrain the shape. The repository already stores large documents as chunked rows with a character budget (`prediction_queue`: 900,000 characters, each statement under 100 KB) and uses a fence row whose `CHECK` fails the batch when a compare-and-swap matched nothing (`*_cas`). The size of the `sync.json` object and of one `watchlist` entry was **not measured**; earlier evidence records the same gap ("object sizes were not measured"). The design must therefore not depend on a size and must refuse, not truncate, an over-budget document.

**Not established:** the production size of either object; whether the retired external `/api/sync/*` path obtains a step lease in every mode (Stage 2 confirms, see open question O1); how many D1 statements one metadata step may use before the Worker invocation budget matters (Stage 2 measures offline).

## Decision (proposed)

The owner is asked to accept or amend each numbered decision. Nothing here is active, and no schema is applied.

### 1. One domain, one marker

A new per-domain marker `epg_checkpoint_authority` (`id=1`, `mode` `r2`|`d1`, `generation`, `writes` `open`|`held`), the batch fence `epg_checkpoint_cas`, and the rows below, in a proposed migration `0030` (number reserved against `main` `6349e8d`; renumber at implementation if taken). The pattern is that of the other domain markers (`filter_preset_authority`, `started_authority`). While `mode` is `r2` (the inserted value) or the tables are absent, behavior is **exactly today's**: R2 objects, unconditional PUTs, `epgStepGuard`. The marker is the gate; **no new Cloudflare variable** is a production selector. Both objects move under the one marker: the ingest status is part of the checkpoint domain, not a second authority.

`generation` is an authority epoch: only import, activation, hold, release and an explicit rollback export change it. A runtime write never changes it and compares it.

### 2. Storage shape: envelope row plus per-film rows (recommended)

| Table | Holds |
| --- | --- |
| `epg_checkpoint_run` | Exactly one row (`id=1`): `run_id`, `run_key` (nullable like today's optional `runKey`), `started_at`, `stage`, `seal_phase` (non-null exactly while `stage='seal'`), `queue_attempted` (0 or 1, set only by `completeRun`), `completed_at` (null until complete, then immutable), `has_error`, `revision` (per-row compare-and-swap, strictly increasing across runs), `last_write_id`, `body_chunks`, `body_chars`, `body_sha256`, and the watchlist completeness fields `watchlist_present` (0 or 1), `film_count` (null when absent) and `film_list_sha256` (null when absent), `updated_at`. The typed columns repeat the few fields that fences and readers compare, so no predicate parses JSON. They are written from the same object in the same batch; a mismatch with the body is `checkpoint_malformed` and fails closed. |
| `epg_checkpoint_receipt` | One row per committed write of the current row: `write_id` (primary key, a uuid the writer generates), `run_id`, `revision`, `body_sha256`, `applied_at`. Inserted in the same batch as the write; rows older than the 16 newest revisions are deleted in the same batch. It is the write receipt that classifies an unknown outcome (decision 6). |
| `epg_checkpoint_body` | The run **without** `watchlist`, as ordered text chunks (`seq`, each statement at most 90,000 characters, the joined body at most 900,000). Replaced together with the run row. |
| `epg_checkpoint_film` | One row per `watchlist` entry: `(run_id, ordinal)` primary key, `film_id`, `body` (at most 90,000 characters), `body_sha256`. A save writes only the rows whose digest changed, so a 24-film metadata step writes at most 24 rows. |
| `epg_ingest_status` | One row (`id=1`): `schema_version` (1), `last_success_at`, `failed_at`, `code`, `consecutive_failures` (0 to 1000), `revision`, `updated_at`. |

The repository (`src/epg-checkpoint-d1.js`, Stage 2) exposes the **same object shapes** as today (`loadRun` returns the run with its `watchlist` array reassembled and verified against the digests; `readIngest` returns `{schemaVersion, failedAt, code, lastSuccessAt}` plus the optional counters). The call sites keep their form: the existing `loadJSON(env,'sync.json')` / `saveJSON(env,'sync.json',run)` façade routes the two keys, as `PredictionD1.saveMutable` and `DiscoveryAuthority.ownsKey` already do. A document over a budget is refused with `epg_checkpoint_budget` and changes nothing.

**Completeness of the watchlist.** The run row states what the film rows must be, and a reader never infers it from the rows it happens to find:

- `watchlist_present=1` with `film_count=N` and `film_list_sha256` = SHA-256 over the ordered tuples `(ordinal, film_id, body_sha256)`; `watchlist_present=0` (and null count and digest) means the run has **no** watchlist, which is not the same as an empty one (`film_count=0` with the digest of the empty list). This preserves the real distinction between `run.watchlist` deleted at completion and an empty array.
- `loadRun` reads the rows of the current `run_id`, requires ordinals `0..N-1` with no gap or duplicate, a distinct `film_id` per row, each row's digest, and the aggregate digest. A missing, extra, duplicated or reordered row is `checkpoint_malformed`; a snapshot is never silently shortened.
- A save recomputes the digest from the in-memory list (the writer holds the whole list) and stores it in the same batch as the changed rows, so the digest always describes the committed set.
- **Run creation verifies before exposing.** The writer first stages all rows, then **reads them back** and checks count, contiguity, row digests and the aggregate against its intended list. The switch batch then re-asserts in SQL what SQL can assert (`COUNT(*)`, `MIN(ordinal)=0`, `MAX(ordinal)=N-1`, `COUNT(DISTINCT film_id)=N` for the new `run_id`) so a row removed between readback and switch aborts the batch. SQL cannot hash, so the aggregate is verified by the readback and again on every read.
- **At completion the working set is removed with the transition.** The `completeRun` batch (decision 4) sets `watchlist_present=0` and deletes the run's film rows in the same transaction, matching `delete run.watchlist`. A completed run therefore never reassembles a watchlist, event recovery included, and does not retain the large live working set; rows found for a run with `watchlist_present=0` are `checkpoint_malformed`. Rows of any other `run_id` exist only as garbage of an interrupted creation and are deleted by the next creation batch.

Why per-film rows are not only an optimization: the watchlist array is the dominant and unmeasured part of the object, and a single-row D1 document is capped. Per-film rows bound both a row and a step's write set independently of the total size.

### 3. The fenced write

Every checkpoint save is **one D1 batch**, statements in this order; the first four abort the whole batch when they fail:

1. **Authority fence:** `mode='d1'`, `writes='open'`, `generation` equal to the one the request read.
2. **Step fence in the batch (new; today it is a separate read):** the EPG mode revision and the step lease (`holder`, `modeRevision`, not released, `expiresAt` beyond `now + BOUNDARY_MARGIN_MS`), the statement ADR 0175 already uses for the certificate. A save with **no** `env.epgStep` is refused (`epg_checkpoint_unfenced`); there is no mode-revision-only fallback.
3. **Run compare-and-swap:** `UPDATE epg_checkpoint_run … WHERE id=1 AND run_id=? AND revision=?`, followed by a statement that fails the batch when it matched no row. A stage or seal-phase **regression** within one run is refused (ranks of `STAGE_RANK` and `SEAL_RANK`); `completed_at` once set is never changed; `stage='complete'` is left only by a new run.
4. **Row-set guard:** every film row written names the current `run_id`.
5. Body chunk replace and the changed film rows.

The step guard before the write (`epgStepGuard`) stays as the early refusal that renews the lease; the in-batch fence is what closes the window. A refused batch writes nothing; the writer reads the row and decides, it never retries blind. The sequence of one metadata step is: read run, mutate at most 24 entries, one batch.

**Run creation (`beginSync`).** Every attempt gets an `attempt_id` (uuid) and an `attempt_started_at` taken from the Worker clock at entry, before the watchlist fetch. The film rows are first staged under the new `run_id` in bounded batches (at most 50 rows each) and verified as above; they are invisible because no run row names that id. The switch is **one** batch: fences 1 and 2, CAS on the **previous** `(run_id, revision)` (or on an empty row), the new run row with `revision = previous + 1`, its body and completeness fields, the **ingest success** (see below) and the deletion of the previous run's film rows. This removes the partial commit between the two objects. A crash before the switch leaves only unreferenced rows (garbage, cleaned by the next creation); a crash after leaves a complete run.

**Ingest status is ordered by attempt, not by completion time.** `epg_ingest_status` also keeps `success_attempt_id`, `success_attempt_started_at`, `failure_attempt_id` and `failure_attempt_started_at`. Attempts are totally ordered by `(attempt_started_at, attempt_id)` (the clock is the Worker's; two attempts in the same millisecond from different isolates are ordered by id, which is arbitrary but stable, and this is a diagnostic ordering, not a safety fence).

- **Success** is written in the run-creation batch and sets the success columns, `failed_at=null`, `code=null` and `consecutive_failures=0`. It applies only if its attempt is newer than the stored success attempt; the run CAS makes a stale creation fail anyway.
- **Failure** is one upsert guarded by fence 1 only, **not** by the step lease or the run revision, because a diagnostic about a failed fetch must survive a lost lease. It applies **only if its attempt is newer than both** the stored success attempt and the stored failure attempt. A losing old attempt that fails after a newer attempt has already succeeded (or already failed) is **superseded**: nothing is written and the event is logged as `superseded_failure`. An applied failure sets `failed_at` (the failure time, display only), `code`, the failure columns and increments `consecutive_failures` (cap 1000). Repeating the same `attempt_id` is a no-op.
- `last_success_at` is never lowered; the failure statement computes it as today's code does (the previous run's `updatedAt` when it is `complete` and `has_error=0`, else the stored value) and keeps the larger.
- An unknown outcome is read back: `failure_attempt_id` equal to mine is applied; a newer success or failure attempt is superseded; otherwise the identical statement is repeated (idempotent by `attempt_id`).
- While `writes='held'` the failure record is dropped and logged; no run executes in that window by the cutover procedure.

### 4. Stage machine, the single completion operation and the certificate (qualifies ADR 0175 decision 4 in `d1` mode)

```
create -> metadata -> epg -> seal(ledger -> catalog -> publish -> finalize -> queue) -> complete
```

`metadata` is skipped when nothing is pending; `catalog` is skipped on layout 2 (existing `sealLayout`). Only forward moves within a run; a failed unit stays in the same phase with its attempts (`SEAL_UNIT_ATTEMPTS`); `error` is a field on the same stage, not a stage.

**`completeRun` is the only way to `stage='complete'`.** In `d1` mode the repository's generic save refuses a transition into `complete` (a guard in the batch), and exposes one specialized operation, `completeRun(env, run, {queueAttempted, madridRunKey})`, that both completion routes call:

| Route | Today (`r2` mode, unchanged) | In `d1` mode |
| --- | --- | --- |
| `sealQueueStep` | `refresh` unit, `prepareEpgCompletion`, R2 complete save, `certifyCompletedRun`, event flushes | `refresh` unit, `prepareEpgCompletion`, `completeRun({queueAttempted:true})`, event flushes. The separate `certifyCompletedRun` call is **not made**: its `seal_certify` phase line and the `certificate` field of the step result come from the outcome of `completeRun`. |
| Single-call route `completeWithRatings` → `finishSync` | `persist*`, `prepareEpgCompletion`, R2 complete save, event flushes, then the queue refresh; **no certificate call** (repair only) | The queue refresh is attempted **before** completion, as on the seal route (its error is caught and recorded in `enrichmentQueueError` in the body saved with the completion), then `completeRun({queueAttempted:true})`, then the flushes. This reorders the route in `d1` mode only; `r2` mode keeps today's order. |

`completeRun` is one D1 batch:

1. fences 1 and 2 (the step-lease fence of ADR 0175 decision 4.2 is the same statement);
2. the run CAS to `stage='complete'` with `completed_at`, `queue_attempted=1`, `watchlist_present=0` and the deletion of the run's film rows;
3. the certify `UPDATE published_epg_authority … WHERE … programme_run_id=? AND madrid_run_key IS ? AND (finalized_run_id IS NULL OR finalized_run_id=?) AND EXISTS (SELECT 1 FROM epg_checkpoint_run WHERE run_id=? AND stage='complete' AND queue_attempted=1)`, **non-aborting**: if its condition does not hold the batch still commits the completion, exactly as today where a certify failure never stops the run;
4. the pause-row clear with the ADR 0135/0175 predicate (`finalized_run_id = programme_run_id`).

**Observable outcome.** After the batch `completeRun` reads back the certificate (`readCertificate`, as `certifyRun` does) and returns `certified`, `owed` (the row is complete but `finalized_run_id` differs: a pointer on another run, a missing or different Madrid day, a lost race), `absent` (no certificate column) or `skipped` (no pause table or no frozen day). `owed` is reported in the step result as `certificate: owed` and stays visible through the existing `ensure` `certificate` debt; it is derived from the readback, not stored.

**The order holds on every route, structurally.** A certificate for a run whose checkpoint is not `complete` with `queue_attempted=1` cannot exist: statement 3 requires both, the generic save cannot set either, and the repair unit uses the same statement. A route cannot certify before its queue attempt because the only operation that completes a run takes `queueAttempted` and certifies in the same batch; a run imported from a complete R2 checkpoint at activation is stored with `queue_attempted=1` by the import (the cutover plan completes at a day boundary, after the queue step). The event flushes stay **after** the batch and keep their own `owed` replay. The crash window "complete in R2, certificate owed" does not exist for runs completed in `d1` mode. `EpgOrchestration.certifyComplete` stays for runs completed before an activation and for an `owed` outcome; it reads the D1 checkpoint instead of `sync.json` when the marker is `d1`, requires `stage='complete'` and `queue_attempted=1`, still creates no Workflow and writes no `control`, checkpoint or receipt. In `r2` mode **nothing changes**: R2 first, certificate second, flushes last, as accepted in ADR 0175.

Post-complete saves (event-pending flags, removal hand-over cursors, the ratings attempt marker) are same-stage CAS saves at `complete`; they cannot change `stage`, `run_id`, `run_key`, `completed_at`, `queue_attempted` or the watchlist fields.

### 5. Readers and writers

All of these move to the repository behind the same façade in Stage 2, with no behavior change: **writers** `beginSync`, the metadata step, `epgSync` (EPG input and commit), `finishSync` and its persist tail, `stageSealedGeneration`, `sealLedgerStep`, `sealCatalogStep`, `sealPublishStep`, `sealFinalizeStep`, `sealQueueStep`, `sealCheckpoint`/`sealAdvance`, the ratings attempt marker, the removal hand-over flush, and the error recorders of the `/api/sync/*` handlers; **readers** `beginSync` (current run), the sync handlers (`drive`, archive fences, seal source), `epg-orchestration.js` (`drainState`, `act`/`drive`, `sealClaimPending`, `certifyComplete`, `readModel`, rollover preflight), `discovery.js` (completion clock, continuation status), `enrichment.js` (queue refresh, `showsAuthoritative`, `priorityOpen`, diagnostics, programme-updated time), `monitor.js` (`epgFacts`), `mcp.js` (`epg_sync_step`), and offline tooling (snapshot exporter baseline identity, production preflights). A GET or MCP read stays read-only; reads never repair.

### 6. Unknown outcome, stale writers, replay

- **Unknown outcome of a batch** (timeout, lost response) is classified from the write receipt, never from the latest snapshot alone. Every write carries its own `write_id`, inserted into `epg_checkpoint_receipt` in the same batch with its `revision` and body digest. Readback: a receipt for my `write_id` means **applied** (at that revision, even if later writes have advanced the row). No receipt and `revision = expected` means **not applied**. No receipt and `revision` advanced by at most 16 (every committed write left consecutive receipts, so mine would be in the retained window) means **not applied, superseded by a newer writer**. No receipt and `revision` advanced by more than 16, an unreadable receipt table or a gap in the receipt revisions means **indeterminate**. An advanced revision is never read as "not applied" on its own.
- **Indeterminate** is never answered by replaying the batch. The step stops with `epg_checkpoint_indeterminate` (class `evidence_unreadable`: unsafe, a domain quarantine for the owner, no budget spent as a failure of the source), the next action re-reads the durable state and derives what is still to do from it (units are idempotent), and an owner clears the quarantine as for other unsafe evidence. A repeat of the **identical** batch is allowed only after a classification of *not applied*; it is then idempotent by the CAS and the receipt.
- **Stale writer** (old Workflow instance, a step whose lease was taken, an older request): refused by fences 1 to 3; it learns `epg_checkpoint_conflict` and re-reads. A step of another run cannot match `run_id`.
- **Replay of a seal unit:** unchanged: units are idempotent and recorded in the envelope; the CAS makes a repeated save a no-op.
- **Old Worker version after activation** cannot be fenced by D1 because it does not know the table. Safety is by procedure (decision 7), not by a runtime check. The R2 `sync.json` is left frozen and untouched after activation; it is a rollback image, not a fallback and not read by new code in `d1` mode.
- **Unreadable or malformed state** (marker, run row, digest mismatch, chunk count mismatch): fail closed (`epg_checkpoint_unavailable`/`checkpoint_malformed`); never an R2 fallback in `d1` mode.

### 7. Cutover and rollback boundary (planned by this ADR, executed by AIR-551 under its own owner GO)

Order and holdpoints, each a separate owner decision: (a) deploy code that is dormant while the tables are absent or the marker is `r2`; (b) apply the migration (preflight, one apply, readback; the marker stays `r2`); (c) a read-only preflight proves the deployed version is the new code, no gradual rollout or older instance is live, the EPG Workflow instance runs the deployed version (the controlled rollover of ADR 0176 when it does not), no live step lease, and `sync.json` is **`complete`** for the current Madrid day so the import carries one small run with no `watchlist`; (d) hold writes, import, read back digest parity, switch `mode` to `d1` with `generation+1`, release. The import path supports every stage by design, but the plan cuts at a `complete` boundary, not mid-seal. Code rollback does not revert rows or the marker. **Data rollback** (separately approved, before any code revert): hold, export the current run and ingest status to the R2 objects with a conditional write against the frozen image's ETag, read back byte and digest parity, set the marker to `r2` with `generation+1`, release. No silent lease reset or force release exists on any path. The R2 arm stays in code only until AIR-551 retires it after acceptance; afterwards recovery is roll-forward in D1 (see the [D1 authority recovery runbook](../runbooks/recovery/d1-authority-and-time-travel.md)) per ADR 0162.

### 8. Local stand-in

An explicit local-only selector `EPG_CHECKPOINT_DB_OPTIONAL`, not configured in production, serves the R2 arm for development and tests when the domain tables are not installed at all, as the other domains do (ADR 0162). It is registered in the feature-flag reference at Stage 2. It is **not** a rollout flag, so no flag-removal card applies; if review prefers a temporary production selector instead, the flag lifecycle of the agent workflow starts with its removal card before implementation.

### Not decided

The migration apply, any import, the activation, the retirement of the R2 arm and every Cloudflare setting. Deployment, a green test run and this ADR authorize none of them.

## Alternatives considered

| Option | For | Against | Verdict |
| --- | --- | --- | --- |
| **A. One chunked JSON document** (like `prediction_queue`) | Smallest code change; same shape as an existing store | Every save rewrites the whole object, including the unmeasured `watchlist`; a document over the budget blocks the EPG run entirely | Rejected: no bound on write size independent of an unmeasured size |
| **B. Envelope plus per-film rows** (this ADR) | Bounded rows and write sets; memory no worse than today; same object shape for callers | More tables and a digest check; run creation stages rows before one switch batch | **Recommended** |
| **C. D1 control row, working set in immutable R2 blobs referenced by digest** | Small D1 footprint | Keeps a cross-store commit (blob then pointer) and orphan blobs, the partial-commit class the migration exists to remove | Rejected |
| **D. Keep R2, make the PUT conditional (ETag CAS)** plus a D1 fence | Smallest data move | The certificate and the checkpoint stay in two stores; the step fence cannot join the write; the crash window of ADR 0175 stays | Rejected; also contradicts the accepted AIR-546 direction |
| **E. Retain both objects as an accepted R2 exception** | No work | Keeps unconditional PUT and the check-then-write window beside an otherwise D1-owned EPG | Not chosen by the owner disposition |
| Certificate before the complete write | none | A certificate before completion is false (ADR 0175 rejects it) | Rejected |
| Completion and certificate as two D1 batches (as in `r2` mode) | Same code path as `r2` | Keeps a crash window that a single database no longer needs | Rejected for `d1` mode; `r2` mode unchanged |
| Ingest status outside the marker | Independent of checkpoint holds | Two markers, two cutovers, partial commit at run creation returns | Rejected |

## Consequences

- One transaction now covers fence, step lease, run state, certificate and pause clear in `d1` mode; the unfenced PUT and the guard-then-write window disappear for this domain.
- New complexity: one migration (five tables plus the marker and fence), a repository, a façade route for two keys, the digest check, a cleanup of unreferenced film rows, and a second mode (`r2`) kept until retirement.
- The in-batch step-lease fence makes a step that lost its lease fail even between its guard and its write; a slow D1 can therefore turn into more `epg_checkpoint_conflict` retries than today's silent overwrite. This is intended, and Stage 2 measures the statement and write budget of the metadata and seal steps offline.
- Ingest diagnostics gain `consecutiveFailures`, a bounded failure code and attempt ordering that drops a superseded failure; existing consumers ignore the new fields.
- The write receipt table adds one insert and one bounded delete to every save; Stage 2 measures this inside the statement budget.
- Compatibility: `sync.json` objects written by the current code import unchanged; fields unknown to the repository live in the body and survive a round trip.
- Risk that remains outside the design: an old Worker version or an instance not on the deployed version writing the frozen R2 object after activation. It is closed only by the holdpoints of decision 7.

## Recovery and migration boundary

Nothing is activated or applied by this record. The implementation (Stage 2, a separate PR after acceptance) delivers the migration file **not applied**, the repository and the dormant façade, and offline tests: restart and crash windows at each phase and between the two run-creation steps; replay of every seal unit; stale run, stale revision, stale authority generation and stale step lease; two concurrent writers; unknown outcome with readback; ingest failure and success including the monotonic guard; certificate ordering on both completion routes (a certificate never exists without a complete run with `queue_attempted`, completion with a non-matching certify still commits and reports `owed`, the single-call route attempts the queue before completion and the generic save cannot complete a run); watchlist completeness (missing row, extra row, duplicate, reorder, empty versus absent, deletion at completion, a row removed between readback and the creation switch); ingest ordering (a late failure of an old attempt after a newer success or failure is superseded, same-attempt repeat is a no-op); receipts (applied, not applied, superseded, indeterminate, no blind replay); `r2` mode byte-identical to today; unsupported authority refusal (`held`, wrong mode, missing tables); resource budgets (statements per step, rows per step, refusal on an over-budget body or film row). Applying the migration, activation, import, rollback and retirement of the R2 arm each need their own owner GO under AIR-551 and its plan; code rollback reverts none of the data.

## Evidence

- **Original decision:** not yet taken. Storage strategy: owner disposition on [AIR-275](https://trello.com/c/4x7hH0gI) (2026-11-20); this design: [AIR-550](https://trello.com/c/xMTEtaLp), stage 1.
- **Implementation:** none (Stage 2 after owner acceptance).
- **Dated verification:** code reading of `main` `6349e8d` on 2026-11-20 (`src/worker.js` `saveJSON`, `epgStepGuard`, `beginSync`, metadata step, `sealStep`, `sealPublishStep`, `sealFinalizeStep`, `sealQueueStep`, `certifyCompletedRun`; `src/epg-orchestration.js` `casDoc`, `acquireStep`, `assertStep`; `src/published-epg.js` `certifyRun`); the [AIR-546 ledger](../evidence/d1-migration/air-546-mutable-r2-inventory-2026-11-20.md). No production read was made for this design.
- **Uncertainty:** object and entry sizes; D1 statement budget per Worker invocation for the largest step; whether the external sync path holds a step lease (O1); the final migration number (O3).

### Open questions for review

- **O1.** Does `beginExternalStep` ever return an environment without `epgStep` while a checkpoint write follows? If yes, the contract "no step, no write" refuses that path in `d1` mode; Stage 2 confirms and documents it.
- **O2.** The caps (90,000 characters per statement, 900,000 per body) are borrowed from `prediction_queue`; a read-only size measurement before activation confirms or revises them.
- **O3.** Migration number and schema version are reserved against the current `main` and renumbered if another migration lands first.
- **O4.** In `d1` mode the single-call route attempts the queue refresh before completion (decision 4). This is the only behavior reorder the ADR proposes outside the storage move; the owner may instead ask to retire that route first, or to keep it certify-less (repair only), in which case the structural order rule would need a different guard.

## Follow-ups

[AIR-550](https://trello.com/c/xMTEtaLp) stage 2 (repository and dormant integration, after acceptance); [AIR-551](https://trello.com/c/YAVPlcAe) (controlled production cutover and retirement of the R2 arm); [AIR-547](https://trello.com/c/99faXisC) (maintained documentation alignment). Current status lives in Trello and GitHub.
