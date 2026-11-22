# AIR-579: D1 load burst of 22 Nov 2026 (16:00-18:15 UTC), read-only root-cause analysis

Observation 18:5x UTC, 22 Nov 2026 (19:5x Madrid). **Read-only**: the D1 analytics GraphQL (`d1QueriesAdaptiveGroups`) and the Workflows and deployments `GET` endpoints through the Cloudflare API connector, repository inspection, and `EXPLAIN QUERY PLAN` on a **scratch sqlite database built from `migrations/` only** (no production database, no production rows). No D1 write, index, schema, flag, cron, Task, Workflow, lease, R2 or manual run. Counts, durations and query shapes only; no keys, payloads or tokens.

This page is an RCA with a verdict. It is **not a fix** and promises no latency change. Code changes below are proposals for separate cards.

## Verdict

1. **A temporary burst, not a sustained regression.** From 16:00 to about 18:15 UTC the database ran at 17-47 k queries per 15 minutes (reference 0.7-4 k) and 20-36 M rows read per bucket (reference at most 6 M). It returned to 3.1 k queries / 3.3 M rows (18:30) and 2.3 k / 1.4 M (18:45). Data read up to 18:54 UTC; the next natural EPG run is the next trigger to watch.
2. **Trigger: an EPG run at about 16:00-16:03 UTC followed by Discovery catch-up.** The 16:00 bucket holds 197 k rows written (the EPG publication). The `iptv-epg` Workflow has instances at 16:0x; `iptv-ratings` ran at 16:00. `iptv-discovery` created 13, 8 and 3 instances in the 16, 17 and 18 UTC hours, all `complete`. Discovery is held until the EPG run is certified complete and then catches up ([ADR 0175](../../adr/0175-epg-priority-holds-until-run-complete.md)); the burst is that catch-up working through the new programme. The last Discovery instance of the burst was created at 18:13:52 UTC.
3. **No code deployment explains 16:00.** The six newest deployments are all between 17:50 and 18:47 UTC (docs commits, AIR-571, AIR-551); earlier ones were not enumerated. The Letterboxd Workflow had no instance yet.
4. **The single largest query (176 M rows) is not Worker code.** The text does not exist in `src/`, `scripts/` or `tests/`. It is an ad-hoc diagnostic (a join of the active Discovery ledger with the Channel policy, seven executions between 16:45 and 17:30, one of them 176 M rows / 17.5 s in the 17:00 bucket), consistent in time and subject with the AIR-567 identity audit after the Channel blacklist. It is a cost of a diagnostic, not of the system. It is **not** the cause of the two Predictions errors (see below).
5. **The two `no such column` errors are an independent defect of ad-hoc probes, not an overload effect and not a code-version drift.** Both statements are absent from the repository and name columns that do not exist: `SELECT id,stage,programme_run_id,revision FROM discovery_checkpoint` (29 x at 16:00; the table has `id, programme_run_id, generation, hop_id, payload_json`, migration 0011) and a `film` read with `film_id` (12 x at 18:00; the key column is `id`). Nothing in the Worker issues them.
6. **Predictions link: plausible contention, not proven.** Both Task errors fall inside the burst, but the heartbeat CPU-limit reset (slot `:30`, finished 17:34:57 UTC) is **not** explained by the 176 M query (17:00-17:05). In the minutes before it the top time consumers were Discovery reads (see the window table). The `D1 DB is overloaded` at 18:10 UTC coincides with the heaviest wall-time bucket of the burst (18:00: 103 s of query time per 15 minutes) and a loop of 120 whole-catalog reads in seven minutes. D1 executes a database's queries serially, so many 100-400 ms reads queue every other caller, including the Predictions heartbeat. This is consistent, not a measured causal chain: per-request queue wait is not exposed by analytics.

## Time series (15-minute buckets, UTC)

