# ADR 0113: The Prediction runner advances the persisted queue; the catalog is read only at named rebuild boundaries

**Status:** Accepted  
**Original decision date:** 2026-11-11  
**Recorded at:** 2026-11-11  
**Approval source:** scope of [AIR-431](https://trello.com/c/LXGD3quG) (P1: the Prediction queue must advance independently of active Discovery chunks), confirmed by the independent review of PR #508 (the card scope authorizes the outcome; no further owner gate)  
**Related work:** [AIR-431](https://trello.com/c/LXGD3quG), AIR-417, [AIR-424](https://trello.com/c/KZ51Kn7N), [ADR 0064](0064-prediction-queue-conditional-writes.md), [ADR 0085](0085-d1-authoritative-discovery.md)  
**Supersedes:** None  
**Superseded by:** None

## Context

Until now every `prediction_next`, `prediction_submit` and `prediction_complete` of a run rebuilt the whole queue (`refreshPredictionQueue`): it re-read the profile, the view index, the programme and the whole Discovery catalog (`epg/discovered-films.json`, up to 20000 rows through `routeRead`). A `routeRead` is fenced: it compares the Discovery authority generation before and after the read and refuses with `discovery_fence` when it moved. Every Discovery chunk, decision write, continuation write and Workflow write moves that generation. While Discovery was running, nearly every runner step met a fence, the runner answered the `prediction_catalog_held` wait (AIR-424), and a run advanced a few films and then waited until its lease expired. The Predictions queue therefore depended on Discovery being idle, although nothing the runner needs per step lives in the catalog: the work list is already stored in the queue.

## Decision

1. **The persisted queue is the work list of a run.** `next`, `submit` and `complete` read the stored queue (`currentPredictionQueue`) and use it as it is when `queueAdvanceGate` accepts it: valid shape, the programme the caller reads, the same profile hash and version, the same fingerprint schema, fingerprint and prediction prompt versions and the same fingerprint registry digest. A queue that fails the gate is rebuilt by the existing full rebuild.
2. **A written prediction settles its film out of the queue, under the gate inside the write.** `submit` applies `settleQueueFilms` (pending, hot and cold lists, priority, work and retries, counters, `hotPredicted`) to the films with status `created`, `recalculated` or `already_current`, in one conditional queue write (`mutatePredictionQueue`, trigger `batch_progress`). `complete` settles every successful film of the run again, idempotently, inside its own `batch_complete` write, together with the retries, `lastBatch` and the once-per-run counter. The gate is repeated on the queue the conditional write actually mutates (`guardedSettle`): a retry after a CAS conflict that loads a queue rebuilt for another programme, profile, contract or registry does not settle into it, and the completion then adds only the run's own retries (which only grow), leaving that generation's `lastBatch` and counters alone. The statistics of the last rebuild (`compatibility`, `fingerprintCompatibility`, `discovery`) stay as they were until the next rebuild.
3. **A step reads only the films it needs, by id.** The metadata of a new batch comes from the watchlist programme, then from `DiscoveryAuthority.readAdmissionsById` (indexed `film_id` lookups in chunks of 80, current rows only, one authority check, no generation compare: each statement is atomic), and from the R2 catalog only outside D1 authority. A film the queue lists whose admission is gone (superseded after the queue was written) is settled out of the queue under the same gate and replaced by the next ready ids, in `start` as well as in `next` (`pickBatchWithFilms`, at most 25 rounds), so a batch of missing films is never repeated; with nothing left a start answers `noop`. If the gate refuses settlement of missing admissions during `start` or `next`, the step answers `503 {status: "blocked", reason: "queue_changed", code: "prediction_queue_changed"}`. A `submit` that has already committed a prediction returns its result even if the subsequent settlement was refused; the next named refresh can reconcile it. `complete` preserves the newer queue's `lastBatch` and counters and records only the run's retries. `enrichment_status` no longer reads the catalog (`selectedCount` comes from the queue) and survives an unreadable Discovery status record.
4. **Full rebuilds remain at named boundaries:** `start` (forced), a changed programme, profile or contract, and the named refresh callers (EPG tail, resolver checkpoint, profile update, reconcile). A rebuild that reads the catalog repeats the fenced read up to three times (each a fresh read) before it fails. A `start` that finds the catalog held, or loses all three reads, runs on the persisted queue when it still passes the gate and is not older than 12 hours; the answer carries `queueStale {reason, ageMs}`. Otherwise it keeps the existing `prediction_catalog_held` wait.
5. **Event coverage is never guessed.** When the programme, the catalog or the view index cannot be read for an Event snapshot, `snapshot.coverage` is `null` and `delta.predictionGain` is `null`.
6. **What this changes for the live Task:** nothing in the protocol. The wait stays valid at its real causes (a programme transition under a held or loading Discovery authority).

**Not decided here.** No production run, flag, schedule, migration or data write is authorized. Delivered in code; not deployed or production-verified until a post-merge deploy and a natural hourly run overlapping Discovery chunks.

## Alternatives considered

- **Retry the fenced read inside every step.** Rejected: it does not remove the dependency and the read is up to 20000 rows per step.
- **Read the catalog without the fence in the runner.** Rejected: a half-moved catalog would feed a rebuild; the fence is correct for a rebuild and unnecessary for a lookup by id.
- **Time-based soft refresh inside a run.** Not adopted: the named refresh callers already rebuild on every Discovery chunk and every EPG commit; a run that misses a film admitted mid-run picks it up at its next batch after that refresh.

## Consequences

- A step costs a few R2 reads and one queue write; it no longer scales with the catalog, and Discovery traffic cannot fail it.
- A new film admitted mid-run reaches the queue through its refresh, not through every step. A completed run's `queue_empty` therefore means "empty as of the last rebuild"; the next start rebuilds.
- Queue statistics (`compatibility`, `discovery`) can be older than the pending lists until the next rebuild.

## Recovery and migration boundary

Code only; no data, flag or marker changes. A code revert restores the per-step rebuild; the queue format is unchanged (the mutation only removes entries and adds `advancedAt`). An ADR never itself authorizes operations.

## Evidence

- **Original decision:** [AIR-431](https://trello.com/c/LXGD3quG)
- **Implementation:** the AIR-431 pull request
- **Dated verification:** [AIR-431 evidence](../evidence/prediction/air-431-queue-independent-of-discovery-2026-11-11.md) (offline, local stand-ins only)
- **Uncertainty:** production behaviour under a natural overlap of the hourly Predictions Task and Discovery chunks is not observed.

## Follow-ups

Production verification on a natural run; the live Task prompt is unchanged.
