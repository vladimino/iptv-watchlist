# AIR-353: wall time of the staged publication

**Captured:** 2026-11-06 and 2026-11-07 (UTC). **Method:** read-only Worker observability (`epg_phase` and `epg_continuation` events, request outcome), Workflow step records and D1 `SELECT`. No write, retry or start.

## The combined `publish` step of run `307a3e1d…` (6 November 2026)

| Part | Wall time |
| --- | --- |
| Request entry to the phase (17:56:30.7 to 17:56:33.1) | 2.4 s |
| `seal_publish`: pointer, mirrors, generation copy, discovery intent, `uncertain.json` (to `finish_sync` at 17:57:04.5) | 31.4 s |
| `finish_sync` before the queue refresh: watchlist, scan observation, events (to 17:57:21.6) | 17.2 s |
| `queue_refresh` (to 17:57:48.5) | 26.8 s |
| Reply: completion, discovery series, response (to 17:57:55.8) | 7.4 s |
| **Request total** (`epg_continuation` `durationMs`) | **83.7 s** (Worker outcome `ok`, wall 85.6 s, CPU 4.2 s) |

The request ended `ok` on the Worker while the MCP client of the operator had timed out at 60 s. The other steps of the same run: ledger (`items`) about 36 s, catalog about 30 s (the last one 4.9 s), each below 60 s.

## Pre-chunk time of the Workflow chunk

A Workflow chunk step of 27.4 s carried a summary `totalMs` of 22.3 s (instance `_2`, 19th chunk): about 5 s lie outside the chunk's own clock (owner check, continuation read, lease, generation and programme reads in `advanceDiscovery`). The Workflow runs a chunk in a step of ten minutes, so this does not meet a 60 s client. From this change the chunk reports the preflight as `timings.preChunkMs`.

## Reading

- The combined step has no single slow part: four parts of 17 to 31 s sum to 83.7 s. The cuts of [ADR 0096](../../adr/0096-bounded-seal-publication-steps.md) give about 34 s (`publish`: entry plus 31.4 s), about 20 s (`finalize`: 17.2 s plus the ratings hand-over) and about 34 s (`queue`: 26.8 s plus the 7.4 s reply). These are estimates from the measured parts.
- A request cancelled by the client, as the 3 s cancellation of 6 November at 16:32:35 UTC, leaves a discovery lease of 90 s. That is a separate contract question (`busy`/`wait`) and is not changed here.

## Limits

No production run through the new steps exists yet. The estimates assume the parts keep their sizes; a larger programme or a slow D1 day moves them. The first natural publication after deploy is the measurement.

## Offline checks of the change

- Production-sized volume (`SEAL_FULL=39920 node tests/discovery-seal-resume.mjs`, local SQLite stand-in): the ledger seal of 39,920 observations took 1,331 batches of 30 and 40.9 s of stand-in time, and every kill point resumed. This is the ledger step; the publication does not scale with the observation count.
- `publish` as four units around one pointer (`tests/discovery-seal-publish.mjs`): a changed fence refuses the step and publishes nothing; a cancellation before the pointer leaves the previous generation and the repeat publishes once; a cancellation after the pointer and before the intent leaves the pointer moved exactly once and the repeat queues the intent once; a passed deadline stops the step after the pointer and after each unit with a saved checkpoint and four calls finish the phase with one pointer, one mirror write, one copy and one intent.
- The request budget is counted from the request's entry: 32 s before a unit may start in the ledger and catalog steps (small units), 20 s in the three publication phases (large units). `finalize` has four units (hand-over, watchlist, scan, events) and `queue` one; a passed deadline gives one unit per call (a test: four calls for `finalize`). The worst case of a publication step is its budget plus the longest unit started before it; the unit durations are not known individually (only the sum of 31.4 s for the pointer, mirrors, copy and intent), so the new per-unit phase markers are the measurement and the 45 to 50 s target is **not yet demonstrated**.
- A failed mirror write or copy is retried up to three times and then reported as degraded, never recorded as done; a lost answer and a restart after a checkpoint resume from the saved units (tests with a slow pointer, a retried mirror write, a copy that always fails).
- Not measured offline: the wall time of the new steps on production data; the stand-ins do not reproduce D1 and R2 latency. The first natural publication after deploy is that measurement.
