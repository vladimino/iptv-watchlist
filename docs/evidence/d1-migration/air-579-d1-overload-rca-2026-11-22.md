# AIR-579: D1 load burst of 22 Nov 2026 (16:00-18:15 UTC), read-only root-cause analysis

Observation 18:44-18:56 UTC, 22 Nov 2026 (19:44-19:56 Madrid); the last analytics bucket read is 18:45 UTC. **Read-only**: the D1 analytics GraphQL (`d1QueriesAdaptiveGroups`), the Workflows, deployments and versions `GET` endpoints through the Cloudflare API connector, repository inspection at `main` `92a57de`, and `EXPLAIN QUERY PLAN` on a **scratch sqlite database built from `migrations/` only** (empty tables; no production database or rows). No D1 write, index, schema, flag, cron, Task, Workflow, lease, R2 or manual run. Counts, durations and query shapes only; no keys, payloads or tokens.

This page is an RCA with a verdict. It is **not a fix** and promises no latency change. Code changes below are proposals for separate cards. Each statement is marked **observed** (read from analytics, Workflows or deployments), **inferred** (from code or plans) or **unattributed**.

## Verdict

1. **Observed: a temporary burst, not a sustained regression.** From 16:00 to about 18:15 UTC the database ran at 17-47 k queries per 15 minutes (reference 0.7-4 k) and 20-36 M rows read per bucket (reference at most 6.1 M, plus one 193 M bucket). It returned to 3.1 k queries / 3.3 M rows (18:30) and 2.3 k / 1.4 M (18:45). The next natural EPG run is the next point to check.
2. **Probable, not established: the burst follows an EPG run and the Discovery catch-up that [ADR 0175](../../adr/0175-epg-priority-holds-until-run-complete.md) schedules after it.** Observed: the 16:00 bucket holds 197,057 rows written, a D1-wide aggregate that analytics cannot attribute to a caller; the `iptv-epg` Workflow has two instances created at 16:0x UTC (the newest at 16:03:13), `iptv-ratings` one at 16:00:29; `iptv-discovery` created 13, 8 and 3 instances in the 16, 17 and 18 UTC hours (24 in all, every one `complete`), the last at 18:13:52. The timing fits a catch-up that ended with the burst, but no Worker log or per-request attribution was read, so the writer of the 197 k rows and the exact callers below stay **unattributed**.
3. **Deployments (observed from the versions list, UTC).** The last version before the onset is `95c1f8a6` at 13:59 (a prompt-catalog change); the next is `f458bbaf` at 16:23 (a test change). **No deployment lies between 14:00 and 16:23**, so the onset at 16:00 was not preceded by a deploy within two hours. That is all this shows: it does not exclude an effect of earlier code or of data, and the sustained phase overlaps later versions: 16:30 (`67a86c55`, Predictions recovery slots), 16:43 (docs), 16:54 (`91877bce`, AIR-565 Channel policy in the scan, no change of the volume already seen at 16:15-16:45), 17:00 (a variable binding deleted), then documentation and AIR-571/AIR-551 versions from 17:25. The earlier question whether code changed around 16:00 is answered only for the 14:00-16:23 interval.
4. **The 176 M-row statement is likely external or ad-hoc (inferred; provenance unconfirmed).** Its exact text is not in `src/`, `scripts/` or `tests/`, which is evidence against a literal checked-in Worker query but not proof of who ran it: dynamic SQL or another caller is not excluded; it joins the active Discovery ledger with the Channel policy (seven executions between 16:45 and 17:30; one of 176 M rows / 17.5 s in the 17:00-17:05 bucket). The subject is plausibly associated with the AIR-565/AIR-567 work of that afternoon; that is an association, not confirmed provenance, and no person or session is named.
5. **Inferred, likely external or ad-hoc (provenance unconfirmed): the two `no such column` errors are statements whose exact text the repository does not contain (the same caveat as finding 4: dynamic SQL is not excluded) and that name columns the schema does not have**: `SELECT id,stage,programme_run_id,revision FROM discovery_checkpoint` (29 x at 16:00; the table has `id, programme_run_id, generation, hop_id, payload_json`, migration 0011) and a `film` read with `film_id` (12 x at 18:00; the key column is `id`, migration 0001). They are not an overload effect (a missing column does not depend on load) and no checked-in Worker query issues them; their caller is unattributed.
6. **Predictions link: plausible, not proven.** Both Task errors fall inside the burst. The heartbeat CPU-limit reset (slot `:30`, finished 17:34:57) does **not overlap** the 176 M statement (17:00-17:05), so that statement is not a likely direct cause (non-causation is not proven): in 17:28-17:35 the largest signatures took 1.5-3.6 s each in total. The `D1 DB is overloaded` at 18:10 UTC coincides with the heaviest wall-time bucket (18:00: 103 s of query time) and 120 whole-catalog reads in seven minutes. D1 executes one database's queries serially, so many 100-400 ms reads can queue other callers, including the heartbeat; this is a mechanism consistent with the timing, not a measured chain (per-request queue wait is not in analytics).
7. **Unattributed read amplification (first follow-up).** The 120 `discovery_admission` catalog reads in seven minutes (about 400 ms and 12 k rows each; 48.5 s in total) are the largest wall-time item before the 18:10 overload. The code shows the SQL source (`readCatalog`, `src/discovery-authority.js:1768`) and that any read of the key `epg/discovered-films.json` through the generic loader reaches it (`src/worker.js:41`). Candidate callers found by tracing: the Discovery catalog-poster step (`src/discovery.js:481-486`), the enrichment genre and status views (`src/enrichment.js:4234-4244`, `:4248`, `:4252`), and the published-key read (`src/worker.js:812`). **Which of them ran 120 times, and why, is not established.** Verifying the caller from the Worker logs comes before any fix; a cache, projection or paging change is not proven as the root fix.

