# Runbook: batch_v2 auxiliary prediction state, checkpoint and outbox recovery and the AIR-554 handoff

[AIR-553](https://trello.com/c/ouMIBO00) delivers this state **dormant**; the cutover is [AIR-554](https://trello.com/c/UrS1gflv), a separate owner L3 plan. Contract: [ADR 0194](../adr/0194-prediction-auxiliary-state-d1-checkpoint-and-outbox.md) (Accepted). Schema: [d1-schema](../reference/data/d1-schema.md). Evidence: [AIR-553 offline evidence](../evidence/prediction/air-553-aux-state-d1-dormant-offline-2026-11-22.md). **Nothing in this runbook is authorized by merging the code.** Applying migration `0034`, importing, flipping the marker, retiring the R2 writers, changing a Scheduled Task, a flag, a binding, or starting a manual batch or Workflow each need their own owner GO.

## State today (code delivered, nothing activated)

- Marker `prediction_aux_authority`: inserted `r2` by migration `0034` (not applied to production by a deploy). With it at `r2`, or with a schema older than 34, the Worker runs the R2 objects exactly as before. A transient read error, a missing binding, a partial table set, a missing marker row or an unknown mode is `prediction_aux_unavailable` (HTTP 502 on the runner routes), **never** read as `r2`.
- With the marker at `d1` (after an activation) stage, sources, manifest and outbox are served **only** from D1; the Worker never reads or writes the R2 objects of those families again (no silent fallback). The Events journal and the deferred-start receipts stay R2.

## Offline import and dry run (read-only until an owner applies the printed SQL)

```bash
node scripts/prediction-aux-d1-import.mjs report <r2-export>
```

```bash
node scripts/prediction-aux-d1-import.mjs digest <r2-export>
```

```bash
node scripts/prediction-aux-d1-import.mjs sql <r2-export> > aux-import.sql
```

`<r2-export>` is a local export of the R2 objects (a directory that mirrors the keys, or one JSON file of key to document), made by the owner. The script opens no database, bucket or network connection. `report` prints counts, bytes, per-state outbox counts, orphan index entries and per-family digests; a source the Worker could not read (stage over its cap, a manifest without a lease epoch or films, an event record without a valid time, more than 256 active pending skipped records, a duplicate identity) is a blocker: exit 2, no SQL. `sql` prints guarded SQL whose first statement aborts the whole file unless the marker is still `r2` at generation 0 and every auxiliary table is empty. Mapping: stage rows keep their order; every run's sources become revision 1; every manifest a create-only manifest; every stop, start and skipped record one outbox row (delivered and superseded as settled with `settled_at` = the event's own time, so an old record is compactable at once and its identity stays; an undelivered record as pending, or quarantined with its attempts from the pending index; `since` from the index entry, else the event time).

## Cutover handoff for AIR-554 (the invariant, not the procedure)

AIR-554 chooses the bounded procedure and its holdpoints under its own owner plan. The invariant it must meet ([ADR 0194](../adr/0194-prediction-auxiliary-state-d1-checkpoint-and-outbox.md) decision 1): a marker pre-read is not a cross-store fence, and D1 cannot fence an R2 object. So, before the marker flips:

1. admission of **all** legacy auxiliary writers is closed: the runner and the deferred Workflow instances, but also the lease-free writers (the skipped-event park, index entry, delivery and acknowledgement of an ordinary HTTP request) and every request that read `r2` earlier;
2. in-flight old-authority mutations are drained or proven unable to land (a live runner lease, a deferred instance in `preparing`, pending outbox records and the held stage are preconditions to list, drain or preserve);
3. the import and its verification (counts and digests of `report`, then a read of the rows through the Worker's own readers) run under that exclusion;
4. only then the marker flips, and the admitted writer afterwards is proven to be the new one;
5. a **paused R2 write across the handover** is tested (a write started before the close and completed after the flip must not change the imported state or be acknowledged as delivered).

Also for AIR-554: capture a comparable natural production baseline before the cutover and compare normal Task runs after it (same prompt, model and batch configuration; incident, EPG, catalog-hold and recovery cohorts separate; sample counts, successful films per hour, completed/interrupted/skipped ratios, stage latency p50/p95, storage cost per successful prediction; preparation headroom against the 180 s claim TTL). No new Tasks, no manual model runs, no change of the claim TTL.

## Recovery

- **Stage.** Rows are the transferable held results; a stale row (profile or contract drift) is dropped by the next drain and reported; a digest conflict is `hold_conflict`. The head (`item_count`, `total_bytes`) is the aggregate cap; if it disagrees with the rows the next merge fails closed on the revision, never silently.
- **Sources.** Every revision is kept; the head names the current one. A piece that fails its hash is `prediction_aux_corrupt`, never data.
- **Manifest.** Create-only. A part that fails its piece digest, or a manifest whose hash does not match the durable run, answers `manifest_unavailable` (fail closed); the readiness edit and the manifest rows are one batch, so a run is never ready without a durable manifest.
- **Outbox.** A pending row is retried by the next authorized start (at most 20, three journal attempts each, oldest first, the latest run's records first); the 8th failed attempt quarantines it (visible in the status read, never taking a slot). A settled row's payload is compacted 14 days after settlement; a compacted row is never rebuilt or re-enqueued. Status counts: `eventOutboxStatus` (pending, quarantined, oldest pending, skipped active count and cap, cap refusals). A cap refusal never changes the refused request's answer.
- **Rollback.** Code rollback is not state rollback. After the flip a marker restored to `r2` is refused; the R2 objects are a frozen pre-flip copy, not a fallback. Restoring a database backup to a pre-activation state is an owner recovery operation, not a runtime path.
