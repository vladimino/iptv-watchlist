# ADR 0030: The EPG commit opens the discovery series as soon as its generation is published

**Status:** Proposed  
**Original decision date:** 2026-10-27  
**Recorded at:** 2026-10-27  
**Approval source:** [AIR-212](https://trello.com/c/c1NQNHRa) card scope (durable discovery enqueue before the commit tail); owner review decision on the hourly gate in [PR #161](https://github.com/vladimino/iptv-watchlist/pull/161#pullrequestreview-5673484347)  
**Related work:** [AIR-199 RCA](https://trello.com/c/GCfptxao), [PR #160](https://github.com/vladimino/iptv-watchlist/pull/160), [AIR-159](https://trello.com/c/Av3wSEY8)  
**Supersedes:** None  
**Superseded by:** None

## Context

On 27 October 2026 the daily EPG commit published a new generation. Both commit calls were then killed with `exceededMemory`. The retry saved `sync.json` as `complete`, then died before `queueDiscovery`. Discovery was left on the previous generation's spent `paused/chunk_budget/0` series. `continuationHealth` reports such a record as `settled`, and the hourly task's stage A only continues a series that has outstanding chunks. As a result, no scheduled caller made the step that the [AIR-159](https://trello.com/c/Av3wSEY8) generation handoff needs ([evidence](../evidence/epg-commit-interrupted-2026-10-27.md)).

`syncStep` called `queueDiscovery(env,'epg_committed',runId)` only after `epgSync` had fully returned. Before that, the commit runs `finishSync` (watchlist and events, `sync.json`), `refreshPredictionQueue` and the ratings refresh, and these parse the largest objects.

## Decision

The commit opens the discovery series for its own generation immediately after the generation is in place, before the commit tail:

- on the full path, right after `publishEpgGeneration` has switched the pointer and copied the generation into the shared objects;
- on the resume path (`run.events` set and the shared `programme.json` already carrying this run), right after `copyEpgGeneration`.

The write is the existing `queueDiscovery`. Its guarantees are unchanged:

- it refuses a generation that is no longer the published one;
- it keeps a live writer's `running` record;
- it keeps a stored series of the same generation, with its progress;
- it is a compare-and-swap against the record it read.

A failure of this early write is recorded as `run.discoveryError` and does not fail the commit. The final `queueDiscovery` in `syncStep` stays as a second, idempotent attempt. The AIR-159 handoff remains the repair for a commit that ends between the pointer switch and the early write, and for state written by an earlier Worker.

**Hourly gate (owner decision on review):** the hourly task's stage A calls `epg_sync_step` only when `epg_status.stage` is `complete`, in addition to every existing generation, lease, backoff and wait guard. This applies to every stage A step: an ordinary continuation, the orphaned-`running` recovery and the AIR-159 generation handoff of a stranded earlier-generation record (such as the AIR-199 `paused`/`chunk_budget`/0 case). An early-queued series is not proof that the commit's tail finished. At `stage: epg`, a step retries the commit (`finishSync`, prediction queue, ratings). That is the daily run's work, not discovery, and it can repeat the memory failure.

**Not decided:** no change to the chunk budget, the series vocabulary, leases or memory use. Nothing here runs TMDB or a chunk. The live hourly Task prompt is updated to the gate only after this delivery is approved and merged, as a separate owner-authorized Task change that preserves its :20 schedule, stage B and the other safeguards.

## Alternatives considered

From the AIR-199 report:

- (a) report `generationConflict` for every stage and let the hourly task make one handoff step. This changes the Task contract and does not prevent the stranded state.
- (c) lower peak memory in the tail. This is tracked separately and makes no guarantee about ordering.

This ADR is (b).

## Consequences

- An invocation killed anywhere after the early write leaves a checkpoint of the published generation, `paused/epg_committed/12`. Read-only status then shows outstanding chunks for the right generation.
- A repeated commit of the same run keeps that series. It does not issue a second initial budget and does not lose progress.
- **New intermediate state:** `sync.json` can stay in stage `epg` (commit tail not finished) while the published generation already has an open series. In that state `epg_sync_step({runId})` is still a commit retry, not a chunk. It takes the resume path: it does not download the EPG again and makes no TMDB call, but it repeats `finishSync`, the prediction-queue refresh and the commit's single ratings attempt.
  - The hourly task does not make that call: stage A requires `epg_status.stage=complete`. The retry is left to the run's own daily task or an owner-approved manual step.
  - Until the live hourly prompt carries the gate, its older wording could take such a step. The window is limited to a commit that was interrupted after publication.

## Recovery and migration boundary

The change is code only; rolling back restores the old order. Existing storage is not migrated. A stranded record written before this change is still recovered only by an explicit continuation step (AIR-159). This ADR authorizes no production step, retry, lease reset or Task edit.

## Evidence

- **Original decision:** [AIR-212](https://trello.com/c/c1NQNHRa)
- **Implementation:** `src/worker.js` (`queueCommittedDiscovery`, `epgSync`); tests `tests/epg-commit-durable-enqueue.mjs` (case 7 models the hourly gate on the Worker's read-only views) and `tests/epg-commit-interrupted-handoff.mjs`
- **Dated verification:** not recorded (no production commit has run with this code)
- **Uncertainty:** where memory runs out in the commit is not established ([AIR-199 report](../evidence/epg-commit-interrupted-2026-10-27.md)). A kill before the pointer switch still leaves the previous generation authoritative, as ADR 0008 requires.

## Follow-ups

- Memory pressure in the commit tail and in chunk checkpoints: a separate card.
- Update the live hourly Task prompt with the `stage=complete` gate after merge (separate owner-authorized Task change).