## Time series (15-minute buckets, UTC; observed)

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

Per-bucket totals are far below the 900 s of a bucket even in the worst bucket (103 s), yet the 18:10 overload happened inside it: **a bucket total does not show the damage; accumulated time of one repeated signature inside a few minutes does.**

| Window (observed) | Top signatures by total query time |
| --- | --- |
| 17:28-17:35 (before the CPU-limit reset) | admission join with `NOT EXISTS film_external_id` 60 x 3.6 s; `published_epg_show` by key 65 x 1.7 s; active-ledger show reads 52 x 1.7 s; observation join 52 x 1.5 s |
| 18:05-18:12 (before the overload) | whole-catalog `discovery_admission` read 120 x 48.5 s; ledger observation read 56 x 14.6 s; `published_epg_show` by key 120 x 4.1 s |

## Hotspots, 16:00-19:00 UTC

Two rankings, because rows read and wall time order the signatures differently. Executions, rows and times are observed; call sites and plans are inferred.

**By total rows read** (a family's rows are summed where it is one call pattern):

| # | Signature (shape) | Executions | Rows read | Code | Cause |
| --- | --- | --- | --- | --- | --- |
| 1 | Channel-policy join over the active ledger | 1 (plus 13 smaller) | 176 M (plus 7.5 M) | none found | Whole-table aggregate by shape; not a production path |
| 2 | `film_external_id`, four signatures (below) | 685 + 505 + 1,245 + 1,998 | 9.4 + 6.9 + 19.0 + 14.9 = 50.2 M | `src/discovery-authority.js`, canonical producers | Three of the four can only scan; see the plan table |
| 3 | `COUNT(*) ... residence='archive' AND observation_key NOT IN (active)` | 341 | 45.3 M (133 k each) | `ledgerArchive`, `src/discovery-authority.js:784`, from the ledger read (`:861`, `:876`, `:882`) | Covering index `(residence, observation_key)` but the count walks the whole archive; about 2 per minute; the count is informational |
| 4 | `published_epg_show` delete and the by-key selects before and after | 1,039 + 685 | 20.5 + 13.5 M | `src/discovery-authority.js:22`, `:1455`, `:1474` | Only index is `(programme_run_id, start_ms)`: one delete and two selects per film key (N+1), each reading the rows of the whole run (about 19.7 k) for `basis` and `match_reason` |
| 5 | Admission join `NOT EXISTS film_external_id ...` | 671 | 16.2 M | `src/canonical-discovery-admission-producer.js:199` | Inherits the `film_external_id` lookup per row |
| 6 | Gate introspection `sqlite_master` (`discovery\_%`, `published_epg%`, `film_person_*`) | 16,624 + 4,610 + 3,490 | 12.3 + 1.7 + 1.3 M | `src/discovery-authority.js:373`, `src/published-epg.js`, `src/film-person-authority.js` | `SCAN sqlite_master` per request: cheap each, about 90 per minute at the peak, follows the number of Discovery calls |
| 7 | Active-ledger reads (show rows, observation join, counts, decision joins) | 396 + 223 + 144 + 125 + 220 + 1,782 | 10.7 + 2.1 + 5.9 + 3.4 + 3.0 + 3.2 M | Discovery chunk | Proportional to the ledger; part of the catch-up |

**By total wall time:** whole-catalog `discovery_admission` read, 422 executions, **166 s**, 5.1 M rows (unattributed caller, verdict 7); admission join 37.3 s; `published_epg_show` delete 34.6 s; active-ledger show reads 34.0 s; `published_epg_show` selects 20.6 s and 29.4 s; observation joins 20.7 s and 13.7 s; archive count 12.7 s.

### `film_external_id`: four distinct signatures

Plans are from the scratch chain at the current schema with **empty tables**. They show which index a statement *can* use. The production planner may choose otherwise; rows per execution are the production evidence.

| Signature (shape) | Scratch plan | Rows per execution (observed) | Reading |
| --- | --- | --- | --- |
| `scheme='tmdb' AND value=?` | `SCAN film_external_id` | about 13.7 k | No usable index: the primary key starts with `film_id`; the only `(scheme,value)` index is partial (`trusted=1 AND conflicting=0`) and the statement also reads untrusted rows |
| `(scheme='tmdb' AND value=?) OR (scheme='letterboxd' AND value=?)` | `SCAN film_external_id` | about 13.6 k | Same cause |
| `scheme IN (...) AND value IN (SELECT value FROM json_each(?))` | `SCAN film_external_id` | about 15.3 k | Same cause; the list size does not matter |
| `scheme IN (...) AND film_id IN (SELECT value FROM json_each(?))` | **`SEARCH` by the primary-key index** `(film_id, scheme)` | about 7.4 k | **Not a scan.** The rows follow the number of ids per call; the remedy is the batch size, not a `(scheme,value)` index |

A `(scheme,value)` index would serve the first three only; the fourth needs a different remedy. The empty scratch database cannot establish the production plan or the table size, which was not read.

Not supported by the evidence: a missing index on `epg_channel` or `epg_channel_category` (the migration has indexes on both foreign keys, the tables are capped at 4,000 and 100 rows, and `src/epg-channel-d1.js` has no reader on the Worker scan path in this snapshot).

## Not done or not established

- No Worker log was read, so every caller named above is a candidate from code, not a correlated request.
- The writer of the 197 k rows of the 16:00 bucket is unattributed.
- Row counts of the tables were not read; plans come from the empty scratch chain plus rows per execution.
- Per-request D1 queue time and the exact failing request of the two Predictions errors are not available.
- The origin of the 176 M statement and of the two `no such column` statements is not established.
- Versions older than the 13:59 one were listed but not compared; the check of 14:00-16:23 is the interval the evidence supports.

## Proposed gate for AIR-554 (for the owner to accept; nothing here is a threshold already set)

The cutover stays **NO-GO** and this page lifts nothing. A bucket total or a momentary empty Workflow list does not protect a longer import: the 18:00 bucket (103 s of 900 s) contained the overload, and the next Workflow, the 15-minute Predictions slot (a slot starts about five minutes before its nominal time) or the 03:24 UTC EPG run can start inside the window. The gate therefore has a fresh preflight, measured criteria against the observed pattern, and an overlap and abort rule. It uses no historical QPS.

**Fresh preflight, repeated within 10 minutes before the first step (read-only):**

1. Errors: no `D1 DB is overloaded` and no `exceeded its CPU time limit` in any Predictions run, Worker log or analytics error row in the previous 60 minutes.
2. Quiet signal: `epg_pipeline_status` reports `discovery.nextAction: stop` (the catch-up of the last EPG commit is finished); no `iptv-epg` or `iptv-discovery` instance is queued, running or paused, and none was created in the last 30 minutes.
3. Repeated-read pattern, measured on the last three complete 15-minute buckets plus the open one: no single signature has more than 50 executions in any 7-minute span at a mean above 200 ms (the 18:05 pattern: 120 executions, about 404 ms); the largest signature's accumulated time in any 7-minute span is recorded and compared with the same figure of the quietest hour of that day (a measurement taken at preflight, not an inherited constant); rows read per bucket are not above the maximum of that day's non-burst buckets.
4. A tail check: the 17:28-17:35 window shows the CPU-limit reset can occur without a single dominant signature, so criteria 1 and 3 together decide, and the gate is **not** satisfied by a quiet bucket total alone.

**Overlap rule:** the window starts after a Predictions slot has finished (registry and `prediction_queue_overview`) and the planned duration `T_imp + T_ver` measured on a scratch rehearsal of the real export must fit before the next slot's start (the owner accepts a longer window only through the owner's own decision on a Task pause, which this page does not request). A window inside 03:24 UTC to the end of the Discovery catch-up is excluded.

