# Discovery pipeline status: memory-safe read (AIR-344)

**Captured:** 2026-11-04.
- **Read-only production observations:** Workers Observability telemetry of Worker `iptv`, script version `2aa94fbd…`, the deploy of PR #369.
- **Offline:** measurements in the agent container (Node 22.22) on branch `claude/air-344-pipeline-status-memory` from `main` `189e4ac`.

**Not done:** no production write, recovery, `epg_sync_step`, flag, Task, or R2/D1 change.
**Card:** [AIR-344](https://trello.com/c/8TV5soDb); context [AIR-341](https://trello.com/c/r8tfPFjt) and [AIR-342](https://trello.com/c/sFNZn818).
**Verdict:** the status read itself hit the memory limit, apart from the resolver chunk. With the fix it reads the ledger once, streamed, and holds one large document at a time. The smallest Node old space it completes in falls from 256 to 48 MB, the lowest value tried, at production size with an interrupted continuation. Its answer is unchanged.

Aggregates only.

## 1. Cause (production telemetry, read-only)

| Invocation (UTC) | Route | Outcome | CPU | Wall |
| --- | --- | --- | --- | --- |
| 2026-11-04 20:20:03 | `GET /api/enrichment/pipeline/status` | **`exceededMemory`** | 1.4 s | 50.0 s |
| 2026-11-04 20:21:27 | `GET /api/enrichment/pipeline/status` | **`exceededMemory`** | 1.8 s | 45.4 s |
| 2026-11-04 20:25:27 | `POST /mcp` (`epg_pipeline_status`) | `ok` | 2.8 s | 95.4 s; the MCP client gave up at 60 s |
| 2026-11-04 20:11, 20:15 | `POST /mcp` (`epg_pipeline_status`) | `ok` | 2.4 s | 8–10 s |
| 2026-11-04 20:35:59, 20:39:48 | `GET /api/enrichment/pipeline/status` | `ok` | 2.2–2.8 s | 10–13 s |

The events carry no peak-memory field.

The same read ended `exceededMemory`, slow `ok` and fast `ok` within minutes, on the same state. One explanation, **not established** by these events, is an isolate whose memory is shared with concurrent requests: the UI polls `GET /api/enrichment/footer/status`, which loads the same ledger.

These are not the resolver chunk's ends (AIR-342): they are reads.

## 2. Where the memory went (code)

On `main` `189e4ac`:
- `discoveryPipelineStatus` read the ledger (46.3 MB in production), the decisions, the catalog (8.0 MB), the continuation, the queues, the score preview, the diagnostics and the lease in one `Promise.all`. Each large one was held as its text and its parsed tree at once.
- With `reason: interrupted`, it then called `interruptedRecoveryFacts`, which read the whole ledger a second time, parsed whole, for its `programmeRunId` alone, and the programme.
- `footerStatus` read the same ledger, the decisions, the catalog and the programme in one `Promise.all`.

## 3. The fix

All in `src/discovery.js` and `src/enrichment.js`, with no new storage, route, flag or response field:
1. **One streamed read.** `ledgerStatusAggregates` reads the pinned ledger once, through the streamed `loadJSON` option of AIR-342. Each item is counted as it is read (`countDiscoveryItem`, the same rules as `ledgerCounts`) and its decision status tallied; no item is kept. A D1-routed or non-streamable ledger is counted from its parsed items, as before.
2. **Sequential reads.** The pipeline status reads the small records together, then the decisions, the ledger and the catalog one after another.
3. **Independent generation check kept.** The recovery verdict still reads the live ledger itself, with the unpinned environment, and compares its run with the published generation, the programme and the continuation. The status's pinned read is not reused: the two can differ after a generation is published, and that is the `generation_mismatch` refusal. Only how it reads changed: the ledger is streamed and its items dropped, so just the wrapper is kept. An interrupted status therefore streams the ledger twice, one after the other.
4. **No catalog copy.** `nextHotPredictions` finds its five Films with an in-order scan of the catalog instead of `Object.values(catalog).find`, which copied the catalog into an array per id.
5. **Footer.** `footerStatus` uses the same aggregates.

## 4. Measurements

Smallest Node `--max-old-space-size` at which the call completes. Fixture: `scripts/discovery-chunk-profile.mjs`, synthetic, 37,000 observations, 50 MB ledger, 3,300 Films, 4,400 decisions.

| Call | `main` | This change | Node time, `main` → this change |
| --- | --- | --- | --- |
| `--call status --interrupted` | 256 MB | **48 MB** | 1.3 s → 7.6 s |
| `--call status` | 176 MB | **48 MB** | 0.7 s → 3.6 s |
| `--call footer` | 192 MB | **48 MB** | 0.8 s → 3.8 s |

**Cost.** The streamed parse costs CPU, about 3 s for a 50 MB ledger, twice for an interrupted status. That is far inside `cpu_ms`. The R2 transfer, not the parse, dominates production wall time, but production wall time of the interrupted status was not measured.

**Results are the same.** `tests/discovery-status-memory.mjs` checks, on a 6,000-observation ledger, parsed and streamed, idle and interrupted, with a shared archive:
- the counts equal `ledgerCounts` of the whole parsed ledger;
- `statuses`, confirmed and verified Films and `nextHotPredictions` are unchanged;
- the recovery verdict is unchanged, a ledger of another run is not `eligible`, and a generation published after the status pinned its own is refused as `generation_mismatch`, parsed and streamed;
- the footer is the same on both paths;
- the ledger is counted once and, for the interrupted verdict, read once more, large documents never concurrently, and nothing is written.

## 5. Limits

- Node's heap is not workerd's isolate accounting; the figures rank the two versions.
- Concurrent requests in one isolate share its memory. Lighter status reads lower that pressure, but other heavy reads, such as the catalog and the programme in D1 mode, remain.
- Production acceptance is a read-only `epg_pipeline_status` after deploy that answers within the MCP client's 60 s.
