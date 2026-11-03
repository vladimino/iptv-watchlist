# EPG commit memory: synthetic stream and parse, 3 November 2026

[AIR-338](https://trello.com/c/B84isUMG). Offline only. No production read or write.

**Captured at:** 2026-11-03, 18:39–18:46 UTC.

**Source:** Node.js v22.23.4. Measured tree `a1d83f3fcc16b676c14b54253ad114527a9b0867`, parent `3fbaba377f7a66385c146df5cdd273cfd1c141ef`. `scripts/epg-commit-memory-profile.mjs --child` loads the Worker sources in a `vm`, with a sqlite D1 stand-in (migrations through `0008`, `published_epg_authority.mode=d1`, `cutover=open`).

**Evidence lifecycle:** dated measurement. **Operational authority:** none. It does not clear a live EPG step, a lease reset, or a claim that the production isolate stayed under its limit.

## What was measured

One synthetic `epgSync` in frozen mode, with an archive pointer already present. Counts: 395 watchlist films, 2,631 catalog films, 19,868 discovery candidates from the XML scan, 34,102 active ledger rows. The archive manifest reports 23,820 archived items; only the one re-entry segment is read. The other archived payloads are not materialized. Titles are Russian. Ledger rows have three showings.

Serialized sizes: active ledger 43,116,001 bytes (the run aimed at 43,167,390 bytes), catalog 12,695,809 bytes. The catalog is larger than the 6,222,569 byte object listed on 30 October because the padding is Cyrillic. The previous programme document seeded in D1 is a small continuity stub, not a production-sized programme. The generation document pulled at `put` was 25,684,098 bytes: rows that also appear in the latest scan are replaced by that scan's short candidates, so the written document is smaller than the padded input.

`stream` reads the ledger through a chunked body and never calls `json()` on it. The decision pass walks every candidate before the archive fence, and the scan list stays live until `put` finishes. The generation document is then pulled one chunk at a time; it is not enqueued in `start()`. `legacy` exposes `json()` only, so the commit parses the whole ledger. Both paths publish through the D1 stand-in. A successful run moves the authority to the new programme run and generation 2.

`put` samples call `process.memoryUsage()` on every output chunk. The 50 ms timer does not run during that microtask loop, so phase-marker peaks can miss it. `live` is `heapUsed + external - bucket retained bytes - harness copy of the output`. `external` already includes `arrayBuffers`; those two are not added. The harness copy is the test bucket accumulating the object it has to store. In production that object lives in R2. A Worker R2 `put` may also keep an upload buffer inside the isolate; this harness cannot see that.

## Results

Heap is V8 `heapUsed`. RSS on the stream runs reached about 370 MB because the in-memory bucket keeps the input ledger and every written copy. Node old space is not the Workers isolate: array buffers sit outside the old-space cap and inside an isolate.

| Run | Old-space flag | At `put`, before the consumer reads | Peak `live` during `put` | Outcome |
| --- | --- | --- | ---: | --- |
| stream, no forced GC | default (limit reported 2,096 MB) | heap 207.0, external 57.1, live 210.6 | heap 231.2, live **234.9** | complete, generation 2, 91.8 s. The 207 MB heap is uncollected garbage from the decision pass. External stayed at the input buffers, so the output document was not queued yet |
| stream | `--max-old-space-size=128` (limit reported 176 MB) | heap 88.7, external 57.1, live 92.3 | heap 103.9, live **121.9** | complete, generation 2, 11.0 s |
| stream, GC at phase markers | default | put samples themselves are not collected. Phase `generation_publish` heap 42.6 → 27.7 (marker peak 78.6) | live **225.3** | complete, generation 2, 10.8 s |
| stream, GC every 2,000 put chunks | `--max-old-space-size=128` (limit reported 176 MB) | after that collection: heap 46.4, live **50.0** | live **99.1**. Retained at the collections: heap 65.1, live **93.3** | complete, generation 2, 11.5 s |
| legacy | `--max-old-space-size=128` | aborted in `JSON.parse` | fatal heap limit after a GC of 128.1 → 128.0 MB | process killed. Authority not moved. About 2.7 s |

The earlier successful legacy parse, measured on the previous tree, peaked at 253.3 MB of heap with no forced GC and 157.2 MB with GC before each sample. That path still parses the whole ledger; it was not re-run here. Scan heap on these stream runs peaked around 51–79 MB before publication.

## Reading

The in-memory parse of this ledger does not fit a 128 MB Node old space. The pull-driven fold does, and it publishes the D1 generation there. Before the consumer reads, external memory is the bucket's input buffers (ledger 43.1 MB plus catalog 12.7 MB, deduped when the same buffer is stored twice), not a second copy of the output. Forcing GC is not what makes the fold succeed: the capped run without a collection at the samples still finishes, while the same cap aborts the parse.

After GC, the retained live set during `put` is 93.3 MB. The sample peak on that run is 99.1 MB. Both figures subtract the harness's 24.5 MB output copy. Adding that copy back, as a stand-in for an upload buffer held in the isolate, gives about 118 MB retained and about 124 MB at the sample peak. That is inside 128 MB with only a few megabytes to spare, and only in this Node process.

This is not a workerd measurement. The `workerd` binary shipped with the repo's Wrangler install is present, and this harness does not run inside it: the Worker is evaluated in a Node `vm`, and the D1 stand-in shells out to `sqlite3`. A 128 MiB isolate was not applied.

**Verdict:** the synthetic D1 commit completes from a pull-driven byte stream where the same volumes abort while parsing the ledger. The output is not queued before the consumer reads. **Not a clearance** that the production memory kill is gone.
