# ADR 0070: Metadata sync freshness clocks are projected into D1 by the existing enrichment projector

**Status:** Proposed  
**Original decision date:** 2026-10-31  
**Recorded at:** 2026-10-31  
**Approval source:** pending owner decision  
**Related work:** [AIR-311](https://trello.com/c/81P7wg4u), [PR #291](https://github.com/vladimino/iptv-watchlist/pull/291), [ADR 0056](0056-d1-enrichment-write-through.md)  
**Supersedes:** None  
**Superseded by:** None

## Context

`metadataSync` decides what to fetch from Letterboxd by reading `metadata.json` in R2. A film is pending when `metadataAt` is missing, `peopleVersion` is not 1, `peopleNamesVersion` is not 2, `synopsisFetchedAt` is missing, or `metadataAt` is older than 30 days. A record that is fresh and already has `synopsisFetchedAt` skips the page, except that `peopleNamesVersion` other than 2 still localizes names. A fresh record without `synopsisFetchedAt` fetches the page for the synopsis only and stamps `synopsisFetchedAt`. Anything else replaces the cache record. `peopleLocalizedAt` is written when the name attempt finishes; the branch does not read it back.

Schema v4 stores `people_version` on `film_metadata` and one `updated_at`. That `updated_at` is `metadataAt`, or else `updatedAt`, or else `synopsisFetchedAt`. A synopsis-only stamp therefore looks like the metadata clock. `peopleNamesVersion`, `peopleLocalizedAt` and `synopsisFetchedAt` are not columns. An absent `metadata.json` entry and an entry whose clocks are null are not distinguished once the row is missing.

Reviewed titles and reviewed names are already stored. `film_dimension` and `person_dimension` keep a reviewed value ahead of a later automatic one. `titles.json` and `people.json` are inputs to that localization. Copying those names back onto the film would repeat a shadow of R2.

[ADR 0056](0056-d1-enrichment-write-through.md) already projects the enrichment domain from a Worker cron. The owner rejected running that projector at the end of `metadataSync`. The cron reads R2 and writes D1. It does not write R2. Production schema is v4 and `D1_ENRICHMENT_WRITE=on`. A code deploy must not start a new writer, and it must not make the v4 projector report schema false.

## Decision

1. **One new table, four clocks.** Migration `0005_film_sync_state.sql` adds `film_sync_state`, keyed by `film_id`, and sets `schema_contract.version` to 5. The columns are `metadata_at`, `synopsis_fetched_at`, `people_names_version` and `people_localized_at`. No other metadataSync field is added. `people_version` stays on `film_metadata`. Names, titles and the 30-day window are not stored. The window remains `METADATA_FRESH_MS` in the domain code.
2. **Absent and null stay different.** No row means `metadata.json` has no entry for that Film. A row with a null clock means the entry exists and that clock is missing or empty. `people_names_version` is the integer from the entry, or null when the value is not an integer. Only the integer 2 means the name attempt finished. Strings are stored as `metadata.json` wrote them.
3. **The existing projector writes the rows.** There is no second cron and no new flag. After a consistent R2 read, the projector compares a separate change key (`projection_state` projection `metadata_sync`, kind `film`) with the four clocks. The enrichment film change key is unchanged, so a schema v4 database does not rewrite its Films because these fields exist on the input. A clock that does not move the film key is written in its own fenced batch. A film that is already being written takes the sync row in that same batch. A failed batch leaves the old key. The next run reads R2 again, so a newer `metadata.json` replaces a stale D1 row and a failed attempt cannot put the old clocks back into R2.
4. **Schema gate.** The sync write runs only when `schema_contract.version` is 5 and `film_sync_state` exists. Version 4 keeps the current projector, including `projector.schema: true` on `/api/d1/status`. Version 5 without the table is `schema: false`, and the Film and Person writes continue. A table without the version bump is ignored. Applying `0005` to production is a separate owner approval. This record does not apply it, does not change `D1_ENRICHMENT_WRITE`, and does not change the cron.
5. **Tombstones.** When the entry leaves `metadata.json` and the Film stays in the view, the same run deletes the sync row and stores the sync key `absent`. When the Film leaves the view, the release batch deletes the sync row as well. The Film row stays, as in ADR 0056. A held Film is not written and is not released.
6. **No reader.** `metadataSync` does not read D1. No page, GET or sync step uses `film_sync_state` to choose an R2 write. A later reader is a separate card, after this contract is accepted.

Not decided here: applying migration `0005`, backfill or reload, turning the projector off or on, and any consumer that reads the new rows.

## Alternatives considered

- **A new flag or a second cron.** Rejected. ADR 0056 already has the writer, and a deploy must not activate a new one. The schema version is the gate.
- **Fold the clocks into the existing film change key.** Rejected for the current production schema. It would mark every Film changed on the next cron and rewrite the enrichment rows before `0005` exists.
- **Store the clocks in `payload_json`.** Rejected. The decision needs typed, nullable columns, not an untyped blob.
- **Copy `titles.json` and `people.json` into the new table.** Rejected. Reviewed localization is already a dimension, and a second copy would not be the sync decision.
- **Read the new table from `metadataSync` in this change.** Rejected. D1 lags R2 by about an hour. Using it to skip Letterboxd or to rewrite `metadata.json` would let the lag decide an R2 write.

## Consequences

- Until `0005` is applied, production behavior is the schema v4 projector. After it is applied, the next runs write one sync row per Film that `metadata.json` names. The offline import does not write those rows, and the projection seed must not invent their keys: a seeded key with no row would hide the missing write. The projector fills the rows itself, inside the existing query and wall budgets.
- A clock-only change does not rewrite credits or dimensions. A change to `peopleNamesVersion` still rewrites the Film, because that integer is already part of the metadata dimension, and the sync row is updated in the same batch.
- `/api/d1/status` gains `schemaVersion`, `syncCheckpoints` and `syncAbsent` only when version is 5 and the table is present. The version 4 success shape is unchanged.
- The backfill executor still requires schema version 4. A database at version 5 stops before a reload write. The reload procedure returns the database to version 4; `0005` is applied again afterwards, under its own approval.

## Recovery and migration boundary

Code rollback is a Worker revert. It does not remove `film_sync_state` or restore R2. Unsetting `D1_ENRICHMENT_WRITE` stops further D1 writes; rows already written stay until a Time Travel restore, which is a separate owner approval and rolls back the whole database. This ADR does not authorize applying `0005`, seeding, a reload, a flag change, a cron change, or any R2 or D1 write.

## Evidence

- **Original decision:** [AIR-311](https://trello.com/c/81P7wg4u)
- **Implementation:** [PR #291](https://github.com/vladimino/iptv-watchlist/pull/291)
- **Dated verification:** `not recorded` (no production migration and no production projector run of these rows)
- **Uncertainty:** production schema v4 and `D1_ENRICHMENT_WRITE=on` are taken from the persistence page and the 2026-10-30 projector evidence. This delivery does not re-read the live database.

## Follow-ups

A reader of these rows, and the owner approval to apply migration `0005`, are separate cards. Neither is implied by accepting this record.
