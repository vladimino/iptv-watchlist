# Film localization reconciliation: the bounded reconciler (code) and its operation contract

Stage 4 of [ADR 0218](../adr/0218-film-lifecycle-dimensions-revision.md) decision 3 ([AIR-663](https://trello.com/c/UP10l6Js), code only). The production operation that runs it is a separate card ([AIR-664](https://trello.com/c/Og9XxXfy)) and needs its own operation-specific owner GO (an L2 contract or an L3 plan). **Delivering this code runs nothing and authorizes nothing.**

## What it does

A Film's effective `localization` row (`film_dimension`) is a stored projection of `owner_review_entry`, the applied reviewed row and `film_localization_source`. [AIR-662](https://trello.com/c/P8cCPv1V) keeps it current for every new source write. The reconciler fixes the rows that are stale **without a new source observation**: a Film written before the projection-aware writer (a historical applied source receipt), a source row with no effective row, a legacy provisional row that is no longer the resolver output, and an owner-only change (a decision removed or changed after the row was materialized). It writes the output of the existing `resolveLocalization`, never a new precedence: owner, then reviewed, then automatic (fixed source order, then the newer observation, then the source name), behind the `strong()` guard and its SQL `WHERE`.

| Part | Path | Role |
| --- | --- | --- |
| Reconciler | `src/film-localization-reconciler.js` | `dryRunLocalizationReconcile`, `applyLocalizationReconcile`, `restoreLocalizationReconcile`, the pure `planLocalizationReconcile`, the fenced writers and the registry spec |
| Shared logic | `src/film-localization-projection.js` | `projectionOf`, `legacyCandidate`, `PROJECTION_UPSERT`, `readOwnerReviewToken`, `ownerTokenStatements` (one implementation, exported, not copied) |
| Tests | `tests/film-localization-reconciler.mjs` | real SQLite fixtures built from every migration |

Nothing imports the module outside the tests: no Worker entry, route, MCP tool, Workflow, cron tick, script or workflow file, and the build does not bundle it (asserted by the test). No flag, Scheduled Task, migration, table, index or column exists for it.

## Contract

- **Dry run is read only.** It opens no receipt, no batch and bumps no revision. It reports `examined`, `cursor`, `hasMore`, the `stale` Films with their pre-image row, the intended post-write row and the effective value, the `held` Films with a reason, `noop`, `unavailable` (with the error code) and `wouldWrite`.
- **Bounded.** At most 50 Films examined (default 20) and at most 25 written (default 10) per run; a larger or non-integer value is `film_person_invalid`. Each written Film is ONE fenced batch (at most 60 statements). The run continues from `cursor` (the last examined id) as `after`.
- **Same two fences.** The Film revision CAS and the owner-review token (`owner_review_authority` generation, every consumed verified owner row, the redirect closure), re-proved inside the batch. A moved resolver input, a lost owner token or a lost revision refuses the batch whole (`localization_inputs_moved`, `localization_owner_moved`, `film_person_revision_conflict`); the pass reports the Film as `moved` and the next run replans. The pre-image row is asserted inside the batch too.
- **Gates.** Marker `d1`/`open` (otherwise a `film_person_*` refusal before any row is read for writing) and the owner-review domain `d1` with writes `open` or `held` (otherwise `localization_owner_unavailable`; a dry run lists the Film as `unavailable`: owner evidence that cannot be proven is never read as a decision). A redirect is never a candidate and never repaired; a Film is never created.
- **Held, nothing written.** Two different owner values (`owner_conflict`), an owner or reviewed row of another value than the resolver output (`protected_row_differs`), an owner projection whose decision is gone with no automatic source to replace it (`owner_projection_without_input`), a legacy candidate that cannot be recorded losslessly (`legacy_candidate_not_preservable`). The reconciler never deletes a row to resolve a hold and never manufactures a review decision. A hold is fixed by the owner through the review routes or by a separately approved correction.
- **No resolver input is lost.** A legacy provisional row of a source that has no source row is recorded as a source row in the same batch (`ON CONFLICT DO NOTHING`) before the row is replaced. No other source row is written or changed.
- **Own receipts.** Kind `film_localization_reconcile`, origin `localization_reconciler`, a fresh request id per run, Film and action (the `runId` is the source event). The write and its applied receipt are ONE atomic batch, so a lost reply after the commit is visible as an `applied` receipt (applied revision = planned + 1) and a rerun of the same run id writes nothing. A historical `localization_source` or `film_localization_projection` receipt is never replayed, settled or reused (equal content proves no causality). An unsettled receipt of this kind whose row already equals the output is `needs_review`, never applied from content alone; a moved input abandons it (`producer_source_changed`); a held output abandons it (`localization_reconcile_held`).

## Pre-image and restore

A receipt stores no payload and a dry-run report is not a pre-image. An apply therefore returns, for every written Film, a **restore token**: `{id, requestId, preImage, postImage, postRevision}`. `preImage` is the exact previous `localization` row (or `null` when there was none) and `postRevision` the exact Film revision the write produced. **The operation persists the token in its sanitized evidence before it treats the run as complete**; a lost token means no restore exists and only a forward correction remains. The tokens contain only a Film id, row columns and revisions.

`restoreLocalizationReconcile` applies the token only while the Film is **still at exactly `postRevision`** and the stored row **still equals `postImage`**; otherwise it refuses with `localization_restore_moved` and writes nothing (another writer's work is never erased). A `null` pre-image deletes the row the reconciler created. A restore bumps the revision, so a second restore of the same token is refused. A restore does not remove the legacy source row the reconciler preserved (a source row is a durable resolver input). The alternative to a restore is a **forward correction**: another reconciler run, which writes the resolver output of the then-current inputs under a new receipt and a new pre-image.

## Rollback of the code

The reconciler writes only rows the previous code already reads with the same resolver. Applied rows and applied receipts stay valid after a code rollback. A receipt of this kind that is still `pending`, `failed` or `unknown` has no operation in the previous registry (`operation_unregistered`, left `waiting`): roll the code back only when `SELECT COUNT(*) FROM canonical_write_receipt WHERE operation='film_localization_reconcile' AND state NOT IN ('applied','abandoned')` is 0 (read only). A code rollback never repairs or removes a row.

## Not authorized here

Running the reconciler against production, choosing a cohort, a cap or a window, storing tokens, any manual sync, model, TMDB or Discovery call, flag, Scheduled Task, Access change, migration, R2/D1 write, retry or lease reset. [AIR-664](https://trello.com/c/Og9XxXfy) prepares the exact dry run, cohort, stop conditions and rollback plan and asks for the operation-specific GO.
