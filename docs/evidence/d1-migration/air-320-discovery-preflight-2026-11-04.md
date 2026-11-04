# AIR-320 discovery schema preflight, 4 November 2026

**Captured:** 2026-11-04 12:20:09 UTC (13:20 Europe/Madrid). Production D1 database `iptv` and R2 bucket `iptv`. Read only. No owner GO for schema apply was given, and none was used.

**Scope:** one `scripts/discovery-production.mjs --target iptv`. It checks whether a later `--apply` would see a complete version 10 with no discovery tables. It does not send `0011`, import a ledger, hold or seal a marker, or start EPG, discovery or TMDB.

## Method

The command describes database `iptv`, then sends `SELECT` statements only. Each read refuses a response whose `rows_written` is not 0. It also `GET`s the Time Travel bookmark and does not call restore. R2 uses `HEAD` for `epg/discovery-latest.json` and for the published generation's `discovery-latest.json`. It `GET`s `sync.json` and `epg/resolver-lease.json`, both small. It does not download the ledger. The query responses carried no bookmark of their own. The Time Travel bookmark prefix is `0000016f-000`. The full bookmark is not recorded.

## Read

| Check | Result |
| --- | --- |
| Operator | `writes` false, `writeState` none, `rowsWritten` 0, `decision` `apply` |
| `schema_contract.version` | 10 |
| Prerequisite tables | 26 present |
| Authority rows | 4 present |
| Discovery tables | 0 |
| Discovery marker | absent |
| Ratings marker | `d1` / `open`, generation 12 |
| Published EPG | `d1` / `open`, generation 2, watchlist generation 2, programme `00ff34fa-e518-4ac7-ae63-b2e46f803503` |
| Owner reviews | `d1` / `writes` `open`, generation 1 |
| Predictions | `d1` / `writes` `held`, generation 2382, queue generation 173, profile generation 0 |
| Metadata cache | `d1`, generation 34 |
| Sync, resolver lease, enrichment projection | idle |
| Shared discovery ledger | present, 45,040,540 bytes, etag prefix `d6961603ec4d` |
| Generation copy | present, 45,040,540 bytes, same etag prefix |
| Ledger bodies | not downloaded |

`decision` `apply` means this snapshot matches the operator's predicate. It is not a statement that the migration was sent.

## Verdict

**PREFLIGHT MATCHES THE APPLY PREDICATE.** Version 10 is complete, discovery tables are absent, and the sampled writers were idle. `--apply` was not run. Prediction `writes` `held` was only read.

**Limits.** One sample, not a fence held across a later apply. The recorded etag is a 12-character prefix, so this note does not prove the two objects' full etags are equal; the sizes are equal and the prefixes match. A same-programme ledger replace that starts from an empty active ledger and dies before any row is written is still not taken over after the lease expires. The publish handoff uses a new programme id and is outside that case. That recovery gap stays open until a later change, and it is not a reason this read wrote anything.

**Not done.** Schema apply, import, hold, seal, activation, revert, a discovery or EPG run, and a prediction hold release. A code deploy does not apply `0011`.
