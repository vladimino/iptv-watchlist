# D1 enrichment projector: linear indexes in the view build (byte-for-byte parity and offline benchmark)

**Captured:** 2026-11-10, offline on one machine (Intel(R) Xeon(R) Processor at 2.30 GHz, 4 cores, Node v22.23.4, V8 12.4.254.21-node.57), deterministic synthetic fixtures. No production read or write of any kind (no D1, no R2, no Cloudflare, no personal data), no manual projector, Discovery or EPG run, no flag, Task, cron, window, lease or budget change. Local `npm test` passed 275 of 275 files and `npm run build` succeeded on the committed code. The natural-run observation that the card also asks for comes after the release and is a separate, dated section below.
**Scope:** [AIR-402](https://trello.com/c/EIWn61UG): replace the per-Film scans of the projector's CPU-only build (`readLifecycle`, `enrichmentInputs`) by indexes built once per build, with no change to the result, its order, the first match or the change keys. It follows the [AIR-400 profile](air-400-view-cpu-profile-offline-2026-11-09.md), which found the two phases quadratic. It does not touch D1, the query order, the writers, the budgets, the hashes or the checkpoint path.
**Verdict:** **BYTE-FOR-BYTE PARITY ON 144 SEEDED STORES AND A MODEL TEST OF THE INDEX; THE TWO QUADRATIC PHASES ARE NOW LINEAR AND THE BUILD TAKES ABOUT 0.8 TO 0.9 S INSTEAD OF 4.8 S AT 52,000 ENTITIES ON THIS NODE MACHINE; NOTHING IS CLAIMED ABOUT WORKERD OR ABOUT THE FIRST D1 READ.** `diff.lifecycle` went from a log-log slope of 1.90 to 1.95 to 1.06 to 1.10 and `diff.inputs` from 2.06 to 2.08 to 1.05 to 1.15; the change keys (linear before and after) are now about half of the build.
**Used by:** [ADR 0106](../../adr/0106-bulk-projector-write-path.md) (the pre-write overhead every window pays); [AIR-396 RCA](air-396-d1-first-query-latency-2026-11-09.md) (H2); [AIR-400 profile](air-400-view-cpu-profile-offline-2026-11-09.md).

## What changed (and what did not)

Five lookups, all inside one build, none kept between runs:

| Where | Before | After |
| --- | --- | --- |
| `readLifecycle`, catalog merge (`src/domain/film-person-reader.js`) | for each catalog record, `[...films.values()].find(...)` twice: the first Film of the map with a trusted, non-conflicting TMDB id equal to the record's, and the Film whose stored id is the record's | `orderedFilmIndex`: buckets by trusted TMDB value and by stored id, each Film with the sequence number of its place in the map; the first match is the lowest number. A key set again keeps its place, a key deleted and set again goes to the end, as in a Map |
| `orderedRecords` (`src/enrichment-projection.js`) | for each Film with two or more source records, rebuild the array of all records and `includes` each | positions of each record in the source lists, computed once per `enrichmentInputs`; the records come out in list order (once for each place they sit in), then the archive-only records in the order found |
| `metadataRecord` | `Object.entries(body)` walked for each Film | `metadataLookup(body)`: the position of the first entry that offers each string (its key or `String(value?.id)`); a Film takes the lowest position over its ids |
| `listedOnWatchlist` and `onCurrentList` | `some` over the watchlist and the programme for each Film | Sets of `String(item.id)` built on first use; a watchlist that holds a `null` or `undefined` item keeps the linear function, which throws on it |

Unchanged: the exported `metadataRecord` and `listedOnWatchlist` (kept as the reference), the view, the inputs, `filmChangeKey`, `personChangeKey`, the checkpoint buckets, the owner overlay, the order of D1 queries and every writer. No flag, schema, authority or document contract moves, so no reference or ADR change is needed.

## Parity: what the tests prove (`tests/projector-view-parity.mjs`)

The baseline is a frozen copy of `src/domain/film-person-reader.js` and `src/enrichment-projection.js` at `d73ac48` (`tests/fixtures/air-402-baseline/`), loaded beside the current sources in separate scopes.

- **144 stores** (6 shapes by 24 seeds, 13,611 Films and 43,556 Persons in all), each built twice so that the two implementations never share an object, go through `readLifecycle(entitiesOnly)`, `enrichmentInputs` and every `personChangeKey` and `filmChangeKey`: the JSON text of the view, of the inputs and the list of keys are identical.
- **The stores reach the paths the indexes replace:** two catalog records with one TMDB id, a catalog record with the TMDB id of a listed Film (632 redirects in the views), two listed Films with one TMDB id, a catalog record whose id is already a stored id, a thin rated-archive stub under a catalog id (richer and poorer than the record), metadata entries under a lid, under `tmdb_<n>`, under a key whose own id names another film, `null` entries and integer-like keys, ids with accents, combining marks and astral characters, a record listed on both lists as one object, falsy list items, retained admitted Films with and without a cache (withheld inputs), and Films that two metadata entries answer to by two different ids.
- **A model test of the index:** 1,500 random `set` (new keys and keys set again), `delete` and lookups, for 8 seeds, against the linear scans the index replaces, comparing the map order and both answers after every step.
- **A null item in the watchlist:** with a retained Film the linear lookup reaches the null item and throws; the indexed code throws the same error. Without one, the same inputs.
- **Six deliberate defects fail the tests:** the last Film wins in a TMDB bucket; a key set again moves to the end; a deleted Film stays in the index; records are not restored to list order; the last metadata entry wins for an id; the highest position wins among a Film's ids.

## Benchmark (`scripts/projector-view-cpu-bench.mjs --impl baseline|indexed`)

Same fixture (deterministic, seed 7, about 19 % Films), same machine, same Node, loaded the same way (`vm.runInThisContext`, ordinary global scope, not the sandboxed test context), 2 warm-ups and 7 repeats on freshly cloned stores, and the two implementations run in alternation (baseline, indexed, baseline, indexed) so that a drift of the machine would show. The first column of each pair is round 1, the second round 2. Wall times in ms, medians.

### At 52,000 entities (9,880 Films, 42,120 Persons)

| Phase | Baseline round 1 / 2 | Indexed round 1 / 2 | Factor |
| --- | --- | --- | --- |
| lifecycle | 2,749 / 2,766 | 278 / 340 | 9.9 / 8.1 |
| overlay | 34.6 / 34.4 | 35.8 / 43.2 | (unchanged code) |
| inputs | 1,563 / 1,608 | 76.4 / 91.6 | 20.4 / 17.6 |
| keys | 408 / 421 | 408 / 446 | (unchanged code) |
| **total wall** | **4,768 / 4,836** (min to max 3,717 to 5,639 / 4,585 to 5,089) | **800 / 923** (768 to 820 / 846 to 979) | **6.0 / 5.2** |
| total CPU (`process.cpuUsage`) | 4,982 / 5,088 | 1,139 / 1,293 | 4.4 / 3.9 |

The coefficient of variation of the total is 0.021 to 0.157 (the highest is the baseline lifecycle phase of round 1, whose minimum was 1.8 s against a median of 2.7 s). The indexed CPU time is larger than its wall time (1.14 s against 0.80 s) because `process.cpuUsage` counts V8's background threads (concurrent garbage collection and compilation) as well as the main thread; the wall time of the main thread is the figure that compares with a single Worker thread.

### Scaling (median wall ms of the lifecycle and inputs phases, rounds 1 / 2)

| Entities | Lifecycle baseline | Lifecycle indexed | Inputs baseline | Inputs indexed | Total baseline | Total indexed |
| --- | --- | --- | --- | --- | --- | --- |
| 6,500 | 52.4 / 56.3 | 33.3 / 34.4 | 23.5 / 25.5 | 9.8 / 9.1 | 129 / 139 | 99 / 99 |
| 13,000 | 147 / 154 | 69.0 / 67.9 | 77.2 / 84.4 | 19.7 / 17.4 | 335 / 352 | 193 / 193 |
| 26,000 | 673 / 677 | 137 / 144 | 388 / 397 | 36.6 / 39.8 | 1,281 / 1,309 | 397 / 407 |
| 52,000 | 2,749 / 2,766 | 278 / 340 | 1,563 / 1,608 | 76.4 / 91.6 | 4,768 / 4,836 | 800 / 923 |
| 104,000 | 10,313 / 9,762 | 664 / 685 | 7,119 / 7,400 | 188 / 215 | 18,413 / 18,504 | 1,851 / 1,878 |

| Log-log slope (1 is linear, 2 is quadratic) | Baseline round 1 / 2 | Indexed round 1 / 2 |
| --- | --- | --- |
| lifecycle | 1.95 / 1.90 | 1.06 / 1.10 |
| overlay | 1.10 / 1.04 | 1.20 / 1.21 |
| inputs | 2.08 / 2.06 | 1.05 / 1.15 |
| keys | 1.02 / 1.03 | 1.04 / 1.06 |
| total | 1.81 / 1.79 | 1.05 / 1.08 |

The slopes include the fixed per-phase costs at the small sizes, so they are fits and not exact exponents; the overlay slope of 1.2 is the unchanged code on a few tens of milliseconds.

### Parity at benchmark scale, and where the time goes now

- **Byte-for-byte at 52,000 and 104,000 entities.** The same fixtures as the benchmark go through the baseline and the indexed code (separate scopes, separate clones of the store): the SHA-256 of the JSON of the view, of the inputs (61.8 MB at 52,000 entities, 123.8 MB at 104,000) and of the list of every change key are equal, with 9,880 and 19,760 Films and 42,120 and 84,240 Persons. This was a one-off check in a scratch script, not committed; the committed test is the 144-store comparison above.
- **A V8 sampling profile of one indexed build at 52,000 entities** (sampled total 1,158 ms; its largest frame, 237 ms in `post` at `node:inspector`, is the profiler's own stop call and not part of the build): `projectionKey` 217 ms (19 %), `personChangeKey` 96 ms, garbage collection 89 ms, `readLifecycle` 74 ms (self time; 2,055 ms in the AIR-400 profile), `stamp` 61 ms, `filmChangeKey` 50 ms, `hash53` 42 ms, `personView` 30 ms. `orderedRecords` and `metadataRecord` (827 and 503 ms in AIR-400) are no longer among the top frames. What is left is the change keys and the view's own object building.

## What this does not show

- **Not workerd.** These are Node and V8 times on one machine; the Worker is another runtime and CPU. The factor is a property of the algorithm (two scans per record and per Film became bucket lookups); the milliseconds are not a Worker figure.
- **Not the first D1 read.** [AIR-396](air-396-d1-first-query-latency-2026-11-09.md) found the first heavy read slow and [AIR-400](air-400-view-cpu-profile-offline-2026-11-09.md) found 4.7 s of build CPU on this machine, which is of the same order but proves no cause. Whether the slow first I/O of the natural runs shrinks is read from natural runs only, below.
- **Synthetic data.** Production's mix of collisions, retired Films and catalog skew is unknown; the parity test covers the paths on purpose and the benchmark's uniform fixture says nothing about worst cases.
- **The change keys are now the largest phase.** At 52,000 entities they take 408 to 446 ms, about half of the indexed build, and are linear; they were out of scope.
- **Retirements** (`tmdbRetirements`) run before the index is built; the parity stores leave them null, and the existing retirement tests run on the new code unchanged.

## Natural acceptance (after the release)

To be read after the post-merge deploy on at least two natural hourly runs, read-only (Worker logs `event=d1_enrichment_projection`: `preWriteMs`, `diff.checkpointCount` wall and `sqlUs`, `diff.storedRead`, volumes and the writer's outcome, and the invocation's CPU and wall time), compared with the runs before it by mode (fast or slow), backlog and concurrent reads. A change in the first-I/O phase is not attributed to this change without proof. Not yet observed.

## STOP and rollback

A natural run whose view, inputs or checkpoints differ from the runs before it (unexplained changed entities, a different `stored` or `remaining` for the same inputs), or a rise of the diff phases over the earlier runs, ends in the ordinary code revert of the PR; no data is touched, since the change keys and rows are unchanged.