**Abort rule during the window:** re-read criteria 1-3 at each step boundary; any overload or CPU-limit error from the import, a Predictions run, a live Workflow instance of `iptv-epg`, `iptv-discovery` or `iptv-prediction-start`, or a single signature crossing criterion 3 stops new steps and follows the run sheet stop path. A stop is read-only until the owner decides.

## Proposed separate cards (none implemented here; each needs an owner decision)

1. **First, Discovery/Platform: attribute the 120 whole-catalog reads** from the Worker logs (verdict 7) before choosing a cache, projection or paging fix.
2. **Discovery/EPG:** replace the per-key `published_epg_show` delete and selects (hotspot 4) with a set-based statement or an index covering `(programme_run_id, basis, match_reason)`; an index is a migration and an L3 apply.
3. **Platform:** for the three `film_external_id` signatures that scan, an index serving `(scheme, value)` for all trust states, or a rewrite; for the `film_id IN json_each` signature, review the batch size. A migration needs its own GO.
4. **Discovery:** bound or cache `ledgerArchive` (hotspot 3) and cache the gate introspection per isolate (hotspot 6).
5. **Process:** a read-cost review for ad-hoc production diagnostics: bounded predicates and ranges, a query-shape and cardinality review, `EXPLAIN` on the scratch chain first, and an explicit read-cost budget. An outer `LIMIT` is **not** a guard: it does not bound the rows an aggregate, a `COUNT(*)`, a join or an `ORDER BY` reads, so it would not have prevented the 176 M-row scan.
6. Re-check after the next natural EPG run with the same analytics, to see whether the burst repeats with the same duration.

Documentation impact: this evidence page and its index entries only. No runtime, architecture, security, integration or deployment change.