| Bucket | Queries | Rows read | Rows written | Query time | `sqlite_master` probes |
| --- | --- | --- | --- | --- | --- |
| 15:00 to 15:45 | 1.4-1.9 k | 0.7-6.1 M | 486-743 | 2-7 s | 127-219 |
| 16:00 | 46,401 | 25.3 M | 197,057 | 44 s | 2,326 |
| 16:15 / 16:30 / 16:45 | 21.0 k / 21.7 k / 20.6 k | 23.8 / 29.0 / 36.6 M | 6.4-11.1 k | 53-79 s | 3.3 k / 3.5 k / 2.7 k |
| 17:00 | 8,595 | **193.0 M** | 2,514 | 35 s | 1,511 |
| 17:15 / 17:30 / 17:45 | 18.8 k / 16.8 k / 19.6 k | 19.6 / 24.3 / 21.5 M | 5.1-5.9 k | 48-50 s | 3.0 k / 2.8 k / 3.3 k |
| 18:00 | 21,067 | 22.1 M | 8,425 | 103 s | 3,230 |
| 18:15 | 6,474 | 15.0 M | 676 | 25 s | 844 |
| 18:30 / 18:45 | 3.1 k / 2.3 k | 3.3 / 1.4 M | 165 / 397 | 35 / 7 s | 428 / 274 |

Windows by wall time (top consumers):

| Window | Top by total query time |
| --- | --- |
| 17:28-17:35 (before the CPU-limit reset) | admission join `NOT EXISTS film_external_id` 60 x 3.6 s; `published_epg_show` by key 65 x 1.7 s; active-ledger show and observation reads 52 x 1.7 s each |
| 18:05-18:12 (before the overload) | **whole-catalog `discovery_admission` read 120 x, 48.5 s total (about 400 ms and 12 k rows each)**; ledger observation read 56 x 14.6 s; `published_epg_show` by key 120 x |

## Ranked hotspots (16:00-19:00 UTC, by rows read; plans from the scratch chain at schema 34)

| # | Signature (shape) | Executions | Rows read | Total ms | Code | Plan and cause |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Channel-policy join over `discovery_observation` / `_show` | 1 (+13 smaller) | 176 M (+7.5 M) | 17.5 k | **none: ad-hoc diagnostic** | Whole-table aggregate by design; not a production path |
| 2 | `COUNT(*) ... residence='archive' AND observation_key NOT IN (active)` | 341 | 45.3 M (133 k each) | 12.7 k | `ledgerArchive`, `src/discovery-authority.js:784`, called from the ledger read (`:861`, `:876`, `:882`) | Covering index on `(residence, observation_key)`, but the subquery counts the whole archive: cost grows with the archive, about 2 per minute; the count is informational |
| 3 | `DELETE FROM published_epg_show WHERE programme_run_id=(...) AND basis='discovery' AND match_reason=?` and the matching `SELECT ... match_reason=?` before and after | 1,039 and 685 | 20.5 M and 13.5 M (about 19.7 k each) | 34.6 k and 20.6 k | `src/discovery-authority.js:22`, `:1455`, `:1474` | Only index is `published_epg_show_by_generation(programme_run_id, start_ms)`: the engine **searches by run and scans every row of the run** for `basis` and `match_reason`. One delete and two selects **per film key** (N+1) |
| 4 | `film_external_id` lookups by `(scheme,value)` or `film_id IN json_each` | 685 + 505 + 1,245 + 1,998 | 9.4 + 6.9 + 19.0 + 14.9 M | 1.5-7 k each | `src/discovery-authority.js`, canonical producers | Plan is `SCAN film_external_id`: the primary key starts with `film_id` and the only `(scheme,value)` index is **partial** (`trusted=1 AND conflicting=0`), which these statements (they read untrusted rows too) cannot use. About 13.7 k rows per lookup; the table size was not read |
| 5 | `SELECT film_id, payload_json, ... FROM discovery_admission WHERE state='current' ORDER BY film_id` | 422 (120 in 7 minutes at 18:05) | 5.1 M | **166 s** | `readCatalog`, `src/discovery-authority.js:1768`, behind the read of `epg/discovered-films.json` | Full catalog with JSON payloads on each read (cap 20,000 rows); long wall time, few rows. Largest wall-time contributor to the overload window |
| 6 | Admission join `NOT EXISTS film_external_id ...` | 671 | 16.2 M | 37.3 k | `src/canonical-discovery-admission-producer.js:199` | Inherits #4 per row |
| 7 | Gate introspection `SELECT name FROM sqlite_master ... LIKE 'discovery\_%'` (and `published_epg%`, `film_person_*`) | 16,624 / 4,610 / 3,490 | 12.3 / 1.7 / 1.3 M | 6.9 / 1.5 / 1.1 k | `src/discovery-authority.js:373`, `src/published-epg.js`, `src/film-person-authority.js` | `SCAN sqlite_master` per request: cheap each (about 740 rows) but about 90 per minute at the peak and 10x the reference; it follows the number of Discovery calls |
| 8 | Active ledger reads (`discovery_observation_show WHERE source_key='active'`, observation join, counts) | 396 + 223 + 144 + 125 + 220 + 1,782 | 10.7 + 2.1 + 5.9 + 3.4 + 3.0 + 3.2 M | 34 s and below | Discovery chunk | Proportional to the ledger; part of catch-up |

