# Lid-only admission row, migration 0048: prerequisites, window, readback and forward-only rollback (the apply needs its own owner GO)

**Update 28 Nov 2026:** 0048 applied to production D1 `iptv` within the AIR-603 window ([evidence](../evidence/d1-migration/air-603-window-apply-2026-11-28.md)); the status text that follows describes the preparation and is kept as history. **Status:** prepared on 27 Nov 2026 under [AIR-672](https://trello.com/c/ZRJlafiP) (step 3 of [ADR 0217](../adr/0217-source-independent-film-admission.md), step 7a of its delivery graph). The file is in the repository and **not applied**; a deploy applies nothing. Whether it has been applied is read live (`schema_contract`, `sqlite_master`) and from a dated evidence page, never from this paragraph. **This runbook authorizes no operation.** It is applied only in the owner's coordinated pending-migration window (AIR-648 and the exact schema chain), under its own action-specific owner approval. Applying it does not activate lid-only admission: that is ADR 0217 step 9, an owner L3 GO.

## Why

ADR 0217 (Accepted) lets a verified Letterboxd film page with a positively absent TMDB relation (H1) be admitted as the canonical Film `film:lb:<lid>`. Its durable, recomputable proof (K2) lives on one immutable row of `film_lid_admission`. The writer (`admitLidOnlyFilm`) and the coordinator kind (`lid_only`) are delivered dormant: they refuse before their first effect unless the admission marker is `d1` **and** this table exists (`admission_unavailable`). While the table is absent the TMDB-proved path is unchanged: its batch asserts that the table still does not exist.

## What the apply does, and does not

- **Does:** one execution of `migrations/0048_film_lid_admission.sql`: the empty STRICT table `film_lid_admission` (primary key `lid`), the triggers `film_lid_admission_immutable` (every column except `film_id` is frozen) and `film_lid_admission_keep` (no delete), and the version change 47 to 48.
- **Does not:** write any Film, claim, receipt or admission row, change a marker, a flag, a Task, any Worker code or an existing table, create `lid_recheck_intent` (a separate file of the attach step) or touch the evidence writer control. Offline proof: `tests/film-lid-admission-migration.mjs`, `tests/letterboxd-lid-only-admission-d1.mjs`.

## Prerequisites (checked immediately before the GO is used, not remembered)

1. `schema_contract` holds exactly one row, `id` 1, `version` `47`; `0047` (AIR-605) and every earlier file of the chain are applied, each under its own GO.
2. The objects the file's guard checks are present, read from `sqlite_master`: the tables `film_rated_admission`, `canonical_write_receipt` (its `CREATE` text names `operation_key`), `letterboxd_admission_authority`, `film_external_id`, `film_redirect`, the index `film_external_id_one_trusted`, the trigger `schema_contract_no_downgrade`, and no object named `film_lid_admission%`.
3. The GO names the live Git blob and SHA-256 of the file on `main`, the production D1 `iptv` and the exact execution path. If another migration landed first, this file was renumbered and re-pinned before merge; the GO names the merged number and predecessor version.
4. No other migration, import or cutover is in flight.
5. Before-state captured in the same window (read-only `SELECT`s): the `schema_contract` row; `SELECT COUNT(*) FROM film_rated_admission`; the admission marker mode and generation; the Film/Person marker.

## Expected cost (a measurement, not a threshold)

One `sqlite_master` row for the table and two triggers, the primary-key index, and the `schema_contract` update. The table is empty, and stays empty until the admission activation.

## The step

Execute the unchanged file once, as **one** atomic batch. Do not edit, split or blindly retry it. After a failed or unclear execution read the state back first and do not re-run: the file cannot run twice (it refuses anything but version 47).

## Readback (all must hold; record it in a dated evidence page under `docs/evidence/`)

- `schema_contract`: one row, `version` `48`, the v48 note.
- `film_lid_admission` exists, is empty, and `sqlite_master` lists both triggers.
- The counts and markers equal the before-state.

## Rollback

Forward-only. While the table is empty it may be dropped (with its triggers) by a separately approved step; a populated table is never dropped, and a wrongly admitted Film is corrected by an owner action under a later decision, never by a delete. A code revert is safe before and after the apply: the writer is dormant until the admission activation.

## Stop conditions

A wrong predecessor version or a missing guarded object (the file refuses and creates nothing), a second apply, a non-empty table found before the first activation, or any in-flight migration.
