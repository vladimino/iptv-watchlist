# ADR 0201: The auxiliary import and its verification run as ordered, resumable chunks that leave receipts, and the flip checks the receipts instead of re-sending the dataset

**Status:** Proposed (2026-11-22; the owner asked for this proposal on [AIR-554](https://trello.com/c/UrS1gflv) after the first real export measured the import; acceptance, the choice between the options below and any schema change are separate owner decisions)  
**Original decision date:** 2026-11-22  
**Recorded at:** 2026-11-22  
**Approval source:** owner instruction in the AIR-554 executor chat of 22 Nov 2026 to start this proposal; [sizing evidence](../evidence/prediction/air-554-aux-real-export-sizing-2026-11-22.md)  
**Related work:** [AIR-554](https://trello.com/c/UrS1gflv)  
**Supersedes:** None  
**Amends:** [ADR 0194](0194-prediction-auxiliary-state-d1-checkpoint-and-outbox.md) and [ADR 0196](0196-prediction-aux-admission-closed-state.md) only in how the import and its verification are batched, if accepted  
**Superseded by:** None

## Context

The cutover contract so far is one atomic D1 batch for the import and one atomic batch for the flip that **contains the canonical row-level verification** (so it cannot be skipped and a differing byte aborts it before the marker moves). The first real export of the legacy state ([evidence](../evidence/prediction/air-554-aux-real-export-sizing-2026-11-22.md), 22 Nov 2026, consistent cut of the auxiliary scope of [ADR 0200](0200-prediction-aux-scoped-export-proof.md)) measured 1,947 objects and 34.8 MB: 738 run sources and 468 persisted manifests carry 33.7 MB of it. The derived import is **3,998 statements and 36.2 MB** and the verification **5,948 statements and 36.7 MB**, against the measured D1 batch limits of 2,000 statements and 8 MiB. Neither the import nor the flip fits one batch. The largest single run is 0.62 MB and the largest statement 55 KiB (the 100 KiB statement limit is respected), so the data can be split by run. The synthetic tests that shaped the original contract were one run of 16 KB.

## Decision (proposed)

1. **Chunked import under the closed marker.** The plan is split into ordered chunks of whole runs (a source revision with its pieces and head, a manifest with its pieces), then the event outbox, then the held stage, each chunk at most 1,500 statements and 6 MiB (margin under the limits; about 6 chunks for the measured data, one run at most 0.62 MB). Every chunk is one atomic batch that starts with a guard asserting: marker `closed` at the exact generation, the chunk's number is the next one (no gap, not applied yet) and the plan digest matches. A chunk that fails its guard writes nothing.
2. **Receipts.** Each chunk's batch also inserts one receipt row `(generation, chunk_no, chunk_sha256, plan_sha256, statements, bytes)`; receipts are insert-only, contiguous and bound to the marker generation by triggers. An unknown outcome is read back by looking at the receipts: present means applied, absent means nothing was written (the batch is atomic), so the same chunk may be sent again; a blind retry is still never made.
3. **Chunked canonical verification.** The canonical per-row verification of the whole dataset (the same assertions as `planVerifySql`, byte-level for source and manifest pieces) is split the same way. Each verification chunk asserts its rows and, only if all pass, inserts a verification receipt `(generation, slice_no, slice_sha256, plan_sha256)`; a differing byte aborts that batch before its receipt exists.
4. **A small flip.** The single flip batch (a few statements) asserts: marker `closed` at the generation; the import receipts are exactly chunks 1 to K of one plan digest and the verification receipts exactly slices 1 to M of the same plan digest; the family totals and states equal the report; then the marker moves to `d1`. The release binds the plan digest, K, M and the capture identity. The data tables stay insert-only and settled outbox rows terminal (existing triggers), and the Worker refuses auxiliary D1 writes while the marker is `closed`, so rows cannot change between a verified slice and the flip without owner-level access to the database.
5. **Reads and recovery.** The marker stays `closed` (readers refuse the cohort, nothing is partially authoritative) until the flip. `closed` to `r2` stays refused once any row exists; an interrupted import is resumed from its receipts, never abandoned silently. A restore stays a separate owner operation.
6. **Schema.** The receipts need two small tables and their triggers: either an additive migration after `0034` (applied with it; its number is assigned after any other pending migration) or an amendment of the still unapplied `0034`. The additive form keeps the reviewed `0034` hash and is the proposal.

## Options the owner may choose instead

- **No receipts, progress read from the data** (a chunk guard counts the runs already present). No schema change, but the flip can no longer prove in the database that the whole verification passed; the proof moves to the operator's process, which is exactly what the review of PR 897 rejected. Not proposed.
- **Pre-import of immutable history before the freeze.** Terminal runs' sources and manifests are immutable; importing them while the legacy path is authoritative would leave only recent runs, the outbox (1.08 MB) and the stage for the window and would remove most of the window risk. It changes the rule that an import runs only under the closed marker and on empty tables, needs its own guard and proof and a decision on runs that change after a first import; it is a follow-up design, not part of this one.
- **Keep old runs in R2.** Import only live and recent runs inline and leave terminal history in R2. It changes the accepted retention decision of ADR 0194 (all history inline) and is the owner's choice.

## Consequences

- The import and the flip fit the measured limits: about 6 import batches, about 6 verification batches and one small flip for the measured dataset, each well under 8 MiB.
- The window budget (run sheet P3) needs the duration of one chunk on production D1, which is unmeasured; it is read from the first chunk (the first chunk makes the tables non-empty, so the abort path after it is "resume or hold", not `--reopen`) or from a scratch D1, which the owner has not authorized. The budget rule and the import gate of the run sheet are rewritten around chunks when this is accepted.
- More code (the chunker, the receipts, the flip check), a schema addition, a new operator step state and tests; nothing here is applied, imported or flipped by merging this ADR.
- The D1 cost of about 12 large batches is a measurement to take, not a threshold (Paid baseline); the current D1 load analysis is [AIR-579](https://trello.com/c/OlcWhyM7).

## What this does not decide

Whether to accept the proposal, which option to take, the migration form, the chunk budgets (the numbers above are proposals) and any production operation. The residual of ADR 0196 and the drain bound are unchanged.
