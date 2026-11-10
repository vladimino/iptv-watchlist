# AIR-420: the ledger seal pays for D1 round trips, not for SQL

**Captured:** 2026-11-10, 17:05 to 17:40 UTC. **Method:** read-only only: MCP `epg_status`, Worker observability (`epg_phase` events), the Workflow instance records of `iptv-epg`, D1 query analytics (`d1QueriesAdaptiveGroups`), two D1 `SELECT`s on `discovery_seal` and `discovery_observation`, and an offline measurement on the sqlite stand-in. No write, start, step, retry, lease change, flag, Task or cron change. No Film or observation id is recorded here.

## The incident

The daily EPG run of 10 November (`epg_20261110_0`, sync run `6d9e3c36…`, due 16:00 UTC) entered `seal/ledger` at 16:08:25 UTC and finished the ledger at 17:12:42 UTC: **64 minutes** for 47,059 observations. The run of 9 November sealed 44,924 observations in about 6 minutes. The run was never stopped; it advanced in every step and the read model said `healthy` throughout, because the executor's progress count did not include the ledger cursor.

D1 readback at 17:11:43 UTC: `phase=items`, `item_total=47059`, `cursor_items=46191`, `cursor_bytes=55349138`, transfer `loading`. At 17:12 UTC: 46,552 rows `active` of one programme run, no `retiring` row.

## Three days of the same code

`src/discovery-authority.js` did not change between 8 November 16:58 UTC and this change, so the three runs below ran the same seal code.

| Run | Item total | Observations a 31 s step | Ledger duration | Steps |
| --- | --- | --- | --- | --- |
| 8 Nov (`epg_20261108_0`) | 42,566 | 420 to 600 | not finished after 39 min (28,972 written; the run ended in an error at 16:44 UTC) | 54 |
| 9 Nov (`epg_20261109_0`) | 44,924 | 7,500 to 9,360 | 6 min 52 s including one wait of 4 min 27 s | 6 |
| 10 Nov (`epg_20261110_0`) | 47,059 | 420 to 660 | 64 min | 85 |

Volume grew by 4.8 % from 9 to 10 November; the rate fell about 17 times. Volume is not the cause.

## Where the time goes

- **Not SQL.** D1 query analytics for 10 November 16:20 to 16:40 UTC: 17,855 observation upserts took 1.5 s of SQL time in total; every other seal statement is below 0.2 s in total. On 9 November 47,389 upserts took 3.3 s. The seal step spends about 31 s of wall time and a few hundred milliseconds of it in SQL.
- **Not a rescan.** Rows read per upsert are 3 on both days; the show delete reads tens of rows per call.
- **Not a concurrent writer in the logs.** In the slow intervals the only events of the Worker are the EPG Workflow's own. The slow rate is constant for the whole instance on 8 and 10 November and the fast rate is constant on 9 November.
- **Round trips.** A seal batch of about 30 observations made 6 sequential D1 round trips (four reads of the authority gate, one read of the job row, one write batch); the Worker counts show the same ratio (457 fences to 1,588 + 1,359 + 504 + 614 + 545 gate and job reads in 20 minutes). On 9 November a step made about 300 batches (about 17 ms a round trip); on 10 November 14 to 22 batches (about 250 to 350 ms a round trip). Everything else in the run was slower in the same proportion on the slow days (the first two Workflow steps took 6.2 s and 2.5 s on 9 November, 14.1 s and 7.8 s on 10 November, 18.3 s and 20.0 s on 8 November).

**Proven:** the seal's wall time is the number of sequential D1 round trips multiplied by a round-trip latency that is constant within one Workflow instance and differed about 17 times between instances. **Not proven:** why the latency differs between instances. The telemetry carries no location of the Workflow instance; an instance that runs far from the D1 primary (served from MAD) is the likely reading and is not confirmed. Discovery and projector contention are not supported by the data: SQL time is flat and no other writer logs in the slow intervals.

## The change and its measurement

The seal batch now packs its rows (several observations in one upsert statement, show deletes by 80 keys) and, after the first batch of a step, is sent without re-reading the values that the batch itself checks by compare-and-set. Offline, 40,000 observations of about 1.2 kB with two shows each, over a previous ledger of 38,000 (36,000 keys seen again, 2,000 retiring for good), `tests/discovery-seal-throughput.mjs`:

| | Before (`origin/main` `d6be4e4`) | After |
| --- | --- | --- |
| Batches | 1,334 | 295 |
| Observations a batch | 30 | 136 |
| D1 round trips | 8,004 | 300 |
| Round trips per 1,000 observations | 200.1 | 7.5 |
| Statements | 53,338 | 11,770 |
| Stand-in wall time | 10.7 s (3,740 rows/s) | 3.0 s (13,532 rows/s) |
| Model at 17 ms a round trip | 136 s | 5 s |
| Model at 300 ms a round trip | 40 min | 90 s |

The model for the slow day (40 min for 40,000) agrees with the 64 minutes observed for 47,059 including the gaps between steps. Estimated ledger time after the change on a slow instance: about 350 batches, 2 to 4 steps, two to three minutes; on a fast instance one step.

**Limits.** The stand-in has no network; the "after" figures for production are a model, not a measurement. If the slow part were the write batch alone and not every round trip, the gain on a slow instance would be the batch density only (about 4.5 times, 64 min to about 14 min). The step log now carries `batches`, `writeMs`, `items`, `archives` and `archiveMs`, so the next natural run measures this directly. The catalog and publication phases were not changed; on 10 November they took from 17:17 to after 17:34 UTC and are the next thing to read on a slow instance.

## The live run

No intervention was needed or made. The ledger completed at 17:12:42 UTC; one Workflow step attempt failed with an internal Workflows error at 17:17 UTC and was retried by the platform; at 17:34 UTC the run was in `seal/finalize` with no failure counted.
