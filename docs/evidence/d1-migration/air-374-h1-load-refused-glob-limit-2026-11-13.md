# AIR-374 H1 load refused by the D1 LIKE and GLOB pattern limit (13 Nov 2026)

**Capture:** 13 Nov 2026, about 00:30 to 00:40 UTC. Read-only snapshot of three R2 keys and eight D1 tables, a read-only preflight, one projector lease taken and left to expire, and one batch sent twice with no row written. Counts and digests only; no row, id, title or private plan is recorded here.

## What was read

- R2 (read-only, `HEAD`, conditional `GET`, `HEAD`; ETags unchanged): `letterboxd/admissions/verified-films.json` 175,465 bytes sha256 `10e73da90e4a92c54b28633424ef6193bdc20e74f9e1dd11c015a400323b745f`; `enrichment/view-index.json` 9,902,291 bytes sha256 `05b37e1addbe02ec9262f447a8b433d8bf28314deb05c70367ebd9996f494568`; `identity/tmdb-retirements.json` 1,846 bytes sha256 `c8aa44c218794edd001eeb9b7073d9cb1c5816b90d85748e9094003de7adfea6`.
- D1 `iptv` through the connector (`SELECT` only): schema 19, marker `prepared` / `open` / 1, baseline `verified` with reference `cutover_accepted/v2:732b9768abcd3b0c2c460a9b0766b25aa1fbe472daed7a93393dbbe073a97cb5`, projector window `idle`, projector and Discovery leases free; `film_external_id` 10,907, `film_redirect` 10, `film` 10,105, `person` 53,880, the three target tables and the four receipt tables 0. Narrow copy of the eight tables (one pass, `cursor: null`).
- Offline plan from `main` `e6441d7`: `plan` twice with the same digest `2b5329d88a32af41f1cd4bc61e34b750615e365ba1b747f1680d3d4f8d33b8c2` (`ok`, 708 / 398 / 4 = 1,110 rows in 29 batches, retention skipped `noFilm` 3), `verify-plan`, `verify-private-plan --lease-id` and `verify-emitted` (batch set digest `20f5d96f07b9c9ca6202f3d3e671fa1c45274ea47807ad12bdf78edd7ee77c3b`) all `ok`.

## What happened

Preflight and the held pass passed and the projector lease was taken (`changes` 1). The first batch (index 0, 40 `film_rated_admission` rows, digest `df879921…55e63`) was sent through D1 REST once and failed with HTTP 400, `success: false`, error code 7500 `LIKE or GLOB pattern too complex: SQLITE_ERROR`; an identical second send under a further owner GO failed the same way. Read afterwards: the three target tables 0 rows, the lease held until its expiry. No other batch was sent. The lease was left to expire (00:54:10 UTC, before the next `:00` tick).

## Cause

D1 refuses to evaluate a `LIKE` or `GLOB` pattern over 50 bytes: a constant `SELECT` with a 51-byte pattern fails and a 50-byte one runs (observed through the connector, no table touched). The `CHECK` of `verified_at` and `observed_at` in migrations `0014` and `0015` is a 92-byte `GLOB`; `CREATE TABLE` accepted it, so the four tables `film_localization_source`, `person_localization_source`, `film_rated_admission` and `film_retention` can take no INSERT on D1. All four are empty. Migration `0020` (not applied) carried seven 77-byte patterns. `0016`, `0019` and every other migration have none over the limit.

## Consequence and next step

H1 cannot load `film_rated_admission` (708) or `film_retention` (398) on the current schema through any channel; `tmdb_retirement_decision` (4) has no long pattern. Fix: `0020` rewritten in place (unapplied) and a new `0021` that rebuilds the four empty tables ([runbook](../../runbooks/film-person-0021-apply.md), `tests/migration-pattern-limit.mjs`). Nothing was applied. The snapshot and plan above stay valid only for the same sources and state; the H1 plan is rebuilt under its own GO after the applies.

## Limitations

The D1 limit was established with constant `SELECT`s and the refused batch, not with the documentation. The DDL of `0021` has not been run on D1. Whether the projector or another writer ever inserts into the two localization tables on D1 was not examined (both are empty).
