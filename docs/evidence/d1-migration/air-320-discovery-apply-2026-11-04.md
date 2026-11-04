# AIR-320 discovery schema apply, 4 November 2026

**Captured:** 2026-11-04 12:45:19–12:45:38 UTC (13:45 Europe/Madrid). Production D1 database `iptv`. One owner GO, given in chat at 13:44 Europe/Madrid, covered `scripts/discovery-production.mjs --apply --confirm apply --target iptv` only. Import, hold, seal, activation, lease reset, a prediction hold release, and any EPG, discovery or TMDB run were not included and were not run.

**Scope:** move a complete schema v10 to v11 and insert the discovery marker at `mode` `r2`, `cutover` `open`, generation 0, null programme. Not a ledger import and not an authority flip. Neighbour markers were only read.

## Method

The operator files on the checkout matched `origin/main` `8a47790e6f51d6635a77d53bd742452584e390f7`, the merge of the reviewed head `74d5e254893c0023d30ba88fb7f25d77b0e4bc2a`. The production entry reads `migrations/0011_discovery_authority.sql` and sends its 29 statements as one D1 HTTP `POST /query` body `{batch}` to `https://api.cloudflare.com/client/v4`. The database name was `iptv` and the opened uuid matched the production constant. The request was sent once. `write_uncertain` was not retried.

Immediately before that request, at the same minute, `node scripts/discovery-production.mjs --target iptv` returned `writes` false, `rowsWritten` 0, `decision` `apply`, schema 10, 26 prerequisite tables, 4 authority rows and 0 discovery tables. Writers for sync, the resolver lease and the enrichment projection lease were idle. Time Travel bookmark prefix `00000174-000`. Time Travel restore was not called.

That preflight's neighbour read was: ratings `d1` / `open` / generation 12; published EPG `d1` / `open` / generation 2 / watchlist generation 2 / programme prefix `00ff34fa-e51`; owner reviews `d1` / `writes` `open` / generation 1; predictions `d1` / `writes` `held` / generation 2388 / queue generation 175 / profile generation 0; metadata cache `d1` / generation 34. The shared discovery object and the published generation's copy were both present, 45,040,540 bytes, etag prefix `d6961603ec4d`, and the pair was stable. Neither body was downloaded. Equal sizes and a 12-character etag prefix are not full-object parity and are not import evidence.

The 29 statements copy no ledger, decision or catalog row. They insert `discovery_authority` as `mode` `r2`, `cutover` `open`, generation 0, null programme, leave `discovery_transfer` idle, and set the contract to version 11 only while the stored version is 10 and the prerequisite holds.

## Read-back

The apply command returned `operation` `apply`, `writes` true, `writeState` `committed`, schema 11, `mode` `r2`, `cutover` `open`, generation 0, 16 discovery tables and 0 observations. Its `rowsWritten` field counts the read statements in that process and stayed 0; the migration itself is the committed batch. The process refused to return success unless the read-back was version 11, the marker was `r2` / `open` / generation 0 / null programme, the transfer was idle, observations were 0, and the five neighbour markers were unchanged.

A separate read-only status at 12:45:38 UTC sent no write (`writes` false, `rowsWritten` 0).

| Check | Result |
| --- | --- |
| `schema_contract.version` | 11 |
| Discovery tables | 16, `decision` `already_applied` |
| Marker | `mode` `r2`, `cutover` `open`, generation 0, programme null |
| Observations | 0 |
| Ratings | still `d1` / `open` / generation 12 |
| Published EPG | still `d1` / `open` / generation 2 / watchlist generation 2 |
| Owner reviews | still `d1` / `writes` `open` / generation 1 |
| Predictions | still `d1` / `writes` `held` / generation 2388 / queue 175 / profile 0 |
| Metadata cache | still `d1` / generation 34 |
| Writers | sync, resolver and projection idle |
| Discovery objects | still both present, same size and etag prefix, stable; bodies not read |

## Verdict

**Schema apply holds.** Version 11, empty discovery tables, marker `r2` with `cutover` `open`. The ledger, decisions and catalog admission stay in R2. The persistence arrow stays unused until a later activation sets `d1` / `open`.

**Not done by this apply.** Import, hold, seal, activation and revert are separate. The empty same-programme seal of an initially empty active ledger remains unresolved and blocks activation, not this empty schema. A code rollback does not drop the tables, does not return the version, and does not change the marker. Restoring the database is a Time Travel of the whole database and is its own approval. Prediction `writes` `held` was only read.
