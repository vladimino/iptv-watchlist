# AIR-553: the batch_v2 auxiliary state in D1, dormant implementation, offline evidence

[AIR-553](https://trello.com/c/ouMIBO00) · 22 November 2026 (Europe/Madrid) · implements [ADR 0194](../../adr/0194-prediction-auxiliary-state-d1-checkpoint-and-outbox.md) (Accepted) as dormant code; regenerated on the head that answers the independent review of the implementation PR.

**Scope and limits.** Offline only: the real Worker code over a sqlite D1 stand-in and an in-memory R2, and a recording Workflow stand-in. **No production read or write was made, no migration was applied, no marker was flipped, no Task, flag, binding, model, Workflow or manual run was touched.** The marker `prediction_aux_authority` is inserted as `r2`; with it (or with a schema older than `0034`) the Worker runs the legacy R2 code. This report is **not** a production acceptance and claims no production latency. Wall time is the local stand-in (a sqlite process per D1 statement, an in-memory R2): it penalizes D1 calls and makes R2 free, so it is **not** Cloudflare latency and must not be read as a prediction of it. Rows read are the rows *returned* (a lower bound of what D1 bills as scanned) and rows written are sqlite's changes including triggers: estimates, not billed telemetry. The comparable natural production baseline and the post-cutover comparison are the AIR-554 acceptance.

## What was measured

One cycle is what a Scheduled Task runs ([ADR 0193](../../adr/0193-deferred-batch-start-with-server-issued-key.md)), **counted once from its first call to its last**: key issuance, the deferred start (receipt), the Workflow preparation, the bounded readback of the envelope, the profile, the contract and **each film part once**, the submits in groups of five, one heartbeat and the owned `complete` (which delivers the terminal Event). Workloads S5, S7 and S10 are `manifestSize` 5, 7 and 10 with `generationSize=1` and `submitBatchSize=5`, as the Task prompts have them. **Four arms** ran the **same revision** over the **same** seeded queue (40 films), profile and catalog, repeated in alternating order (12 pairs per arm and workload; `node scripts/prediction-aux-benchmark.mjs --pairs 12 --aged 1000`):

- `legacy`: schema 33 and the `PredictionAux` module absent: what production runs today;
- `shipped33`: schema 33 and the module **present**: this revision's Worker before migration `0034` is applied (the real "no overhead before the migration" arm);
- `r2marker`: migration `0034` applied, marker `r2` (the dormant overhead of the marker read);
- `d1`: marker `d1`, the four families in D1.

Counts are exact and identical across repetitions (the sample size matters for the wall-time distribution only). In every cycle of every arm the same films were committed through the same requests (13, 16 and 19 for S5, S7 and S10: key 1, receipt 1, readback 8, 10 and 13, submit 1 or 2, heartbeat 1, complete 1; the Workflow preparation makes no request).

### S5 (12 paired cycles per arm; counts exact, wall time local)
| arm | requests | D1 calls | D1 statements | D1 write stmts | D1 rows returned | D1 rows written | R2 ops | R2 aux ops | est. USD per committed film | wall p50 ms | wall p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| legacy | 13 | 302 | 590 | 208 | 1164 | 197 | 188 | 20 | 136.80e-6 | 620.1 | 758 |
| shipped33 | 13 | 302 | 590 | 208 | 1164 | 197 | 188 | 20 | 136.80e-6 | 628.9 | 799.1 |
| r2marker | 13 | 314 | 614 | 208 | 1332 | 197 | 188 | 20 | 136.83e-6 | 648.8 | 819 |
| d1 | 13 | 332 | 669 | 226 | 1371 | 218 | 168 | 0 | 136.29e-6 | 783.8 | 965.9 |

Per phase (requests / D1 calls / R2 ops; wall p50/p95 ms, local):
- legacy: key 1/0/0 (0.1/0.9), receipt 1/5/4 (9.1/15.4), prepare 0/100/38 (152.3/170.4), readback 8/24/16 (9.4/15), submit 1/98/75 (302.9/349.3), heartbeat 1/20/12 (55.3/91.9), complete 1/55/43 (95/140)
- shipped33: key 1/0/0 (0.1/0.2), receipt 1/5/4 (9.6/11.7), prepare 0/100/38 (146.1/197.5), readback 8/24/16 (9.8/13.4), submit 1/98/75 (298.1/370.1), heartbeat 1/20/12 (55.5/78.1), complete 1/55/43 (93.8/163.4)
- r2marker: key 1/0/0 (0.1/0.6), receipt 1/5/4 (10.1/23.2), prepare 0/102/38 (163.6/231.4), readback 8/32/16 (13.8/21.7), submit 1/99/75 (316.2/373.8), heartbeat 1/20/12 (56.3/66.1), complete 1/56/43 (99/119.5)
- d1: key 1/0/0 (0.1/0.2), receipt 1/5/4 (10.6/20.1), prepare 0/106/32 (167.9/264), readback 8/40/8 (72.7/99.3), submit 1/101/73 (341.1/428.5), heartbeat 1/20/12 (59.9/73.5), complete 1/60/39 (114/137.2)
shipped33 vs legacy: D1 calls +0.0 %, R2 ops +0.0 %. r2marker vs legacy: D1 calls +4.0 %. d1 vs legacy: D1 calls +9.9 %, write statements +8.7 %, rows written +10.7 %, rows returned +17.8 %, R2 ops -10.6 %, est. cost per film -0.4 %.

### S7 (12 paired cycles per arm; counts exact, wall time local)
| arm | requests | D1 calls | D1 statements | D1 write stmts | D1 rows returned | D1 rows written | R2 ops | R2 aux ops | est. USD per committed film | wall p50 ms | wall p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| legacy | 16 | 372 | 740 | 269 | 1398 | 254 | 234 | 24 | 123.04e-6 | 818.3 | 955 |
| shipped33 | 16 | 372 | 740 | 269 | 1398 | 254 | 234 | 24 | 123.04e-6 | 847.9 | 925 |
| r2marker | 16 | 387 | 770 | 269 | 1608 | 254 | 234 | 24 | 123.07e-6 | 906.2 | 985 |
| d1 | 16 | 409 | 834 | 287 | 1655 | 275 | 210 | 0 | 122.48e-6 | 1013.1 | 1114.7 |

Per phase (requests / D1 calls / R2 ops; wall p50/p95 ms, local):
- legacy: key 1/0/0 (0.1/0.2), receipt 1/5/4 (9.6/14.4), prepare 0/108/38 (156/202.5), readback 10/30/20 (12.1/16.4), submit 2/148/111 (452.2/534.4), heartbeat 1/20/12 (61.7/71), complete 1/61/49 (98.4/129.1)
- shipped33: key 1/0/0 (0.1/0.1), receipt 1/5/4 (9.7/14.8), prepare 0/108/38 (161/192.9), readback 10/30/20 (13.6/15), submit 2/148/111 (477.8/543.6), heartbeat 1/20/12 (58.1/73.8), complete 1/61/49 (105.1/129.1)
- r2marker: key 1/0/0 (0.1/0.3), receipt 1/5/4 (9.5/17.3), prepare 0/110/38 (171.9/204.9), readback 10/40/20 (15.7/24.8), submit 2/150/111 (518.4/585.3), heartbeat 1/20/12 (62.4/82.6), complete 1/62/49 (107.3/146.2)
- d1: key 1/0/0 (0.1/0.2), receipt 1/5/4 (10/22.6), prepare 0/114/32 (174.8/218.4), readback 10/50/10 (92.8/119.5), submit 2/154/107 (510/613.6), heartbeat 1/20/12 (61.6/72.5), complete 1/66/45 (129/164.5)
shipped33 vs legacy: D1 calls +0.0 %, R2 ops +0.0 %. r2marker vs legacy: D1 calls +4.0 %. d1 vs legacy: D1 calls +9.9 %, write statements +6.7 %, rows written +8.3 %, rows returned +18.4 %, R2 ops -10.3 %, est. cost per film -0.5 %.

### S10 (12 paired cycles per arm; counts exact, wall time local)
| arm | requests | D1 calls | D1 statements | D1 write stmts | D1 rows returned | D1 rows written | R2 ops | R2 aux ops | est. USD per committed film | wall p50 ms | wall p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| legacy | 19 | 450 | 905 | 335 | 1647 | 314 | 288 | 27 | 106.52e-6 | 910.6 | 1126.7 |
| shipped33 | 19 | 450 | 905 | 335 | 1647 | 314 | 288 | 27 | 106.52e-6 | 883.9 | 1032.7 |
| r2marker | 19 | 468 | 941 | 335 | 1899 | 314 | 288 | 27 | 106.54e-6 | 902.5 | 1024.5 |
| d1 | 19 | 493 | 1011 | 353 | 1952 | 335 | 261 | 0 | 106.02e-6 | 1047.2 | 1186.4 |

Per phase (requests / D1 calls / R2 ops; wall p50/p95 ms, local):
- legacy: key 1/0/0 (0.1/0.2), receipt 1/5/4 (9.1/12.2), prepare 0/120/38 (145.8/199.8), readback 13/39/26 (16/25.6), submit 2/196/150 (581.1/703.6), heartbeat 1/20/12 (55.1/67.6), complete 1/70/58 (93.9/120.2)
- shipped33: key 1/0/0 (0.1/0.2), receipt 1/5/4 (8.6/18.8), prepare 0/120/38 (143.8/192), readback 13/39/26 (14.8/18.9), submit 2/196/150 (569.6/665.4), heartbeat 1/20/12 (53.3/84.1), complete 1/70/58 (92.4/117.3)
- r2marker: key 1/0/0 (0.1/0.2), receipt 1/5/4 (9.2/10.3), prepare 0/122/38 (142.4/200.8), readback 13/52/26 (18.8/41.8), submit 2/198/150 (585.1/654.9), heartbeat 1/20/12 (53.8/70.4), complete 1/71/58 (92.7/113.5)
- d1: key 1/0/0 (0.1/0.2), receipt 1/5/4 (9.6/12.3), prepare 0/126/32 (151.1/171.7), readback 13/65/13 (127.9/143.6), submit 2/202/146 (603.2/669.9), heartbeat 1/20/12 (58/89.2), complete 1/75/54 (103.5/130.2)
shipped33 vs legacy: D1 calls +0.0 %, R2 ops +0.0 %. r2marker vs legacy: D1 calls +4.0 %. d1 vs legacy: D1 calls +9.6 %, write statements +5.4 %, rows written +6.7 %, rows returned +18.5 %, R2 ops -9.4 %, est. cost per film -0.5 %.

## Reading the counts

- **Before the migration there is no overhead.** `shipped33` equals `legacy` in D1 calls, statements, rows and R2 operations for every workload: the module's authority check reuses the per-request read the Worker already makes (the version comes from it), so the shipped Worker costs nothing until `0034` is applied.
- **After the migration, marker `r2`:** +4.0 % D1 calls, all reads (one marker read per request), no extra write, no extra R2 operation.
- **D1 arm:** +9.6 to +9.9 % D1 calls (after the reductions below), +5.4 to +8.7 % write statements, +6.7 to +10.7 % rows written, +17.8 to +18.5 % rows returned (the pieces of the manifest and sources are read back instead of one object), and 9.4 to 10.6 % fewer R2 operations; the four families touch **no** R2 object (R2 aux ops 20, 24 and 27 become 0).
- **Estimated storage cost per committed film** (illustrative list prices as recalled: D1 $0.001 per million rows read and $1.00 per million rows written, R2 class A $4.50 and class B $0.36 per million; **an estimate under stated assumptions, not billed telemetry, and not an acceptance threshold**): equal within 0.5 % in every arm (S5 136.8e-6 USD legacy, 136.3e-6 D1): the extra D1 rows cost about what the removed R2 operations cost. The account's own price table and billed rows decide in AIR-554.
- **Where the D1 calls go** (S5; requests / D1 calls per phase): readback 8 requests 24 calls (legacy) against 40 (D1): two calls per part (the marker read and one batch for the manifest row and its covering pieces); preparation 100 against 106; submit 98 against 101; complete 55 against 60; receipt, heartbeat and key unchanged. R2 operations drop in preparation (38 to 32), readback (16 to 8), submit and complete.
- **Not established.** Whether the D1 arm is faster, equal or slower on Cloudflare. Atomicity and the removal of the cross-store window are design reasons ([ADR 0194](../../adr/0194-prediction-auxiliary-state-d1-checkpoint-and-outbox.md)), **not** a speed claim. A material regression found in production blocks final performance acceptance and returns to the design choice with the owner; the 180 s claim TTL is not changed to hide cost.

### Reductions made after the first measurement (counts above include them)

The first measurement of this branch showed +14.6 % D1 calls. The avoidable parts were removed: the part readback and the whole-manifest readback read the row and the covering pieces in **one** batch (the pieces are chosen by SQL from the row's own index); the sources read the head with its run binding, the revision's metadata and its pieces in one batch; the first revision of a start no longer reads a head that cannot exist; the outbox drain reads the latest run's rows, the oldest rows and the compaction candidates in one batch (and compacts only when there is something to compact); and the heartbeat, complete and manifest-readback requests run as timed steps with the per-request authority scope, which also removes repeated authority reads from the **legacy** path (302 against 382 D1 calls for the same cycle before this change). The remaining difference is the replacement of R2 reads and writes by D1 reads and writes of the same data.

## Runtime telemetry for AIR-554

`prediction_step_timing` now covers every phase of the cycle without added storage calls or payload logging: the steps `batch_prepare` (the Workflow preparation, with its existing stages), `batch_manifest` (a part readback), `batch_heartbeat` and `batch_complete` emit their own line next to `batch_start` and `batch_submit`, and three stages join the closed list: `event_delivery` (the outbox drain of an authorized start), `manifest_ready` (the manifest write and the deferred readiness edit) and `terminal_event` (the run's terminal write and its Event delivery). D1 classes are the table names, so the auxiliary tables appear as their own classes ([reference](../../reference/api/prediction-runner.md)). AIR-554 reads the same lines before and after the cutover.

## Aged database and the status read

The D1 arm on a database holding 0, 300 and 1,000 settled runs (each with a 38,000-character manifest, a source, its run row and a compacted outbox row; 1.4 MB, 14.5 MB and 44.8 MB) makes **exactly the same** D1 calls (332), statements (669) and write statements (226) as the empty one; local wall time p50 770.7, 824.2 and 816.2 ms (4 samples each, stand-in, no trend with size). The hot queries are primary-key or index searches and never a scan of a history table (asserted with `EXPLAIN QUERY PLAN` in `tests/prediction-aux-budget.mjs`: manifest row and pieces, source head and pieces, outbox row, pending drain, compaction candidates and the outbox of one run). The **status read** no longer groups the retained history: four per-state counter rows maintained by triggers, two single-row counters and one indexed oldest-pending row; it is at most four D1 calls on the aged database and its plans never scan the outbox.

## Growth

One S5 cycle adds one source revision, one manifest (with its pieces) and one outbox row (plus its source piece): about 34.8 KB of sqlite pages in the stand-in, about 3.3 MB for 96 runs a day. Under the accepted retention (sources and manifests kept indefinitely; settled outbox payloads compacted 14 days after settlement, identity kept) growth is linear in runs; D1 storage accounting differs from sqlite pages. No archive mechanism is introduced; revisit only with production evidence and a new decision.

## Scenarios (S5, counts per arm)

| scenario | legacy | shipped33 | r2marker | d1 |
| --- | --- | --- | --- | --- |
| held stage drained by the next run: D1 calls (R2 ops, aux R2 ops) | 358 (232, 29) | 358 (232, 29) | 370 (232, 29) | 409 (213, 0) |
| journal outage then recovery (second cycle): D1 calls (R2 ops, aux R2 ops) | 304 (198, 28) | 304 (198, 28) | 316 (198, 28) | 339 (170, 0) |
| one refused start (skipped Event): D1 calls (R2 ops, aux R2 ops) | 92 (14, 8) | 92 (14, 8) | 93 (14, 8) | 97 (6, 0) |

## Deterministic tests that carry the contract

`tests/prediction-aux-d1.mjs` (authority outcomes; explicit fence classes and every missing or incomplete fence; stage cap, CAS, exact drops by film, digest and holder, snapshot consistency; source revisions and their binding to the run; manifest digests, replay byte verification, part identity and covering-piece reads; outbox identity, cap, quarantine, settlement against the target run and compaction), `tests/prediction-aux-worker.mjs` (the real Worker with the marker at `r2`, at `d1` and unavailable; deferred readiness in one batch with a stale instance and a heartbeat race; same-batch stage settlement; source and run in one batch with a fault, a stale revision and an incompatible binding; terminal run and outbox row in one batch with a fault at the terminal batch, replay and recovery by a successor; a replacement hold surviving a drain; missing manifest of a ready run; production `writes=held`; the outbox fault matrix; pure reads), `tests/prediction-aux-import.mjs` (the importer over the real R2 objects the legacy path wrote, byte-equal parity of the served parts, the strict index and key blockers, incomplete exports, oversized and adversarial Unicode payloads against the byte budget, and `verify` catching a same-length corrupted piece, changed drained and settled metadata, changed run id, attempt time and compaction flag, and extra child rows of a run or of an unknown run; a source-only export showing that an orphan source is history for the importer but refused by the reader, with the read-only `preflight`), `tests/prediction-aux-budget.mjs` (the exact operation, statement and row budgets of this report across the four arms, aged-database independence, query plans and the bounded status read; **no latency assertion**).

## Not covered

Cloudflare latency, D1 rows scanned and billed, production queue and catalog shapes, the Workflow instance start delay, and the behaviour of a late runner after a marker flip: AIR-554. This report authorizes no operation.
