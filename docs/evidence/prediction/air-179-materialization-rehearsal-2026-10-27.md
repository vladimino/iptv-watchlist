# Prediction version materialization: plan and offline rehearsal on the AIR-175 snapshot

**Captured:** 2026-10-27, offline on the owner's machine; code on branch `claude/air-179-prediction-materializer` (base `main` `8b861ff`)  
**Input:** the [AIR-175 snapshot](../d1-migration/air-175-r2-snapshot-identity-2026-10-26.md), `consistent_fenced`, aggregate `f71eee103b8e45a696def1805d050454bf3721e0cd688dc041c16bddcc0bdeb3` (the plan id), `manifest.json` SHA-256 `c26e04536ff2ebc047e731ad0b0e39eed51a9550bc921f457026de06c7b1865a` re-checked after the runs; the directory stayed write-protected  
**Scope:** local files and an in-memory bucket only; no request to the Worker, R2 or D1, no flag, Task or Access change  
**Verdict:** **GO for review of the materializer, offline only.** Every planned record materializes, every object equals its historical body, no body changes, every batch replays; no production run is recorded or authorized here  
**Used by:** [AIR-179](https://trello.com/c/vdLts7tJ), [ADR-0026](../../adr/0026-historical-prediction-version-materialization.md), [AIR-74](https://trello.com/c/5AdAmKPe) blocker 3

Aggregates only. `plan.jsonl` (film ids, ETags, checksums) and the per-batch reports stay in a private directory outside the repository.

## Plan (`prediction-versions-materialize.mjs plan`)

| Measure | Value |
| --- | --- |
| Bundles read | 2,335 (all `current` only; no history records in this snapshot) |
| Records already linked / pending / malformed | 0 / 2,335 / 0 |
| Objects to write | 2,335, 1,786,040 bytes |
| Objects already present / with differing bytes | 0 / 0 |
| Unreadable bundles / unreferenced version objects | 0 / 0 |
| Planned films / records / batches (≤ 50 films) | 2,335 / 2,335 / 47 |
| Stops (malformed, checksum mismatch, unreadable) | 0, 0, 0 |
| `plan.jsonl` SHA-256 | `084dea0b03a27d34c241f6a8f59a3feaa8e6be310ab5877450097e92df3c0b42` |

## Rehearsal (`rehearse`, Worker code in vm, both gates on)

| Step | Result |
| --- | --- |
| Dry run per batch | 47 × HTTP 200 |
| Apply per batch | 47 × HTTP 200; outcomes `materialized` 2,335 |
| Replay of every batch | 47 × `replay: true`, nothing written |
| Check after apply | pending 0, malformed 0, linked 2,335, object ≠ body 0, body changed 0, provenance block 2,335 of 2,335 |
| Wall time (plan + rehearsal) | 2.8 s |

The 14 prediction bundles whose film id resolves to no Film (class C, AIR-180 acknowledgement) are materialized like the others; materialization does not change their class.

## Limits

- The rehearsal bucket starts from the snapshot. Production has moved on since `2026-10-26T22:19:31.757Z`: bundles rewritten by a later submit will answer `bundle_changed` and need a plan from a new fenced snapshot.
- It does not run the offline importer on the rehearsed bucket; the portability claim rests on the shared rule `predictionMaterializationPlan` that the importer also uses.
- Production needs separate approvals for `PREDICTION_VERSION_OBJECTS=on`, `PREDICTION_MATERIALIZATION=on`, the `apply` run, and a new fenced snapshot to reconcile.
