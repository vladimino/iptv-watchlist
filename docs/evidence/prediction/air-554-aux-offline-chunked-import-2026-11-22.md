# AIR-554: offline implementation of the chunked import, seal and chunked verification (ADR 0202)

[AIR-554](https://trello.com/c/UrS1gflv) · 22 November 2026 (UTC). Repository change and local tests only. **No production read or write, no export, no credential, no scratch D1, no Task, flag, Workflow, Access or lease change.** Production remains NO-GO; nothing here authorizes an operation.

## What was built

- `migrations/0035_prediction_aux_import_receipts.sql` (schema 35, additive; `0034` is byte-for-byte unchanged): three insert-only receipt tables (`prediction_aux_import_chunk`, `prediction_aux_seal`, `prediction_aux_verify_slice`) and 33 `prediction_aux_sealed_*` triggers on every auxiliary data table, active only while the marker is not `d1` and a seal exists for the marker's generation.
- `scripts/prediction-aux-d1-import.mjs`: deterministic chunking of whole runs (at most 1,500 statements and 6 MiB per batch), in-transaction guards, receipts, seal, verification slices and the small flip batch; the plan digest is independent of generation and limits.
- `scripts/prediction-aux-cutover-production.mjs`: operator commands `import`, `seal`, `verify`, `flip` over receipts (chunk k+1 only after chunk k is proven committed, identical retry of an unknown outcome, stop on a receipt with another SHA, `--max-chunks`, `--plan-sha256`).

## Sizing (synthetic dataset at the 22 Nov scale, sqlite stand-in)

Whole import 1,621 statements / 36,298,376 bytes becomes 6 chunks of at most 6,089 KiB, 6 verification slices and a flip of 1,877 bytes. A real-size database run took 3 chunks and 3 slices in about 2 s on sqlite. **That is not D1 timing**; chunk, slice and cut durations on D1 are unmeasured, so run-sheet P3 stays open.

## Tests

`tests/prediction-aux-cutover-production.mjs` covers parity, atomic rollback of a partial chunk, concurrent same and different plans, an ambiguous timeout with a late commit, receipt collision and retry, skipped and out-of-order chunks and slices, generation change, late SQL after the seal, refusal of any change to sealed rows, normal Worker writes on every family after `d1`, mismatching totals, bytes and plan, and fail-closed behavior.

Review round 1 (independent review of `533f792`): the stage head (`item_count`, `total_bytes`, `revision`, `updated_at`), which the Worker's `readStage` cross-checks against the staged rows, is now asserted by the verification, by the seal guard and by the flip guard, and `held_at` of every staged row is part of the byte-level verification. Regressions: each altered head field after the import and before the seal is refused by the seal (operator and in-batch guard), and an altered `held_at` fails the verification. The run sheet's `--import` command no longer names the removed `--sql-sha256`.

Mutation check of the guards (19 mutations): 16 are killed by a test. Three survive by design, because the same property is enforced twice: removing the no-seal clause from the chunk guard (the seal trigger still aborts the write), removing the seal check from the flip guard (the slice receipts cannot exist without the seal), and removing the stage-head condition from the flip guard (the head is frozen by the seal triggers and was already asserted by the seal and the verification). They are defense in depth and are kept.

## Still needed before any production step (each its own owner decision)

Apply `0034` and `0035`; Task freeze; measured chunk and slice durations and the P5 D1 health gate; close, import, seal, verify and the flip release. This evidence changes none of those gates.
