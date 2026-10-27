# Interrupted EPG commit and stranded discovery series, 27 October 2026

[AIR-199](https://trello.com/c/GCfptxao) · read-only diagnosis.

**Captured at:** 2026-10-27 19:04–19:15 UTC. **Sources:** Worker `iptv` Workers Observability (read-only telemetry query, script versions `04b65ad1…` on 26 October and `f0f31dc5…` on 27 October), and the read-only IPTV MCP tools `probe_read`, `epg_status` and `epg_pipeline_status`. **Pinned repository reference:** `main` at `a4aeed0` for the code analysis. **Scope:** the daily EPG commit calls on 26 and 27 October and every Worker invocation from 27 October 16:07 to 19:10 UTC. No request headers, tokens, cookies or R2 object contents were read or recorded. **Evidence lifecycle:** dated, historical observation; live state can change with the next scheduled run. **Operational authority:** none. No writer, step, retry, lease reset, flag, Task or Access change was made.

## Observations

### Worker invocations (`POST /mcp`, caller `mcp`, route `/api/sync/epg`)

| Request (prefix) | `entered` at (UTC) | `runId` in `epg_continuation` | Outcome | Wall / CPU ms | Note |
| --- | --- | --- | --- | --- | --- |
| `2a58022e` | 26 Oct 15:56:59.792 | `23570366…` | `exceededMemory` | 35 508 / 14 897 | first commit call, no terminal ring entry |
| `16c5a029` | 26 Oct 15:57:47.452 | `23570366…` | ok, `epg_commit`, HTTP 200 | 21 052 / 3 956 | resume path; `queueDiscovery` → `paused/epg_committed/12` |
| `941e5cde` | 26 Oct 15:59:02.565 | `23570366…` | ok, `continuation`, HTTP 200 | 40 028 / 2 534 | chunk, 12 → 11 |
| `6086018b` | 26 Oct 15:59:45.661 | `23570366…` | `exceededMemory` | 39 956 / 5 077 | chunk; later recovered as orphan with `chunkCompleted=true` |
| `d2d2befa` | 27 Oct 16:04:44.618 | `b2699929…` | `exceededMemory` | 65 562 / 27 456 | first commit call, no terminal ring entry |
| `6bab7dad` | 27 Oct 16:06:06.468 | `b2699929…` | `exceededMemory` | 36 743 / 2 494 | second commit call, no terminal ring entry |

From 27 October 16:07 to 19:10 UTC there were **no** `epg_continuation` events and **no** `exceededMemory` outcomes. The same filters return the two 27 October calls above when run on 16:00–16:07 UTC, so the empty result is not caused by the filter.

### Read-only status at 19:04 UTC

- `epg_status`: `runId=b2699929…`, `stage=complete`, `updatedAt=2026-10-27T16:06:38.614Z`, `remaining=0`, `ratingsPending=true`, `enrichmentQueueError=null`, no `ratingError`.
- `epg_pipeline_status`: `programmeRunId=b2699929…`. The continuation is `paused`, `reason=chunk_budget`, `remainingChunks=0`, `programmeRunId=23570366…`, recorded at `2026-10-27T00:02:42.640Z`. `continuationHealth.status=settled`, `generationConflict=null`. `scoringPreview.stale=true`, still pinned to `23570366…`. `lastBatch` is from 27 October 00:02 UTC (old generation).
- `continuationDiagnostics.recent` ends with the two 27 October `entered` entries. Neither has a `completed` or `failed` entry.

### Previously recorded in the AIR-199 card (same read-only telemetry, earlier session)

Daily `exceededMemory` counts for `POST /mcp`: 20 Oct 0; 21–24 Oct one each, around 15:0x UTC; 25 Oct 5; 26 Oct 16; 27 Oct 2. The first ones are before the AIR-159 merge (`45d3af4`, 26 October).

## Analysis

1. **First call on 27 October.** It scanned the EPG and published generation `b2699929…`: `programmeRunId` and `discovery-latest` are dated 16:04:51 UTC. The call then ended with `exceededMemory` before `queueDiscovery`. On 26 October the first commit call ended the same way, and its retry succeeded.
2. **Second call (retry) on 27 October.** It took the resume path (`run.events` → `copyEpgGeneration` → `completeWithRatings`). `finishSync` saved `sync.json` as `complete` at 16:06:38.614 UTC. The invocation was killed about 4.2 s later (16:06:42.767 UTC). That was before the ratings refresh finished (`ratingsPending=true`, no `ratingError`) and before `queueDiscovery` in `syncStep`. **Confirmed:** the stranded state is `sync=complete` with a published new generation, while the continuation is still the spent `chunk_budget/0` series of the old generation.
3. **Why nothing recovers it.** With `sync=complete`, a step takes the `continuation` branch, and the AIR-159 generation handoff in `advanceDiscovery` would supersede the old record. `tests/epg-commit-interrupted-handoff.mjs` case 7 and `tests/orphaned-continuation.mjs` case 14 cover this. But `continuationHealth` computes `generationConflict` only for a `running` record, so the read-only views show `settled`/`null`. The hourly task's stage A ([scheduled tasks](../reference/scheduled-tasks.md)) continues only when chunks are outstanding, so it makes no step at `remainingChunks=0`. The telemetry confirms that no step was made after 16:06. The next daily run starts a new generation; it does not recover this one.
4. **Root cause (confirmed).** Discovery is queued only at the end of a fully successful commit, after `finishSync`, the prediction-queue refresh and the ratings refresh. An invocation killed in that tail leaves a published generation without a discovery series. No read-only status reports the mismatch, and no scheduled caller is allowed to act on it.

- **AIR-94 alignment.** The first commit call already ended with `exceededMemory` on 26 October under script version `04b65ad1…`, before the AIR-94 non-film screening deploy. AIR-94 is therefore not the trigger. Its status fields (`rejectedNonfilm`, `excluded_nonfilm`) are unaffected by this RCA.

## Hypotheses not proven

- **Where memory runs out.** On both days the first commit call (full EPG scan, CPU 14.9 s and 27.5 s) died. On 27 October the resume-path retry also died, after `sync.json` was saved, while it was in `refreshPredictionQueue` or the ratings refresh. On 26 October the chunk `6086018b` died after its chunk work (`chunkCompleted=true`), i.e. around the checkpoint `refreshPredictionQueue` / status writes. `refreshPredictionQueue` parses the programme, the discovered-films catalog, the view index and the previous queue at the same time, and that is the common factor. **Hypothesis:** growing JSON objects that the Worker parses in full push these tails over the limit. The object sizes were not measured.
- **How to check, if authorized separately:** (a) a read-only HEAD/size listing of `programme.json`, `epg/discovered-films.json`, `epg/discovery-latest.json`, the enrichment view index and the prediction queue, without reading contents (needs separate owner approval); (b) a Worker-side diagnostic that logs object byte sizes and the stage name before each large parse; (c) an offline reproduction with synthetic objects of the measured sizes.

## Fix candidates (separate cards; nothing implemented here)

- (a) Make the mismatch visible: `continuationHealth.generationConflict=true` whenever the continuation's `programmeRunId` differs from the published generation, for every stage. Explicitly let the hourly task make one fail-closed step for the AIR-159 handoff. This changes the Task contract, so it needs an ADR and owner approval.
- (b) Queue discovery as soon as the generation is published, before the `finishSync`/queue/ratings tail, or make the handoff not depend on that tail.
- (c) Lower peak memory in the commit tail and in chunk checkpoints, e.g. avoid parsing the same large objects concurrently.

No auto-reset is proposed.

**Used by:** [AIR-199](https://trello.com/c/GCfptxao). **Superseded by:** none recorded.
