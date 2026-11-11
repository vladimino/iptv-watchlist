# Prediction queue independent of Discovery chunks, 11 November 2026

[AIR-431](https://trello.com/c/LXGD3quG). Offline evidence only: the Worker in a Node `vm` on an in-memory R2 and a real Discovery authority on a local sqlite D1 stand-in (`tests/prediction-queue-discovery-independence.mjs`). No production write, run, lease reset, flag, schedule or migration, and no production read for this report. Design: [ADR 0113](../../adr/0113-prediction-runner-advances-persisted-queue.md).

## Cause (from the code and the AIR-424 / AIR-417 captures)

Every `next`, `submit` and `complete` rebuilt the queue, and a rebuild reads the whole catalog through a fenced `routeRead` (generation compared before and after). A Discovery chunk, decision, continuation or Workflow write moves that generation, so under Discovery traffic the read failed with `discovery_fence` and the run waited on `prediction_catalog_held`.

## Method

The stand-in's `onQuery` hook moves `discovery_authority.generation` on every statement against `discovery_admission` while the "storm" flag is on, as a Discovery chunk landing between two statements. 200 admitted films (60 hot, 140 cold), a queue built beforehand, then `start` and a full run in batches of 20 with 1–10 films per `submit`.

## Results (one local run, indicative)

| Step | Observed |
| --- | --- |
| Full rebuild (`queue/reconcile`), quiet | 9 D1 queries, 1 whole-catalog read, ~50 ms |
| Rebuild under the continuous storm | fails; the fenced read is repeated 3 times |
| `start` under the storm | 200 running, `queueStale.reason: discovery_fence`, 4 whole-catalog reads (3 retries + 1 Event snapshot), 1 by-id read |
| `next` under the storm (35 calls) | 0 whole-catalog reads, mean 4.7 D1 queries (authority gate), ~8 ms |
| `submit` under the storm (38 calls) | 0 by-id reads; the only catalog read is the periodic progress Event (best effort) |
| `complete` | 200 `complete`, `snapshot.coverage: null`, `predictionGain: null` |
| Whole run | 34 batches, all 200 films predicted exactly once, no `discovery_fence` in the logs, no failed boundary, lease released |

Review follow-up (same file): a start whose first 25 hot films have no admission any more settles them and selects replacements; with every film missing it answers `noop` and the queue holds none of them; a reconcile that rebuilds the queue for a newer programme between a step's gate and its conditional write (forced CAS conflict) leaves that queue untouched by the old `submit` settlement and by the old completion (it keeps its `lastBatch` and counters). Mutants without the in-write gate fail both checks.

Other scenarios in the same file: a replayed `submit` is `already_current` and settles nothing twice; a film whose admission was superseded is never offered and leaves the queue; a published programme transition under the storm is the honest 503 `prediction_catalog_held` wait with the lease kept, and the run continues on the new generation once the storm ends; `enrichment/status` reads no catalog; `prediction_queue_overview` stays `eligible/ready` with `partial` and `catalog_unavailable`; `readAdmissionsById` chunks 250 ids into 4 statements, excludes superseded rows, and is closed on a held cutover, an incomplete load and outside D1 authority.

## Not proven

The production behaviour of a natural hourly Predictions run overlapping real Discovery chunks. That needs a natural run after deploy and is the verification step of the card; this report does not stand in for it.
