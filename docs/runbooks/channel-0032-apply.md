# EPG Channel migration 0032 and the first Channel import: owner GOs, preconditions, readback and rollback (proposed, not applied)

**Status:** proposed L3 plan for [AIR-563](https://trello.com/c/TzDy1d4b). Nothing here is applied or authorized. Production D1 `iptv` was on schema 31 on 21 Nov 2026 14:xx UTC (read-only check: one `schema_contract` row, the v30 and v31 tables present, no `epg_channel*` table, `published_epg_authority` `d1`/`open`). Contract: [EPG Channel](../reference/domain/epg-channel.md), [ADR 0187](../adr/0187-epg-channel-authority.md). Page: [Channel management](channel-management.md). Two separate owner GOs follow; the first import is not covered by the schema GO.

## What this does, and does not

- **Holdpoint 1, schema:** one execution of `migrations/0032_epg_channel_authority.sql` (4 STRICT tables, 2 indexes, one trigger guard, two seed rows, version 31 to 32). It refuses on anything but a complete version 31 before a table is created. It writes no Channel row, no marker and no mode: there is no authority switch to flip.
- **Holdpoint 2, first import:** the owner loads the playlist through `/admin/channels` (revision 0 to 1), after the schema readback.
- **Neither** makes any scan read the policy. `scanEPG()`, Discovery, TMDB, Tasks, flags, Access and the EPG generation are untouched; the policy stays staged until the reader of [AIR-564](https://trello.com/c/omIQl2Lh). The migration after this one, `0033` (Letterboxd Sync, AIR-570/571), requires a complete version 32 and is a separate GO.

## Holdpoint 1: schema 0032

**Preconditions, checked immediately before the GO is used (not remembered):**

1. `SELECT version FROM schema_contract WHERE id = 1` is `31`, with exactly one `schema_contract` row, and `watchlist_authority`, `watchlist_cas` and `watchlist_current` exist (the file refuses otherwise).
2. No `epg_channel*` table exists (a second apply is refused anyway).
3. `main` contains the Channel admin route and the deploy of that commit succeeded (the page then answers "schema absent" and writes nothing; after the apply it works). The GO names the live git blob of `migrations/0032_epg_channel_authority.sql` on `main` (blob `f48b66a454eae3da9fb426b96a642be3bf325d68` on `eb882a3`; recheck it), the production D1 id and the exact statement: one execution of the whole file, no per-statement retry.
4. No other migration apply is in flight (`0033` and every later file stay unapplied).
5. Before-state captured in the same window: `SELECT version, note FROM schema_contract WHERE id = 1`; `SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'epg_channel%'`; `published_epg_authority` mode, cutover, generation; and the row counts of `published_epg_show`, `discovery_observation_show` and `discovery_decision`-class tables to prove they do not move.

**Stop conditions:** version not 31, a Channel table already present, a failed or partial execution (read the state back before anything else; do not re-run blindly), or any drift in the preconditions.

**Readback after the apply:** `version` is `32` with the v32 note and one `schema_contract` row; `epg_channel_revision` has one row at revision 0, `import_revision` 0, `category_count` 0, `channel_count` 0; `epg_channel_cas` has one row `ok = 1`; `epg_channel_category` and `epg_channel` are empty; four tables and two indexes exist; the no-downgrade trigger exists; `published_epg_authority` and the before-counts of the show and Discovery tables are unchanged; `GET /api/admin/channels` answers `available: true`, `revision: 0`, `empty: true`. Record it in `docs/evidence/d1-migration/` as a sanitized dated record.

## Holdpoint 2: first import (a separate owner GO)

**Preconditions:** the schema readback above is recorded and the snapshot is empty (revision 0); the owner names the playlist file and the group policy map; the page is the one deployed from `main`.

**Procedure (owner, in the browser):** open `/admin/channels`, choose `playlist.m3u8`. The file is parsed in the browser and a file with any entry lacking `tvg-id`, an orphan `#EXTINF`, an unsafe value or a truncation is blocked, not partly imported. Set the policy of each group by **group name** (the owner's rule: categories 3 to 8 are `discover`, the other 29 groups `deny_all`; the page lists groups in first-seen order, so confirm the mapping by name against the owner's list, not by position). Run "Проверить разницу" and compare before confirming. Confirm once.

**Acceptance (live readback, never asserted from the baseline):** the preview and the receipt agree on channels and categories; `epg_channel_revision` is revision 1 with a non-null `plan_sha256` and `source_sha256`; row counts by category and by effective policy; no row with a category key missing from `epg_channel_category`; no channel left without `source_id` unless it is XMLTV-only; the before-counts of the show and Discovery tables are unchanged; the receipt id is recorded. The offline baseline (35 groups, 2 103 M3U ids, 1 355 XMLTV channels, 1 340 matching ids, 2 118 expected records) is a dry-run reference, not an invariant; any mismatch is reported, not adjusted.

**XMLTV-only channels:** the import page takes only the playlist, so the XMLTV-only channels (15 in the baseline) are **not** registered by it; they read as an id the snapshot does not know, which is `known_only`, the same effective policy as an unclassified channel. The planner supports registering them (`xmltvChannels`), but a page input for the XMLTV channel list is not delivered. Whether to accept 2 103 records with those 15 unregistered, or to deliver that input before the import, is an owner decision.

## Rollback and recovery

A code revert changes no D1 data: the tables stay and nothing in a scan reads them. There is no automatic undo of a schema apply and the version never goes down (the no-downgrade trigger). The channel tables are unreferenced by any scan, so leaving them in place is harmless; the page fails closed if they are removed. Undoing imported data is a new import of the previous playlist (a new revision) or clearing owner decisions on the page; dropping the four tables needs a named compensating migration under its own GO. A whole-database restore ([D1 time travel](recovery/d1-authority-and-time-travel.md)) also discards every other write since the point and is not a Channel rollback.
