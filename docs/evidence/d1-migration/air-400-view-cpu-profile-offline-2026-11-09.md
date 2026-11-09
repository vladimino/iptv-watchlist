# D1 enrichment projector: offline CPU profile of the view build (52,000 entities)

**Captured:** 2026-11-09, offline on one machine (Intel(R) Xeon(R) Processor, 4 cores, Node v22.23.4, V8 12.4.254.21-node.57), deterministic synthetic fixtures. No production read or write of any kind (no D1, no R2, no Cloudflare, no personal data), no manual projector, Discovery or EPG run, no flag, Task, cron, window, lease or budget change, no runtime change.
**Scope:** [AIR-400](https://trello.com/c/Pz4DM2um): the CPU-only stretch of `d1EnrichmentDiff` between the last D1 read (`diff.predictionAuthority`) and the first D1 read after it (`diff.checkpointCount`): `diff.lifecycle`, the owner overlay, `diff.inputs` and `diff.keys`. It follows [AIR-396](air-396-d1-first-query-latency-2026-11-09.md), whose leading hypothesis (H2) is that the slow first query is that CPU charged to the next I/O phase by a Worker clock that does not advance during CPU.
**Verdict:** **THE BUILD IS QUADRATIC IN TWO PHASES AND TAKES ABOUT 4.7 S OF WALL TIME AND 4.9 S OF CPU TIME ON THIS NODE MACHINE AT 52,000 ENTITIES (MEDIANS); THE WALL TIME IS ABOUT HALF OF THE OBSERVED 9.6 S WALL PHASE AND THE CPU TIME ABOUT HALF OF THE 10.5 S WORKER CPU OF THAT INVOCATION, A COMPARISON THAT PROVES NO CAUSE. GO for one separate, narrowly scoped optimization card (indexes in three lookups, parity-gated); NO-GO for touching D1, the query order or the writer path.** `diff.lifecycle` (57 % of the build) and `diff.inputs` (32 %) scale with a log-log slope of 2.04 and 2.03 (2 is quadratic); the change keys (9 %) and the overlay are linear. No offline experiment can separate this CPU from D1 transport or queueing, and a first version of this benchmark inflated the key phase 30 times through its own test harness (see below).
**Used by:** [ADR 0106](../../adr/0106-bulk-projector-write-path.md) (the pre-write overhead every window pays); [AIR-396 RCA](air-396-d1-first-query-latency-2026-11-09.md) (H2).

## Method

`scripts/projector-view-cpu-bench.mjs` (offline only, `node --expose-gc scripts/projector-view-cpu-bench.mjs --profile 1 --keys-breakdown 1`) runs the **real** sources of the Worker bundle (`src/domain/film-person-reader.js`, `src/enrichment-projection.js`, `src/owner-review-d1.js`, loaded the way the bundle carries them) in the call order of `d1EnrichmentDiff`: `LifecycleReader.readLifecycle(store, now, {entitiesOnly: true})`, `OwnerReview.applyViewOverlay`, `EnrichmentProjection.enrichmentInputs`, then `personChangeKey` and `filmChangeKey` of every input. For each phase it records wall time (`process.hrtime`), CPU time (`process.cpuUsage`, user plus system), V8 GC time (`perf_hooks`) and heap growth, after 2 warm-ups and 7 repeats, on **freshly cloned** store objects every repeat (the reader caches its indexes per source object in a `WeakMap`, so reusing a store would hide the cold cost the projector pays on every run). Sizes: 6,500, 13,000, 26,000, 52,000 and 104,000 entities; the log-log slope of the median total against the entity count says how the cost grows.

The fixture is deterministic (seeded) and synthetic: about 19 % Films and 81 % Persons (the production mix of 2026-11-09, about 48,500 entities), 4 % of the Films on the watchlist and in the programme with a metadata record, the rest discovered-catalog Films, 12.2 credits a Film (75 % with 11 actors, 20 % with 6, 5 % with 35), every Person credited at least once and the rest drawn from a skewed pool, the bundle's film-title and person-name dictionaries, and 200 Film and about 300 Person owner reviews. The 52,000-entity run holds 9,880 Films and 42,120 Persons; the view sizes are the ones the reader returned, not the requested ones.

## Result: scaling and breakdown

| Entities (Films + Persons) | Films | Lifecycle ms | Overlay ms | Inputs ms | Keys ms | Total wall ms (median, min to max of 7) | Total CPU ms | GC ms (sum of phases) | Heap growth MB (sum) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 6,500 | 1,235 | 52.7 | 4.7 | 27.5 | 51.1 | 136 (130 to 150) | 231 | 50.1 | 36.1 |
| 13,000 | 2,470 | 146 | 10.4 | 83.0 | 102 | 343 (335 to 423) | 503 | 69.7 | 42.8 |
| 26,000 | 4,940 | 863 | 21.9 | 418 | 213 | 1,528 (1,475 to 1,556) | 1,716 | 145 | 77.1 |
| 52,000 | 9,880 | 2,690 | 36.6 | 1,498 | 426 | 4,696 (4,550 to 5,215) | 4,945 | 257 | 133 |
| 104,000 | 19,760 | 14,301 | 85.4 | 7,442 | 885 | 22,959 (19,074 to 24,210) | 23,073 | 597 | 278 |

At 52,000 entities (the card's minimum), phase by phase:

| Phase | Wall ms median | Min to max | CV | CPU ms | GC ms | Share of the build |
| --- | --- | --- | --- | --- | --- | --- |
| lifecycle | 2,690 | 2,585 to 3,243 | 0.076 | 2,825 | 82.7 | 57 % |
| overlay | 36.6 | 33.9 to 47.9 | 0.114 | 79.7 | 55.3 | 1 % |
| inputs | 1,498 | 1,473 to 1,560 | 0.018 | 1,556 | 54.2 | 32 % |
| keys | 426 | 408 to 439 | 0.03 | 478 | 64.9 | 9 % |

- **Dispersion is small** (CV of 2 to 15 % per phase over 7 repeats; the larger CV is the lifecycle phase, the one with the most allocation and GC). CPU time equals wall time within a few percent (single-threaded, no I/O), so wall is a fair proxy for CPU here; GC is about 5 % of the build (256 ms of 4,697 ms at 52,000 entities).
- **Growth.** Total slope 1.86; lifecycle 2.04, inputs 2.03, keys 1.03, overlay 1.02. From 52,000 to 104,000 entities the lifecycle phase goes from 2,690 to 14,301 ms and the inputs phase from 1,498 to 7,442 ms. Interpolated to the production size of about 48,500 entities, the two quadratic phases are about 2.3 and 1.3 s (an interpolation of this fixture, not a measurement of production).
- **Memory.** The heap grows by about 133 MB across the four phases at 52,000 entities (about 278 MB at 104,000). That is the `heapUsed` delta of each phase and includes garbage not yet collected, so it overstates what the build retains; it is not comparable with the roughly 50 MB the projector's own comment reports for the retained view of the 2026-10-29 snapshot. Peak and retained memory were not measured separately.

## Where the time goes (V8 sampling profile of one 52,000-entity build)

| Function (self time) | Self ms | Share of the sampled build |
| --- | --- | --- |
| readLifecycle | 2,055 | 44.0 % |
| orderedRecords | 827 | 17.7 % |
| metadataRecord | 503 | 10.8 % |
| (garbage collector) | 238 | 5.1 % |
| projectionKey | 213 | 4.6 % |
| (anonymous), the key replacer | 121 | 2.6 % |
| personChangeKey | 96 | 2.0 % |
| stamp | 83 | 1.8 % |
| (anonymous) | 57 | 1.2 % |
| filmChangeKey | 55 | 1.2 % |

Sampled total 4,675 ms. The three lookups that dominate are all per-Film scans of whole sources: in `readLifecycle` each discovered-catalog record runs `[...films.values()].find(...)` over every Film built so far (a copy of the Film map and a linear search per record); in `orderedRecords` every Film that has two or more source records rebuilds the array of all watchlist, programme, metadata and catalog records and runs `listed.includes` on it; in `metadataRecord` every Film walks `Object.entries(store.metadata)`. The lifecycle phase also reads `store.watchlist.films` and `store.programme.films` with `some` once per Film (`listedOnWatchlist`, `onCurrentList`). These are algorithmic, not string or hash costs, and they match the measured slope of 2.

## The change keys and string work (cheapest hypotheses)

On the same 52,000 inputs (57.3 million characters of JSON: Persons 869 characters on average, Films 2102 on average and 4,232 at most): the whole `projectionKey` of every entity takes 395 ms; `JSON.stringify` with the replacer `projectionKey` passes takes 212 ms (3.7 ns a character), the same without a replacer 124 ms (2.2 ns a character), and the two 53-bit hash passes 162 ms (2.8 ns a character). The replacer therefore costs about 87.5 ms in total, and the replacer does change the text of some entries (the lifecycle stamps a dimension with the run's own clock, which the replacer maps to `@now`), so it is not removable. A single combined pass could save at most the second of the two hash passes (under 80.9 ms). **Hashing and serialization are linear and small (9 % of the build); they are not the bottleneck and need no change.** (`hash53` in the breakdown is a copy of the one in `src/enrichment-projection.js`, used only to time the passes, and was checked equal to `projectionKey` on 2,000 entities.)

## A pitfall found on the way: the test context inflates the key phase

The first version of this benchmark loaded the sources through the test helper `tests/d1-enrichment-context.mjs`, which runs them in `vm.createContext()`. In that sandbox every global read (`Math.imul` twice per character in the hash loop, `JSON`, `Map`) goes through the sandbox's property interceptor, and the key phase took **13,123 ms instead of 426 ms** at 52,000 entities (a V8 profile put 59 % of the build in `hash53`). The same copy of `hash53` outside the sandbox hashes the same text in 0.16 s. That figure was an artifact of the harness, not of the code, and would have been wrong to compare with the Worker, where the bundle is plain script scope. The benchmark now loads the same sources with `vm.runInThisContext` by default (`--vm 1` reproduces the sandbox):

| Entities | Phase | Ordinary global scope ms | Sandboxed test context ms | Ratio |
| --- | --- | --- | --- | --- |
| 13,000 | lifecycle | 146 | 214 | 1.5 |
| 13,000 | inputs | 83.0 | 102 | 1.2 |
| 13,000 | keys | 102 | 3,279 | 32.2 |
| 52,000 | lifecycle | 2,690 | 3,055 | 1.1 |
| 52,000 | inputs | 1,498 | 1,856 | 1.2 |
| 52,000 | keys | 426 | 13,123 | 30.8 |
| 104,000 | lifecycle | 14,301 | 16,917 | 1.2 |
| 104,000 | inputs | 7,442 | 8,834 | 1.2 |
| 104,000 | keys | 885 | 26,445 | 29.9 |

The lifecycle and inputs phases are 14 to 47 % slower in the sandbox, with the same shape (slopes 1.95 and 2.03 there against 2.04 and 2.03 here), so their quadratic growth does not depend on the loading; the key phase does, by a factor of 30. **Consequence for earlier evidence:** CPU figures taken inside the sandboxed test context (for example the "JS plus in-memory SQLite CPU per Film" of the [AIR-391 spike](air-391-bulk-projector-spike-2026-11-09.md), 1.6 to 2.1 ms) may be inflated by the same effect and are not Worker CPU; its round-trip and statement **counts** are unaffected. This was not re-measured here.

## Comparison with the natural tick of AIR-396 (what it does and does not show)

| Quantity | Value | Source |
| --- | --- | --- |
| `diff.checkpointCount` wall, 09 Nov 2026 23:00 Madrid | 9,608 ms | AIR-396 (D1 meta: 6.1 ms of server SQL) |
| Worker CPU of that whole invocation | 10.5 s | AIR-396 telemetry |
| Offline view build, 52,000 entities, median | 4.70 s wall, 4.94 s CPU | this report |
| Offline view build interpolated to about 48,500 entities | about 4.1 s wall (about 4.3 s CPU) | this report (interpolation of the 52,000-entity medians) |

Like is compared with like: the offline **wall** time (4.70 s) is about 49 % of the observed **wall** phase (9.6 s), and the offline **CPU** time (4.94 s) is about 47 % of the invocation's **Worker CPU** (10.5 s); wall and CPU differ by 5 % here, and the two ratios are not independent evidence of each other. The magnitudes are of the same order, which makes H2 (CPU charged to the next I/O phase by a Worker clock that does not advance during CPU) **plausible and not excluded**; they do **not** establish it, for these reasons that one offline experiment cannot remove:

1. **A different machine and runtime.** This is Node on one Xeon core, not workerd; the Worker's per-core speed, its isolate limits and memory behaviour are unknown, and a 2x difference either way is within what this can hide. The 52,000-entity total alone leaves about 4.9 s of the 9.6 s unexplained.
2. **A different input.** The fixture has none of the production's programme `shows`, the discovery-decision resolution (thousands of entries), the Letterboxd diary, the rated-archive admissions or the TMDB retirements, all of which the real view build also reads, and its text sizes are modelled. The production view takes more CPU than this fixture by an unknown factor.
3. **Competing explanations stay open.** D1 transport or queueing before the first query (AIR-396 H3 and H4), a cold database connection on the first touch and other work of the same hourly invocation produce the same symptom. The D1 `meta` that AIR-396 added to the projector (`sqlUs`, `dbRows`, `replica` per phase) separates the database's server SQL time from the **combined** non-SQL remainder of a phase (`ms - sqlUs/1000`); it cannot attribute that remainder to queueing, transport or clock-charged CPU independently, so those three stay unresolved. Telling them apart needs further instrumentation (for example timing a trivial D1 read right before and right after the CPU stretch) or an intervention (shrinking the CPU stretch and watching whether the phase shrinks with it); this report does neither.
4. **The Worker clock cannot be tested here.** That `Date.now()` advances only across I/O in a Worker is a platform property this offline run does not exercise; the AIR-396 evidence for it is that the slow phase follows the first I/O after the CPU stretch, not that the CPU was measured.

Matching magnitudes are not a cause: if the optimization below were made and the first-I/O phase did not shrink by about what the CPU fell, H2 would be refuted for the next tick.

## GO / NO-GO

- **GO, for one separate card ("D1 projector: linear lookups in the lifecycle and input build"), conditional on its own acceptance.** The quadratic cost is a measured fact of this code, independent of the Worker-clock question: at 104,000 entities the two phases take 21.7 s on this machine, and the production view grows with Discovery. Scope: replace the per-Film scans named above with indexes built once per run (a Map of the Films by trusted TMDB id for the catalog merge, a rank Map for `orderedRecords`, id and alias indexes for `metadataRecord`, Sets for `listedOnWatchlist` and `onCurrentList`), keeping first-match and source-order semantics. **Baseline:** this report (2,690 and 1,498 ms at 52,000 entities, slopes 2.04 and 2.03); **expected gain** (an upper bound read off the profile, not a promise): up to about 3.4 of the 4.7 s of sampled wall time, with a linear slope; **risks:** a view that differs in order or in the first match (the view feeds the change keys, so a difference rewrites checkpoints and, with the flag on, Films), stale indexes if a source object is mutated between builds; **gates:** byte-identical view and inputs on this fixture and on the existing lifecycle, enrichment-projection and projector tests, the change keys of every entity unchanged, this benchmark re-run with a slope close to 1, and the **natural-run acceptance** that matters: the invocation CPU telemetry and the first-I/O phase after the build on the next ticks, read together with the AIR-396 `meta`. The card must say that it may leave the pre-write overhead unchanged if H2 is false.
- **NO-GO, for now:** any change to the query order, to `diff.checkpointCount`, to the writer path, to the window or to budgets on this evidence (AIR-396's conclusion stands, and moving the count moves the slow phase); a change to hashing or serialization (linear, 9 % of the build, replacer overhead about 87.5 ms); caching the view across runs (a plan must not outlive its window, ADR 0106).

## Limitations

- One machine, one Node version, synthetic data; absolute times do not transfer to the Worker. The shape (slopes, shares) is more robust than the milliseconds, and the 30x harness effect shows how far a loading detail can move a figure.
- The fixture's mix of discovered and watchlist Films, the missing production inputs listed above, and the size of the owner-review document are modelled; a sensitivity run over those shares was not made.
- The metadata-cache transform (`diff.metadataCache`, D1 rows) and R2 JSON parsing are outside the measured stretch and are not included.
- GC figures are approximate: the harness forces `global.gc()` before every measured phase and observes GC events asynchronously, so the per-phase `gcMs` (about 5 % of the build) is an order of magnitude, not an attribution, and says nothing precise about GC in a Worker.
- Seven repeats a size and two warm-ups; the 104,000-entity size has the widest spread (19.1 to 24.2 s total) because of GC and memory growth.
- The benchmark does not run in CI; it is a manual tool. Its fixture is generated, so no production payload is stored.

## STOP and rollback

Offline evidence and one script only: nothing is applied and no runtime path changes. A revert is an ordinary PR. The optimization card, if opened, needs its own plan, review and natural-run acceptance, and must not be combined with an activation of the grouped write path or with any change to the writer.
