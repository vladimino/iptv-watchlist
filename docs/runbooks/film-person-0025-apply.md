# Film/Person migration 0025: owner GO, apply preconditions, readback and rollback contract (applied)

**Status:** applied to production D1 `iptv` on 19 Nov 2026 (about 07:05-07:08 UTC) as one execution after the owner GO; schema version 25, empty `film_retention_scan`, four triggers, `film_retention` and the Film/Person marker unchanged ([apply record and readback](../evidence/d1-migration/air-532-0025-apply-2026-11-19.md)). Migration `0025_film_retention_scan_watermark.sql` ([ADR 0173](../adr/0173-watchlist-retention-observed-at-is-state-start.md), Proposed; [AIR-532](https://trello.com/c/mGPwomMX)). Merging and deploying the code applies nothing; the Worker never applies SQL files and CI applies nothing, so any other database needs its own explicit, operation-specific owner GO. The GO used on 19 Nov 2026 is spent and must not be reused. This page keeps the procedure and the contract; it authorizes nothing.

## What the migration is, and is not

- One file: a refuse-insert unless schema is a complete version 24 with the listed tables, `CREATE TABLE film_retention_scan` (STRICT, empty, one row at most), a monotonic and a no-delete trigger on it, **two guard triggers on `film_retention`**, and the version bump to 25. It writes no data row.
- It does not backfill or rewrite any `film_retention` row, does not touch `canonical_revision`, the receipts, the marker or the Film/Person authority.
- **The performance benefit is not active on code deploy alone.** It started with the production apply of 19 Nov 2026; before that the producer kept the previous behaviour (every newer scan rewrites `observed_at`, the expensive per-scan writes). Natural-run timing is still to be verified.

## Preconditions (checked before the owner GO is used)

1. `SELECT version FROM schema_contract WHERE id = 1` is 24 (the file refuses anything else), and the code that reads the watermark is already deployed (`main` contains `readRetentionWatermark`).
2. The Film/Person marker is `d1`/`open`; no Film/Person writer run is in flight (no EPG finalize and no `rated_admission_retention` slice running; read `epg_status` and the receipt table for `pending` rows of origin `rated_admission_retention`).
3. The signed GO names the live git blob of the file on `main`, the production D1 id and the exact statement (one execution), as for 0023.

## Readback after the apply

`SELECT version, note FROM schema_contract WHERE id = 1` is 25 with the v25 note; `SELECT COUNT(*) FROM film_retention_scan` is 0; `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'film_retention_scan%'` lists the four triggers (monotonic, no-delete, two guards on `film_retention`); `SELECT COUNT(*) FROM film_retention` and `SELECT mode, cutover, generation FROM film_person_authority WHERE id = 1` are unchanged. The first natural scan then writes the watermark row once.

## Inherited rows

Before this migration `film_retention.observed_at` was overwritten at every scan, so every existing row holds the **latest confirmation**, not the original transition time. The migration neither backfills nor reconstructs that history. After activation an inherited timestamp must not be read as "the state began then"; a row's `observed_at` is a known state start only once a later exit or re-add has written it. No analysis of "the longest stay on the watchlist" is valid from inherited rows.

## Rollback contract after the apply

A routine code revert (Worker back to a version that does not read `film_retention_scan`) is **safe**, because the ordering guard is in the database, not only in the code:

- The two guard triggers on `film_retention` abort any write that contradicts the stored boolean with an observation that is newer than the stored row but older than the watermark. The reverted producer would otherwise accept exactly that (the original P1 of the review). The abort fails the fenced batch closed: nothing is written, the producer raises `film_person_unavailable`, the slice stops.
- The reverted producer rewrites `observed_at` on every scan again (observations at or after the watermark are allowed) and does not advance the watermark. The watermark only lags; nothing is weakened, and row-level monotonicity still holds. Re-deploying the new code resumes from the stored watermark.
- Known limits, both fail closed or harmless: (a) a Film merge whose retired and surviving rows carry different booleans and an observation older than the watermark is refused by the guard (the merge needs an owner decision); (b) a late **first** observation of a Film that has no retention row is not covered by the guard (no confirmed state is overwritten; the new code refuses it in the plan).
- A rollback of the **migration itself** (dropping the table or the triggers, lowering the version) is not provided: `schema_contract_no_downgrade` forbids the version going down, and dropping the guard would reopen the hole. It needs its own owner-approved plan.
- Any data repair, hold or re-apply is a separate owner GO.
