# AIR-374 E6: first read-only production measurement of Film, Person and EPG volumes (12 Nov 2026)

**Captured:** 2026-11-12, about 15:32-15:35 UTC (times in UTC). **Method:** the 14 fixed `SELECT` statements of the [E6 runbook](../../runbooks/film-person-e6-budget-measurement.md), printed by `emit-sql` of `scripts/film-person-e6-measure.mjs` on main `f624825`, sent one per request through the Cloudflare D1 read path (connector `d1_database_query`) by a Claude Executor session, each judged by `verify-step`, then the whole bundle by `verify` and `summarize`. **Result: all 14 statements CONTINUE, whole bundle `verify` `ok: true`, no stops; the per-run unit ceiling is NOT chosen.** This is decision E6 of the [holdpoint decision pack](../../runbooks/film-person-holdpoint-decision-pack.md) ([AIR-374](https://trello.com/c/ha7ais3w)).

This file holds counts, timestamps and enums only: no id, title, name or payload. The raw result bundle stays local and is not committed.

## Owner GO and parameters

- After the E6 kit merged ([PR #557](https://github.com/vladimino/iptv-watchlist/pull/557)) and after the owner was shown the runbook GO text with its caps, the owner wrote in chat on 12 Nov 2026: `даю GO на read-only production-измерение`.
- Parameters used: operator is the assistant (Claude Executor) through the Cloudflare D1 read path; 14 statements from `emit-sql` on main `f624825`; statements digest `38d50e82d454633ec9370f2981e05b88498a2a00809fdc2fb83b87bf2fe54543`; one statement per request in printed order; window about 15:32-15:35 UTC, outside the hourly `:00` tick and the daily EPG run (next due 16:00 UTC).
- Caps as in the runbook: 300,000 `rows_read` and 5,000 ms per statement, 1,500,000 and 60,000 ms in total; the two delta statements only when every generation member count is at most 20,000.
- Limitation: the owner did not fill the parameters explicitly. The assistant chose the window and the operator within the runbook defaults, and the GO text was not re-signed with filled brackets.
- **This GO covered that one run. It is not a standing authorization;** a repeat measurement needs its own GO.

## Results

| Item | Observed |
| --- | --- |
| Statements | 14 of 14 `CONTINUE`; whole bundle `verify` `ok: true`; no stop |
| Total cost | `rows_read` 662,279; database time 656 ms |
| Largest statement | 206,856 rows (`table_counts`); 159 ms (maximum per statement) |
| Schema and markers | schema 19; marker `prepared` / `open` / 1; EPG authority `d1` / `open`, generation 285; watchlist generation 9; receipts 0 |
| Published generations | 9 retained (oldest 2026-11-02T16:13Z, newest 2026-11-11T17:05Z); newest 8 sampled |
| Members per generation (sampled 8) | 394-395, median 395; watchlist members 394-395; shows 971-1,951 |
| Membership deltas | newest pair: joined 3, departed 2; previous pair: joined 0, departed 1 |
| Units per run (observed plus departed) | about 397 and 395 |
| Table counts | films 10,044; persons 53,623; credit rows 107,064; watchlist films 391; metadata rows 399; sync rows 399; dimension rows 34,936 |
| Credits per watchlist Film | min 11, p50 22, p90 22, p95 24, p99 24, max 26, mean 21.99; at the cap: 0 |
| Films per Person | p50 1, p90 4, p95 6, p99 16, max 50 (6 Persons in the 50 bucket) |
| Persons credited from the watchlist | 6,452, with 8,600 credit rows |
| Film updates per day (14 days, n = 12 days) | median 254, max 5,884 |
| Person updates per day (n = 13 days) | median 1,550, max 18,692 |
| Unit cost on the sqlite stand-in (offline) | 14 round trips unchanged (no-op); 38 applied (36 queries, 2 batches) |

## Ceiling status

Status `incomplete`. Unknown, and not measured here: `changedShare`, the per-step query budget, wall time and CPU of an EPG Workflow step, the round-trip time on the EPG path, CPU per unit and the fixed overheads. **No per-run ceiling is chosen; the provisional 50-unit ceiling of P3a stays provisional.** The only arithmetic this record states: at about 397 units per run a 50-unit pass needs about 8 steps, and 50 applied units cost up to about 1,900 round trips (38 x 50).

## Limits

- A single point-in-time measurement.
- Membership change is not content change: `changedShare` stays unknown without a producer dry run.
- The statements read production only; nothing was written. No flag, Task, cron, marker, R2 or producer operation occurred.
- The raw file stays local and uncommitted; this record was reproduced offline with `summarize`.
- The Trello comment was posted on 12 Nov 2026 (16:32-16:35 Madrid time).

## Next steps

1. A dry run or differential of the producer to measure `changedShare`.
2. Document and verify the Workflow step limits and the EPG-path round-trip time.
3. A durable cursor/fingerprint and failure results for the producer; only then choose the per-run limit (steps 3-5 of the owner's 12 Nov decisions). Nothing here authorizes any of them.
