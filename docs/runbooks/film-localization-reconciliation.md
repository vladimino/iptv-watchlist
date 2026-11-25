# Film localization reconciliation: the bounded reconciler (code) and its operation contract

Stage 4 of [ADR 0218](../adr/0218-film-lifecycle-dimensions-revision.md) decision 3 ([AIR-663](https://trello.com/c/UP10l6Js), code only). The production operation that runs it is a separate card ([AIR-664](https://trello.com/c/Og9XxXfy)) and needs its own operation-specific owner GO (an L2 contract or an L3 plan). **Delivering this code runs nothing and authorizes nothing.**

## What it does

A Film's effective `localization` row (`film_dimension`) is a stored projection of `owner_review_entry`, the applied reviewed row and `film_localization_source`. [AIR-662](https://trello.com/c/P8cCPv1V) keeps it current for every new source write. The reconciler fixes the rows that are stale **without a new source observation**: a Film written before the projection-aware writer (a historical applied source receipt), a source row with no effective row, a legacy provisional row that is no longer the resolver output, and an owner-only change (a decision removed or changed after the row was materialized). It writes the output of the existing `resolveLocalization`, never a new precedence: owner, then reviewed, then automatic (fixed source order, then the newer observation, then the source name), behind the `strong()` guard and its SQL `WHERE`.

| Part | Path | Role |
| --- | --- | --- |
| Reconciler | `src/film-localization-reconciler.js` | `dryRunLocalizationReconcile`, `applyLocalizationReconcile`, `recoverLocalizationReconcile`, `resumeLocalizationReconcile`, `restoreLocalizationReconcile`, the pure `planLocalizationReconcile`, the fenced writers and the registry spec |
| Shared logic | `src/film-localization-projection.js` | `projectionOf`, `legacyCandidate`, `PROJECTION_UPSERT`, `readOwnerReviewToken`, `ownerTokenStatements` (one implementation, exported, not copied) |
| Tests | `tests/film-localization-reconciler.mjs` | real SQLite fixtures built from every migration |

Nothing imports the module outside the tests: no Worker entry, route, MCP tool, Workflow, cron tick, script or workflow file, and the build does not bundle it (asserted by the test). No flag, Scheduled Task, migration, table, index or column exists for it.

## Contract

- **Dry run is read only.** It opens no receipt, no batch and bumps no revision. It reports `examined`, `cursor`, `hasMore`, the `stale` Films with their pre-image row, the intended post-write row and the effective value, the `held` Films with a reason, `noop`, `absent` (a redirect or a missing Film), `unavailable` (with the error code) and `wouldWrite`. **A dry-run entry is a report, not a pre-image.**
- **Bounded, by raw Film ids.** A run reads one keyset page of raw Film ids (`id > after ORDER BY id LIMIT n`) and classifies each Film with the ancestry-aware reader, so the scan is bounded by the examined limit whatever the candidates are, and an owner value reachable only through a merged ancestor is found. At most 50 Films examined (default 20) and at most 25 written (default 10) per run; a larger or non-integer value is `film_person_invalid`. `hasMore` and `cursor` (the last examined id) continue the page. Each written Film is ONE fenced batch (at most 60 statements). No index or schema is needed.
- **Same two fences.** The Film revision CAS and the owner-review token (`owner_review_authority` generation, every consumed verified owner row, the redirect closure), re-proved inside the batch, plus the intent's own pre-image row. A moved resolver input, a lost owner token, a lost revision or a changed stored row (any column, not only resolver inputs) refuses the batch whole (`localization_inputs_moved`, `localization_owner_moved`, `film_person_revision_conflict`); the pass reports the Film as `moved` and the next run plans a NEW intent.
- **Gates.** Marker `d1`/`open` and the owner-review domain `d1` with writes `open` or `held` (otherwise `localization_owner_unavailable`; a dry run lists the Film as `unavailable`: owner evidence that cannot be proven is never read as a decision). A redirect is never a candidate and never repaired; a Film is never created. **A restore enforces the same gates** (see below).
- **Held, nothing written.** Two different owner values (`owner_conflict`), an owner or reviewed row of another value than the resolver output (`protected_row_differs`), an owner projection whose decision is gone with no automatic source to replace it (`owner_projection_without_input`), a legacy candidate that cannot be recorded losslessly (`legacy_candidate_not_preservable`). The reconciler never deletes a row to resolve a hold and never manufactures a review decision. A hold records no intent and opens no receipt.
- **No resolver input is lost.** A legacy provisional row of a source that has no source row is recorded as a source row in the same batch (`ON CONFLICT DO NOTHING`) before the row is replaced. No other source row is written or changed.
- **Own receipts.** Kind `film_localization_reconcile`, origin `localization_reconciler`, a fresh request id per run, Film, action and digest. The write and its applied receipt are ONE atomic batch. A historical `localization_source` or `film_localization_projection` receipt is never replayed, settled or reused (equal content proves no causality). A payload-free receipt cannot be re-planned: the registry spec abandons an unsettled one (`reconcile_intent_required`; with the atomic tail a non-applied receipt has no committed effect) and only the recorded intent settles it.

## Intent, checkpoint and recovery (the pre-image contract)

A receipt stores no payload and a dry-run report is not a pre-image, so **the exact immutable per-Film intent is the pre-image**: `{version, id, runId, requestId, digest, at, plannedRevision, postRevision, inputs, preImage, postImage}`. The digest binds the full pre-image (`null` when the row is absent, otherwise every column), the full post-write image, the normalized resolver inputs, the **stable write time `at`** (the one clock the plan reads; the committed `updated_at` is the intent's, never a later clock reading) and the planned revision. The writer re-checks all of it inside the batch; it never replans under an old digest.

`applyLocalizationReconcile` **requires a durable `checkpoint` port** from the operation (AIR-664 chooses the storage, cohort and window; this module owns the contract) and **fails closed**:

1. `checkpoint.record(intent)` must resolve BEFORE the write is permitted. A throw stops the pass with nothing written for that Film (`localization_checkpoint_failed`).
2. The write is one receipted, atomic, fenced batch under the intent's request id.
3. `checkpoint.settle(intent, {state})` records the outcome: `applied` (the receipt is applied at exactly `postRevision` with the intent's digest), `not_applied` (a definite replan refusal) or `unknown`.

The mutation primitives (the fenced write and the fenced restore) are **private**: no exported function commits a localization row without the checkpoint port and the receipt of its own request. `resumeLocalizationReconcile` needs the same port (the exact intent is recorded idempotently before the write is permitted, `localization_checkpoint_failed` writes nothing, the outcome is settled afterwards). A failed durable settlement is never completion: the pass stops, reports `localization_checkpoint_settle_failed`, and does not advance the cursor past that Film. Every exit of a pass returns what it did and never loses progress: `written` (intents), `uncertain` (intents whose write may have committed), `moved`, `held`, `noop`, `absent`, `cursor` (the last Film fully settled, the resume point), `stopped`, and `failedId`/`error` for the Film that stopped it. A stopped page always reports `hasMore: true` (the failed Film and the Films after it are unprocessed) and `examined` counts every Film that was read. A failure on a later Film (a read error, a refused checkpoint) never discards an earlier Film's intent.

**Recovery after an unknown outcome (a lost reply).** `recoverLocalizationReconcile({intent})` is read only and settles the recorded intent against the applied receipt and the revision: `applied` (the receipt of that request id is applied at `postRevision` with the intent's digest: the intent is a valid restore token), `not_applied` (no applied receipt, and the Film is still at the planned revision with the intent's pre-image row: safe to resume), or `unknown` (a moved Film or any mismatch: never guessed, never written, for review). `resumeLocalizationReconcile({intent, checkpoint})` re-issues the same request id and digest, so a committed effect is never written twice and a not-yet-written intent is written once; a lost reply during a resume is `unknown` and recoverable the same way.

## Restore

The restore token is the apply intent. `restoreLocalizationReconcile` validates and binds it **before any receipt is reserved**: a complete, self-consistent intent (an explicit `preImage` that is `null` or a complete image, a complete `postImage`, a digest and request id that recompute from the content; a missing or fabricated field is `film_person_invalid`), the marker open, the owner-review domain D1-authoritative (`localization_owner_unavailable` otherwise; the CURRENT owner-review token is read again and its predicates ride in the restore batch, so an owner move between the wrapper's read and the commit is `localization_owner_moved`; it need not equal the apply-time token), and **its own apply receipt**: it must exist, be `applied`, and carry the same request id, digest, target and applied revision (`localization_restore_unbound` otherwise). It is not a general mutation API and cannot put an arbitrary row back.

The write applies only while the Film is **still at exactly `postRevision`** and the stored row **still equals `postImage`**; otherwise it refuses with `localization_restore_moved` and writes nothing (another writer's work is never erased). A `null` pre-image deletes the row the reconciler created. A restore bumps the revision, so a second restore of the same token is refused. A restore does not remove the legacy source row the reconciler preserved (a source row is a durable resolver input). The alternative to a restore is a **forward correction**: another reconciler run, which writes the resolver output of the then-current inputs under a new receipt and a new intent.

## Rollback of the code

The reconciler writes only rows the previous code already reads with the same resolver. Applied rows and applied receipts stay valid after a code rollback. A receipt of this kind that is still `pending`, `failed` or `unknown` has no operation in the previous registry (`operation_unregistered`, left `waiting`): roll the code back only when `SELECT COUNT(*) FROM canonical_write_receipt WHERE operation='film_localization_reconcile' AND state NOT IN ('applied','abandoned')` is 0 (read only). A code rollback never repairs or removes a row.

## Production operation plan (AIR-664, DRAFT: awaiting plan review; authorizes nothing)

[AIR-664](https://trello.com/c/Og9XxXfy) is the Stage 4 **operation**. Everything below is a proposal for review. Each numbered gate needs its own owner decision; a green review of this plan is not an operation GO.

### 0. Blockers found offline (no live read was made)

1. **No entry point.** The module is dormant (asserted by the test): no Worker route, MCP tool, Workflow or script can call it. A production dry run therefore needs new code. Proposed shape, following the existing `letterboxd_claim_backfill` precedent in [MCP reference](../reference/api/mcp.md): an owner-only MCP tool with `mode` `dry_run` (default, read only) and `apply` (explicit `confirmGo`, run id, the two authority generations, `expectedCount` and `expectedDigest` copied from a dry run). No SQL, Film id list or key is accepted from the caller. This code is an **implementation GO**, proposed as its own card so that AIR-664 stays a pure operation.
2. **No checkpoint storage.** `applyLocalizationReconcile` requires a durable `checkpoint` port and no store exists. A receipt carries no payload, so the intent is the only pre-image. Options (owner decision; ADR required, one at a time per the facilitation protocol):
   - **R2 immutable object per intent** (recommended). Server-built key from the run id and Film id, `put` only if absent (equal digest is an idempotent success), a second object for the settlement, read back by `recover`. No migration, no schema change; the key family is fixed in code and never taken from an argument. Not atomic with the D1 batch, which the contract does not need (record BEFORE write, settle AFTER).
   - **New D1 table.** Strongest queryability, but a migration with its own apply gate and contract-version change.
   - **Operator-held (rejected).** `record` must resolve inside the Worker before the write; a chat or Trello copy cannot be that.

### 1. Read-only preflight (L0, immediately before any dry run)

Read live, never from this page: Film/Person marker `d1`/`open` and its generation; owner-review domain `d1` with writes `open` or `held`; schema version; feature flags and executor modes; no active Workflow chain or lease that would write Film rows; the receipt check from [Rollback of the code](#rollback-of-the-code) (`film_localization_reconcile` receipts not `applied` or `abandoned` must be 0). Any other value stops the operation.

### 2. Dry run and cohort

- The dry run scans every Film by keyset pages of at most 50 raw ids and reports `stale`, `held` (with reason), `noop`, `absent`, `unavailable`, `wouldWrite`. Total Films and the stale count are **unknown until this run**; nothing in this plan assumes them.
- The cohort is exactly the `stale` Films of one dry run, pinned by `expectedCount` and a digest over the sorted `id:digest` lines of their intents. A different state at apply is a refusal with `writes: 0`.
- Every `held` Film is listed with its reason and **left untouched**; resolving a hold is a separate owner decision (the reconciler never deletes a row or manufactures a review decision).
- **Zero eligible is an explicit no-op:** the evidence records the dry run, the generations and `writes: 0`; no apply is requested.

### 3. Cap and waves (provisional, reviewable)

Code maxima stay as shipped (50 examined, 25 written per call). Proposed waves: **pilot 1 to 3 Films**, read back, then waves of at most 10, then at most 25, each read back before the next. Rationale: one wave must be small enough to verify by hand and restore exactly; the values are provisional tuning, not product constraints, and may change on review. No time window is needed for correctness (the revision CAS and the owner-review token fence concurrent writers); an operator may still choose a quiet period.

### 4. Fences, receipts and stop conditions

Fences are the shipped ones (revision CAS, owner-review token, pre-image row, marker open). Stop at the first of: `localization_checkpoint_failed`, `localization_checkpoint_settle_failed`, any `unknown` outcome (recover first, never retry blind), more `moved` than the owner accepted for the wave, a `held` reason not present in the approved dry run, a readback mismatch, or any collateral delta. A stopped pass reports `cursor` and `failedId`; resume only through `resumeLocalizationReconcile` with the recorded intent.

### 5. Readback after each wave

- Each written Film: the stored row equals the intent `postImage`, the revision is `postRevision`, and the applied receipt carries the intent request id and digest.
- Effective value and owner precedence: a Film with an owner row keeps the owner value; no reviewed or owner row changed.
- No collateral change: row counts and digests of every other `film_dimension` dimension, `owner_review_entry`, `film_localization_source` (only the preserved legacy rows named by the intents may appear), redirects and Person tables are unchanged; receipt count delta equals the writes.
- Stale cases: the repeated dry run lists no previously written Film as `stale` (idempotence).
- Unknown outcome: `recoverLocalizationReconcile` settles it read only before anything else happens.

### 6. Rollback and restore

The restore token is the recorded apply intent, valid only while the Film is still at exactly `postRevision` with the row equal to `postImage` (`localization_restore_moved` otherwise). Any later change is handled by a **separately approved forward correction** (another reconciler run), never a blind restore. A restore does not remove a preserved legacy source row. Code rollback follows [Rollback of the code](#rollback-of-the-code).

### 7. Evidence and documentation impact

Sanitized dated evidence under `docs/evidence/film-person/` at execution: Film ids and counts, digests, generations and outcomes; **no localization payloads and no intent bodies** (they stay in the checkpoint store). Affected documents once code exists: this runbook, [MCP reference](../reference/api/mcp.md), the persistence diagram if R2 is chosen, a new ADR for the checkpoint store, the [read side effects](../reference/api/read-side-effects.md) audit (the dry run must stay write free), the [deployment runbook](deployment.md). This offline step's evidence: [AIR-664 operation plan](../evidence/film-person/air-664-localization-reconcile-operation-plan-2026-11-25.md).

### Proposed operation GO (text for the owner; not granted)

L3 plan, one operation: run `film_localization_reconcile` (after its implementation is merged and deployed) against the cohort of one dry run, in the approved waves, with the approved checkpoint store, the stop conditions above and the exact-revision restore. Allowed side effects: the `film_dimension` localization row of the cohort Films, the legacy source rows named by their intents, the receipts of this kind and the checkpoint objects. Everything else (sync, model, TMDB, Discovery, flags, Tasks, Access, migrations, lease resets, retries outside the recorded intent) stays forbidden. Revocation: the owner says stop; the tool is not called again.

## Not authorized here

Running the reconciler against production, choosing a cohort, a cap or a window, storing tokens, any manual sync, model, TMDB or Discovery call, flag, Scheduled Task, Access change, migration, R2/D1 write, retry or lease reset. [AIR-664](https://trello.com/c/Og9XxXfy) prepares the exact dry run, cohort, stop conditions and rollback plan and asks for the operation-specific GO.
