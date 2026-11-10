# AIR-373: measured R2 to D1 parity for Film/Person (production read, 10 Nov 2026)

**Captured:** 2026-11-10, 18:08 to 18:44 UTC. **Authority:** owner GO of 10 Nov 2026 for the measuring operation only (narrow capture plus stage A parity). **Result: MEASUREMENT, NOT A PASS.** The compared classes show **0 differing values** and **1,600 unexplained differences**; a `cutover_minimum` gate would fail (`unexplained`, `source_unverified`). Nothing was repaired, no baseline was recorded and the marker stayed `r2` / `open` / generation 0.

**Production writes: none.** No D1 row was written (not even the projector lease row the approved plan allowed), no R2 object was written, no flag, cron, Task, migration, marker or baseline changed.

This file holds counts, digests and limits only: no id, title, name or payload.

## The run deviated from the reviewed protocol

The approved protocol runs `captureProjectorInputs` and `runParity` (`scripts/film-person-capture.mjs`, main at `d6be4e4`) directly against production D1 over HTTP, and takes the projector lease for the stage A cut. That was not possible: the session's `D1_BACKFILL_API_TOKEN` was refused (`401 Invalid API Token` on token verification and on the first `SELECT`; nothing was read with it). On the owner's instruction the run used the Cloudflare API connector instead. The connector can only be called by the operator, not by the local process, so the run was done as follows.

| Step | What ran | Where |
| --- | --- | --- |
| T0 | the 20 witness aggregates of `readWitness` and the 10 `GATE_STATEMENTS`, as one multi-statement read | production D1, 18:08:47 UTC |
| Copy | 66 tables read in pages by `rowid` (251 `SELECT`s, 539,746 rows, about 130 MB of JSON) into a local sqlite file built from the production DDL (tables, indexes and views, no triggers) | production D1 read, 18:14 to 18:34 UTC |
| T1 | the same 30 statements | production D1, 18:35:26 UTC |
| Discovery resync | generation, aggregates, the rows of `discovery_admission` at or above generation 72990 and ten small discovery tables, in one request with the generation read first and last (equal: 73043) | production D1, 18:39:16 UTC |
| Capture and parity | the merged `captureProjectorInputs` and `runParity`, unmodified; R2 read live with the read-only `R2_SNAPSHOT_*` key; D1 statements answered by the local copy | local, 18:40:54 to 18:43:31 UTC |
| T2 | the same 30 statements | production D1, 18:44:02 UTC |

Consequences, stated plainly:

- **The production lease was never taken.** The stage A cut took its lease in the local copy (797 lease statements, all local). Stability of production is argued from the three reads instead: every one of the 20 witness aggregates and the schema, marker, fence, baseline, projector lease, window, published and owner rows were identical at T0, T1 and T2, and the local copy returned the same 30 results as production at T1 except the two discovery rows below.
- **The discovery tables moved during the copy.** `discovery_authority.generation` went from 73023 to 73038 between T0 and T1 and the discovery lease id changed (the Discovery Workflow was running). `discovery_admission` (237 rows) and the small discovery tables were re-read at generation 73043; after that the local `discovery_decision` and `discovery_admission` matched production on count, sum of generation and sum of payload length, read in the same request. That check is weaker than the witness: a change that keeps those sums would not be seen. The generation moved again before T2.
- **Six tables were created empty and never copied** (`published_epg_stage`, `published_epg_stage_chunk`, `published_epg_stage_row`, `discovery_observation`, `discovery_observation_show`, `discovery_decision_history`) because the readers check that they exist. The local binding refused any `SELECT` naming them; it refused none.
- **`fingerprint_payload` was copied as `film_id` only** (the diagnostics test existence by `film_id`).
- The operator's bridging code (the page reader in the connector, the loader, the local binding) is not reviewed code.

## What was read

| Store | Requests |
| --- | --- |
| R2, final capture and parity | 36 `HEAD`, 9 `GET`, 0 `LIST`; 9 allowlisted objects present, 11,048,365 bytes in total (largest 9,033,363) |
| R2, other | one `HEAD` of `sync.json` as a credential check; one earlier capture attempt that stopped at `d1_derived_failed` after its R2 reads of the same allowlist (its request counts were not kept) |
| D1 through the connector | preflight (database description and 9 `SELECT`s), one row count of every table, the DDL read, T0, the copy, T1, the resync and T2. The three witness reads reported 0 rows written |
| D1 with the refused token | four requests, all `401`; no data returned |

