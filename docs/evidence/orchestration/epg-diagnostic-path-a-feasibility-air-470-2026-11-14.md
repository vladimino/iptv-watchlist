# AIR-470: Path A feasibility of the EPG diagnostic replay, offline measurement (14 Nov 2026 UTC)

**Status: PROVISIONAL. The gate is not decided.** On the corrected harness the real, unchanged seal **completes** the full-scale replay under a Node V8 old-space cap of 96 MiB and above; it runs out of memory at 80 MiB. The margin to the 128 MB Cloudflare isolate is thin and unproven in both directions: peak V8 heap is 95 to 107 MiB, peak external memory 10 to 35 MiB, and workerd's own accounting was not measured. The "substantial memory margin" that [ADR 0139](../../adr/0139-epg-diagnostic-chunked-replay-dataset.md) point 12 requires for Path A is **not shown** by this evidence, and the opposite (a NO-GO) is not shown either. `src/worker.js` was not changed, Path B was not started, and no production or diagnostic resource was read or written.

An earlier version of this report (PR #617, HEAD `eaf3f005`) claimed a NO-GO with a roughly 70 MiB shortfall. Independent review found three harness artifacts that inflated the measurement (whole-file input parsing, an eager R2 read stream, a put that concatenated the whole body) and that claim is **withdrawn**. The numbers below replace it.

## What was measured

Path A: the real `stageSealedGeneration` and `planDiscoveryLedger` run unchanged; only the active scan is materialized, as the plain array they expect (`planDiscoveryLedger` calls `latestList.map(...)`). Dataset parts, archive segments, D1 ingestion and the baseline objects are not held by the measuring process.

Tool: `scripts/epg-path-a-feasibility.mjs`; regression test at tiny scale: `tests/epg-path-a-feasibility.mjs`.

```
node --max-old-space-size=6000 scripts/epg-path-a-feasibility.mjs build   --dir /tmp/<new-empty-dir> --item-bytes 700
node scripts/epg-path-a-feasibility.mjs measure --dir /tmp/<that-dir> --heap-mb 128 [--departures 2000 --returns 200]
```

- `build` (unconstrained) creates a deterministic, sanitized synthetic baseline with the real planner and ledger writers: generation 1 holds 82 369 observations, the commit of generation 2 scans 42 156 and the real seal archives 40 213 into 64 real segments with a real manifest and pointer. It writes only into an absent or empty directory inside the OS temp directory and never clears anything.
- `measure` copies the baseline and runs ONE real `stageSealedGeneration` in a fresh Node 22 process with `--max-old-space-size=<heap-mb>`, 2000 departures and 200 returns. Corrected harness: the scan and returns are read with a bounded line reader (no whole-file text, no line array), a `gc()` runs before the retained-scan baseline is taken, the R2 stand-in streams bodies on demand (one 64 KiB chunk per pull) and writes streams to disk chunk by chunk, and the semantic check runs in the unconstrained parent after the capped process has ended.
- Fixture size, calibrated to the H2a evidence: active ledger NDJSON 52.2 MB (H2a about 49.97 MiB, 42 156 items), archive 54.1 MB (H2a about 50.15 MiB, 40 213 items).

## Result (calibrated fixture)

| Old-space cap | Outcome |
| --- | --- |
| 1024, 160, 128, 112, 96 MiB | completes; counts exact (scan = expected = new ledger items, upserted keys = departures) |
| 80 MiB | out of memory **inside `stageSealedGeneration`** (after the scan was loaded and retained) |
| 64 MiB | out of memory before the scan is read (module load and the idle baseline) |

Memory (MiB), cap 128 (completes):

| Quantity | Value |
| --- | --- |
| idle process heap / RSS | 8.7 / 67.2 |
| retained scan after `gc()` (heap used) | 64.9, so the scan alone is about **56 MiB** above idle |
| transient peak while loading the scan | 75.8 heap (parsing adds about 11 MiB transiently) |
| peak heap during the seal | **107.3** |
| peak external / ArrayBuffers during the seal | 35.3 / 31.7 (stand-in and Buffer use of whole-object `text()`/`json()` reads) |
| peak RSS during the seal | 263 (includes the Node runtime and the sqlite worker thread) |

At the other completing caps the seal peak heap was 95 (cap 96), 101 (112), 114 (160) and 143 (1024); heap peaks fall as the cap falls because the collector works harder, so the 95 to 107 MiB range is the realistic envelope, not a single figure. About 70 R2 puts, 81 gets, 107 MB written and 217 MB read by the stand-in; wall time of the whole child about 13 s here. These are not latency claims about Cloudflare.

## Interpretation and limits

- The scan array is not the problem the first report suggested. Retained, it is about 56 MiB of heap; the seal adds about 40 to 50 MiB of heap on top of it.
- Peak heap 107 MiB plus peak external 35 MiB is about 142 MiB, above 128 MB if the isolate counts both; heap alone leaves about 21 MiB for the Worker runtime and the harness-free modules. If only the heap counts the margin is about 16 percent, if external counts too there is none. Which accounting applies is exactly what was not measured.
- `--max-old-space-size` caps V8 old space, not whole-process or whole-isolate memory, so completing at 96 or 128 MiB does not prove a fit in a 128 MB isolate. RSS and the sqlite stand-in are not Cloudflare numbers.
- Not exercised: the canary's own `EpgOrchestration.acquireStep` and fences, `materialize`, the receipt, and any workerd or `wrangler dev` run (ADR 0139 point 17). They remain required before the Path A gate can be called passed, and a workerd run is the cheapest way to resolve the accounting question above.
- Synthetic records of the real shape and size, not production payloads; one seed, one departure and return count; one machine.

## Decision state

Path A is **neither accepted nor rejected**. The ADR's own acceptance bar (a substantial margin) is not met by this evidence; the NO-GO of the previous version is withdrawn. Options for the owner: (a) require the representative workerd or `wrangler dev` measurement of the full seal path before deciding; (b) judge the thin Node margin sufficient to proceed on Path A with that measurement as part of the implementation PR; (c) go to Path B. No change to `src/worker.js` and no Path B work is started without a separate owner architecture decision.
