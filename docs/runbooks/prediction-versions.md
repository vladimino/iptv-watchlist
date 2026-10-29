# Immutable prediction versions: the writer and one-time materialization (owner approval required)

The Worker writes each committed prediction once as its own R2 object beside the mutable `predictions.json` bundle; the rule, the key and the pointer shape are in the [prediction runner reference](../reference/api/prediction-runner.md#immutable-prediction-version-objects) and the design decision in [ADR-0019](../adr/0019-live-d1-backfill-boundaries.md) item 4. The writer has no switch ([ADR 0045](../adr/0045-retire-prediction-version-objects-switch.md)). This page describes its failure handling and rollback, and the procedure for the one-time production materialization, which no deploy, merge or page performs: each production step needs its own action-specific owner approval.

## 1. The writer (always on; the former `PREDICTION_VERSION_OBJECTS` is retired)

Effect: every created or recalculated prediction is written once to `enrichment/films/<id>/predictions/versions/<sha256>.json` before the bundle is rewritten, and the bundle record carries `r2Key` and `contentSha256`. The submit contract, the queue, the readers and the view are the same as without the object. The former `PREDICTION_VERSION_OBJECTS` variable is retired and inert whatever it holds; its value `on` since 27 October 2026 is the behaviour kept.

1. Failure handling: the writer is additive (one write-once object per committed prediction, about the size of the prediction record), fails closed on a conflicting existing object, and never deletes. A storage error or byte conflict on the version write is handled exactly as a bundle write failure: the item is `failed` with `storage_error`, the bundle and view index stay unchanged, the run stops with `stopReason: storage_error` (`mustComplete: true`), and the film is retried by the ordinary schedule after the queue backoff. A conflict (an existing object with other bytes at a checksum key) is investigated read-only and never overwritten.
2. Verification is read-only: after a naturally scheduled run that commits a prediction, the run's completion has no `storage_error` stop, and an authorized read of one touched film's bundle shows `current.r2Key` ending in `/predictions/versions/<current.contentSha256>.json`; the object exists; a local SHA-256 of its bytes equals `contentSha256`. No manual run is started to verify.
3. Rollback: there is no runtime switch. Stopping the writer is a code revert. Objects already written **stay in R2**: they are referenced by bundle pointers, remain valid bodies, and are classified by the offline importer; there is no deletion step and none is to be invented. Reverting to code that reads the former switch writes the bundle alone unless `PREDICTION_VERSION_OBJECTS=on` is still bound (or restored under owner authorization), and records written so carry no pointer.
4. Retirement close-out: after the AIR-226 deploy, the owner removes the leftover `PREDICTION_VERSION_OBJECTS` binding from Worker `iptv` under a separate authorization and reads its absence back with `feature_flags` (`state: absent`); record it in the [feature flag register](../reference/feature-flags.md).

## 2. One-time materialization of historical versions (implemented; no production execution recorded here)

Records written before the rule, in `current` and in `history`, carry no pointer. The backfill needs each of them as an immutable object. The production run of 28 October 2026 is recorded in the [apply evidence](../evidence/prediction/air-74-materialization-apply-2026-10-28.md). The operation is described by [ADR-0026](../adr/0026-historical-prediction-version-materialization.md): a plan from a fenced snapshot, bounded batches sent to a gated Worker route that writes under the prediction writer lease, receipts, and reconciliation from a new snapshot. It is not a background job and not a Scheduled Task change. Every production step below is a separate owner approval.

### Body, key and bundle change

The object for a historical record is exactly what the writer would have written at the time: the record with keys sorted, without `replacedAt` and without pointer fields; the key is `enrichment/films/<id>/predictions/versions/<sha256>.json` with the SHA-256 of those bytes. Old bodies are preserved byte for byte; nothing is re-predicted and no field is edited. The bundle gains `r2Key` and `contentSha256` on each record and a `materialized` block `{at, from: 'predictions.json', planId, previousEtag, previousSha256}`; each history record keeps its `replacedAt` and its order.

### Procedure

All outputs go to one private directory outside the repository (the script refuses a path inside it). Reports hold counts only; `plan.jsonl` holds film ids, ETags and checksums and stays private.

1. **Snapshot.** A verified snapshot with status `consistent_fenced`, taken with the [read-only exporter](r2-snapshot-export.md) under its own approval. It is the plan's source and the recovery source for every bundle the operation rewrites.
2. **Plan (offline).** `node scripts/prediction-versions-materialize.mjs plan --snapshot /abs/snapshot --output /abs/private/dir` writes `origin.json` (plan id = the snapshot's aggregate SHA-256, `plan.jsonl` SHA-256, counts), `plan.jsonl` (≤ 50 films per batch) and `report.json`. Malformed pointers, unreadable bundles and existing objects with differing bytes are stops: those films are left out and counted. `node scripts/prediction-versions-plan.mjs` remains the per-record read-only view.
3. **Rehearse (offline, mandatory).** `… rehearse --snapshot /abs/snapshot --output /abs/private/dir` runs the Worker code against an in-memory copy of the snapshot: dry run and apply per batch, a replay of every batch, then the check (no pending or malformed record, every object equals its body, no body changed, provenance on every planned bundle, and every bundle outside the plan, already fully linked by the live writer, left byte for byte). It exits 3 unless `ok`. Record the aggregates as dated evidence.
4. **Gate (owner, Cloudflare settings).** Writing needs `PREDICTION_MATERIALIZATION=on`; record it in the [flag register](../reference/feature-flags.md). The version writer has no switch ([section 1](#1-the-writer-always-on-the-former-prediction_version_objects-is-retired)), so later submits keep materialized bundles linked.
5. **Validate (read-only against production).** `… validate --output /abs/private/dir --endpoint https://<worker host>` sends every batch as a dry run. The Access service token comes from `PREDICTION_MATERIALIZE_ACCESS_CLIENT_ID` / `PREDICTION_MATERIALIZE_ACCESS_CLIENT_SECRET` in the environment and is never printed or written. Expected outcomes are `would_materialize`; `bundle_changed` counts films a submit rewrote after the snapshot. Some dry-run reads are cheap but not free; no lease is taken. The dry run does not read `PREDICTION_MATERIALIZATION`; set the flag only immediately before an approved apply. Without an Access path, the same route code can be run read-only over the S3 API with the read-only snapshot credential and a store that refuses every write, as on [28 October 2026](../evidence/prediction/air-74-materialization-validate-2026-10-28.md); apply always goes through the Worker.
6. **Apply.** `… apply --output /abs/private/dir --endpoint https://<worker host>` sends the batches in order and stops at the first non-2xx answer; `apply.json` holds per-batch results and the list of **incomplete** batches with their class counts; the command exits 4 when any batch is incomplete. Resume with `--from-batch <n>`. Only a batch whose films are all `done` gets a receipt; repeating it returns that receipt (`replay: true`), and repeating it with other items is refused (`receipt_mismatch`). An incomplete batch has no receipt, so re-sending it revisits every film. HTTP 409 `prediction_writer_busy` means a submit holds the lease: wait and resume the same batch.
7. **Reconcile.** Turn `PREDICTION_MATERIALIZATION` back off. Take a new fenced snapshot (separate approval) and run `prediction-versions-plan.mjs` on it: zero pending records and zero mismatches outside films that a later submit created with the writer on; then the offline importer's prediction family must report no `prediction_version_*` reasons. Films that answered `bundle_changed` need a new plan from that snapshot.

### Per-film outcomes

| Outcome | Class | Meaning | Action |
| --- | --- | --- | --- |
| `materialized` / `would_materialize` | done | Objects written (or would be) and the bundle linked | — |
| `already_materialized` | done | The bundle carries this plan's block with the planned previous ETag and SHA-256 and nothing pending (a lost response or an earlier incomplete attempt) | — |
| `nothing_pending` | done | Every record already links | — |
| `bundle_changed` | replan | ETag or bytes differ from the plan (a submit intervened); nothing written to the bundle | New plan from a new fenced snapshot |
| `bundle_missing` | replan | No bundle at the key; nothing written | New plan; investigate read-only if unexpected |
| `bundle_unreadable` / `malformed_pointer` | stop | Not as planned; nothing written | Investigate read-only |
| `checksum_mismatch` | stop | An existing object at the key has other bytes; the bundle is unchanged | Stop; investigate, never overwrite |
| `readback_failed` | stop | The bundle was written but does not read back linked | Stop; compare with the snapshot |

A batch is `complete` only when every film is `done`; only then is it sealed by a receipt.

### Recovery

- **Lost response or crash inside a batch.** No receipt is written for a failed batch (HTTP 5xx). Re-send the same batch: objects already written are linked, finished films report `already_materialized`.
- **Incomplete batch.** It has no receipt. Films in class `replan` go into a plan from a newer fenced snapshot (a new plan id, so new receipts); after a fix, re-sending the batch revisits all its films. Films in class `stop` are investigated read-only before anything else is sent for them.
- **Receipt mismatch.** HTTP 409 `receipt_mismatch` means the batch number is already sealed for this plan with other items: the local `plan.jsonl` is not the one that was applied. Stop; nothing was written.
- **Rollback.** Version objects and receipts are additive and stay; the Worker never deletes. A bundle can be restored to its pre-rewrite bytes from the input snapshot (its manifest holds key, bytes and checksum) under a separate approval; the `materialized` block names the ETag and checksum it replaced. Turning `PREDICTION_MATERIALIZATION` off stops further batches; code rollback removes the route only.
- **Approvals.** Reading production for a snapshot, setting each flag, `validate` against production, `apply`, and the reconciling snapshot are each separate owner approvals. A deploy or merge authorizes none of them.
