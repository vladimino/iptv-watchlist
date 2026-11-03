# EPG generation put: known-length stream on workerd, 3 November 2026

Offline only. No production read or write.

**Captured at:** 2026-11-03, 19:34 UTC.

**Source:** Node.js v22.23.4 and Miniflare's workerd, compatibility date `2026-10-18`. Measured tree `45a61612fbcc020f52286e01cf2d63a385687855`, parent `13dff02`. `tests/epg-r2-known-length.mjs` loads the Worker sources, including `putKnownLength` and the discovery generation writer, as one module. D1 is Miniflare's local D1 with migrations `0001`–`0008` and `published_epg_authority.mode=d1`, `cutover=open`. R2 is Miniflare's local bucket. No isolate memory cap was set.

**Evidence lifecycle:** dated measurement. **Operational authority:** none. It does not clear a live EPG step, a lease reset, or a claim that the production isolate stayed under its limit. The 3 November Node memory reading stays in [epg-commit-memory-2026-11-03.md](epg-commit-memory-2026-11-03.md).

## What was measured

`R2.put` of a plain `ReadableStream` and of `FixedLengthStream`, then one synthetic frozen publication.

The predecessor ledger has 34,102 stored rows, Russian titles and three showings. The last row repeats the canonical key of the first. The archive manifest reports 23,820 archived items; only the re-entry segment is stored. The latest scan has 19,868 candidates (19,867 overlapping the ledger, plus that one re-entry). The watchlist has 395 films and the catalog 2,631. The ledger is seeded by a fixed-length stream, not by one concatenated string.

The publication counts UTF-8 bytes on the decision walk, puts the generation document through `FixedLengthStream`, and copies the generation objects with each object's stored size.

## Results

| Check | Result |
| --- | --- |
| Plain `ReadableStream` put | `TypeError`, message matches `known length`. Nothing useful is stored |
| `FixedLengthStream` of `{"название":"Брат"}` | stored size equals the UTF-8 byte length, text matches |
| Body four bytes short of the declared length | put throws, object absent |
| Seeded ledger | 43,925,228 bytes, pad 360, 2.5 s |
| Generation object and stable `epg/discovery-latest.json` | both 25,731,133 bytes |
| Streamed item count, `Брат 0`, re-entry title | 34,102, both titles present |
| Programme and catalog copies | 338 and 184,582 bytes |
| D1 after publish | authoritative, mirrored, programme run `00ff34fa-e518-4ac7-ae63-b2e46f803503`, generation 2 |
| Publish wall time inside the isolate call | 8.7 s. The whole request, including the seed, was 12.0 s |

The written generation is smaller than the seeded ledger because rows that also appear in the latest scan are replaced by that scan's short candidates. The same replacement showed up in the Node memory reading.

Process samples, not isolate heap: the Node test process after the run had heap 50.1 MB, external 5.8 MB, array buffers 1.8 MB. The workerd process RSS high-water mark was 535,788 KiB (about 523 MiB). That process holds the local R2 simulator and the runtime. It is not the Workers isolate, and no 128 MiB cap was applied. A completed run here does not show that a production commit stays under the isolate limit.

## Reading

workerd refuses a plain `ReadableStream` and accepts the readable side of `FixedLengthStream` when the byte count matches. The generation copy lands on the stable key at the same size, so the copy is not dropped for lack of a known length. A mismatch is rejected before the D1 pin: the short-body probe stores nothing, and the Node suite covers a failed generation put that leaves the published pin and the archive pointer where they were.
