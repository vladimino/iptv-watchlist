# Discovery `epg_sync_step` "Internal error" overnight, 28 October 2026 — RCA

[AIR-224](https://trello.com/c/l1SppklF) · read-only diagnosis.

**Captured at:** 2026-10-28 06:05–06:25 UTC. **Sources:** Worker `iptv` Workers Observability (read-only telemetry queries through the Cloudflare API: invocation outcome, wall and CPU time, request method, path and user agent, and the `epg_continuation` log lines; no other request headers, no cookies, no tokens), and the read-only IPTV MCP tool `epg_pipeline_status` (one call, 06:1x UTC). **Pinned repository reference:** `main` at `882487f` for the code analysis. **Scope:** every `epg_continuation` step from 27 October 20:00 to 28 October 06:00 UTC and every `exceededMemory` outcome of the Worker from 25 October 00:00 to 28 October 09:00 UTC. The Scheduled Task run identifiers come from the card; the task's own run history was not read. **Evidence lifecycle:** dated, historical observation; live state changes with the next scheduled run. **Operational authority:** none. No step, sync, discovery, TMDB call, retry, lease reset, flag, task, prompt, Access or storage change was made.

## Symptom

The hourly task `Почасовые прогнозы «В эфире»` reported a generic MCP `Internal error` in its discovery stage A and, correctly, did not repeat the call. Its prediction stage B completed every hour (`queue_empty`, `failed=0`). `continuationDiagnostics.recent` showed six step entries at `phase: entered` without a terminal entry, all for generation `b2699929…`.

## Affected runs

Every `epg_continuation` line in the window is a step `caller: mcp`, `route: /api/sync/epg` (an `epg_sync_step`). The invocation event of the same Workers request id carries the platform outcome. Start = invocation end − wall time.

| Ring entry `id` (prefix) | `entered` at (UTC) | Request id (prefix) | Invocation start (UTC) | Outcome / HTTP | Wall / CPU ms | Chunk committed? |
| --- | --- | --- | --- | --- | --- | --- |
| `1ffc65af` | 27 Oct 20:21:31.033 | `337d6773` | 20:21:30.798 | `exceededMemory` / 503 | 38 044 / 3 548 | not established |
| `def49eb5` | 27 Oct 21:20:01.745 | `51a0072a` | 21:20:01.453 | `exceededMemory` / 503 | 42 243 / 6 570 | not established |
| `99d59fd3` | 27 Oct 22:20:54.761 | `d1e837f3` | 22:20:54.283 | `exceededMemory` / 503 | 46 761 / 2 590 | not established |
| `f2cf006a` | 28 Oct 00:21:26.289 | `f57e8210` | 00:21:26.094 | `exceededMemory` / 503 | 39 591 / 3 577 | not established |
| `7ef5a250` | 28 Oct 01:24:24.058 | `ddd5662a` | 01:24:23.735 | `exceededMemory` / 503 | 38 298 / 3 719 | not established |
| `916d2561` | 28 Oct 02:17:33.166 | `d34e73ed` | 02:17:32.853 | `exceededMemory` / 503 | 40 994 / 3 832 | not established |
| `54e583f0` | 28 Oct 03:24:43.841 | `3d0187a3` | 03:24:43.536 | `exceededMemory` / 503 | 42 946 / 5 875 | not established |
| `6d343b5c` | 28 Oct 04:16:30.383 | `7d835f9d` | 04:16:30.282 | `exceededMemory` / 503 | 37 619 / 2 651 | not established |
| `0bcc66a3` | 28 Oct 05:22:31.665 | `72324870` | 05:22:31.437 | `exceededMemory` / 503 | 40 407 / 4 773 | **yes**, see below |

- All nine invocations: `POST /mcp`, user agent `openai-mcp/1.0.0 (Codex)`, platform message `Worker exceeded memory limit.`, no `completed` or `failed` line. Each `entered` line is the first line of its invocation (offset 0.1–0.5 s from the start); no other line was logged by these invocations.
- From 27 October 20:00 to 28 October 06:00 UTC no `epg_continuation` step got a response: 9 steps, 9 `exceededMemory`. No step was logged at 23:2x UTC.
- The card's 28 October 05:20 UTC run (scheduled_for `05:20:00Z`) is entry `0bcc66a3`.
- `exceededMemory` outcomes of the Worker per day, all on `POST /mcp`: 25 Oct 5, 26 Oct 16, 27 Oct 5, 28 Oct (to 09:00) 6. 28 of the 32 carry the `(Codex)` user agent; four on 25–26 October carry `openai-mcp/1.0.0` without it. The 27 October 16:04 and 16:06 calls are the EPG commit calls diagnosed in [the 27 October report](epg-commit-interrupted-2026-10-27.md).
- The last steps that did get a response are in the ring on 27 October 00:00–00:02 UTC (generation `23570366…`, `completed`, 33–35 s each).

### The 05:22 step committed before it was killed

`epg_pipeline_status` at 06:1x UTC:

- `lastBatch`: `startedAt 05:22:36.551`, `finishedAt 05:23:06.696`, `checked 2`, `added 1`, `tmdbCalls 4`, `touched 2407`, `remaining 15317`, `hopId 4fe09eb2…`, `programmeRunId b2699929…`.
- `continuation`: `paused`, `reason null`, `remainingChunks 6`, `hopId 4fe09eb2…`, `at 05:23:09.576`; `continuationHealth.status: settled`.
- The invocation ended at 05:23:11.844, 2.3 s after the checkpoint.

The step's chunk and its checkpoint were stored. The invocation was killed in the trailing writes (score preview, variant plan, lease release, diagnostics ring) or while forming the response. The task saw an MCP error for a committed step. The checkpoint itself is the only direct commit evidence, because only the newest `lastBatch` and `continuation` are kept. For the other eight steps the data cannot tell whether they died before or after their checkpoint. The ring of 26–27 October shows both kinds under the previous generation: an orphan with `chunkCompleted: false` resumed on 27 October 00:00 after the step `99b505f1` (26 Oct 22:58, `exceededMemory`), and `6086018b` (26 Oct 15:59) recovered with `chunkCompleted: true`.

## Root cause

1. **Proven.** Every "entered without terminal" entry in the window is a step invocation that the Workers runtime terminated for exceeding its memory limit. The platform answered HTTP 503, which the MCP client reports as a generic `Internal error`. No Worker code runs after that, so neither the outcome log line nor the outcome ring write can exist. These entries are not ring-buffer artefacts or lease or checkpoint races.
2. **Proven for 05:22, consistent for the others.** The kill comes late in the step: wall times are 37.6–46.8 s against 33–35 s for complete steps on the smaller previous generation, and the 05:22 kill came 2.3 s after the checkpoint.
3. **Memory source (from earlier evidence, not re-measured here).** The discovery chunk parses the full discovery ledger `epg/discovery-latest.json`, 60–63 MB ([memory pressure](epg-memory-pressure-2026-10-27.md)). The offline model needs about 166 MB of Node old space for a chunk on the full ledger against about 79 MB with a bounded ledger ([benchmark](discovery-ledger-benchmark-2026-10-27.md), [split rehearsal](discovery-ledger-split-rehearsal-2026-10-27.md)). Generation `b2699929…` carries 53,346 ledger candidates. Bounding the ledger in production is [AIR-222](https://trello.com/c/9Y4G9DG6) scope, not this card's; nothing here changes memory use.

## What the code could not say, and the change

The Worker cannot catch its own termination. Before this change the diagnostics could not distinguish a step that committed and lost its response from one that died before committing. An interrupted step stayed at `phase: entered` indefinitely. A series whose hops kept dying before their checkpoint would be resumed by every scheduled call.

The delivery (PR linked on the card):

- writes a `checkpointed` phase (ring and log) right after the hop's checkpoint, before the trailing writes;
- closes an entry left without a terminal phase for 15 minutes as `interrupted`, with `committed` true/false (from `checkpointed`) or null (from `entered`) and `cause: unknown`, so it is not presented as a proven error;
- fails the series closed (`paused` / `reason: interrupted`, `nextAction: stop`, no chunk, no lease) when two hops in a row end before their checkpoint;
- adds regression tests for a step killed after and before its checkpoint, late writes of a killed hop against its successor, and the fail-closed stop.

## Limits

- The per-step commit state of the eight earlier steps is not recoverable from stored data.
- The Scheduled Task run history, prompt and error text were not read; the task side comes from the card.
- Telemetry retention is 7 days; the 25–26 October counts are near its edge.

**Used by:** [AIR-224](https://trello.com/c/l1SppklF). **Superseded by:** none recorded.
