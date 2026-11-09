# D1 enrichment projector: checkpoint reconciliation by buckets (offline benchmark and equivalence)

**Captured:** 2026-11-09, offline (in-memory SQLite and the real projector code) plus two read-only D1 `SELECT`s of the production `projection_state`. No manual projector, Discovery or EPG run, no flag, Task, cron, lease, window or budget change, no production write.
**Scope:** [AIR-395](https://trello.com/c/RbPf1nPj), the part that removes the read of every checkpoint from the hourly diff (`diff.storedRead`: 31,772 to 32,691 rows, 6.4 to 11.2 s in the four [AIR-392](air-392-projector-pre-write-overhead-2026-11-09.md) runs). It measures what crosses the D1 binding, not D1 or network latency, and it does not measure the effect on a production run.
**Verdict:** **EQUIVALENT BY TEST, TRANSFER REDUCED ONLY WHILE THE BACKLOG IS SMALL.** The bucket path gives exactly the plan, writes and final D1 state of reading every checkpoint in all tested cases (first import, steady state, change, new Film, deletion, restoration, a stored `absent` entity, stale and corrupt checkpoints, a tight budget). For a 32,100-entity table it moves 6,679 digest rows instead of 32,100 rows when nothing changed, 6.9 to 7.8 thousand rows for 0.1 to 0.5 % changed entities and 10.9 thousand at 2 %; above 20 % changed entities, and while the view has far more entities than the table has rows (the state of production on 2026-11-09), it reads the whole table as before. **The gain therefore appears once the backlog has drained.**
**Used by:** [ADR 0056](../../adr/0056-d1-enrichment-write-through.md) (the change keys and the diff), [ADR 0106](../../adr/0106-bulk-projector-write-path.md) (the per-window overhead the diff represents).

## The method

The diff needs one answer per entity of the view: does D1 already hold this entity's fresh change key? Today D1 ships every stored key to the Worker. D1 can summarize them where they are: a `GROUP BY` over the 33,000 rows measured **35 to 49 ms** of SQL time in production (two read-only `SELECT`s on 2026-11-09, `rows_read` about 65,000), so the 6 to 11 s of `diff.storedRead` is the transfer and serialization of the rows, not the scan.

- **Buckets.** An entity's bucket is its kind and a multiplicative hash of the last four characters of its id, modulo 4,096 (the same integer arithmetic in SQL and in JavaScript). A first version used the last two characters; the benchmark showed numeric tmdb ids falling into about 100 buckets of 240 rows, so that 0.5 % changed entities already pulled 57 % of the table, and it was replaced.
- **Digest.** Per bucket D1 returns the number of stored keys that are not `absent` and two sums of 32-bit slices of the hash part of the key (the last 28 characters of `<version>:<text length>:<two 53-bit hashes in hex>`, see `projectionKey`). The Worker computes the same from the fresh keys. A bucket whose count and both sums agree holds exactly the view's entities with their fresh keys and no other live entity.
- **Differing buckets only** are read row by row (statements of up to 90 buckets, at most six at a time, `IN` over the same hash expression), and the **unchanged** `d1EnrichmentPlan` runs over the view entities of those buckets and the rows read. A stored `absent` row is left out of the sums, so an entity stored as `absent` always makes its bucket differ; held Films and the absent detection behave as before because every stored row of a differing bucket is read.
- **Fallbacks to reading the whole table (the previous, paged read):** a view below 5,000 entities (every test and a young database), a view with far more entities than the table has rows (`missing` above 25 % of the buckets: each never-stored entity makes a bucket differ, so the digest cannot gain), more than 40 % of the buckets differing, or a fresh key too short for the slices. No new flag, schema, index, writer, cron or window; the `projection_state` format is unchanged.
- **Risk accepted by the owner (2026-11-09, on AIR-395):** the sums are a checksum, not an exact comparison. A changed entity is missed only if its new key has the same two 32-bit slices as the old one: about 2^-64 for one change, since the slices come from a 106-bit hash. A miss leaves that entity's D1 rows stale until its key next changes or the checkpoints are rebuilt.

## What the tests prove (`tests/d1-enrichment-buckets.mjs`, offline)

- The SQL and the JavaScript compute identical bucket sums on 400 keys of the real shape and ids of several forms; the `absent` row is excluded; a key too short for the slices is not summed.
- Whole-table run and bucket run give the same summary (`changedFilms`, `changedPeople`, `absent`, `written*`, `released`, `remaining`, `stored`, `admittedFirst`) and the same final D1 state (Films, Persons, credits, watchlist rows, `projection_state`) at every step: first import, steady state, one title changed, a new Film with a roster change, two Films deleted, the same two restored, a live Person stored as `absent`, a stale Person and a stale Film checkpoint that no source lists, a corrupt stored key, a stored key of the right shape and another value.
- Steady state reads no row; a one-title change reads a few buckets (`diff.checkpointRows` under a quarter of the table); the digest is one query; `summary.stored` equals the table count.
- A tight budget converges to exactly the state of one unconstrained run.
- Three deliberate defects make the test fail: entities not filtered to the differing buckets, buckets that exist only in D1 ignored, `absent` rows not excluded from the sums.

## Offline benchmark (`scripts/projector-checkpoint-bench.mjs`)

The real `d1EnrichmentCheckpoints` and its SQL on an in-memory SQLite shaped like production: 28,700 Persons and 3,400 Films (32,100 entities, tmdb and slug ids, keys of the real format), for several shares of changed entities. `rowsAcrossBinding` counts the rows the Worker would receive; the whole-table read receives 32,100.

| Scenario | Path | Queries | Rows across the binding | Buckets differing of 6,679 | Digest, JS plus SQLite ms (offline) |
| --- | --- | --- | --- | --- | --- |
| nothing changed | buckets | 2 | 6,679 | 0 | 103 |
| 0.1 % changed | buckets | 4 | 6,878 | 28 | 105 |
| 0.5 % changed | buckets | 5 | 7,844 | 156 | 118 |
| 2 % changed | buckets | 9 | 10,944 | 595 | 138 |
| 5 % changed | buckets | 19 | 16,325 | 1,381 | 103 |
| 20 % changed | full (more than 40 % differ) | 9 | 38,779 | 3,782 | 97 + whole read |
| 50 % changed | full | 9 | 38,779 | 5,487 | 103 + whole read |
| production backlog (a third of the view never stored, 5 % of the rest changed) | full (`skipped: backlog`) | 6 | 21,388 | not asked | none |

Reading the table: the bucket path moves about a fifth of the rows when nothing or little changed (5 times fewer at 0 %, 4 times at 0.5 %, 3 times at 2 %); at 5 % it is half, and above the share where it would not gain it reads the whole table, paying the digest once (6,679 rows, about 20 % more transfer) when the changed share is between 20 and 40 % of the buckets. In the state of production on 2026-11-09 (the view has about 48,500 entities, the table about 32,700 rows, so a third of the view was never stored) the backlog check reads the whole table straight away and the digest is not asked for.

## What this does not show, and what must be read from natural runs

- **No latency.** The offline stand-in has no D1 or network. The AIR-392 runs say the cost of 32,000 rows is 6 to 11 s; this evidence assumes that cost scales with the rows moved, which the AIR-395 interim paged read (merged, `dd1bf38`) tests first. If the paged read shows no gain, that assumption weakens and the digest's gain is a prediction only.
- **No effect while the backlog lasts.** Production has about 4,700 changed Films and 12,600 changed Persons and a third of the view not yet stored: the run reads the whole table. The first natural runs after this code is deployed will show `checkpointMode: full` with `skipped: backlog`, and the digest path starts when the backlog has drained. The acceptance on natural runs is `diff.checkpointDigest` and `diff.checkpointRows` replacing `diff.storedRead` once `checkpointMode` is `buckets`, with the run's plan unchanged.
- **Skew and Discovery bursts.** The synthetic ids are uniform enough that 6,679 buckets hold about 5 entities each; a real day with clustered changes reads more buckets per change.
- **The digest's D1 cost** (about 100 ms offline, 35 to 49 ms measured for a simpler aggregate in production) is expected to stay far below the transfer it replaces; that is also read from natural runs.

## STOP and rollback

Revert the code by the ordinary PR if a natural run shows a plan different from the whole-table read (a changed or absent entity found by neither), a rise of `diff.*` time over the AIR-392 baseline, or a query count that limits the 800-query budget. The revert does not touch data (the format is unchanged).