Capture: `ok`, manifest digest `26a77b927e788d2cbc4275be0cdf3e3550e307bc57ade44fd511cf7d691716ff`, allowlist digest `4a2e4b20a0ee01e24f53842e3e51873f66ffcbafdf607bcb4730e8422a51748e`, routes `publishedEpg`, `discovery` and `ownerReview` all D1-routed, 60 capture statements. Gate before the capture: schema 18, marker `r2` / `open` / 0, baseline `empty`.

## Parity

`runParity`: `ok`, no reasons, read consistent (in the local copy), diagnostics stable. Ledger digest `856604999790e16976c73736166aa7b7a7b11c2a204876bc222e97487bc8ec9b`, report digest `02ec54e9020472bfae3ec61c8fd85e9662db6d5506e2df2e4f23cc5cfc4b2240`, `asOf` 2026-11-10T18:41:11.835Z. Source: `verified:false` (the tool's design; this run does not change it).

| Class | Expected (R2 view) | Actual (D1) | Missing in D1 | Extra in D1 | Differs | Explained | Unexplained |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| film | 9,254 | 9,254 | 4 | 4 | 0 | 0 | 8 |
| person | 48,804 | 49,763 | 0 | 959 | 0 | 953 | 6 |
| filmExternalId | 10,062 | 10,054 | 12 | 4 | 0 | 0 | 16 |
| personExternalId | 48,804 | 48,807 | 0 | 3 | 0 | 0 | 3 |
| filmAlias | 9,410 | 9,545 | 5 | 140 | 0 | 0 | 145 |
| personAlias | 48,806 | 49,906 | 0 | 1,100 | 0 | 953 | 147 |
| credit | 93,828 | 98,073 | 88 | 4,333 | 0 | 4,289 | 132 |
| filmLocalization | 9,254 | 9,254 | 4 | 4 | 0 | 0 | 8 |
| personLocalization | 48,804 | 48,807 | 0 | 3 | 0 | 0 | 3 |
| watchlist | 394 | 392 | 3 | 1 | 0 | 0 | 4 |
| redirect | 9 | 5 | 4 | 0 | 0 | 0 | 4 |
| retirement | 4 | 0 | 4 | 0 | 0 | 0 | 4 |
| ratedAdmission | 708 | 0 | 708 | 0 | 0 | 0 | 708 |
| retention | 401 | 0 | 401 | 0 | 0 | 0 | 401 |
| ownerLink | unavailable (link values are not derivable; accepted by the owner decision of 10 Nov 2026) | | | | | | |
| projectionKey | 58,058 | 58,061 | 4 | 7 | 0 | 0 | 11 |
| **Total** | | | **1,237** | **6,558** | **0** | **6,195** | **1,600** |

Reading of the table (counts only; the keys behind them were not kept):

- **1,113 of the 1,600** are `ratedAdmission` (708), `retention` (401) and `retirement` (4): the D1 tables of migrations 0015 and 0016 are empty. The schema is applied; nothing has written those rows.
- **No value differs** in any class: every key present on both sides carries the same encoded value.
- The remaining 487 are spread over the identity classes, largest in `filmAlias` (145), `personAlias` (147) and `credit` (132).
- Diagnostics (classification, never an exception): 3 keyed Persons absent from the view, cause `removed_from_sources`; 5 redirects in D1, all of kind `expected_redirect`, against 9 expected redirects and 4 retirements without a redirect; 4 changed Films, all `retained_duplicate`.
- Owner reviews: 7 entries; the count, the digest of the `(kind, source_key)` keys and the digest of keys with generation were equal before and after the cut.

## Not proved

- R2 and D1 were not read in one atomic snapshot, and here the D1 side was a copy taken 7 to 27 minutes before the R2 reads. The equal witness at T0, T1 and T2 shows the witnessed Film/Person tables did not change in that span; it does not cover a writer that leaves every witness aggregate unchanged.
- The discovery inputs are consistent only to the weaker check described above.
- `ownerLink` link values are not compared. Owner-review keys were checked for preservation, not source parity.
- The 1,600 unexplained differences were not classified by cause beyond the table: the ledger with its key lists was not kept, only the report.
- The reviewed direct path (production D1 over HTTP with the lease) has still never run against production.

## What this does not authorize

No repair, no baseline import or recording, no `r2` to `prepared`. Each needs its own owner GO. A baseline cannot be recorded from this run: its source is unverified and its unexplained total is not zero.

Runbook: [Film/Person baseline](../../runbooks/film-person-baseline.md). Card: [AIR-373](https://trello.com/c/ugu3sQmp).
