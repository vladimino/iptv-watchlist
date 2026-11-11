# AIR-429: a capped departure budget drains a frozen discovery ledger in bounded portions

**Captured:** 2026-11-11 (UTC). **Method:** offline only. The real planner (`planDiscoveryLedger` through `publishGenerationWithLedger` and `stageSealedGeneration`) and the real ledger seal ran against synthetic objects, a sqlite stand-in for D1 and an in-memory or on-disk bucket. No network, no R2, no D1, no production write, no flag, no run. The only production input is the shape measured on 10 November 2026 ([AIR-423](air-423-ledger-generation-diff-2026-11-10.md)): 47,059 active observations, 20,568 in the latest scan, 26,491 absent.

This record decides nothing. [ADR 0111](../../adr/0111-bounded-ledger-departure-budget.md) is Proposed; setting `DISCOVERY_LEDGER_MODE=bounded` stays a separate owner decision ([runbook](../../runbooks/discovery-ledger.md#switching-frozen-to-bounded-under-d1-authority)).

## Memory of one commit (Node old space, MB)

Smallest `--max-old-space-size` at which the commit completes, bisected at about 4 MB resolution (`scripts/discovery-bounded-transition-benchmark.mjs`; 4,818 observations leave the scan per day, as in production). Node's limit approximates, but is not, the Workers isolate limit.

| Commit | Measured MB | Notes |
| --- | --- | --- |
| frozen (the daily commit that is known to fit) | 173 | baseline |
| bounded, first, no budget | 220 | all 26,491 + 4,818 depart in one request |
| bounded, budget 0 (daily flow only) | 177-185 | the floor of any budget |
| bounded, budget 4,000 | 185-189 | the chosen cap |
| bounded, budget 8,000 | 189 | |
| bounded, budget 12,000 | 197 | |
| bounded, steady state after the drain | 134 | cheaper than frozen |

Repeated runs of the same scenario differ by up to 8 MB, so differences below that are noise. Holding the departures as JSON text instead of objects lowered the floor (cap 0) from 185 to 177 MB.

**Result against the card's target.** The target "no worse than the frozen baseline" is **not met** by any cap: even with no backlog archived the planner needs 4-12 MB above the frozen commit, because the daily flow itself departs. A cap of 4,000 saves about 31-43 MB against the uncapped first commit (220 MB in this series; [AIR-426](air-426-bounded-transition-rehearsal-2026-11-11.md) measured 216 MB in another run); it cannot go below that floor. This is stated so the owner can decide whether the margin is acceptable. It is not a NO-GO by measurement alone: the isolate headroom is unmeasured, and the margin is within the noise of the isolate model. The flag stays unset.

## Drain at production size

`BOUNDED_PERF=47059:20568 node tests/discovery-bounded-d1-rehearsal.mjs` (cap 4,000, the scan unchanged between generations, so **no daily flow**; the memory table above uses a flow of 4,818 a day, and the two tables must not be combined):

| Day | Staging ms | R2 puts | R2 MB | Document MB | D1 archive rows | Backlog left | Seal round trips / batches |
| --- | --- | --- | --- | --- | --- | --- | --- |
| frozen (before) | 17,829 | 3 | 56.6 | 56.6 | 0 | 26,491 | 341 / 290 |
| 1 | 18,802 | 69 | 57.6 | 52.2 | 4,000 | 22,491 | 393 / 278 |
| 2 | 16,964 | 69 | 58.5 | 47.8 | 4,000 | 18,491 | 373 / 258 |
| 3 | 16,739 | 69 | 59.4 | 43.4 | 4,000 | 14,491 | 353 / 238 |
| 4 | 15,060 | 69 | 60.2 | 39.1 | 4,000 | 10,491 | 333 / 218 |
| 5 | 13,956 | 69 | 61.1 | 34.7 | 4,000 | 6,491 | 313 / 198 |
| 6 | 14,034 | 69 | 62.0 | 30.3 | 4,000 | 2,491 | 293 / 178 |
| 7 | 12,018 | 69 | 62.5 | 27.5 | 2,491 | 0 | 254 / 163 |

Drained in 7 = ceil(26,491 / 4,000) commits; the final D1 counts are 20,568 active and 26,491 archive rows (conservation). Staging time is the stand-in's CPU, not production wall time. Each commit writes 69 R2 objects (64 segment versions, the manifest, the pointer, the document, `sync.json`). The first capped seal does about the D1 work of a frozen one (393 against 341 round trips); the real cost of a D1 archive batch is not measured.

## What the tests prove (`tests/discovery-bounded-drain.mjs`, scaled to a universe of 500, window 30, shift 11, cap 40)

- After every generation the active ledger equals an independent model: the scan plus the held backlog, with held rows not seen; the archive holds exactly the departed set; D1 archive rows equal it.
- Drain within `ceil(B / cap)` commits (5 against a bound of 8) although the daily flow (55) exceeds the cap (40): the progress guarantee does not depend on the flow.
- Final active ledger equals the scan, with no `drain` field; a cap above the backlog is the plain bounded mode; `frozen` is unchanged.
- A commit stopped after the archive pointer moved, retried, equals an uninterrupted twin; a missing manifest and a lost fence fail closed with nothing written; departures held in memory stay at most cap plus flow.
- Mutation check: ignoring the cap makes the test fail. `tests/epg-status-ledger-mode.mjs` covers the `drain` header (accepted only on a bounded document with a backlog of at least 1).

## Not measured

The isolate headroom of the Workers runtime, the cost and quota of a D1 archive batch in production, and wall time of the ledger phase on the real instance. No production switch happened.