Not supported by the evidence: a missing index on `epg_channel` or `epg_channel_category` (both have `epg_channel_by_category` and `_by_owner_category`, the tables are capped at 4,000 and 100 rows, and `src/epg-channel-d1.js` has no reader in the Worker scan path); a schema or code regression at 16:00.

## Not done or not established

- The Worker logs were not read; the per-request caller of each signature is traced from code, not from log correlation. The Discovery chunk and projection call chain that reads `discovered-films.json` repeatedly should be confirmed by the Discovery owner.
- Row counts of `film_external_id`, `discovery_admission`, `published_epg_show` and the ledger tables were not read; plans come from the empty scratch chain and the rows-per-execution figures.
- Per-request D1 queue time and the exact failing request of the two Predictions errors are not available from analytics.
- Who ran the diagnostics (#1 and the two `no such column` probes) is not established; only that the Worker does not.

## Proposed gate for AIR-554 (for the owner to accept; the figures are measurements, not thresholds set here)

Cutover stays **NO-GO until the gate holds**; this page does not lift it. A proportionate gate, tied to observed errors and the measured import:

1. No Predictions run, Worker log or analytics error with `D1 DB is overloaded` or `exceeded its CPU time limit` in the 60 minutes before the window.
2. The last EPG run is certified complete and no `iptv-discovery` or `iptv-epg` instance is live or queued, so a Discovery catch-up is not running (the burst above is tied to that state, not to a time of day).
3. The latest three 15-minute analytics buckets show no query above a few seconds of single-statement time and total query time per bucket well below the bucket length; a recorded bucket, not an inherited threshold. Historical 500-2,000 queries per bucket is a reference, not a requirement.
4. The measured cost of the import batch (rows read and written, duration; up to 2,000 statements, 8 MiB) from a scratch rehearsal on the real export is accepted by the owner against the headroom read in step 3.
5. Abort rule during the window: any overload or CPU-limit error stops new steps and follows the run sheet's stop path.

## Proposed separate cards (none implemented here; each needs an owner decision)

1. **Discovery/EPG:** replace the per-key `published_epg_show` delete and selects (hotspot 3) with a set-based statement or an index covering `(programme_run_id, basis, match_reason)`; an index is a migration and an L3 apply.
2. **Platform:** an index serving `film_external_id(scheme, value)` for all trust states, or a rewritten lookup (hotspot 4); a migration.
3. **Discovery:** stop reading the whole admission catalog per call (hotspot 5): cache within the chunk, project, or page.
4. **Discovery:** bound or cache `ledgerArchive` (hotspot 2), and cache the gate introspection per isolate (hotspot 7).
5. **Process:** a cost guard for ad-hoc production diagnostics (read `EXPLAIN` on the scratch chain first, bound by `LIMIT` or a row estimate) so one statement cannot read 176 M rows.
6. Re-check after the next natural EPG run: the same analytics, to see whether the burst repeats with the same duration.

Documentation impact: this evidence page and its index entries only. No runtime, architecture, security, integration or deployment change.
