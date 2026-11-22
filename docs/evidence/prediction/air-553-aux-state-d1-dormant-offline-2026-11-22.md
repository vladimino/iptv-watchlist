# AIR-553: the batch_v2 auxiliary state in D1, dormant implementation, offline evidence

[AIR-553](https://trello.com/c/ouMIBO00) · 22 November 2026 (Europe/Madrid) · implements [ADR 0194](../../adr/0194-prediction-auxiliary-state-d1-checkpoint-and-outbox.md) (Accepted) as dormant code.

**Scope and limits.** Offline only: the real Worker code over a sqlite D1 stand-in and an in-memory R2, and a recording Workflow stand-in. **No production read or write was made, no migration was applied, no marker was flipped, no Task, flag, binding, model, Workflow or manual run was touched.** The marker `prediction_aux_authority` is inserted as `r2`; with it (or with a schema older than `0034`) the Worker runs the legacy R2 code unchanged. This report is **not** a production acceptance and does not claim any production latency. Wall time below is the local stand-in (a sqlite process per D1 statement, an in-memory R2): it penalizes D1 calls and makes R2 free, so it must not be read as Cloudflare latency. The comparable natural production baseline and the post-cutover comparison are the AIR-554 acceptance.

## What was measured

One cycle is what a Scheduled Task runs ([ADR 0193](../../adr/0193-deferred-batch-start-with-server-issued-key.md)): a deferred start (receipt), the Workflow preparation, the bounded readback of every manifest part, submits in groups of five, one heartbeat and the owned `complete` (which delivers the terminal Event). Workloads S5, S7 and S10 are `manifestSize` 5, 7 and 10 with `generationSize=1` and `submitBatchSize=5`, as the Task prompts have them. Three arms ran the **same revision** over the **same** seeded queue (40 films), profile and catalog, repeated in alternating order (12 pairs per arm and workload; `node scripts/prediction-aux-benchmark.mjs --pairs 12 --aged 1000`):

- `legacy`: the `PredictionAux` module is absent (production before migration `0034`);
- `r2marker`: migration `0034` applied, marker `r2` (the dormant overhead of the marker read);
- `d1`: marker `d1`, the four families in D1.

Counts are exact and identical across repetitions (the sample size matters only for the wall-time distribution). The same films were committed by every arm in every cycle (no extra model work).

## S5 (12 paired cycles per arm; counts exact, wall time local)
| arm | D1 calls | D1 batches | D1 statements | D1 write stmts | D1 written bytes | R2 ops | R2 aux ops | wall p50 ms | wall p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| legacy | 382 | 201 | 830 | 208 | 122523 | 188 | 20 | 316.9 | 410.2 |
| r2marker | 409 | 228 | 893 | 208 | 122523 | 188 | 20 | 330.7 | 377.3 |
| d1 | 442 | 228 | 934 | 224 | 141502 | 168 | 0 | 385.1 | 462.7 |
d1 vs legacy: D1 calls +15.7 %, write statements +7.7 %, written bytes +15.5 %, R2 ops -10.6 %.

## S7 (12 paired cycles per arm; counts exact, wall time local)
| arm | D1 calls | D1 batches | D1 statements | D1 write stmts | D1 written bytes | R2 ops | R2 aux ops | wall p50 ms | wall p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| legacy | 464 | 245 | 1016 | 269 | 168345 | 234 | 24 | 343.2 | 396.1 |
| r2marker | 494 | 275 | 1085 | 269 | 168346 | 234 | 24 | 357.4 | 378.5 |
| d1 | 536 | 275 | 1135 | 285 | 188521 | 210 | 0 | 440.7 | 491.8 |
d1 vs legacy: D1 calls +15.5 %, write statements +5.9 %, written bytes +12.0 %, R2 ops -10.3 %.

## S10 (12 paired cycles per arm; counts exact, wall time local)
| arm | D1 calls | D1 batches | D1 statements | D1 write stmts | D1 written bytes | R2 ops | R2 aux ops | wall p50 ms | wall p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| legacy | 560 | 296 | 1235 | 335 | 220771 | 288 | 27 | 404.3 | 470.5 |
| r2marker | 593 | 329 | 1310 | 335 | 220771 | 288 | 27 | 428 | 449.3 |
| d1 | 641 | 329 | 1366 | 351 | 242751 | 261 | 0 | 539.7 | 578.9 |
d1 vs legacy: D1 calls +14.5 %, write statements +4.8 %, written bytes +10.0 %, R2 ops -9.4 %.


## Reading the counts

- **R2.** In the D1 arm the four families touch **no** R2 object (R2 aux ops 20, 24 and 27 become 0 for S5, S7, S10); total R2 operations fall by 9.4 to 10.6 %. A refused start (the skipped Event) costs 14 R2 operations (8 of the families) in the legacy arm and 6 (the journal write only) in the D1 arm.
- **D1.** The D1 arm makes 14.5 to 15.7 % more D1 calls (the stage, the sources, the manifest pieces, the outbox rows and the readback reads replace R2 gets and puts), 4.8 to 7.7 % more write statements and 10 to 15.5 % more written statement bytes. The largest D1 statement stays at or below 13,181 bytes (the budget is 100 KiB).
- **Dormant overhead.** With the migration applied and the marker at `r2`, a cycle makes 6.5 to 7.1 % more D1 calls than before the migration (one marker read per request, held for the request) and **zero** more writes or R2 operations. Before the migration is applied there is no overhead: the version comes from the authority read every request already makes.
- **Not established.** Whether the D1 arm is faster, equal or slower on Cloudflare. The atomicity of the readiness edit and the removal of the cross-store window are design reasons ([ADR 0194](../../adr/0194-prediction-auxiliary-state-d1-checkpoint-and-outbox.md)), **not** a speed claim. The cost of a D1 call and of an R2 operation differ in production; the cost conversion needs the account's current price table (rows read and written for D1, class A and B operations for R2) and is part of the AIR-554 comparison.
- **Optimizations already made** (counts above include them): the pure part readback holds the authority marker for its request; the first source write, the manifest insert and the outbox admission no longer read first; the auxiliary marker read is held for the request. The remaining difference is inherent in replacing R2 reads and writes by D1 reads and writes of the same data.

## Aged database

The D1 arm on a database holding 0, 300 and 1,000 settled runs (each with a 38,000-character manifest, a source and a compacted outbox row; 1.4 MB, 14.5 MB and 44.7 MB) makes **exactly the same** D1 calls (442), statements (934) and write statements (224) as the empty one; local wall time p50 350.6, 366.2 and 358.0 ms (4 samples each, stand-in). The hot queries are primary-key or index searches and never a scan of a history table (asserted by `tests/prediction-aux-budget.mjs` with `EXPLAIN QUERY PLAN`: manifest row and pieces, source head and pieces, outbox row, pending drain, compaction and the outbox of one run).

## Growth

One S5 cycle adds one source revision, one manifest (one or more pieces) and one outbox row (plus its source piece): about 34.8 KB of sqlite pages in the stand-in, about 3.3 MB for 96 runs a day. Under the accepted retention (sources and manifests kept indefinitely; settled outbox payloads compacted 14 days after settlement, identity kept) the growth is linear in runs; D1 storage accounting differs from sqlite pages. No archive mechanism is introduced; revisit only with production evidence and a new decision.

## Scenarios (counts, S5)

| scenario | arm | D1 calls | R2 ops | R2 aux ops | detail |
| --- | --- | ---: | ---: | ---: | --- |
| held stage drained by the next run (run 2 shown) | legacy | 458 | 232 | 29 | preparation 214 D1 calls |
| | r2marker | 499 | 232 | 29 | preparation 242 |
| | d1 | 550 | 203 | 0 | preparation 266 (the drain commits each staged row in the same batch as the film's prediction) |
| journal outage, then recovery (second cycle) | legacy | 386 | 198 | 28 | preparation 152 |
| | r2marker | 413 | 198 | 28 | preparation 166 |
| | d1 | 451 | 170 | 0 | preparation 177 |
| one refused start (skipped Event) | legacy | 92 | 14 | 8 | 0 D1 writes |
| | r2marker | 93 | 14 | 8 | 0 |
| | d1 | 98 | 6 | 0 | 4 D1 write statements (the outbox row, delivery, counter) |

## Deterministic tests that carry the contract

`tests/prediction-aux-d1.mjs` (authority outcomes, stage cap and CAS, source revisions, manifest digests and part reads, outbox identity, cap, quarantine, settlement and compaction), `tests/prediction-aux-worker.mjs` (the real Worker with the marker at `r2`, at `d1` and unavailable; deferred readiness in one batch with a stale instance and a heartbeat race; same-batch stage settlement; fault matrix of the outbox), `tests/prediction-aux-import.mjs` (the offline importer against the real R2 objects the legacy path wrote, with byte-equal parity of the served parts), `tests/prediction-aux-budget.mjs` (the exact operation and statement budgets of this report, aged-database independence and query plans; no latency assertion).

## Not covered

Cloudflare latency, D1 rows read and written as billed, production queue and catalog shapes, the Workflow instance start delay, and the behaviour of a late runner after a marker flip: AIR-554. This report authorizes no operation.
