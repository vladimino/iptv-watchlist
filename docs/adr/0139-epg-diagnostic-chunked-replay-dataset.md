# ADR 0139: EPG diagnostic replay dataset as a chunked manifest with content-addressed parts (proposal for owner decision)

**Status:** Proposed (design for owner decision under the architecture gate of [AIR-470](https://trello.com/c/jSOVQGBH); nothing is implemented, provisioned or run by this ADR, and it is not a production GO)  
**Original decision date:** unknown (pending owner decision)  
**Recorded at:** 2026-11-14  
**Approval source:** not documented (the owner approves, amends or rejects this proposal on the pull request or the card)  
**Related work:** [AIR-470](https://trello.com/c/jSOVQGBH), [AIR-456 H2a NO-GO evidence](../evidence/orchestration/epg-diagnostic-dataset-air-456-h2a-no-go-2026-11-12.md), [ADR 0121](0121-epg-diagnostic-rehearsal-design.md), [ADR 0124](0124-epg-diagnostic-canary-run-contract.md)  
**Supersedes:** None (ADR 0121 and ADR 0124 stay Accepted; this ADR would add a second dataset format next to the one they describe)  
**Superseded by:** None

## Context

The EPG diagnostic canary replays a frozen copy of one published generation through the real `stageSealedGeneration`. The H2a build of 12 Nov 2026 stopped with `size_budget_exceeded`: the published baseline is 42 156 active items (about 49.97 MiB) plus 40 213 archive items (about 50.15 MiB), 82 369 items and about 100 MiB, and `EpgReplay.LIMITS.maxBytes` is 96 MiB. This is a refusal by a budget, not a measured out-of-memory. Raising the budget is not a fix, because the format and every consumer hold the whole dataset as one value.

Allocation map of the current path (read from `main`, `f314b339`; sizes are the published baseline, B = about 100 MiB of payload text). JavaScript strings are UTF-16 or Latin-1 internally, so the real heap footprint of a JSON text is between 1x and 2x its UTF-8 size; the factors below are lower bounds.

| Stage | Where | What is held at the peak | Lower bound |
| --- | --- | --- | --- |
| `dataset-build` (operator, Node) | `EpgReplay.buildDataset` | generation text and parsed items; every segment text AND its parsed body; the sorted copy of the items; `canonical(baseline)` string; then `JSON.stringify(dataset)` and `JSON.parse` for the verification | 4B to 6B |
| `verify` | `verifyDataset` | `canonical(baseline)` (one more full copy), a `Set` of keys, `JSON.parse(segment.text)` per segment | 2B |
| `dataset-put` | `putDataset` | file text, parsed dataset, a second verification, then the read-back text and its parse | 4B |
| `loadDataset` in the Worker | `object.text()` then `JSON.parse` then `verifyDataset` | R2 body text (B), parsed object (about B), `canonical(baseline)` (B) | 3B, above 128 MB |
| baseline materialization | `materialize` | the dataset stays resident; each segment text is written, then the active ledger is re-serialized | B plus the writes |
| `planMutation` / `replayScan` | `archivedOnly`, `verifyDataset` again (called twice, once per function, and `replayScan` calls `planMutation` again) | another `canonical(baseline)` on every call, a `Map` of every archived payload (about half of B), a copy of the active array | 3B to 4B |
| `stageSealedGeneration` | `planDiscoveryLedger` and the non-stream branch | `holder.discovery` (the scan, about half of B) plus, outside the D1 stream view, a `TextEncoder` copy of every merged item before the put | 1B |

Production EPG stays inside 128 MB because it streams: the segments are read one at a time, the ledger is emitted from an iterator and written with a known length. The diagnostic path is the only consumer that holds the dataset as a single object. The production out-of-memory of AIR-460 is a different problem and is not part of this decision.

What cannot be done inside the current format: the dataset digest is `sha256(canonical(everything except digest))`, a sorted-keys canonicalization of one JSON value. It cannot be computed or verified incrementally without holding the value, and `baseline.archive.segments[].text` embeds each segment as an escaped JSON string inside the JSON of the dataset, so it can neither be streamed cheaply nor parsed without the whole file. A bounded loader therefore needs a different on-disk shape and a different digest rule. That is a new durable format and a new digest contract, which the card names as an architecture gate.

## Decision (proposed)

Add `epg-replay-dataset` schema version 2, a chunked dataset, alongside version 1. Version 1 stays readable and fail-closed behaviour is unchanged for it (it is simply refused above its budget); new datasets are built as version 2.

1. **Parts.** A dataset is one small **root manifest** and N **parts**. Parts are the existing archive segment objects (already create-only JSON, already named by sha256 in the production manifest) plus **ledger shards**: the active items cut into shards of at most 2 MiB, in sorted-key order, one JSON object per line (NDJSON) so a shard is verified and consumed record by record. Every part is stored at `diagnostic/replay/v2/<datasetDigest>/parts/<sha256>.<kind>` and is create-only.
2. **Root manifest** (at most 256 KiB, canonical JSON, the only object read whole): schema, builder, `builtAt`, source generation and archive manifest ids, fidelity, counts, the list of parts in order with `{kind, index, sha256, bytes, items, firstKey, lastKey}`, and the archive manifest itself. The dataset digest is `sha256(canonical(root without digest))`. Because the root lists every part digest, the digest commits to all of the data without ever canonicalizing it as one value.
3. **Streaming verification.** The loader reads the root, then each part through a bounded reader (one part at a time, at most 2 MiB resident for ledger shards; archive segments are bounded by their own size and are the largest unit, so the budget below is per part and is measured, not assumed). Each part is hashed incrementally while it streams, then checked against the root: bytes, items, sorted order inside and across shards (`lastKey` of one part below `firstKey` of the next), duplicate keys across shards, segment index and topology against the manifest, and totals. A missing, duplicated, truncated, reordered or extra part fails closed.
4. **Heap and request budgets.** Hard constants in the module: part size, number of parts, total bytes (raised from 96 MiB to a documented value only because nothing is resident any more; the total becomes a storage and R2-request cost bound, not a memory bound), one part in flight, and a verified peak-heap figure that the offline benchmark must stay under with a stated margin to 128 MB. If the benchmark cannot show a margin, the work is BLOCKED with evidence, not worked around.
5. **Mutation without materialization.** `planMutation` picks departures by seeded Fisher-Yates over the sorted key list. Only the keys are held (about 42 k short strings) and shards are streamed once to collect them. `replayScan` becomes an async iterator that yields the shard records minus the departures, then the returned payloads read from the segments they live in. A plan is still regenerated from the dataset, never trusted. The same seed and the same data give the same plan digest in version 1 and version 2 only for the plan fields that do not name the dataset digest; the dataset digest necessarily differs, so the plan digest does too, and this is stated, not hidden.
6. **Seal.** The real `stageSealedGeneration` is not changed. `holder.discovery` is today an array; the diagnostic run passes an array only up to what planning needs, or the work adds an iterable `holder` that `planDiscoveryLedger` already uses for the streaming view. Whether one of those two is enough without touching production code is the first thing the implementation must show; if a change to `src/worker.js` seal code is needed, it returns to the owner as a separate decision because it touches the production seal path.
7. **Operator path.** `dataset-build` reads production objects through the existing read-only key, one part at a time, and writes parts and then the root into a private local directory; `verify` is a streaming local command; `dataset-put` uploads parts first and the root last, each create-only, with read-back by digest, so a partial upload is never a valid dataset (no root). Operation-specific owner GO for every production read and diagnostic R2 write stays as today and is not granted by this ADR.
8. **Failure semantics.** Fail closed with distinct reasons: `part_missing`, `part_digest_mismatch`, `part_truncated`, `part_duplicated`, `part_unexpected`, `part_order`, `generation_drift` (source generation or manifest changed between reads), `budget_exhausted`, `root_malformed`. An unknown outcome of an upload is reported and never retried blindly.

## Alternatives considered

- **Raise the 96 MiB budget only.** Rejected: it moves the refusal to the Worker's loader, where three copies of the dataset are needed.
- **Streaming JSON parser over the current version-1 file.** Rejected as the sole fix: the digest still needs the whole canonical value, and the embedded segment strings are escaped twice.
- **Truncate or sample the input to fit.** Rejected by the card and ADR 0121: it would make a "measured" result about a different workload.
- **Do not store a dataset; read production objects directly.** Rejected: the diagnostic domain must not hold a production binding or read production (ADR 0121).
- **Retire the canary.** Rejected by the owner on 14 Nov 2026 ([AIR-457](https://trello.com/c/InwLNuYs)).

## Consequences

- A second dataset format and a second digest rule to maintain. Version 1 tests and H1/H2a evidence keep passing; version 1 above its budget keeps refusing.
- Storage and R2 request count grow with part count (roughly 64 archive segments plus about 25 ledger shards for the H2a baseline); every part is create-only and content-addressed, so upload is resumable by the root-last rule.
- Local Node measurements cannot prove Worker peak memory or latency. The acceptance statement stays "offline-verified" with the stated margin and unknowns, never "canary passed".
- Rollback is code-only; diagnostic D1/R2 objects stay.

## Unsupported assumptions

- That the real seal path can consume an iterator for the active scan without a change to `src/worker.js`. To be proved first.
- That the largest archive segment fits comfortably next to one ledger shard. The H2a evidence gives totals, not the size distribution of segments; the implementation reports it from the synthetic fixture and the owner-approved real build must confirm it.
- That 128 MB leaves a usable margin once nothing is resident. The proposed benchmark measures this offline; it is not a Cloudflare measurement.

## Recovery boundaries

No production or diagnostic resource is touched by this proposal. After acceptance, implementation is offline code and tests; `dataset-build` against production R2, `dataset-put`, `prepare-domain` and any Workflow launch need their own operation-specific owner GO.
