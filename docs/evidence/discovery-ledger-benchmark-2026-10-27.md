# Bounded discovery ledger: offline memory benchmark, 27 October 2026

[AIR-220](https://trello.com/c/uPvMc5ww) · offline, synthetic. Implements [ADR 0034](../adr/0034-bounded-discovery-ledger.md). Follows the [AIR-211 memory report](epg-memory-pressure-2026-10-27.md).

**Captured at:** 2026-10-27, branch of AIR-220 on top of `main` `0a5d4fb`. **Command:** `node scripts/discovery-ledger-benchmark.mjs --output <dir outside the repo> --sizes 20,40,63,90`. **Scope:** synthetic stores only; no network, no R2, no production data. **Evidence lifecycle:** dated measurement of this code and this synthetic shape. **Operational authority:** none. Nothing was deployed, activated or written to production.

## Method

- **Data.** Each size gets a synthetic full-mode store: a ledger of every candidate ever seen, ~1 KB per item with Cyrillic titles and descriptions. Exactly 22,000 candidates are in the latest scan, each with two shows; this matches the order of magnitude recorded for the production generation. The store also holds the other objects at the sizes AIR-211 measured: catalog 5.96 MB, view index 4.55 MB, programme 2.24 MB, plus 8,800 decisions.
- **Bounded store.** The bounded store is what one `bounded` commit of the same scan makes from the full store. That is the offline equivalent of the AIR-222 split; the split itself was not measured.
- **Scenarios.** Each scenario runs the real Worker code (`src/*.js` in a `vm` context) in a child process with object bodies on disk.
  - The **commit** is `publishGenerationWithLedger` with the next day's scan: 5 % of the candidates leave and 5 % of the archived ones return.
  - The **chunk** is one `POST /api/enrichment/discovery/resolve`; TMDB is unreachable, so the chunk ends after its reads and writes.
- **Measure.** For each scenario, a binary search finds the smallest `--max-old-space-size` (with `--max-semi-space-size=1`) at which it completes.

## Results

| Full ledger | Items (total / in scan) | Commit, `full` | Commit, `bounded` | Chunk, `full` | Chunk, `bounded` | Active ledger (bounded) | Archive (bounded) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 24.5 MB | 23,000 / 22,000 | 114 MB | 114 MB | 98 MB | 98 MB | 23.6 MB | 1,120 items, 1.2 MB |
| 35.6 MB | 36,857 / 22,000 | 157 MB | 114 MB | 114 MB | 98 MB | 23.6 MB | 14,977 items, 15.4 MB |
| 52.6 MB | 58,049 / 22,000 | 228 MB | 114 MB | 161 MB | 98 MB | 23.6 MB | 36,169 items, 37.1 MB |
| 72.6 MB | 82,928 / 22,000 | 307 MB | 114 MB | 212 MB | 98 MB | 23.6 MB | 61,048 items, 62.6 MB |

The archive is spread over 64 write-once segment versions, about 1 MB each at the largest size.

## Reading

- **Bounded memory is independent of history.** With the scan held at 22,000 candidates, the bounded commit needs 114 MB and the bounded chunk 98 MB at every history size. In full mode both grow linearly: 114 → 307 MB for the commit, 98 → 212 MB for the chunk.
- **Bounded memory is set by the active ledger.** The active ledger is 23.6 MB, so the 10–15 MB working hypothesis of ADR 0034 does not hold for this shape. Whether production fits with margin depends on the real size of a scan and its show counts, which were not read.
- **The archive grows on its own.** Per commit, only the touched segment versions are read and written, one at a time.
- **The numbers are relative.** Node's old-space limit is not the Workers isolate limit; AIR-211 records a production retry that succeeded where this model predicted more than 128 MB. The comparison between modes, and the shape of the curves, carry over. The absolute values do not.

## Not measured

- The first bounded commit over a full production ledger (the AIR-222 split). It parses the full ledger once, like any `full` commit today.
- The EPG XML scan of a real commit, which adds to the commit's memory in both modes.
- Real production item composition.

**Used by:** [AIR-220](https://trello.com/c/uPvMc5ww), [ADR 0034](../adr/0034-bounded-discovery-ledger.md). **Superseded by:** none recorded.
