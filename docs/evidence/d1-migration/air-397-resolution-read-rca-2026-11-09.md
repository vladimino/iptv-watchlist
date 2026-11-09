# D1 projector: why `read.resolution` is slow (read path, aggregates, offline cost; root cause inconclusive)

**Captured:** 2026-11-09 and 2026-11-10 UTC, read-only: the code of `main` at `039f02b`, the stored `projection_run.summary_json` of the 20:00 and 22:00 UTC runs, one D1 aggregate `SELECT` over `discovery_decision` (counts and lengths only, no payload), D1 query analytics of the 20:00 UTC window, and an offline benchmark on synthetic rows. No manual projector, Discovery or EPG run, no flag, Task, cron, lease, window or budget change, no production write, no payload downloaded or recorded.
**Scope:** [AIR-397](https://trello.com/c/O1yieGvC). What the projector's read of the shared Discovery decisions does, what it costs, which component of it is slow, and whether the projector needs the whole document. It does not change Discovery, the producer or any read.
**Verdict:** **READ PATH ESTABLISHED; THE SLOW COMPONENT IS NOT ISOLATED (INCONCLUSIVE).** The read is 27 sequential D1 page queries and 26,263 sequential `await crypto.subtle.digest` calls (one per row, an integrity check), with JSON parsing and canonical JSON per row. The database's own time is small (about 5 ms per page). Two components scale with the read and are not separated in production: 27 sequential D1 round trips (about 5 to 9 s if each costs the 180 to 330 ms per call seen in the slow run of [AIR-396](air-396-d1-first-query-latency-2026-11-09.md)) and 26,263 sequential digest awaits (2.4 s on an idle Node machine). Neither alone explains the slow runs (16 to 21 s) with certainty, and one run cannot tell them apart. No fix is recommended on this evidence; three variants with their costs and gates are listed for the owner and Coordinator.
**Used by:** [ADR 0106](../../adr/0106-bulk-projector-write-path.md) (the pre-write overhead every window pays), [AIR-392](air-392-projector-pre-write-overhead-2026-11-09.md).

## The read path (code, `main` at `039f02b`)

1. `d1EnrichmentStore` (`src/d1-enrichment.js`) reads `epg/discovery-resolution.json` through `d1EnrichmentDiscoveryRead`, inside the one `Promise.all` that also reads the catalog and the R2 objects (`store.readBlock`). Under a D1 authority it never reads the R2 copy (frozen at the cutover).
2. `DiscoveryAuthority.routeRead` (`src/discovery-authority.js`) opens the authority row, reads the whole value with `readDecisions`, then reads the authority row again and fails the read (`discovery_fence`) if the generation, programme or transfer state moved. That compare is the staleness guard.
3. `readDecisions` pages `discovery_decision` by `observation_key` (`DECISION_PAGE` = 1,000 rows; one page after the other, a keyset read). For **every row** it: encodes the payload to count bytes, `JSON.parse`s it, computes `decisionHash` (canonical JSON, `await crypto.subtle.digest('SHA-256')`, hex) and compares it with the stored `decision_hash`; any mismatch fails the read (`discovery_unavailable`). Bounds: `DECISION_READ_ROWS` 100,000, `DECISION_READ_BYTES` 16 MiB.

Measured size today (one aggregate `SELECT`, 28.4 ms of SQL): **26,263 rows, 7,520,453 payload bytes, mean 286 bytes, maximum 3,993 bytes.** So one read is 27 page queries (plus the two authority reads) and 26,263 awaited digests.

## What the production runs show

| Run (UTC) | `read.resolution` ms | `store.readBlock` ms | Source |
| --- | --- | --- | --- |
| 14:01 | 6,764 | 6,764 | AIR-392 |
| 15:01 | 16,454 | 16,454 | AIR-392 |
| 16:01 | 1,194 | 1,194 | AIR-392 |
| 17:01 | 18,956 | 18,956 | AIR-392 |
| 19:00 and 20:00 | 3,814 (20:00), range 3.8 to 5.1 s for the two | 3,814 (20:00) | `summary_json` and AIR-395 |
| 22:00 | 20,787 | 20,787 | `summary_json` |

- The read is the longest of the concurrent reads in every run, so it is the whole `store.readBlock` time; the other reads of the block take 0.1 to 4.5 s.
- Implied cost per row on today's row count: 45 microseconds in the fastest run (1,194 ms), 790 microseconds in the 22:00 UTC run. The earlier runs had somewhat fewer rows (not recorded). The two modes differ by a factor of about 17 with the same code and almost the same data.
- **D1 SQL time is small.** D1 query analytics of 20:00 to 20:03 UTC: 164 `discovery_decision` page queries, 164,000 rows read, **830.8 ms** of SQL in total (5.1 ms per page; the window also holds other reads of the table, so this is not one read). For one read of 27 pages that is about 0.14 s.
- **The per-call overhead outside SQL is large in a slow run.** In the 22:00 UTC run every one-row D1 read took 180 to 330 ms of wall time for 0.1 to 1 ms of SQL ([AIR-396](air-396-d1-first-query-latency-2026-11-09.md)). The 27 pages are sequential, so at that overhead they alone cost about 5 to 9 s; in a fast run they cost far less.

## Offline cost of the per-row work (synthetic rows, Node 22, 4 cores)

`node --expose-gc scripts/discovery-decisions-read-bench.mjs` (26,263 synthetic rows of 288 mean bytes, median of 5 after a warm-up; it calls the real `decisionHash`):

| Step | Wall ms | CPU ms |
| --- | --- | --- |
| Current loop (utf8, parse, `await decisionHash` per row) | 2,388 | 1,784 |
| of which `JSON.parse` | 30 | 45 |
| of which canonical JSON | 106 | 125 |
| of which `crypto.subtle.digest`, one await per row | 1,863 | 1,254 |
| of which hex conversion | 69 | 84 |
| Variant: one page of `decisionHash` together (`Promise.all`) | 1,203 | 1,445 |

On this machine the digest awaits are about 78 % of the per-row wall time and the parse is about 1 %; issuing a page of digests together halves the wall time and leaves the CPU the same. A Worker has different digest latency, a different CPU and a busy event loop (the read runs beside the R2 reads of `store.readBlock`), so these numbers do not predict Worker time. They show the structure: the per-row cost is the digest, not the parse, and its cost is paid 26,263 times in sequence.

## Competing hypotheses

| Hypothesis | Evidence | Status |
| --- | --- | --- |
| H1. D1 executes the page queries slowly | About 5 ms of SQL per page; 28 ms for a full scan with aggregates | Excluded as the cause (small) |
| H2. 27 sequential D1 round trips, each with the per-call overhead of a slow run | 180 to 330 ms per call outside SQL in the 22:00 UTC run; 27 sequential pages = about 5 to 9 s | Plausible for slow runs; not measured for these calls |
| H3. 26,263 sequential digest awaits (plus canonical JSON and parse) | 2.4 s offline, digest the largest part; a fast run is 1.2 s in the Worker; each await yields to the event loop | Plausible for all runs; the slow-mode multiplier (about 17) is not explained by an idle-machine cost |
| H4. The read competes with the other concurrent reads of `store.readBlock` for the isolate's event loop and CPU | Concurrent catalog read (1.0 to 4.5 s) and R2 JSON parsing in the same isolate | Open |
| H5. R2 or platform latency in the same block | Slow runs also have a slower `read.catalog` (3.9 to 4.5 s against 0.6 to 1.2 s) and `store.publishedSnapshot` | Open; fits a general slow mode ([AIR-392](air-392-projector-pre-write-overhead-2026-11-09.md)) |

Not established by this evidence: the split of the 20,787 ms of the 22:00 UTC run between the 27 round trips, the 26,263 digests and the contention. No production timing exists inside `readDecisions`.

## Which fields does the projector need?

By reading the code (not proven by a test): the projector builds the view with `readLifecycle(store, now, {entitiesOnly: true})`. The decisions enter it through `decisionForFilm` (`tmdbId`, `filmId`, `status`) and the identity and availability code that receives the matched decision, which reads `status`, `attempts`, `retryAt`, `terminalReason`, `reason`, `tmdbId`, `filmId`, `conflictingTmdbIds` and `discovery`. A second loop over all decisions builds `candidates` and `conflicts`; `enrichmentInputs` and the projector do not read those two. `status`, `attempts`, `retry_at`, `terminal_reason`, `tmdb_id` and `film_id` are columns of `discovery_decision`; `reason`, `conflictingTmdbIds` and `discovery` exist only inside `payload_json`. So the projector does not need the whole payload of every row, but a scoped read is not a three-column read, and the `discovery` object has to be traced before anything is dropped.

## Variants (not decisions; none is done here)

| Variant | Expected effect | Cost and risk | Gate and test |
| --- | --- | --- | --- |
| V0. Keep as is | `read.resolution` stays 1.2 to 20.8 s inside the pre-write time (up to 42 % of the 49.9 s of the 22:00 UTC run) | None | None |
| V1. Optimise the shared read path: hash a page together; if the round trips matter, larger pages | Offline wall time halves for the digest part (2.4 to 1.2 s); a Worker gain is not known; fewer round trips only if the page size grows | Touches the read that Discovery uses too (the bound constants, memory of a page of digests); integrity check kept | The existing `tests/discovery-authority.mjs` bounds and tamper cases, an equality test of the read result, a measurement per component first |
| V2. A scoped read for the projector (select needed columns and JSON fields in SQL, no per-row digest in the Worker) | Removes the 7.5 MB transfer and the 26,263 awaits; about 1 to a few queries; the largest expected gain | A new read API on the Discovery authority (owner gate); the projector would no longer verify each row's hash; needs the `discovery` and `conflictingTmdbIds` uses traced; the generation fence must stay | Owner design gate; a parity test of `decisionForFilm` and the view against the whole read over fixtures; fence and stale-generation tests |
| V3. A cache of the decisions | Not offered: it would risk a stale generation and bypass the authority fence | | |

Recommendation for the Coordinator: before any of V1 or V2, one small instrumentation step that times, inside `readDecisions`, the page queries, the parse and the digests as three aggregate numbers (no payload, no key), delivered through the existing natural run. It settles H2 against H3 with production data and costs no new route, cron or run. Whether to take it is the owner's decision.

## Limitations

- Six production runs with `read.resolution` and one aggregate read; no timing inside `readDecisions`; the 164-query analytics figure covers a window with more than one reader.
- The offline numbers are for an idle Node process on synthetic rows; they do not say what a Worker spends.
- The statements about which fields are used come from reading the code and are not tested.
- The row count of the earlier runs is not recorded, so per-row figures for them use today's count.
