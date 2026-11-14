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

What the current format implies: the dataset digest is `sha256(canonical(everything except digest))` and the current `canonical()` implementation builds the sorted-keys string of the whole value, so it needs whole-value materialization. A streaming canonicalizer is theoretically possible, but it would still have to sort keys of one huge object and read segment texts that are embedded as escaped JSON strings inside the dataset JSON, so it would be a new digest implementation with the same contract risk and no cheaper than a new format. This ADR therefore proposes a new durable format and digest rule and does not claim v1 is impossible to stream. The card names a new durable format or digest contract as an architecture gate.

## Decision (proposed)

Add `epg-replay-dataset` schema version 2, a chunked dataset, alongside version 1. Version 1 stays readable with unchanged fail-closed behaviour, provenance, immutability, isolation and the owner-GO boundaries of ADR 0121 and ADR 0124 (it is simply refused above its budget). Version dispatch is by the root object, below.

### Wire contract

1. **Root key and dispatch.** v1 keeps `diagnostic/replay/<digest>.json`. v2 has one canonical root at `diagnostic/replay/v2/<datasetDigest>/root.json` and nothing else may be read as a v2 dataset. The loader chooses the version from the digest-addressed key it was asked for, then checks `kind` and `schemaVersion` inside the root; a root under the wrong key or version fails with `root_malformed`. There is no fallback between versions.
2. **Root manifest** (at most 256 KiB, canonical JSON, the only object read whole): schema, builder, `builtAt`, source generation and archive manifest ids, fidelity, counts, total budgets, the archive manifest, and the ordered list of parts `{kind, index, key, sha256, bytes, items, firstKey, lastKey}`. The dataset digest is `sha256(canonical(root without digest))`; because the root lists every part digest it commits to all data without canonicalizing it as one value.
3. **Parts.** Archive segments (existing create-only objects, `textSha256` already defined by the Worker) and ledger shards: the active items in sorted-key order, NDJSON, cut at a shard byte cap. Key: `diagnostic/replay/v2/<datasetDigest>/parts/<kind>-<index>-<sha256>`; create-only.
4. **Bounded reads.** Each part is read through a streaming reader with a declared maximum length: the loader refuses a part whose R2 object size differs from the root `bytes`, hashes the exact bytes while streaming (one chunk in flight, backpressure by awaiting each chunk), and stops at the first excess byte. Separate hard limits exist for the ledger shard size, for the archive segment size (the largest unit, which the H2a evidence does not break down; the fixture reports the real distribution and the limit is set from evidence, not guessed), for the number of parts and for total bytes. The total may exceed 96 MiB only once the benchmarks below support it; the number is not fixed by this ADR.
5. **Structural validation** while streaming: sorted order inside a shard and across shards (`lastKey` of one part below `firstKey` of the next), duplicate keys, item and byte counts, segment index and key topology against the archive manifest, totals, and the archive summary agreement of v1. A missing, duplicated, truncated, reordered, extra or foreign part fails closed with a distinct reason (`part_missing`, `part_digest_mismatch`, `part_truncated`, `part_duplicated`, `part_unexpected`, `part_order`, `generation_drift`, `budget_exhausted`, `root_malformed`).
6. **Upload and unknown outcomes.** Parts first, root last, every object create-only with read-back by digest; without a root a partial upload is not a dataset. An unknown outcome of a part or root write is reported and never blindly retried; a repeat of the same command is idempotent because the keys are content-addressed and a different content under an existing key aborts.
7. **No hidden all-items arrays.** Verification, D1 ingestion (`ingestLedger` already takes an async iterable of items), plan derivation and replay iterate parts; the only whole-dataset structure allowed is the set of active keys (short strings) that the seeded selection needs, and its size is reported.

### Verify-before-mutate and binding of later reads

8. **Complete verification precedes any write.** Root and every part are verified in full before baseline materialization, `materialize` or the seal start. Verification records a **verified-bytes receipt** for the run: root digest plus each part digest and size. Every later read of a part (materialization, replay, return payloads) is a bounded read that re-hashes the exact bytes it consumes and compares them with that receipt, so a part replaced between verification and use is `part_digest_mismatch`, not data. R2 objects are create-only and content-addressed, so replacement means a different key; a key whose bytes changed is a failure.
9. **Partial materialization.** Materialization writes the baseline objects in the order it does today and the marker last. A run that finds a partial baseline (objects but no marker, or a marker of another dataset or a consumed one) refuses with `domain_not_clean` or `domain_not_prepared` and writes nothing; recovery is the owner's existing cleanup and a new launch, as in ADR 0124. Nothing is repaired or retried automatically.
10. **Repeated verification is quantified, not assumed.** Verification is needed at preflight, launch, `begin` and `seal`. For the H2a-scale baseline each full pass is about one R2 GET per part (roughly 64 archive segments plus the ledger shards, plus the root) and about the full dataset byte count read and hashed. The offline benchmark must report, per pass, R2 GETs, bytes, CPU and wall time, and the total for the four passes. If four full passes are too costly, the options for the owner are a verified-receipt cache keyed by root digest in the diagnostic D1, or full verification only at launch and seal with preflight and begin checking the root and part sizes (HEAD). This ADR does not choose; it requires the numbers.

