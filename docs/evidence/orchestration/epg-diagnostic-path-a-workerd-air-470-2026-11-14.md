# AIR-470 Path A in local workerd: full unchanged seal at H2a scale

Date: 2026-11-14 (UTC). Verdict: **INCONCLUSIVE** for the 128 MB isolate margin; semantics **exact**.

## Method

`scripts/epg-path-a-workerd.mjs measure` builds `dist/server/index.js`-based copy, adds one harness route and runs it in Miniflare (workerd) with the sanitized H2a-scale baseline from `scripts/epg-path-a-feasibility.mjs build` (42 156 active + 40 213 archived items; about 100 MiB). The route materializes the active scan as an array (Path A), applies 2 000 departures and 200 returns, and calls the real, unchanged `stageSealedGeneration` against local D1 and R2. No production or diagnostic resource is touched and `src/worker.js` is unchanged. After the runtime stops, the persisted local R2 is read back by an unconstrained process and checked.

## Results (three runs, same baseline)

| Run | seal wall (ms) | workerd RSS idle (MiB) | peak during seal (MiB) | increase over idle (MiB) | semantic check |
| --- | --- | --- | --- | --- | --- |
| 1 | 11 505 | 1 051.9 | 1 241.0 | 189.1 | exact |
| 2 | 11 544 | 1 008.4 | 1 253.8 | 245.4 | exact |
| 3 | 11 531 | 994.8 | 1 233.0 | 238.1 | exact |

Exact means: scan items 40 226 = 42 026 - 2 000 + 200, ledger items after = 40 226, upserted archive keys = 2 000, `sealError` null.

## Limits of this measurement

- Local workerd does not enforce the 128 MB isolate limit, and `process.memoryUsage()` returns zeros there, so heap and external cannot be read per isolate.
- The only available signal is process RSS of workerd, which also holds the seeded R2/D1 data caches (idle RSS about 1 GiB) and the proxy runtime. The increase of 189 to 245 MiB is an upper bound of isolate growth, not an isolate heap figure, and it exceeds 128 MB, so it cannot support GO.
- It does not show NO-GO either: the Node heap-capped runs in the earlier report remain the only cap-enforced data (OOM at 80 MiB, completion at 96 MiB and above, peak about 95 to 107 MiB heap plus external).

## Conclusion

Verdict against ADR 0139's "substantial margin" criterion: INCONCLUSIVE. Local tooling cannot establish an isolate margin. Options for the owner: (a) accept Path A with a measurement on a real Workers isolate under separate authorization, (b) approve Path B (planner streaming refactor), or (c) treat the Node data as sufficient evidence of no substantial margin. Nothing here authorizes any of these.
