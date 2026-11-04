# AIR-318 ratings activation, 4 November 2026

**Captured:** 2026-11-04 07:56:07–08:02:46 UTC (08:56–09:02 Europe/Madrid). Production D1 database `iptv`. R2 bucket `iptv` was read and not written. One owner GO, given in chat at 08:54 Europe/Madrid, covered `scripts/ratings-domain-production.mjs --activate --confirm activate --producers-drained --target iptv` only. Revert and a Ratings Task were not included and were not run.

**Scope:** compare the loaded documents with the current R2 objects, set `mode` `d1` and `cutover` `held`, re-read R2, and seal `cutover` `open` at generation 1 when the bytes still match. This is the authority flip for the mutable ratings documents. Events, archive receipts, ZIP bytes and HTML snapshots stay in R2.

## Method

A read-only preflight at 07:55:57 UTC found schema 10, marker `r2` / `open`, generation 1, 475 document rows and 891 view rows. Sync, the resolver lease, the enrichment projection lease and `letterboxd/ratings/run.json` were idle. The prediction marker was still `d1` / `writes` `held` / generation 2358 / queue generation 165 / profile generation 0. This command does not read that flag, and this run did not release the hold.

`--producers-drained` is the acknowledgment on this command that the checked writers stay stopped for the command. The script samples those four writers once before it reads the objects. It does not stop a Scheduled Task. The Ratings Task is expected at 17:30 Europe/Madrid and was not running in this sample.

The production entry then read the mutable ratings objects, compared them with the stored rows, and sent the hold and the seal as D1 HTTP `POST /query` bodies `{batch}`. That REST body is not a Worker binding `batch`. The database name was `iptv` and the opened uuid matched the production constant. The command returned one result: `writeState` `committed`, `mode` `d1`, `cutover` `open`, generation 1. It was not sent a second time. The read-back did not observe the intermediate hold.

## Read-back

A separate read-only query at 08:02:59 UTC. That query sent no write (`batches` 0). Operator status afterwards also reported `writes` false.

| Check | Result |
| --- | --- |
| `schema_contract.version` | 10 |
| Marker | `mode` `d1`, `cutover` `open`, generation 1 |
| `ratings_document` rows | 475, and 475 distinct keys |
| `ratings_view` rows | 891 |
| `ratings_domain_cas.ok` | 1 |
| Owner reviews | still `d1` / `open` / generation 1 / `mirror_generation` 1 / 7 rows |
| Prediction marker | still `d1` / `held` / generation 2358 / queue generation 165 / profile generation 0 |
| Published EPG marker | still `d1` / `open` / generation 2 / watchlist generation 2 |
| Metadata cache marker | still `d1` / generation 34 / mirror generation 34 |
| Operator status | `writes` false, schema 10, marker `d1` / `open` / generation 1 |

## Verdict

**Activation holds.** The ratings marker is `d1` with `cutover` `open` at generation 1. Readers and writers of the mutable ratings documents use D1 and do not fall back to R2. The R2 objects are not updated by those writers. The persistence arrow and the ratings-sequence note are the live path. Their labels changed in the same delivery and need a fresh rendered owner visual approval. The previously approved labels said the path was not live.

**Not done by this activation.** Revert and a Ratings Task run are separate. A code rollback does not drop the rows and does not return the marker to `r2`. Returning an open marker to `r2` is `--revert --confirm r2` after the copy back to R2, and is its own approval. Restoring the database is a Time Travel of the whole database and is its own approval.

**Limits.** One committed command, then one read-back. No Worker route was called. The intermediate hold was not read back on its own. The count of `{batch}` requests inside the command was not recorded.
