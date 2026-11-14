# AIR-485: offline comparison of EPG seal staging layouts, 14 November 2026

Offline only: Node v22.23.4, the Worker bundle loaded in-process, the D1 stand-in on a local SQLite file with every migration applied, a file-backed R2 stand-in. Synthetic data, no private payloads. No production read or write, no Workflow, Discovery, TMDB, flag, lease, Task, R2, D1 or Access action. Tree: `origin/main` at `f5c57498` (after [PR #635](https://github.com/vladimino/iptv-watchlist/pull/635)); the same run at `962dc37d` gave the same figures within 1-2 MiB. **Operational authority: none.** Design input for [ADR 0145](../../adr/0145-epg-seal-publication-only-staging.md) (Proposed).

Reproduce: `npm ci && node scripts/epg-seal-staging-bench.mjs` (about 130 s; `--out file.json` writes the rows below; `--only C:catalog` runs one cell).

## Volumes

Sized like the natural runs of 13-14 November 2026 ([seal memory RCA](../epg-seal-memory-rca-air-460-2026-11-13.md), [stream measurements](air-460-seal-stream-workerd-2026-11-14.md), [M3 step metrics](../d1-migration/air-374-m3-epg-step-metrics-2026-11-13.md)): 9,226 catalog Films in D1 `discovery_admission` (12.7 MB of JSON), 30% of them airing, programme `report` 2,242,013 bytes, watchlist 1,477,694 bytes over 396 Films. The staged objects each layout writes:

| Layout | Staged R2 objects (MiB) |
| --- | --- |
| A0, A1 | `payload.json` 14.2 |
| B | `report.json` 2.1, `catalog.json` 10.7, `watchlist.json` 1.4, `rest.json` (uncertain, fence, expected) under 0.1 |
| C, C+ | `payload.json` without the catalog 3.6, `availability.json` 0.8 |

Every Film's admission changes in every run (`changedFilms` 9,226), because `replaceCatalogAvailability` stamps `showsProgrammeRunId` on each Film with a `tmdbId`. The volume is the same in all layouts.

## Layouts

- **A0**: `main`, the Worker's own step code.
- **A1**: A0's object; `seal_catalog` reads the D1 catalog once instead of twice. Other steps are A0's.
- **B**: an R2 split into four objects; each step reads only its parts. `rest.json` stands in for a manifest.
- **C** (D1-aware): no staged catalog. The staged input is the scan's confirmed availability (`{confirmedTmdbId, shows}`), the exact input of `replaceCatalogAvailability`. `seal_catalog` rebuilds the catalog from the live D1 rows with the Worker's own `replaceCatalogAvailability` and `mergeCatalogIdentity`.
- **C+**: C, plus the publication's D1 rows staged and validated in `published_epg_stage` before the seal. The `pointer` unit then commits that stage in one batch. It reuses the existing tables; no schema change.

**Equivalence.** With the D1 rows unchanged since the scan, C's rebuilt catalog equals A0's merged catalog byte for byte. The harness asserts this and fails otherwise.

## Method

Each (layout, step) cell runs in a fresh child process over a fresh copy of the prepared state.

- **`minHeap`** is the smallest `--max-old-space-size` (MiB) at which the step completes, found by binary search (8-512, `--max-semi-space-size=2`). It bounds the live V8 heap including synchronous peaks such as a whole-text `JSON.parse`. The harness and Worker bundle baseline is 8.9 MiB.
- **R2 and D1 counters** come from a separate uncapped run.
- **Stubs.** `persistWatchlist`, `persistScan`, `persistEvents`, `refreshPredictionQueue`, `queueCommittedDiscovery`, `ratingsGate`, `prepareEpgCompletion` and `flushEpgEvent` are stubbed identically in every layout. So the finalize and queue figures measure what the payload layout contributes, not those units.

## Observed

Each cell was searched twice; the two `minHeap` values are shown.

| Layout | Step | minHeap MiB | Wall ms | R2 read (gets / MiB) | D1 reads (count / MiB) | D1 statements written |
| --- | --- | --- | --- | --- | --- | --- |
| A0 | `seal_catalog` | 63 / 63 | 981 | 1 / 14.2 | 25 / 16 | 40 |
| A1 | `seal_catalog` | 64 / 64 | 517 | 1 / 14.2 | 13 / 8 | 40 |
| B | `seal_catalog` | 55 / 56 | 508 | 1 / 10.7 | 13 / 8 | 40 |
| C | `seal_catalog` | **40 / 40** | 497 | 1 / **0.8** | 13 / 8 | 40 |
| A0 | `seal_publish` (4 units) | 44 / 46 | 349 | 3 / 18.5 | 30 / 0 | 2,077 |
| B | `seal_publish` | 31 / 31 | 294 | 5 / 7.8 | 30 / 0 | 2,077 |
| C | `seal_publish` | **31 / 31** | 262 | 3 / 7.8 | 30 / 0 | 2,077 |
| C+ | `seal_publish` | 18 / 18 | 75 | 3 / 7.8 | 19 / 0 | 12 |
| A0 | `seal_finalize` | 44 / 44 | 103 | 1 / 14.2 | 0 | 0 |
| B | `seal_finalize` | 15 / 15 | 14 | 1 / 2.1 | 0 | 0 |
| C | `seal_finalize` | 18 / 18 | 22 | 1 / 3.6 | 0 | 0 |
| A0 | `seal_queue` | 44 / 44 | 107 | 1 / 14.2 | 0 | 0 |
| B | `seal_queue` | 15 / 15 | 15 | 1 / 2.1 | 0 | 0 |
| C | `seal_queue` | 18 / 17 | 23 | 1 / 3.6 | 0 | 0 |

Notes on the table:

- **`seal_catalog`.** The step wrote 228 admissions; that is the first batch, which the deadline stopped. The write volume per batch is the same in every layout.
- **`seal_publish` R2 traffic.** R2 writes are 8 objects and 9.2 MiB in every layout (generation programme, mirrors, copy, uncertain).
- **C+ staging cost.** C+ moves 15 D1 reads, 8 batches, 2,064 statements and 2.3 MiB of D1 writes out of `seal_publish` into staging time (176 ms).

## What the figures show

- **No catalog in the step.** Removing the catalog from what a step parses is the only change that lowers `seal_catalog` (63 to 40 MiB). It also lowers every later step (44 to 31 MiB for publish, 44 to 18 MiB for finalize and queue). C reaches it without copying the D1-owned catalog to R2. B also lowers the later steps, but in `seal_catalog` it still parses a 10.7 MiB copy of a domain D1 owns.
- **One D1 catalog read (A1).** It halves the D1 read volume of `seal_catalog` (16 to 8 MiB, 25 to 13 reads) and its wall time (981 to 517 ms), but does not lower the peak. The first read's objects are garbage before the second read is parsed, so the peak is one read, not two. It is worth having for D1 load and time, not for memory.
- **C+.** It lowers `seal_publish` further (31 to 18 MiB, 2,077 to 12 statements) only by doing the same staging work in another step. That step's peak was not measured; inferred, it is about today's pointer unit, since it builds the same chunks from the same report.

## Final layout after ADR 0142 decision 13 (D), derived

Layout D is assessed for the owner's order, in which ADR 0142 decision 13 (M5) reaches `main` first. D stages only C's `publication.json`, with no catalog, no `availability.json` and no `seal_catalog` phase.

- **Not a separate run.** D's object is byte for byte C's `bench/C/payload.json`, so D's `seal_publish`, `seal_finalize` and `seal_queue` are the C rows above: 31, 18 and 18 MiB, with 3.6 MiB of R2 read per step.
- **No catalog step.** D has no `seal_catalog`, so the A0 63 MiB step, its 14.2 MiB R2 read and its 8-16 MiB of D1 reads disappear.
- **D1 writes come from M5, not from D.** That the 9,226 admission writes per run disappear follows from M5 removing the availability writes.
- **Why `seal_catalog` has no work after M5 (code reading of `epgSync` at `00d3f162`).** The staged catalog is `replaceCatalogAvailability(cache, ...)` over the scan-time D1 read, and the scan gets copies of the cached Films. Without the availability writes, the staged catalog equals the scan-time copy of D1, so the phase has nothing of its own to write.
- **M5 status.** At `00d3f162`, M5 is not delivered: `epgSync` still calls `replaceCatalogAvailability`.

## Inferred, not measured

- **`seal_stage` serialisation.** Its write transient shrinks with the staged bytes: one `JSON.stringify` of 14.2 MiB in A0 against 3.6 + 0.8 MiB in C. Cyrillic text makes these two-byte V8 strings, roughly twice their UTF-8 length. That step also holds the scan residue; its heap was not measured here.
- **R2 read amplification per run.** It is the payload read of every seal step attempt: (catalog steps + publish steps + finalize + queue) × 14.2 MiB in A0. In C it is catalog steps × 0.8 MiB plus the others × 3.6 MiB. The step counts of a natural run were not read.
- **`sync.json` copy of the watchlist.** `sync.json` carries `run.watchlist` (the same Film list as `payload.watchlist`) and is read about three times and written at least once per action. That copy is not changed by any layout here.

## Not established

- **workerd accounting.** Node V8 heap is not the workerd 128 MiB isolate accounting, which also counts buffers and native memory. The figures rank layouts; they are not isolate headroom.
- **No OOM fix claimed.** The 14 November OOMs were in `seal_ledger` and at `seal_publish_copy` ([AIR-462 correlation](air-462-epg-oom-natural-run-2026-11-14.md)). `seal_ledger` streams only the generation ledger and reads no payload, so **no layout here changes it**. For `seal_publish_copy`, every layout already holds `report` and `watchlist` (A0 deletes the catalog after parsing). C lowers the step's entry peak and the garbage it leaves, not what is resident during the copy.
- **Production sizes.** No production payload was read: the card allows offline work only. The catalog churn, the airing share and the number of seal steps per run are taken from the cited dated evidence, not re-measured.
- **Concurrent D1 changes.** The behaviour when D1 rows change between the scan and `seal_catalog` is a code reading (see ADR 0145). The benchmark covers only the unchanged case. In layout D the question disappears, because the seal writes no catalog.
