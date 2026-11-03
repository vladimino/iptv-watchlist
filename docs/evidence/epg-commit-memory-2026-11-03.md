# EPG commit memory: synthetic stream and parse, 3 November 2026

[AIR-338](https://trello.com/c/B84isUMG). Offline only. No production read or write.

**Captured at:** 2026-11-03, 17:40–17:56 UTC.

**Source:** Node.js v22.23.4. Measured tree `062fecc84526c7ee712f3cbba223b213c20655d3`, parent `3fbaba377f7a66385c146df5cdd273cfd1c141ef`. `scripts/epg-commit-memory-profile.mjs --child` loads the Worker sources in a `vm`, with a sqlite D1 stand-in (migrations through `0008`, `published_epg_authority.mode=d1`, `cutover=open`).

**Evidence lifecycle:** dated measurement. **Operational authority:** none. It does not clear a live EPG step, a lease reset, or a claim that the production isolate stayed under its limit.

## What was measured

One synthetic `epgSync` in frozen mode, with an archive pointer already present. Counts: 395 watchlist films, 2,631 catalog films, 19,868 discovery candidates from the XML scan, 34,102 active ledger rows. The archive manifest reports 23,820 archived items; only the one re-entry segment is read. The other archived payloads are not materialized. Titles are Russian. Ledger rows have three showings.

Serialized sizes: active ledger 43,116,001 bytes (the run aimed at 43,167,390 bytes), catalog 12,695,809 bytes. The catalog is larger than the 6,222,569 byte object listed on 30 October because the padding is Cyrillic. The previous programme document seeded in D1 is a small continuity stub, not a production-sized programme.

`stream` reads the ledger through a chunked body and never calls `json()` on it. `legacy` exposes `json()` only, so the commit parses the whole ledger. Both paths publish through the D1 stand-in. A successful run moves the authority to the new programme run and generation 2.

## Results

Heap is V8 `heapUsed`. RSS and external include the in-memory bucket, which keeps the input ledger and every written copy. Those copies are R2 objects in production. Node old space is not the Workers isolate: array buffers sit outside the old-space cap and inside an isolate.

| Run | Old-space flag | `generation_publish` heap enter → exit (peak) | Outcome |
| --- | --- | ---: | --- |
| stream, no forced GC | default (limit reported 2,096 MB) | 50.5 → 43.1 (**112.1**); a later run peaked at **67.9** | complete, generation 2 |
| stream, GC at phase markers | default | 42.6 → 27.6 (**67.9**) | complete, generation 2 |
| stream, GC before each sample | default | 50.1 → 43.0 (**50.1**) | complete, generation 2. The timer does not run during a stretch that never returns to the event loop, so this peak can miss the middle of the fold |
| stream | `--max-old-space-size=128` (limit reported 176 MB) | 64.0 → 55.6 (**67.4**) | complete, generation 2, 10.4 s |
| stream | `--max-old-space-size=192` (limit reported 240 MB) | 50.7 → 55.5 (**67.4**) | complete, generation 2 |
| legacy, no forced GC | default | 53.9 → 253.3 (**253.3**) | complete, generation 2. Exit heap stays at the peak: the parsed ledger is live |
| legacy, GC before each sample | default | 50.2 → 157.2 (**157.2**) | complete. GC does not bring it under the parsed graph |
| legacy | `--max-old-space-size=128` | aborted in `JSON.parse` | fatal heap limit after a GC of 128.1 → 126.9 MB. Process exit 134. Authority not moved |

Scan heap on the stream runs peaked around 51–58 MB. `finish_sync` on the capped stream run peaked at 67.5 MB.

## Reading

The in-memory parse of this ledger does not fit a 128 MB Node old space. The byte fold does, and it publishes the D1 generation there. Forcing GC is not what makes the fold succeed: the capped run uses V8's own collector and still finishes, while the same cap aborts the parse.

This is not a workerd measurement. The `workerd` binary shipped with the repo's Wrangler install is present, and this harness does not run inside it: the Worker is evaluated in a Node `vm`, and the D1 stand-in shells out to `sqlite3`. A 128 MiB isolate was not applied. Adding the 41.1 MB document to the 67.4 MB heap observed under the Node cap is about 109 MB if the isolate holds both at once, and a second buffered copy of the document would pass 128 MB. RSS near 370 MB on the stream runs is the bucket's retained copies, not that isolate sum.

**Verdict:** the synthetic D1 commit completes from a byte stream where the same volumes abort while parsing the ledger. **Not a clearance** that the production memory kill is gone.
