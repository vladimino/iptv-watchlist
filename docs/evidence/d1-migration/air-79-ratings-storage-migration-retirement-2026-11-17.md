# AIR-79 ratings storage migration retirement, 17 November 2026

**Trello:** [AIR-79](https://trello.com/c/485tlGLA), slice D-3. **Code reference:** `main` at `7ddfadf`. **Captured:** 17 November 2026 (UTC). Decision: [ADR 0160](../../adr/0160-retire-ratings-storage-migration.md). Continues the [flag closure audit](air-79-flag-closure-and-legacy-export-route-2026-11-17.md), whose live `ratings_sync_status` readout is the precondition used here.

## Scope and method

Removes the owner-only MCP tool `ratings_storage_migrate`, the route `POST /api/letterboxd/ratings/migrate` and the conversion code, and replaces the `migrationState() === 'complete'` gate with a read-only storage schema guard. No production read or write was made for this change; the precondition is the earlier read-only `ratings_sync_status` readout of 13:44 UTC (migration `complete`, removal queue at schema version 2 with 0 legacy entries, cursor migrated, orchestration mode `cloudflare`). No flag, binding, marker, schedule or stored object was touched.

**Equivalence.** `migration === 'complete'` meant that both stored objects were already in the new form. The guard tests exactly that (queue `schemaVersion` 2, cursor `schemaVersion` 2 with a `writer`), so behaviour on the recorded production state is unchanged.

## Removed

| Item | Where |
| --- | --- |
| MCP tool `ratings_storage_migrate`; route `POST /api/letterboxd/ratings/migrate` | `src/mcp.js`, `src/worker.js` |
| `migrate`, `migrationState`, `separateActive`, witness writes, `MIGRATION_WRITER` | `src/letterboxd-ratings.js` |
| `migrateRemovalQueue` | `src/enrichment.js` |
| `migrateCursor` | `src/letterboxd-diary.js` |

The witness document `letterboxd/ratings/migration.json` stays in storage as a historical D1 document and is no longer read or written.

## Behaviour on unsupported storage

`start` and `step` answer `storage_unsupported` with `storage`; the EPG commit enqueues nothing, keeps `removalRefs` on the sync run and reports `ratingsPipeline: 'blocked'` and `ratingsStorage`; `ratings_sync_status` reports `storage`; orchestration maps `storage_unsupported` to `config_invalid`. Nothing converts, rewrites or falls back to R2 or to a version 1 form. A D1 restore to a point before the migration would leave the pipeline refused until an owner-approved operation restores the new form.

## Tests

`tests/ratings-migration.mjs` is renamed `tests/ratings-storage-schema.mjs` and now proves the guard: version 1 queue, unmerged cursor and missing objects are refused with no write, a supported state works, and the EPG commit blocks and keeps its references. Other ratings, MCP and API tests drop the migration setup. `tests/projector-window-r2-inventory.mjs` counts one wrapper and one dynamic write site fewer in `src/letterboxd-ratings.js` (the removed witness write; not a projector input).

## Verification

Local, on the final checkout: `npm run test:all` passed with the core suite at 421 of 421 files and the non-functional suite at 40 of 40; `npm run build` and `git diff --check` were clean. A first full run stopped at `projector-window-r2-inventory.mjs`, which was updated as above and then passed. CI and the independent review are recorded on the pull request and the card, not here.
