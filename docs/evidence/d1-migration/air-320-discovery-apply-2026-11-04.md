# AIR-320 discovery schema apply, 4 November 2026

**Captured:** 2026-11-04 12:45:19–12:45:38 UTC (13:45 Europe/Madrid). Production D1 database `iptv`. R2 bucket `iptv` was headed and not written. One owner GO covered `scripts/discovery-production.mjs --apply --confirm apply --target iptv` only. Load, import, hold and activation were not included and were not run.

**Scope:** send only `migrations/0011_discovery_authority.sql` when the contract was a complete version 10 and every discovery table was absent. The inserted marker stays `mode` `r2`, `cutover` `open`, generation 0. No ledger, decision or catalog row is copied.

## Method

A read-only status immediately before the write matched the apply predicate: schema 10, 26 prerequisite tables, four authority rows, zero discovery tables, idle sync, resolver and enrichment-projection writers. The production entry then sent the migration as one D1 HTTP `{sql}` body. The database name was `iptv` and the opened uuid matched the production constant. The command was not sent a second time.

## Read-back

A separate read-only status at 12:45:38 UTC. That query sent no write.

| Check | Result |
| --- | --- |
| `schema_contract.version` | 11 |
| Marker | `mode` `r2`, `cutover` `open`, generation 0, both programme columns null |
| Discovery tables | 16 |
| `discovery_observation` rows | 0 |
| Operator decision | `already_applied` |
| Neighbour markers | ratings `d1` / `open` generation 12; published EPG `d1` / `open` generation 2; owner reviews `d1` generation 1; predictions `d1` / `writes` `held` generation 2388; metadata cache `d1` generation 34 |
| Bookmark prefix | `00000174-000` |

## Verdict

**Schema apply holds.** Production `iptv` has migration `0011`. Readers stayed on R2. A later load copied the ledger; a later activation opened the marker. Those are separate records.

**Limits.** One committed command, then one read-back. Ledger bodies were not downloaded. Time Travel restore was not called.
