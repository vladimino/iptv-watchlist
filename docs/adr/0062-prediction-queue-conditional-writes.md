# ADR 0062: Every prediction queue writer writes conditionally and rebuilds on conflict

**Status:** Proposed  
**Original decision date:** 2026-10-31  
**Recorded at:** 2026-10-31  
**Approval source:** not documented (awaiting the owner's decision)  
**Related work:** [AIR-298](https://trello.com/c/VBVLAbuW), root finding in [AIR-281](https://trello.com/c/bjKa4hRj) / [PR #269](https://github.com/vladimino/iptv-watchlist/pull/269)  
**Supersedes:** None  
**Superseded by:** None

## Context

`enrichment/prediction-queue.json` (schema 3) is the derived projection the prediction runner selects work from. Membership, lanes and work classes are rebuilt from the published programme, the catalogue, the view index and the taste profile. The object also carries runner state that a rebuild cannot derive: `retries[id]` (`retryAt`, `attempts`, `kind`, `lastRunId`), `lastBatch`, `lastCheckAt` and `metrics`. A rebuild copies those forward from the queue it read.

The [AIR-298 inventory](../evidence/prediction/air-298-queue-writer-inventory-2026-10-31.md) found 14 write paths:

- **11 rebuild triggers** of `refreshPredictionQueue`:
  - runner routes: `scheduled` / `manual` at start, `next_priority`, `batch_progress`, `completion_check`, `batch_complete`;
  - `programme_updated` (EPG commit tail), `epg_scan` (EPG scan route), `profile_updated` (profile publication), `resolver_checkpoint` (discovery resolver) and `manual_reconcile` (owner route).
- **3 direct read-modify-writes:**
  - the start's idle check (`lastBatch`, `lastCheckAt`);
  - the submit's per-film retry record;
  - the completion's retries, batch summary and counter.

Every one of them wrote the whole object without an etag condition (`saveJSON`).

The runner routes run under the 90-second prediction writer lease. That lease is not renewed and is not checked before the write. The resolver runs under the discovery lease and renews it before the write. The EPG commit tail, the EPG scan, the profile publication and the reconcile take no lease. Two interleaving writers therefore lost an update silently: a rebuild that read the queue before a retry write put back the old `retries` map. The consequences:

- the film became eligible before its backoff ended (premature model work);
- its attempt counter restarted;
- a batch summary or a counter increment disappeared;
- a caller holding a programme or profile read before a publication could overwrite a newer queue.

This is a code hypothesis derived from the absence of conditions; no production incident was observed.

R2 supports conditional writes on the Workers binding. `put` with `onlyIf: {etagMatches}` or `{etagDoesNotMatch: '*'}` returns `null` when the condition fails ([Workers API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#conditional-operations)). The condition is evaluated atomically against the committed state, and competing conditional writes to one key are serialized ([consistency](https://developers.cloudflare.com/r2/reference/consistency/#conditional-writes)). `null` is an unambiguous conflict; a `put` that throws has an unknown outcome. The repository already relies on this for the view index (`updateViewIndex`), `mergeStoredJSON` and the runner, writer and discovery leases.

## Decision

The prediction queue keeps its single object and format, and every write of it becomes a compare-and-swap on the etag of the object the writer read.

1. **One conditional put.** All writers go through one `put` with `onlyIf: {etagMatches: <etag read>}`, or `{etagDoesNotMatch: '*'}` when the object was absent. No other code writes the key.
2. **Rebuild (`refreshPredictionQueue`).** Each attempt reads the queue and its etag first, then the profile, the view index and the catalogue, so a rebuild never rests on inputs older than the queue it replaces. When the stored queue names another programme generation than the caller's programme, the attempt rebuilds from the published programme instead. A stale caller cannot put back an older generation, and a newer queue makes the caller rebuild from the newer one. The carried state (retries of films still outstanding, `lastBatch`, `lastCheckAt`, `metrics`) comes from the queue just read.
3. **Recording (`mutatePredictionQueue`).** The submit's retry record, the start's idle check and a stopped run's missing retries apply their change to a fresh copy of the queue just read and put it conditionally. They never create an absent queue.
4. **Run bookkeeping inside the rebuild's write.** The completion applies its retries, batch summary and counter to its own `batch_complete` rebuild before the conditional put (`amend`). A conflict re-applies them to the next rebuild. The counter moves only when `lastBatch.runId` is not yet this run, so a repeated completion counts once.
5. **Retry records only grow while their film is outstanding.**
   - `attempts` is the larger of the run's count and the stored count plus one;
   - `retryAt` is the latest of the run's time, the stored time and the backoff of the merged count (1 hour doubling, at most 6 hours);
   - a record whose `lastRunId` is the run is written once;
   - the completion and every stop record any failure of the run that the submit's write did not land.

   A film that is no longer outstanding drops its record on the next rebuild, as before.
9. **A failed retry write fails closed.** A queued run's failure is saved on the run record with `retryHeal: pending` before the queue write. Only a queue write that confirms all of the run's failures clears the mark: the submit's, the completion's or a stop's.
   - When every attempt fails (a conflict through 5 attempts, a put that throws, or no queue object), the run still stops, but the mark stays.
   - The runner lease keeps naming its last run after release or expiry. Before acquiring the lease, the next start writes that run's marked retries.
   - If that write fails too, the start selects nothing, takes no lease and answers `503 prediction_retry_heal_pending`. A failed film therefore never becomes eligible before its `retryAt` because a write was lost.
   - A repeated attempt re-reads the queue, and a record that already carries the run's `lastRunId` is left as it is. An unknown outcome is therefore never doubled.
6. **Bounded conflict.** At most 5 attempts per call, with a short jittered pause between them (about 20 to 170 ms each, at most about 340 ms in total).
   - Exhaustion throws `PredictionQueueConflictError` (`code: prediction_queue_conflict`) and writes nothing of the caller's.
   - The owner reconcile answers `409 {code: prediction_queue_conflict}`.
   - Every other caller keeps its existing error path: the runner stops with `storage_error`; the EPG commit tail records `enrichmentQueueError` and continues; the resolver records `prediction_queue_checkpoint`; the profile publication stands and the next rebuild follows.
7. **Unknown outcome.** A `put` that throws is not repeated blindly. The error propagates, and the next writer reads whatever was stored.
8. **Leases unchanged.** Queue correctness does not depend on any lease. A lease holder's `beforeWrite` (the resolver's fence) renews before every attempt, so a writer that lost its lease writes nothing.

**Not decided:**

- no new lease and no change of lease ownership or TTL (the start reads the released lease's last run name, which it always kept);
- no separate retry object and no change of the queue format or any migration;
- no change of the retry policy, hot-first selection, batch sizing or which films are outstanding;
- no per-film recovery;
- no production queue refresh, reconcile, run, flag or Scheduled Task change.

The code is delivered in the AIR-298 PR. Deploying it changes how future scheduled runs, EPG commits and resolver chunks write the queue; it activates nothing new.

## Alternatives considered

1. **Conditional write with a rebuild from fresh state (chosen).** Every writer stays where it is, and only the write changes. The cost is a repeated rebuild under contention, bounded to 5. It covers retries, batch state and stale inputs in one rule.
2. **One shared writer lease for every writer, plus conditional writes.** The EPG commit tail, the EPG scan, the profile publication and the resolver would have to take the prediction writer lease.
   - They would answer `busy` to each other, and the EPG tail is already memory- and time-sensitive.
   - The resolver would hold the discovery and prediction leases in an order the runner does not share.
   - The 90-second writer lease is not renewed, so a long rebuild can outlive it, and conditional writes would still be needed as the fence.

   Rejected: more coupling and new failure modes for no correctness gain over 1.
3. **Independent retry state** (a separate CAS-written retry object, or one per film). A rebuild would no longer carry retries.
   - Every reader of `retries` would change: the runner selection, the footer and Event slices, data health, the Limbo inventory, the recovery assessment, the diagnostics and the offline importer classification.
   - The stored retries would need a migration with a dual-read window.
   - `lastBatch`, the counter and the stale-generation overwrite would remain unsolved.

   Rejected as broader than needed; it stays possible later on top of 1.
4. **Fence only the owner reconcile under the writer lease** (the partial mitigation in the AIR-281 evidence). The other blind writers remain. Rejected.

## Consequences

- No silent lost update of retries, batch state or counters; a stale generation or profile cannot overwrite a newer queue. Tests: `tests/prediction-queue-cas.mjs`.
- Storage per write is unchanged without contention: one read of the queue (formerly part of the inputs) and one put. A conflict adds one rebuild, at most 5 per call. The number of storage operations per rebuild does not grow with the queue size.
- A conflict that persists through 5 attempts is now an explicit error where it used to be a silent overwrite. For a runner it means a `storage_error` stop, after which the next scheduled run continues. Its retries are written by the stop or, failing that, by the next start before it selects anything. While they cannot be written, starts answer `503 prediction_retry_heal_pending` and run nothing: availability is traded for the backoff guarantee.
- Deleting or resetting the runner lease by hand would drop the pointer to an unsettled run; the runbook forbids it.
- Retry records written by the completion now also carry `failedAt` and `validation` when the run knows them. That is a superset of the former shape, and readers ignore unknown fields.
- Each rebuild of a caller whose programme differs from the stored queue's generation reads the published programme once more. This happens only in that case, which keeps the memory-sensitive EPG tail at its current reads.

## Recovery and migration boundary

The stored format is unchanged, so a code revert needs no data change. After a revert the blind writes return together with their risk. Neither this change nor its revert restores retry metadata already lost. No migration, backfill, queue refresh or reconcile is part of this decision. Accepting this ADR approves the architecture only: any production queue operation, run, flag or Scheduled Task change still needs its own owner approval.

## Evidence

- **Original decision:** [AIR-298](https://trello.com/c/VBVLAbuW), from the [AIR-281 audit](../evidence/prediction/air-281-targeted-recovery-no-go-2026-10-31.md).
- **Implementation:** the AIR-298 PR (branch `cursor/air-298-queue-cas-3186`).
- **Dated verification:** [writer inventory and offline race tests, 2026-10-31](../evidence/prediction/air-298-queue-writer-inventory-2026-10-31.md); no production run.
- **Uncertainty:**
  - how often writers interleave in production is not measured;
  - conflict exhaustion is expected to be rare but is not observed;
  - R2 behaviour is taken from the Cloudflare documentation and the repository's existing conditional writers, not from a production experiment.

## Follow-ups

- The owner decides `Accepted` or `Declined` before merge.
- A per-film recovery writer (AIR-281 alternative 1) would build on this contract and needs its own card and ADR.
