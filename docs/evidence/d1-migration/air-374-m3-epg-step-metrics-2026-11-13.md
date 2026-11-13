# AIR-374 M3: read-only EPG step metrics from the Worker logs (13 Nov 2026)

**Captured:** 2026-11-13, about 14:45-15:10 UTC. **Method:** read-only telemetry queries (`POST /accounts/{id}/workers/observability/telemetry/query`, views `events` and `invocations`, service `iptv`) through the Cloudflare API connector, under the owner's chat GO of 13 Nov 2026 (`GO на M2b/M3, только чтение`, repeated "GO все еще в силе"). The queries read logs and wrote nothing; no EPG run, Workflow instance, flag, Task or marker was touched. This GO covered this read only. Counts and timings only: no run id, request id, film id or payload is recorded here.

**Window and limits.** The telemetry keeps about 7 days: the oldest EPG event found is 2026-11-06 16:04 UTC and the newest 2026-11-12 16:32 UTC (the daily run of 13 Nov 16:00 UTC had not happened at capture time). A single point-in-time read of the retained logs, not an independent replay. The `invocations` view does not name the Workflow class, so a Workflow invocation cannot be attributed to the EPG Workflow rather than Discovery or Ratings by this read.

## What the EPG phases cost (events `epg_phase`, edge `exit`, `elapsedMs`)

6 distinct EPG runs, 69 `epg_phase` events and 64 `epg_continuation` events in the window.

| Phase | n | p50 (ms) | p90 (ms) | max (ms) |
| --- | --- | --- | --- | --- |
| `items` (the per-step item pass) | 18 | 30,511 | 31,550 | 31,776 |
| `seal_catalog` | 4 | 28,995 | 29,827 | 29,827 |
| `seal_stage_plan` | 1 | 41,203 | 41,203 | 41,203 |
| `archive` | 1 | 29,597 | 29,597 | 29,597 |
| `seal_queue` | 1 | 27,878 | 27,878 | 27,878 |
| `seal_publish` | 3 | 20,425 | 24,196 | 24,196 |
| `seal_publish_mirrors` | 1 | 8,513 | 8,513 | 8,513 |
| `seal_publish_pointer` | 1 | 2,153 | 2,153 | 2,153 |
| `seal_finalize_watchlist` | 1 | 6,659 | 6,659 | 6,659 |
| `seal_finalize_scan` | 1 | 911 | 911 | 911 |
| `epg_input_scan` | 2 | 656 | 3,899 | 3,899 |

The item and catalog steps run about 29 to 32 s of wall time each (a bounded step budget), the seal phases 3 to 41 s. These events carry no CPU time and no D1 call count per step (some carry `reads`, `batches` and `writeMs`, not enough for a distribution).

## Memory

- Two log lines `Worker exceeded memory limit.` (service `iptv`) at 2026-11-12 16:20:15 UTC and 16:26:16 UTC, inside the 12 Nov EPG run.
- Workflow invocations with outcome `exceededMemory`: the narrow 16:00-16:45 UTC window of 12 Nov returned 3 records (CPU up to 54.5 s, wall up to 810 s), the 7-day aggregate returned 1 on 11 Nov and 1 on 12 Nov. The two reads of the `invocations` view disagree on the count, so the numbers are indicative only; the log lines are the firmer fact. Outcome `canceled` appears 1 time on 8 Nov, 2 on 9 Nov and 1 on 11 Nov. The cause is not established by this read and is not guessed here.
- Workflow invocation CPU where reported: 12.7 s to 91.8 s per invocation, wall 4.4 to 43.5 minutes (all Workflow classes together).

## What this does and does not settle for D-C

- It gives the real wall time of an EPG step (about 30 s), the order of a Workflow invocation's CPU, and a memory signal during the EPG run. A producer pass inside the same Workflow run adds to that memory and CPU: the memory outcome is the constraint to weigh before choosing a slice size or running the producer in the same invocation as publication.
- It does NOT give: D1 calls per EPG step, the round-trip time on the EPG path, or the CPU of one step handler; the `/api/sync/epg` step invocations are not separated in the retained window.
- `changedShare`, the Person and credit unit volume and the cost of a producer pass (M2b) are not measured here.

Nothing here authorizes any production operation or chooses a D-C parameter.
