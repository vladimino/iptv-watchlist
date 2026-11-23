# AIR-554 P3: measured chunked cutover on a disposable remote scratch D1

[AIR-554](https://trello.com/c/UrS1gflv) · 23 November 2026 (UTC). Owner-authorized bounded rehearsal ([GO / handoff](https://trello.com/c/UrS1gflv#comment-6b03f10bc74d412058dc54ef)). **Production was not read or written**: no production D1, no production R2, no export, no Task, flag, Access, lease, Workflow or marker. Raw metrics: [measurements JSON](air-554-p3-scratch-measurements-2026-11-23.json) (790 recorded requests). **P3 stays OPEN**: the cold R2 capture duration `T_cut` is not measured here, and the other required inputs are not accepted yet.

## Setup

| Item | Value |
| --- | --- |
| Code | `main` at `a2d79cf4039fa400a34cfd27f1559fa8e931911c` (ADR 0202, PR #930) plus the benchmark harness `scripts/prediction-aux-p3-benchmark.mjs` (this PR) |
| Scratch database | `iptv-aux-p3-benchmark-20261123`, uuid `82c01d85-494d-4262-b700-335f721a78ec`, created 2026-11-23T07:57:31Z, same account as production, primary location hint `weur` (production runs in `WEUR`; every response reported `served_by_region` `WEUR`) |
| Identity guard | the harness refuses the production uuid and name, any name that does not start with `iptv-aux-p3-benchmark-`, and a database that is not empty; the API had to read back exactly the uuid and name given; `D1_BACKFILL_ENDPOINT` and `D1_BACKFILL_DATABASE_ID` are ignored. The operator's own production pin was neither changed nor bypassed: the binding is injected (`execute`), the same code path as the operator tests |
| Surface | the real operator (`apply 0034+0035`, `close`, chunked `import`, `seal`, chunked `verify`, `flip`) over the same D1 REST client and published binding the cutover uses (`POST /d1/database/{id}/query` with `{batch}`), from the agent sandbox (one HTTPS proxy hop) |
| Fixture | **synthetic only**: 1,600 R2 objects (800 runs, a source and a stop record each, 45,000 bytes of random text per source), cut by the real exporter from a loopback fake bucket and converted by the real converter; no production object, no PII. Plan digest `e896fad9f862601341ec837c77b6b27ee42bc1065397a0018253c7d21e7471a5` |
| Fixture size | 4,000 data statements, 36,985,380 bytes (22 Nov real export: 3,998 statements, 36.2 MB). Totals match the plan on the database afterwards. **Not the real shape**: no held stage and no manifests, so the real run has other row mixes and index writes |
| Run | one complete run from an empty database, base schema 0001 to 0033, then `0034` and `0035`, close, import, seal, verify, flip |

## Measurements (one run; n=6 chunks, n=7 slices)

Per batch (one HTTP request, one atomic D1 batch):

| Step | Statements | Request bytes | HTTP wall ms | D1 duration ms | rows written | rows read |
| --- | --- | --- | --- | --- | --- | --- |
| Import chunks 1 to 5 | 550 | 6,266,705 | 914 to 1,295 | 59 to 76 | 1,099 | 1,649 to 1,655 |
| Import chunk 6 | 1,262 | 5,719,692 | 1,367 | 171 | 5,723 | 9,393 |
| Verify slices 1 to 5 | 818 | 6,283,750 | 855 to 1,306 | 53 to 77 | 819 | 2,043 to 2,051 |
| Verify slice 6 | 1,500 | 6,058,840 | 1,019 | 86 | 1,501 | 3,367 |
| Verify slice 7 | 32 | 16,312 | 171 | 2 | 33 | 4,071 |
| Seal (guard and row) | 2 | 1,289 | 169 | 0.51 | 2 | 4,021 |
| Flip (guard and marker) | 2 | 1,912 | 157 | 0.47 | 2 | 4,838 |

Summary of the request-level wall clock: import chunks min 914, median 983, p95 and max 1,367 ms; verify slices min 171, median 1,019, p95 and max 1,307 ms. Totals: import 6.75 s wall (11,218 rows written, 17,652 read), verify 6.55 s wall (5,629 written). No batch was refused, no timeout, no `write_uncertain`, no CPU or size error. Round trip of a trivial `SELECT 1` from the sandbox: median 146 ms, max 191 ms.

Whole commands, **as the operator runs them** (each command reads the whole state back, about 21 sequential single-statement requests, about 3.2 s, before and after each step and after every chunk or slice):

| Command | Wall seconds |
| --- | --- |
| schema 0001 to 0033 (harness, not the operator) | 5.6 |
| `status` before / after | 4.2 / 4.3 |
| `apply` 0034 and 0035 (one batch of 90 statements, 27,054 bytes, D1 9.4 ms) | 8.2 |
| `close` | 8.9 |
| `import` (6 chunks) | 40.4, which is 6.7 per chunk |
| `seal` | 10.5 |
| `verify` (7 slices) | 44.3, which is 6.3 per slice |
| `flip` | 10.0 |

Integrity: marker `d1` at generation 2, receipts 6 chunks, 1 seal and 7 slices, every table total equals the plan (800 source heads, revisions and outbox rows, 1,600 source pieces), the flip committed, the plan digest pin held. 182 HTTP 400 responses are the operator's expected probes (seven authority tables without a `cutover` column, tried with and without it, 26 readbacks); every other request succeeded.

## Cleanup

After the evidence was fixed, the exact uuid and name `82c01d85-494d-4262-b700-335f721a78ec` / `iptv-aux-p3-benchmark-20261123` were read back (161 tables, 41,492,480 bytes, not the production uuid or name) and the scratch database was deleted; a listing afterwards shows only `iptv`. The synthetic capture directories were deleted locally; no production object or credential value is recorded here.

## What this means for P3 (run sheet formulas)

The operator-level cost is dominated by the state readbacks, not by D1: the slowest import request was 1.37 s, the operator spends 6.7 s per chunk and 6.3 s per slice. With `K = 6`, `M = 7`, `T_chk = 6.73 s`, `T_slc = 6.33 s` and the sheet's `+1` minute for the seal:

- `S = 5 + T_cut + 6*T_chk + 1 + 7*T_slc = 7.41 + T_cut` minutes; `F = S + T_cut + 5 = 12.41 + 2*T_cut`.
- Largest `T_cut` that satisfies `now+A+S <= 30` and `now+A+F <= 45` (the tighter bound), by `now+A` (minutes after T0 at the close): 5: 13.8; 10: 11.3; 15: 7.6; 20: 2.6.
- Sensitivity if every D1 step were three times slower than measured (`S = 10.23 + T_cut`): 5: 12.4; 10: 9.8; 15: 4.8; 20: not satisfiable.

`T_cut` (a cold read-only R2 capture) is **not measured**: a scratch D1 cannot measure it, and no number is invented here. Until it is measured and the owner accepts the inputs, P3 is OPEN.

## Limits of extrapolation (do not read this as a production figure)

- One run, n=6 and n=7 samples; no repetition under varying load. Only the maxima are bounds of this run, not percentiles of production.
- The scratch database is new, tiny and idle; production `iptv` is about 2.4 GB with 145 tables and live writers. Per-batch D1 duration there is unmeasured.
- Latency is from the agent sandbox through a proxy; the owner's machine or another network will differ (the 146 ms round trip is a floor of this path, not of the cutover).
- The fixture lacks a held stage, manifests and the real row mixes; the real plan may have other statement counts per chunk (the 22 Nov plan was 3,998 statements).
- Not covered: the real release flow from the owner's side, the Task freeze, P5 (D1 health gate), the 15-minute freshness of the second cut on real captures, and any concurrent Worker traffic.

## Residual gates (unchanged)

P1 (accepted export scope and a rehearsed capture), P3 (cold `T_cut` and acceptance of these inputs), P4, P5, P6 (`0034` and `0035` still not applied to production), P7, P8 are open. This evidence authorizes nothing: no production apply, close, import, seal, verify or flip.
