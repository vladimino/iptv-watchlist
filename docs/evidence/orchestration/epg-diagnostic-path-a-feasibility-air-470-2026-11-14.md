# AIR-470: Path A feasibility of the EPG diagnostic replay, offline result (14 Nov 2026 UTC)

**Result: Path A does NOT fit the 128 MB budget at the H2a scale. STOP per [ADR 0139](../../adr/0139-epg-diagnostic-chunked-replay-dataset.md) point 12-13: the decision on Path B (a production planner streaming refactor) returns to the owner. `src/worker.js` was not changed and no production or diagnostic resource was read or written.** This is an offline measurement in Node with a sqlite D1 stand-in and a file-backed R2 stand-in; it is not a Cloudflare isolate measurement and not a canary result.

## What was measured

Path A means: the real `stageSealedGeneration` and `planDiscoveryLedger` run unchanged and only the active scan is materialized, as the plain array they expect (`planDiscoveryLedger` calls `latestList.map(...)`; `collectLedgerDecisions` and `iterateLedgerItems` hand `holder.discovery` to the merge). Dataset parts, archive segments, D1 ingestion and baseline objects are not held by the measuring process.

Tool: `scripts/epg-path-a-feasibility.mjs` (tiny-scale regression test: `tests/epg-path-a-feasibility.mjs`).

```
node --max-old-space-size=6000 scripts/epg-path-a-feasibility.mjs build   --dir /abs/tmp/dir --item-bytes 700
node scripts/epg-path-a-feasibility.mjs measure --dir /abs/tmp/dir --heap-mb 128 [--departures 2000 --returns 200]
```

- `build` (unconstrained) creates a deterministic, sanitized synthetic baseline (titles `Synthetic film N`, hash-derived words, no production payload) with the real planner and ledger writers: generation 1 holds 82 369 observations, the commit of generation 2 scans 42 156 of them, and the real seal archives the other 40 213 into 64 real segments with a real manifest and pointer. The published active ledger is written as NDJSON for the scan.
- `measure` copies the baseline, then runs ONE real `stageSealedGeneration` in a fresh Node 22 process with `--max-old-space-size=<heap-mb>`: 2000 departures and 200 returns, samples `process.memoryUsage()` every 10 ms. The R2 stand-in keeps objects on disk, so the fixture is not in the measured heap.

Fixture size (calibrated to the H2a evidence): active ledger NDJSON 52.2 MB (H2a: about 49.97 MiB, 42 156 items), archive 54.1 MB (H2a: about 50.15 MiB, 40 213 items), 106 MB in total. A larger-record variant (`--item-bytes 1200`: ledger 73.2 MB, archive 74.2 MB, 148 MB) was also run as a growth-headroom check.

## Result (calibrated fixture, `--item-bytes 700`)

| Old-space cap | Outcome |
| --- | --- |
| 1024 and 256 MiB | completes; semantics exact (see below) |
| 192, 160, 128 MiB | **JavaScript heap out of memory** (the 128 MiB run dies about 7.5 s in) |

Measured at the 256 MiB cap, which completes:

| Quantity | MiB |
| --- | --- |
| idle process (modules not yet loaded into the seal) heap / RSS | 8.7 / 66.8 |
| heap after the scan array alone is loaded (40 226 items, nothing else) | 118.7, so the scan costs about **110 MiB of heap** on its own |
| peak heap during the seal | 194.8 |
| peak external / ArrayBuffers | 118.1 / 114.6 (the R2 stand-in returns whole segment and ledger objects; a real R2 `get` body is streamed, so this is partly an artifact of the stand-in) |
| peak RSS | 433 (includes the sqlite stand-in) |

Semantics at every completing run: scan items = expected (42 156 - 2000 + 200 = 40 356 at the unconstrained size; the tool reports the exact numbers), new ledger items = scan items, `upsertedKeys` = departures, archive items grow by the departures minus the returns. Wall time of the stage was about 12-16 s on this machine, R2 stand-in traffic about 70 puts and 80 gets (about 0.4 GB read), which is not a latency claim about Cloudflare.

Larger fixture (`--item-bytes 1200`): the scan array alone is 160 MiB of heap, peak heap 470 MiB when uncapped, OOM at 192 and 128 MiB.

## Interpretation

- The decisive figure does not depend on the stand-ins: at the real record size the scan array alone is about 110 MiB of V8 heap, against a 128 MB isolate that must also hold the Worker runtime, the modules, the planner's own structures (key sets, the merged items, the encoded copies) and the response. The measured peak heap is about 195 MiB. There is no margin to define: Path A fails the gate it was given.
- The same V8 engine runs in workerd, so heap object sizes are comparable; isolate accounting (external memory, how R2 bodies and sqlite buffers are charged) is not, and RSS here is not Cloudflare's number. These unknowns can only move the result by tens of MiB, not by the 70 MiB or more that Path A is short.
- Not exercised: the canary's own `EpgOrchestration.acquireStep` and fences, `materialize`, the receipt, and a workerd / `wrangler dev` run. The failure above is already sufficient to stop; they remain required evidence for any path that continues.

## Decision needed (owner)

ADR 0139 point 13: Path B, a narrowly scoped, separately approved refactor of the production planner so `holder.discovery` can be an iterable or re-openable source (parity evidence against the current planner on identical inputs and the EPG regression suite). Nothing in this measurement authorizes a change to `src/worker.js`, and nothing was run against production or diagnostic resources.

Limits: Node 22 and a sqlite CLI stand-in on a development machine; synthetic records of the real shape and size, not production payloads; one seed and one departure/return count; no workerd run.