### Seal compatibility: two paths, path A is a feasibility gate

11. **The real production seal and planner stay unchanged by this ADR, and this ADR does not authorize a change to `src/worker.js`.** In `src/worker.js`, `planDiscoveryLedger` calls `latestList.map(...)` over `holder.discovery`, and `collectLedgerDecisions` and `iterateLedgerItems` feed that same holder into `openDiscoveryMerge`. A bare async iterator is therefore not a drop-in replacement for the scan and is not assumed to work.
12. **Path A (first gate).** Keep the real seal and planner as they are and materialize only the active scan as the array the code expects, streaming everything else (dataset parts, archive segments, the D1 ingestion, the baseline objects). The scan is about half of the dataset. Path A is accepted only if the full-scale measurements below show a substantial memory margin to the 128 MB isolate limit with the scan resident next to what the real planner and emit allocate. It is tested first, before any v2 code beyond what that test needs.
13. **Path B (only if A fails).** Return to the owner with a narrowly scoped, separately approved proposal to refactor the production planner for streaming (accepting an iterable or a re-openable source for `holder.discovery`), with parity evidence against the current planner on identical inputs and the production EPG regression suite. It is a production change to the seal path and needs its own ADR and approval; nothing about it is decided here.

### Determinism

14. **Per version, not across versions.** Selection uses a seeded generator keyed by `dataset.digest + '|' + seed`. A v2 dataset has another digest, so the departures and returns it samples differ from those of a v1 dataset of the same generation, not only the plan digest. The requirement is deterministic derivation and reproduction within each version (same dataset and seed give the same plan and scan on any platform), a regenerated-plan check as in v1, and **semantic parity tests** on small datasets that build the same baseline in v1 and v2 and compare counts, ordering, the key set, archive topology, the invariants of the plan (cardinalities, departures a subset of active keys, returns a subset of archive-only keys, segment arithmetic) and the `expectedVsActual` logic. Identical picks across versions are not promised.

### Operator path

15. `dataset-build` reads production objects through the existing read-only key one part at a time and writes parts and then the root into a private local directory outside the repository; `verify` is a streaming local command; `dataset-put` uploads parts then the root as in point 6. Every production read and diagnostic R2 write keeps its own operation-specific owner GO, which this ADR does not grant.

### Memory evidence required before acceptance of the implementation

16. A deterministic sanitized synthetic fixture of at least 82 369 items and at least 100 MiB with growth headroom, built from the real record shape, never from production payloads. The Node benchmark reports peak heap and RSS per stage with a reproducible command.
17. The full real-seal path (materialize, plan, segment writes, manifest and pointer CAS, emit) is also exercised where feasible in a representative workerd / `wrangler dev` environment with the 128 MB limit, against local simulated R2 and D1. The report states what that does not prove: Cloudflare isolate memory accounting, latency, R2 and D1 behaviour and CPU limits of the real service.
18. The safety margin to 128 MB is defined from those measurements and the report's unknowns; no number is invented in this ADR, no budget is raised without evidence, and if no usable margin can be shown the work is BLOCKED with the evidence instead of a workaround.

## Alternatives considered

- **Raise the 96 MiB budget only.** Rejected: the loader would need about three copies of the dataset in the Worker.
- **Streaming canonicalization and a streaming JSON parser over the v1 file.** Not impossible, but it keeps one huge object, escaped embedded segments and a new digest implementation; the chunked format is simpler to verify part by part.
- **Truncate or sample the input.** Rejected by the card and ADR 0121: the result would describe another workload.
- **Read production objects directly from the diagnostic Worker.** Rejected: the diagnostic domain holds no production binding (ADR 0121).
- **Retire the canary.** Rejected by the owner on 14 Nov 2026 ([AIR-457](https://trello.com/c/InwLNuYs)).

## Consequences

- A second dataset format and digest rule to maintain; v1 tests, H1/H2a evidence and fail-closed behaviour are unchanged.
- More R2 objects and requests per dataset and per verification pass; quantified by the benchmark, not assumed.
- Local Node and workerd results cannot prove Cloudflare isolate peak memory or latency. The acceptance wording stays offline-verified with the stated margin and unknowns, never "canary passed".
- If path A fails, the work stops at an owner decision on a production planner refactor.
- Rollback is code-only; diagnostic D1 and R2 objects stay.

## Unsupported assumptions

- That the real seal and planner work with only the active scan materialized as an array and a usable memory margin. This is the first feasibility test (path A) and is not assumed.
- That the largest archive segment fits next to one ledger shard and the resident scan; the H2a evidence gives totals only.
- That four verification passes are affordable; to be measured.
- That workerd or `wrangler dev` memory behaviour is representative of the Cloudflare isolate; it is evidence, not proof.

## Recovery boundaries

This proposal touches no production or diagnostic resource and authorizes no change to `src/worker.js`. After acceptance, implementation starts with the path A feasibility test, then offline code, tests and documentation. `dataset-build` against production R2, `dataset-put`, `prepare-domain`, a Workflow launch, any diagnostic R2 write and any production seal change need their own operation-specific owner decisions.
