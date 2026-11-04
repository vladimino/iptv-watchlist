# AIR-318 ratings load, 4 November 2026

**Captured:** 2026-11-04 07:44:41–07:48:13 UTC (08:44–08:48 Europe/Madrid). Production D1 database `iptv` and read-only R2 bucket `iptv`. One owner GO, given in chat at 08:41 Europe/Madrid, covered `scripts/ratings-domain-production.mjs --load --confirm load --target iptv` only. Holding the marker, sealing it, reverting it, and starting a Ratings Task were not included and were not run.

**Scope:** copy the mutable ratings objects into `ratings_document`, rebuild `ratings_view` from the film records, and advance `generation` from 0 to 1. `mode` stays `r2` and `cutover` stays `open`. Not an authority flip and not an R2 write.

## Method

A read-only preflight at 07:44:09 UTC found schema 10, marker `r2` / `open`, generation 0, 0 document rows and 0 view rows. The same read listed the bucket and counted 475 mutable ratings keys. Sync, the resolver lease, the enrichment projection lease and `letterboxd/ratings/run.json` were idle. The prediction marker was `d1` / `writes` `held` / generation 2358 / queue generation 165 / profile generation 0. The load command does not read that flag, and this run did not release the hold.

The production entry then listed those keys again, read each object, and called `importDocuments` with `confirm` `load`. Each fenced unit is one D1 HTTP `POST /query` body `{batch}`. That REST body is not a Worker binding `batch`. The database name was `iptv` and the opened uuid matched the production constant. The command returned `writeState` `committed`, `mode` `r2`, generation 1, and 475 documents. It was not sent a second time.

## Read-back

A separate read-only query at 07:48:39 UTC. That query sent no write (`batches` 0). Operator status afterwards also reported `writes` false.

| Check | Result |
| --- | --- |
| `schema_contract.version` | 10 |
| Marker | `mode` `r2`, `cutover` `open`, generation 1 |
| `ratings_document` rows | 475, and 475 distinct keys |
| `ratings_view` rows | 891 |
| `ratings_domain_cas.ok` | 1 |
| Owner reviews | still `d1` / `open` / generation 1 / `mirror_generation` 1 / 7 rows |
| Prediction marker | still `d1` / `held` / generation 2358 / queue generation 165 / profile generation 0 |
| Published EPG marker | still `d1` / `open` / generation 2 / watchlist generation 2 |
| Metadata cache marker | still `d1` / generation 34 / mirror generation 34 |
| Operator status | `writes` false, schema 10, marker `r2` / `open` / generation 1 |

## Verdict

**Load holds.** 475 documents and 891 view rows are in D1. The marker is still `r2` with `cutover` `open`, so readers and the Ratings Task stay on the R2 objects. The persistence arrow and the ratings-sequence note stay not live.

**Not done by this load.** Hold, seal, release, revert and a Ratings Task run are separate. A code rollback does not drop the rows and does not change the marker. Restoring the database is a Time Travel of the whole database and is its own approval.

**Limits.** One committed command, then one read-back. No Worker route was called. The count of `{batch}` requests inside the command was not recorded. The read-back is the proof that generation 1, 475 document rows and 891 view rows are what landed.
