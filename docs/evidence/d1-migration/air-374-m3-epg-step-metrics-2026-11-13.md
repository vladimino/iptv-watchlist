# AIR-374 M3: read-only EPG step metrics from the Worker logs (13 Nov 2026)

**Two parts.** Part A (the baseline of 6 to 12 Nov) and Part B (the natural EPG run of 13 Nov 16:00 UTC). Capture times are given per part below. Part B is the representative measurement for D-C; Part A is kept as the earlier behaviour.

**Part A captured:** 2026-11-13, about 14:45-15:10 UTC. **Method:** read-only telemetry queries (`POST /accounts/{id}/workers/observability/telemetry/query`, views `events` and `invocations`, service `iptv`) through the Cloudflare API connector, under the owner's chat GO of 13 Nov 2026 (`GO на M2b/M3, только чтение`, repeated "GO все еще в силе"). The queries read logs and wrote nothing; no EPG run, Workflow instance, flag, Task or marker was touched. This GO covered this read only. Counts and timings only: no run id, request id, film id or payload is recorded here.

**Status of Part A: a BASELINE, superseded for D-C by Part B below.** The window (6 to 12 Nov) precedes the performance fixes of 8 and 11 Nov and the restoration of `DISCOVERY_LEDGER_MODE=bounded` on 12 Nov (owner statement of 13 Nov, not verified here), so the memory outcomes below describe the earlier behaviour. Part B reads the next natural run passively (logs, Workflow history and D1 SELECTs; no run started by the reader).

**Window and limits.** The telemetry keeps about 7 days: the oldest EPG event found is 2026-11-06 16:04 UTC and the newest 2026-11-12 16:32 UTC (the daily run of 13 Nov 16:00 UTC had not happened at capture time). A single point-in-time read of the retained logs, not an independent replay. The `invocations` view does not name the Workflow class, so a Workflow invocation cannot be attributed to the EPG Workflow rather than Discovery or Ratings by this read.

## Part A: what the EPG phases cost (events `epg_phase`, edge `exit`, `elapsedMs`)

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

### Part A memory

- Two log lines `Worker exceeded memory limit.` (service `iptv`) at 2026-11-12 16:20:15 UTC and 16:26:16 UTC, inside the 12 Nov EPG run.
- Workflow invocations with outcome `exceededMemory`: the narrow 16:00-16:45 UTC window of 12 Nov returned 3 records (CPU up to 54.5 s, wall up to 810 s), the 7-day aggregate returned 1 on 11 Nov and 1 on 12 Nov. The two reads of the `invocations` view disagree on the count, so the numbers are indicative only; the log lines are the firmer fact. Outcome `canceled` appears 1 time on 8 Nov, 2 on 9 Nov and 1 on 11 Nov. The cause is not established by this read and is not guessed here.
- Workflow invocation CPU where reported: 12.7 s to 91.8 s per invocation, wall 4.4 to 43.5 minutes (all Workflow classes together).

### What Part A does and does not settle for D-C

- It gives the real wall time of an EPG step (about 30 s), the order of a Workflow invocation's CPU, and a memory signal during the EPG run. A producer pass inside the same Workflow run adds to that memory and CPU: the memory outcome is the constraint to weigh before choosing a slice size or running the producer in the same invocation as publication.
- It does NOT give: D1 calls per EPG step, the round-trip time on the EPG path, or the CPU of one step handler; the `/api/sync/epg` step invocations are not separated in the retained window.
- `changedShare`, the Person and credit unit volume and the cost of a producer pass (M2b) are not measured here.

Nothing here authorizes any production operation or chooses a D-C parameter.

## Part B: the natural run of 13 Nov 2026 (read-only)

**Part B captured:** 2026-11-13, after the run finished (Workflow `complete` at 16:44:56 UTC) and before this part was committed (17:33:08 UTC). The reads did not record their own start times; the bounds that were observed are: the Discovery Workflow list returned an instance created at 16:53:11 UTC, and the database clock read 17:14:12 UTC in the Discovery state SELECT; one later SELECT (Discovery decision counts) was not timestamped. No end time is claimed beyond the commit time.

**Method.** The same telemetry queries as Part A, plus read-only GETs of the Workflow history (`/accounts/{id}/workflows/iptv-epg/instances/{id}` and `iptv-discovery`) and SELECTs on the D1 Discovery tables, under the owner's chat GO of 13 Nov 2026 (read-only; "смотри логи", "собирай, дорисуем полную картину"). Nothing was started, retried, written or changed. Counts and timings only: no run id, request id, film id or payload is recorded.

**Outcome.** Due 16:00 UTC, published 16:44:34 UTC, latency 44 min 34 s (target 15 min), phase `done`, health `healthy`. The two earlier days for comparison (owner Trello readbacks): 12 Nov 32 min 20 s, 11 Nov 94 min 7 s. The EPG Workflow ran 16:00:48 to 16:44:56 UTC: about 36 min of waits and about 8 min of work (approximate; the figures below are rounded from step times and are not exact arithmetic). The waits fall in two different classes that must not be added up as one cause: about 26.5 min of waits tied to contention with other writers (about 4.5 min projector window, about 22 min of cooldowns after three application-level failures, two of them coded `resolver_busy` while a Discovery chunk step ran; see below) and about 9.6 min of step-lease waits after two memory deaths of the EPG Workflow itself, which are not waits for another writer.

### Step wall time and volume (the successful sync run, `epg_phase` exit)

