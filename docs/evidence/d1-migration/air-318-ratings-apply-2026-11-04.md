# AIR-318 ratings schema apply, 4 November 2026

**Captured:** 2026-11-04 06:48:45–06:48:47 UTC (07:48 Europe/Madrid). Production D1 database `iptv`. One owner GO, given in chat at 07:45 Europe/Madrid, covered `scripts/ratings-domain-production.mjs --apply --confirm apply --target iptv` only. Loading the ratings objects, holding the marker, and opening `cutover` were not included and were not run.

**Scope:** move a complete schema v9 to v10 and insert the ratings marker at `mode` `r2`, `cutover` `open`, generation 0. Not an import, not an authority flip, not an owner-review, prediction, published-EPG, metadata-cache or discovery write, and not an R2 write.

## Method

The production entry reads `migrations/0010_ratings_authority.sql` and sends it as one D1 HTTP `POST /query` body `{sql}` to `https://api.cloudflare.com/client/v4`. That REST body is not a Worker binding `batch`. The database name was `iptv` and the opened uuid matched the production constant.

An earlier invocation at 06:46:54 UTC exited `migration_refused` before any write. The operator's splitter treats an apostrophe as a quote and then looks for the word `commit`. The header comment said `this file's` and `same commit`, so the file looked like one statement and was refused. The read-back after that refusal was still schema v9, with no ratings tables and `batches` 0. The comments were then changed to `the prerequisite in this file` and `same batch`. The SQL with comments removed is the same text as `origin/main` `ac321c072792b2fc740fea1d4d942a0696bd5528`. The operator then accepted nine statements. That request was sent once. The operator returned `writeState` `committed`.

Immediately before the request the same process read version 9, all four ratings tables absent, and idle writers for sync, the resolver lease, the enrichment projection lease and `letterboxd/ratings/run.json`. The same window's neighbour read was: owner reviews `d1` / `writes` `open` / generation 1 / 7 rows; predictions `d1` / `writes` `held` / generation 2352 / queue generation 163 / profile generation 0; published EPG `d1` / `open` / generation 2 / watchlist generation 2; metadata cache `d1` / generation 34. No Time Travel bookmark was read, and Time Travel restore was not called.

The nine statements do not copy a fact, diary, run or queue. They insert `ratings_domain_authority` as `mode` `r2`, `cutover` `open`, generation 0, and set the contract to version 10 only while the stored version is at least 8 and below 10.

## Read-back

A separate read-only query after the operator returned. That query sent no write (`batches` 0).

| Check | Result |
| --- | --- |
| `schema_contract.version` | 10 |
| Ratings tables | `ratings_domain_authority`, `ratings_domain_cas`, `ratings_document`, `ratings_view` |
| Marker | `mode` `r2`, `cutover` `open`, generation 0 |
| `ratings_domain_cas.ok` | 1 |
| `ratings_document` rows | 0 |
| `ratings_view` rows | 0 |
| Owner reviews | still `d1` / `open` / generation 1 / `mirror_generation` 1 / 7 rows |
| Prediction marker | still `d1` / `held` / generation 2352 / queue generation 163 / profile generation 0 |
| Published EPG marker | still `d1` / `open` / generation 2 / watchlist generation 2 |
| Metadata cache marker | still `d1` / generation 34 / mirror generation 34 |
| Operator status | `writes` false, schema 10, marker `r2` / `open` / generation 0 |

## Verdict

**Schema apply holds.** Version 10, empty ratings tables, marker `r2` with `cutover` `open`. Facts, the diary, the ratings run and the removal queue stay in R2. The persistence arrow and the ratings-sequence note stay not live.

**Not done by this apply.** Load, hold, seal, release and revert are separate. A code rollback does not drop the tables, does not return the version, and does not change the marker. Restoring the database is a Time Travel of the whole database and is its own approval.

**Limits.** One refused attempt with no write, then one committed request, then one read-back. No Worker route was called. The REST `{sql}` body is not proof of Worker-binding atomicity; the read-back is the proof that these nine statements landed.
