# AIR-480: natural Discovery retry after `discovery_conflict` (15 November 2026)

Method: read-only production observation after the scheduled wait `2026-11-15T13:00:00.000Z` (14:00 Europe/Madrid). Capture clock **14:01 Europe/Madrid** (`2026-11-15T13:01:40Z` timer; D1 read immediately after). No EPG, Discovery, TMDB, prediction, ratings, R2, D1, flag or Scheduled Task write. No run was started.

Follows [the INCOMPLETE delay snapshot](air-480-natural-run-delay-2026-11-15.md). Independent review of that snapshot asked to observe this natural retry and not treat `remainingChunks` as an observation count. Trello: [AIR-480](https://trello.com/c/ZS0Xdrlq).

## What ran

Hourly reconcile created successor **series 83**, instance `discovery_0e4a5f908f504c6db74980c7565194a2_83`, same pinned run `0e4a5f90-8f50-4c6d-b749-80c7565194a2`.

Worker log (service `iptv`, needle `discovery_workflow`): one `discovery_workflow_reconcile` with `reason=in_progress` at about `2026-11-15T13:00:44Z`. Needles `discovery_workflow_step_failed` and `discovery_conflict` over `12:20–13:10Z` returned **zero** events. The original hard wait’s exception text is still **not** in logs; the stored `lastProgress.error` on series 82 was `unknown`.

D1 `discovery_workflow` after the first chunk of series 83:

| Field | Value |
| --- | --- |
| `phase` | `running` |
| `reason` | `null` (no longer `discovery_conflict`) |
| `waitingUntil` | `null` |
| `chunksThisInstance` | 1 |
| `updatedAt` | `2026-11-15T13:00:43.282Z` |
| `recovery` | `null` |
| Discovery authority generation | 129498 (was 129478 at the 13:47 Madrid snapshot) |

The wait until the next UTC hour **did** open a successor that completed one chunk. That is not proof that every future `discovery_conflict` auto-recovers, and it does not identify the failed step.

## Last chunk (durable `discovery_status`)

Hop `c1536b6a-0ca9-4373-b146-224d331ebe2a`. `stage=partial`, `startedAt=2026-11-15T13:00:09.466Z`, `finishedAt=2026-11-15T13:00:41.133Z` (32 s). `checked=6`, `remaining=5490`, `cheapRemaining=0`, `tmdbCalls=13`, `added=1`, `reused=0`, `touched=31`, `paged=true`, `error=null`.

Assignment totals on that chunk (not generation-lifetime):

| Field | n |
| --- | --- |
| `assigned` | 1 |
| `present` | 69 |
| `replayed` | 38 |
| `replayRemaining` | 0 |
| `evidence_drift` / `slot_taken` / `film_absent` / `stale_run` / `decision_changed` / `observation_inactive` / `slot_absent` / `refused` | 0 |

Revalidation totals on that chunk: `observations=0`, `revalidated=0`, `revalidation_failed=0`, `revalidation_exhausted=0`, `deferred=0`.

`replayRemaining=0` is this chunk’s replay queue, not a complete generation replay. Ledger `remaining=5490` is still outstanding. `remainingChunks=5` on the earlier snapshot was the continuation invocation budget, not 5 observations.

## Published shows

`basis='discovery'` on run `0e4a5f90…`: **15 046** rows / **5 633** films (was 15 045 / 5 632). The +1 row matches this chunk’s `assigned=1`. Still no `created_at` on `published_epg_show`; first-assignment wall time for the generation remains unknown.

## Verdict

**PARTIAL / still INCOMPLETE for AIR-480 R2.** Natural hourly retry after a hard `discovery_conflict` wait **did** resume (series 83, one productive chunk with assignment counters). Cause of the conflict is **unidentified**. Generation replay is **not** complete (`remaining=5490`). First-row delay is **still unobserved**. Next EPG due remains `2026-11-15T16:00:00.000Z` (17:00 Europe/Madrid) and is a due time, not a promised complete time.

Does not accept AIR-480 runtime and does not unblock AIR-374.

The 14:01 Europe/Madrid rows above stay a point-in-time observation. Same series then failed again; see the addendum.

## Limits

- IPTV MCP token refresh failed at the 14:01 capture; that state is D1 + one Worker log event.
- No film ids copied out.
- Series 83 was still `running` after the first chunk at 14:01; the second chunk of that hour is in the addendum, not in the tables above.

## Addendum: recurrent `discovery_conflict` on series 83 (14:06–14:12 Europe/Madrid)

Independent review of HEAD `b984c93d` asked for this extension after a live read at 14:08 Europe/Madrid. Executor D1 `SELECT` at **14:12 Europe/Madrid** (`2026-11-15T13:12Z`) confirms the same series, no writer.

| Field | Value |
| --- | --- |
| instance | still `discovery_0e4a5f908f504c6db74980c7565194a2_83`, series 83 |
| `phase` / `reason` | `waiting` / `discovery_conflict` |
| `waitingUntil` | `2026-11-15T14:00:00.000Z` (15:00 Europe/Madrid) |
| `chunksThisInstance` | 2 |
| `updatedAt` | `2026-11-15T13:06:23.900Z` |
| `lastProgress` | `stage=error`, `checked=0`, `error=unknown` |
| Discovery authority generation | 129518 |

Overwritten `discovery_status` (hop `530f9609-8828-4fa8-8a00-34d1f03b492f`): `stage=partial`, `startedAt=2026-11-15T13:05:50.262Z`, `at=2026-11-15T13:05:55.347Z`, `finishedAt` absent, `checked=0`, no `assignment` object. Independent review also recorded last checkpoint `2026-11-15T13:06:21.497Z` and operational `remainingChunks=4` (invocation budget, not observation backlog).

`basis='discovery'` on the same run: **15 047** rows / **5 634** films (was 15 046 / 5 633 at 14:01). A second address-level write happened before the hard wait.

Worker log needles `discovery_workflow_step_failed` and `discovery_conflict` for 13:04–13:08:30 UTC were **zero** in the review’s read. Absence of those events does not prove no failure. The failing statement or constraint is **not** established. No RCA is claimed.

**Amended verdict:** productive retry on series 83, then a **recurrent hard `discovery_conflict`**. AIR-480 R2 remains INCOMPLETE. Next natural catch-up is 15:00 Europe/Madrid, not started from this session.