| Phase | wall (ms) | Volume |
| --- | --- | --- |
| `epg_input_scan` | 1,588 | (1,874 and 1,392 in the two failed attempts) |
| `seal_stage` (total) | 122,644 | plan 18,758 (7,071 departures, backlog 16,429), archive 78,933, emit 14,640 |
| `seal_stage_archive` | 78,933 | 64 segments, 10 fences done, 56 skipped; fenceMs 17,587, readMs 15,895, putMs 44,095; 58.4 MB |
| `seal_stage_emit` | 14,640 | 36,999 items, 45.8 MB |
| `items` (ledger step) | 30,829 | 22,000 items, 130 batches, writeMs 29,128, cursor 35,200 of 36,999 |
| ledger done | 17,321 | 1,799 items, 14 batches, writeMs 2,965, 16 archives, archiveMs 12,293 |
| `seal_catalog` | 19,106 and 4,251 | 9,226 items, 65 batches, 1 read, writeMs 14,418 |
| `seal_publish` | 21,912 | pointer 5,620, mirrors 5,165, copy 5,011, intent 4,618 |
| `seal_finalize` | 16,651 | watchlist 828, scan 11,951, events 1,947, handover 324 |
| `seal_queue` | 10,974 and 14,459 | |

#### Per-phase and per-step inventory (as retained in the logs)

Every `epg_phase` exit or error event that the telemetry returned for this run (52 events including enters; log completeness is not proven). With n of 1 to 3 per phase a distribution is meaningless, so the values are listed. `epg_input_scan` exit 1,392 / 1,588 / 1,874 ms and error 1,556 ms (n 3 and 1); `seal_stage` exit 122,644 ms (n 1) and error 1,261 / 1,334 ms (n 2); `seal_stage_plan` 18,758; `seal_stage_archive` 78,933; `seal_stage_emit` 14,640; `items` 30,829; ledger `done` 17,321; `seal_catalog` 4,251 / 19,106 (n 2); `seal_publish` 21,912 with `pointer` 5,620, `mirrors` 5,165, `copy` 5,011, `intent` 4,618; `seal_finalize` 16,651 with `handover` 324, `watchlist` 828, `scan` 11,951, `events` 1,947; `seal_queue` 10,974 / 14,459 (n 2). The three `epg_phase` error events are the application-level failures described below.

The Workflow history lists 18 action steps: 16 completed normally on the first attempt (wall min 4 s, median about 22 s, max 146 s, the `epg_commit` step that contains `seal_stage`), and 2 whose first attempt died on memory (28 s and 4 s before the death). This is a per-run inventory, not a distribution over runs. The Part A step time of about 30 s is of the same order for the item and catalog steps, not for every step.

The `items` step reports 22,000 items and a cursor of 35,200 of 36,999, so the cursor started at 13,200: the work before it is not in an exit event. It is consistent with the first, memory-killed attempt of that step (28 s of writes before its death, no exit event), but that attribution is an inference from the arithmetic, not an observation.

### Memory (now attributable to the EPG Workflow)

Two `Worker exceeded memory limit` outcomes, both inside the Workflow `iptv-epg` (the Workflow history names the step, which Part A could not): 28 s into the step that enters `seal_ledger`, and 4 s into the step that enters `seal_publish`. The `exceededMemory` invocations lasted 206 s (CPU 40.1 s) and 380 s (CPU 7.1 s). Each retry returned `step_lease_held` and the Workflow waited the rest of the 300 s step lease (276 s and 300 s). The cost is about 9.6 min. The mechanism is a HYPOTHESIS: memory accumulating across steps in one isolate (each invocation spans several steps). Heap size was not measured.

### Waits that are not step work (two classes)

Class 1, contention with other writers (about 26.5 min, approximate):

- 4.5 min sleep after the first step (`projector_window` branch, projector window busy).
- Three application-level failures of the `epg_commit` branch, 1.3 to 1.6 s after entering the phase: two coded `resolver_busy` (22.8 s and 21.5 s), one `unknown` (7.4 s), all HTTP 502; cooldowns 0.5, 5.3 and 16.3 min (about 22 min).
- All three failed attempts fall inside a `chunk` step of the Discovery Workflow of the previous run (about 52 s every 5 min 50 s, 3 chunks per instance). The Discovery chain ran about 23 h per programme run; its decisions per hour: 389, 276, 455, 169 in the 4 h after the previous publication, then about 25 in the 8 h from 07:00 to 14:00 UTC. A Discovery `plan` step failed `discovery_incomplete` 6 times while the EPG ledger seal ran, and that Discovery instance ended `errored` with no successor (the link to the EPG transfer state is read from the code, not proven).

### Class 2, step-lease waits after the EPG Workflow's own memory deaths (about 9.6 min)

See the memory section above; these are not waits for another writer.

### What Part B settles for D-C, and what it does not

- Settles, for this one natural run only: the observed wall time of the phases and steps listed above (`seal_stage` 122.6 s; the other completed steps from 4 to 36 s), the CPU order of a heavy invocation (40.1 s), and that two steps of the EPG Workflow died on memory on 13 Nov: a producer pass added to a heavy step must be budgeted against that. Waiting, in two classes (contention with other writers about 26.5 min; step-lease waits after memory deaths about 9.6 min), not the step handlers, accounts for most of the publication latency. It is not a per-step distribution over several runs and not an exhaustive per-step measurement.
- Does not settle: D1 calls per EPG step and the CPU of one step handler (still not separated), the heap profile, why all three attempts met a Discovery chunk, the text of the `unknown` error, and the fate of the previous Discovery run after its last instance errored. `changedShare` and the Person and credit unit volume (M2b) are not measured.

Nothing here authorizes any production operation or chooses a D-C parameter.
