# Discovery resolver chunk: memory limit end and fix (AIR-342)

**Captured:** 2026-11-04, 19:00–20:45 UTC.
- **Read-only production observations:** Workers Observability telemetry of Worker `iptv`; `epg_pipeline_status`; an R2 size listing of the published generation (metadata only); SELECT statements on D1 `iptv` for the discovery and published EPG authority markers.
- **Offline:** measurements in the agent container (Node 22.22) on branch `claude/air-342-discovery-chunk-resources` from `main` `430a465`.

**Not done:** no recovery, `epg_sync_step`, discovery, TMDB call, lease change, flag, Task, or R2/D1 write.
**Card:** [AIR-342](https://trello.com/c/sFNZn818), follow-up of [AIR-341](https://trello.com/c/r8tfPFjt) and [ADR 0088](../../adr/0088-guarded-interrupted-discovery-recovery.md).
**Verdict:** the chunk ended on the **Workers memory limit**, not CPU. The fix lowers the smallest Node old space a production-sized chunk completes in, from 160 to 112 MB on the 29 October snapshot scaled to production size, and from 176 to 96 MB on a synthetic fixture. The chunk's results are unchanged.

Aggregates only: no titles, film ids or payloads.

## 1. Cause (production telemetry)

| Invocation (UTC) | Route | Outcome | CPU | Wall |
| --- | --- | --- | --- | --- |
| 2026-11-04 18:36:54–18:37:57 | `POST /api/enrichment/discovery/resolve`, the one gated recovery | **`exceededMemory`**, "Worker exceeded memory limit." | 6.3 s | 63.8 s |

- The CPU is far below the configured `cpu_ms` of 120,000, so CPU is excluded.
- The Cloudflare Ray `a555ba12386b057a-IAD` on the card is the client-side ray. Telemetry names the invocation by its own request id; it matches on route and time.

Between 2 and 4 November, telemetry holds 13 more `exceededMemory` ends of `POST /mcp`, with 1.6–21.6 s of CPU and 38–107 s of wall time. Their times match the `interrupted` `/api/sync/epg` steps in the continuation diagnostics: 3 November at 21:24 and 22:25 UTC, 4 November at 16:04 and 16:25 UTC. The 119 s `canceled` ends of `POST /mcp` are client timeouts, not memory ends. Telemetry does not name the MCP tool, so which of the 13 ran a discovery chunk and which ran a commit is not established.

**State after the recovery** (`epg_pipeline_status`):
- The last status is `checkpoint: cheap_pass`, with `touched` 3,325 and `tmdbCalls` 0.
- The continuation is `running`, its health `orphaned`, with `interruptions` 1.
- So the chunk died **after** the cheap pass and before its final status.

The chunks of 3 November on generation `71820185…` finished (55–68 s each). What fails is the first chunks of a new generation, whose cheap pass touches thousands of hot Films.

**Storage at the time** (R2 listing and D1 markers):

| Measure | Value |
| --- | --- |
| Discovery authority | `r2` (D1 holds a mirror of 36,999 observations), so the chunk parses the R2 JSON |
| Published EPG authority | `d1`, `open` |
| Generation `7c1eaadb…`: `discovery-latest.json` | 46.3 MB |
| `discovered-films.json` | 8.0 MB |
| `discovery-resolution.json` | 2.2 MB |
| `programme.json` | 2.3 MB |

## 2. Where the memory went (offline profile, before the fix)

The built Worker ran one `resolveDiscoveryBatch` (limit 24, TMDB stubbed) against the private 29 October snapshot.
- **Setup.** Objects were held as Buffers, off the V8 heap. The snapshot's ledger (25,846 observations, 33.7 MB) and catalog were scaled to production size: 46.7 MB and 7.9 MB.
- **Reading.** Figures are V8 heap after a forced collection. Node's heap ranks phases; it is not workerd's 128 MB isolate limit.

| Phase | Heap |
| --- | --- |
| Inputs read in parallel (ledger, decisions, catalog, status) | the largest peak: each object exists as its text and its parsed tree at once |
| Retained after the cheap pass | about 62 MB above the start |
| Tail: programme re-read, prediction queue, observation index | peaks about 100 MB above the start |

The tail allocates its own copies on top of the retained set:
- the prediction queue reads the catalog again;
- the programme is read a second time, in production from D1;
- the observation index builds and digests its shards.

**Ledger fields.** The EPG `description` is 41% of the ledger's bytes and is two-byte text in V8. The chunk reads it only when a detail-verified Film has no TMDB overview. The raw titles serve the cheap pass's aliases and a detail-verified Film. The airing counters and the last-seen run are not read by the chunk at all.

## 3. The fix

All in `src/discovery.js` and `src/worker.js`, with no new storage, protocol or authority:
1. **Sequential reads.** The chunk reads its inputs one after another instead of in parallel.
2. **Streamed ledger.** An R2 ledger is streamed item by item through the existing `forEachJsonArrayItems` (the reader the commit already uses). Each item drops `description`, `firstAiring`, `airings` and `lastSeenProgrammeRunId` as it is read. A D1-routed ledger and every other `loadJSON` caller are unchanged.
3. **Released detail.** Once the chunk has chosen its candidates, every other observation also releases its raw titles.
4. **On-demand description.** A chosen candidate whose TMDB detail has no overview reads its description back with one more streamed pass over the same ledger. Otherwise the ledger is read once.
5. **Released catalog.** The catalog and its alias index are released before the programme re-read, the prediction queue and the observation index.

## 4. Measurements after the fix

Smallest Node `--max-old-space-size` at which the chunk completes:

| Fixture | Before | After |
| --- | --- | --- |
| 29 October snapshot scaled to production size (ledger 46.7 MB, catalog 7.9 MB), private | 160 MB | **112 MB** |
| `scripts/discovery-chunk-profile.mjs`, synthetic: 37,000 observations, 50 MB ledger, 3,300 Films, 4,400 decisions | 176 MB | **96 MB** |

On the synthetic fixture, the heap retained in the tail drops from about 113 to 70 MB, and the tail peaks drop from about 138 to 91 MB.

**Results are the same.**
- On the snapshot, the written decisions, catalog, status, prediction queue, score preview and observation index are byte-identical before and after. Only the random hop id and the digests that cover timestamps differ.
- `tests/discovery-chunk-memory.mjs` checks the same equality between a streamed and a parsed ledger.

**Cost.** Streaming a 34 MB ledger takes about 2.3 s of CPU in Node against 0.3 s for one `JSON.parse`, so about 3 s at production size. That is well inside `cpu_ms` 120,000.

## 5. Limits

- Node's heap is not workerd's isolate accounting. The numbers rank the old and new code; they do not prove a margin under 128 MB.
- The production programme is read from the D1 published EPG; that read was not replayed offline.
- Whether a production chunk now reaches its final checkpoint is established only by a production run. That needs its own owner approval.
- The ledger still grows with the active observations. A ledger read in pages (D1 discovery authority, [AIR-320](https://trello.com/c/4cA5GlJn), [ADR 0085](../../adr/0085-d1-authoritative-discovery.md)) removes the whole-document read entirely.
