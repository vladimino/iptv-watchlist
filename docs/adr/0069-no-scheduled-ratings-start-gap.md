# ADR 0069: A scheduled ratings start has no minimum interval after the previous one

**Status:** Proposed  
**Original decision date:** 2026-10-31  
**Recorded at:** 2026-10-31  
**Approval source:** Owner acceptance of this record is still required, as is visual approval of the changed sequence diagram in `docs/architecture/scheduling-and-orchestration.md`. The removal of the guard is the owner's decision of 2026-10-31 on [AIR-310](https://trello.com/c/yoaqG5b6). Accepting this record permits the ordinary PR delivery only. It does not authorize a ratings run, an EPG run, a flag change, a Task edit, a storage write or clearing an isolation.  
**Related work:** [AIR-310](https://trello.com/c/yoaqG5b6); [ADR 0060](0060-independent-letterboxd-ratings-pipeline.md); [ADR 0043](0043-removal-rating-lookup-queue.md); [ADR 0067](0067-diary-recent-window.md); the live Ratings Task change is a separate owner approval already carried out and is not repeated here  
**Supersedes:** In part: [ADR 0060](0060-independent-letterboxd-ratings-pipeline.md) decision 7, the `too_soon` answer (a scheduled start less than six hours after the last start, with `nextStartAt`). The 403/429 six-hour queue pause in decision 5, and every other decision of that record, stay.  
**Superseded by:** None

## Context

- **ADR 0060 decision 7 refused a scheduled start** that followed `lastStartAt` by less than six hours. The answer was `too_soon` with `nextStartAt`. A manual start was not gated. The constant was `SCHEDULED_GAP_MS` in `src/letterboxd-ratings.js`.
- **The owner removed that requirement on 2026-10-31.** There is no six-hour minimum between `ratings_sync_start` calls with `trigger: scheduled`. The guard is a redundant safeguard: a live run is already `busy`, the run record is already compare-and-swap, two interrupted runs at the same checkpoint already isolate the pipeline, and a Letterboxd 403 or 429 already pauses the removal queue.
- **The Ratings Task recurrence is already 17:30.** By a separate owner approval the live task is daily at 17:30 Europe/Madrid, flexible, DTSTART 2026-11-01, and its prompt asks for one Diary page. The coordinator's read-back is recorded on the AIR-310 card. This record documents that expected recurrence. It does not edit the task.
- **ADR 0068** is the open Letterboxd archive-apply record and is not this decision. This record is 0069.

## Decision

`ratings_sync_start` with `trigger: scheduled` has no minimum interval after `lastStartAt`. The reason `too_soon` and the field `nextStartAt` are not part of the answer. `SCHEDULED_GAP_MS` is not exported and is not consulted.

These protections stay, and this record does not weaken them:

- `busy` while a run is `running` and not stale, without handing out that run's id;
- the three-minute step lease and the 30-minute abandoned close;
- isolation after two consecutive interrupted runs in the same phase at the same checkpoint, cleared only by an owner-approved manual start with `clearIsolation: true`;
- the monotone compare-and-swap of `letterboxd/ratings/run.json`, so a start that lost the race cannot overwrite the newer record;
- the Letterboxd 403/429 six-hour queue pause (`pausedUntil`, ADR 0043 and ADR 0060 decision 5);
- idempotent merges of history, facts, the cursor and the queue.

`lastStartAt` remains the start timestamp of the current run record, the same instant as `startedAt`. Freshness continues to use the `endedAt` of finished and error summaries. The field is not a gate. No storage migration rewrites an existing record; the next successful start replaces the record as it already did.

What this record does **not** decide: automatic retries, a bypass of a Letterboxd 403, a manual production write, clearing an isolation, a flag change, a Task edit, or a ratings or EPG run. The Diary phase remains one page ([ADR 0067](0067-diary-recent-window.md)).

## Alternatives considered

Keep `SCHEDULED_GAP_MS`. The owner rejected that on 2026-10-31: the daily task and the protections listed above already bound a repeat start, and the six-hour answer was blocking a later scheduled start for no separate reason.

## Consequences

- A scheduled start soon after a finished run, and one soon after an error run, is `started`.
- Two overlapping invocations still receive one `started` and one `busy`.
- The sequence diagram in `docs/architecture/scheduling-and-orchestration.md` labels the Ratings Task `17:30, enabled` and the start answer `busy` or `isolated`. That rendered diagram needs the owner's visual approval before merge. The state diagram on the same page is unchanged.
- A deploy of this code does not start a run, does not change `RATINGS_PIPELINE`, and does not change the live task.

## Recovery and migration boundary

Removing the guard is a code change. Restoring it is a later code change; no stored object has to be rewritten either way. `lastStartAt` already on a production run record stays until the next start replaces that record. This record authorizes no flag, Task, EPG, Diary, lookup, R2 or D1 operation.

## Evidence

- **Original decision:** the owner decision of 2026-10-31 in the body of [AIR-310](https://trello.com/c/yoaqG5b6).
- **Implementation:** the pull request that delivers this record. The historical text of ADR 0060 decision 7 is left in place; the supersession is the header pointer on that record.
- **Dated verification:** offline tests in `tests/ratings-run.mjs` and `tests/ratings-api.mjs`. No production ratings start or step is part of this record.
- **Uncertainty:** whether the owner accepts this record and visually approves the changed sequence diagram. Both are pre-merge gates.

## Follow-ups

None. The live task is already at 17:30 by a separate approval. Extending the drift monitor to the Ratings Task remains the open follow-up of ADR 0060 and is not this decision.
