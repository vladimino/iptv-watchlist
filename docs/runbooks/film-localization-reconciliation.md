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

Every exit of a pass returns what it did and never loses progress: `written` (intents), `uncertain` (intents whose write may have committed), `moved`, `held`, `noop`, `absent`, `cursor` (the last Film fully settled, the resume point), `stopped`, and `failedId`/`error` for the Film that stopped it. A failure on a later Film (a read error, a refused checkpoint) never discards an earlier Film's intent.

**Recovery after an unknown outcome (a lost reply).** `recoverLocalizationReconcile({intent})` is read only and settles the recorded intent against the applied receipt and the revision: `applied` (the receipt of that request id is applied at `postRevision` with the intent's digest: the intent is a valid restore token), `not_applied` (no applied receipt, and the Film is still at the planned revision with the intent's pre-image row: safe to resume), or `unknown` (a moved Film or any mismatch: never guessed, never written, for review). `resumeLocalizationReconcile({intent})` re-issues the same request id and digest, so a committed effect is never written twice and a not-yet-written intent is written once.

## Restore

The restore token is the apply intent. `restoreLocalizationReconcile` validates and binds it **before any receipt is reserved**: a complete, self-consistent intent (an explicit `preImage` that is `null` or a complete image, a complete `postImage`, a digest and request id that recompute from the content; a missing or fabricated field is `film_person_invalid`), the marker open, the owner-review domain D1-authoritative (`localization_owner_unavailable` otherwise), and **its own apply receipt**: it must exist, be `applied`, and carry the same request id, digest, target and applied revision (`localization_restore_unbound` otherwise). It is not a general mutation API and cannot put an arbitrary row back.

The write applies only while the Film is **still at exactly `postRevision`** and the stored row **still equals `postImage`**; otherwise it refuses with `localization_restore_moved` and writes nothing (another writer's work is never erased). A `null` pre-image deletes the row the reconciler created. A restore bumps the revision, so a second restore of the same token is refused. A restore does not remove the legacy source row the reconciler preserved (a source row is a durable resolver input). The alternative to a restore is a **forward correction**: another reconciler run, which writes the resolver output of the then-current inputs under a new receipt and a new intent.

## Rollback of the code

The reconciler writes only rows the previous code already reads with the same resolver. Applied rows and applied receipts stay valid after a code rollback. A receipt of this kind that is still `pending`, `failed` or `unknown` has no operation in the previous registry (`operation_unregistered`, left `waiting`): roll the code back only when `SELECT COUNT(*) FROM canonical_write_receipt WHERE operation='film_localization_reconcile' AND state NOT IN ('applied','abandoned')` is 0 (read only). A code rollback never repairs or removes a row.

## Not authorized here

Running the reconciler against production, choosing a cohort, a cap or a window, storing tokens, any manual sync, model, TMDB or Discovery call, flag, Scheduled Task, Access change, migration, R2/D1 write, retry or lease reset. [AIR-664](https://trello.com/c/Og9XxXfy) prepares the exact dry run, cohort, stop conditions and rollback plan and asks for the operation-specific GO.
