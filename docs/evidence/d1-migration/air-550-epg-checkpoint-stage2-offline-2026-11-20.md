# EPG checkpoint in D1, stage 2: dormant repository, offline evidence

Date: 20 Nov 2026 (UTC). Scope: repository change only. **No production D1, R2, flag, binding, Workflow, Scheduled Task or Access was read or written**, no migration was applied, nothing was imported and no authority was switched. Source base: `main` at `4697de31` (after the Accepted [ADR 0185](../../adr/0185-epg-checkpoint-d1-authority.md)). Work: [AIR-550](https://trello.com/c/xMTEtaLp) stage 2. The production cutover is [AIR-551](https://trello.com/c/YAVPlcAe), a separate owner-gated operation.

## What changed

| Artifact | Content |
| --- | --- |
| `migrations/0030_epg_checkpoint_authority.sql` | Schema v30: the `epg_checkpoint_authority` marker (inserted as `r2`, generation 0, writes `open`), `epg_checkpoint_cas`, the single `epg_checkpoint_run` row, `epg_checkpoint_body`, `epg_checkpoint_film`, `epg_checkpoint_receipt`, `epg_ingest_status`, and the trigger `epg_checkpoint_run_order` (stage order, immutable completion time, `queue_attempted` changes only into `complete`). Follows a complete version 29 and refuses anything else before a table is created. Not applied anywhere. |
| `src/epg-checkpoint-d1.js` | Storage only. Marker read (`legacy` / `r2` / `d1` / `closed`), `loadRun` (one read batch, completeness and digest verification), `saveRun`, `createRun` (staging, read-back, one switch batch, ingest success), `completeRun` (the only way to `complete`), `gcOrphans`, `classifyWrite`, `readIngest`, `recordIngestFailure`. Never touches R2. |
| `src/worker.js` | The façade of `loadJSON` / `saveJSON` for `sync.json` and `watchlist-ingest.json` chooses R2 or D1 from the marker; the `d1` branches of `beginSync`, `finishSync` and `sealQueueStep`; `completeCheckpointRun`. With the tables absent (schema below 30) or the marker `r2` every path is the previous code. |
| `src/published-epg.js` | `certifyUpdateStatements` (the conditional certificate update and pause clear, without their own fences), `certificateColumnPresent`, `pauseTablePresent`; `certifyRun` adds the checkpoint condition only while the checkpoint marker is `d1`. |
| `src/epg-orchestration.js` | `classifyThrown` maps the checkpoint error codes onto the existing failure classes. |
| `build.mjs`, `tests/local-standins.mjs`, `scripts/local-dev.mjs` | The module is bundled as `EpgCheckpointD1`; the local stand-in selector `EPG_CHECKPOINT_DB_OPTIONAL` joins the others (never set in production). |
| `tests/epg-checkpoint-d1.mjs`, `tests/epg-checkpoint-certificate.mjs`, `tests/epg-checkpoint-worker.mjs` | New core tests, below. |
| Existing tests | Changed only where they pinned "the last migration is 0029" or "the schema is 29": `canonical-producer-chain`, `canonical-producer-schema`, `canonical-rated-admission-bundle`, `canonical-rated-admission-producer`, `migration-pattern-limit`, `started-d1`; `epg-run-certificate` (its static assertion now names the r2 branch of the same order); `tmdb-tv-runtime` (adds the local stand-in to its D1-less env). |

## Tests

All offline: a sqlite D1 stand-in over the real migration chain (each batch one transaction that rolls back whole), a recording R2 stand-in, the real `src/worker.js` and repository in a vm.

- `epg-checkpoint-d1.mjs`: the migration (refused on version 28, version 30, downgrade refused, the raw-SQL triggers); the five authority states; create, load and save round trips with a 120-entry watchlist; a metadata-style save writes only the changed film rows; every fence (no step, another holder, moved mode revision, expired or released lease, a hold, a moved generation) writes nothing; two writers and a stale revision; lost reply (applied by receipt), lost request, **indeterminate** (revision beyond the receipt window or a gap) never replayed; watchlist completeness (missing, extra, swapped, changed, wrong digest or count, body mismatch, typed column contradiction, empty versus absent, a row removed between read-back and switch); completion (no queue attempt refused, certify statements in the same transaction, a non-matching statement still completes, a lost lease writes nothing, the completion time immutable); ingest ordering (older attempt superseded, same attempt a no-op, last success never lowered, counter cap, no step lease needed, held and closed states); orphan staging rows (bounded sweep, interrupted creation, repeated failed attempts); budgets and surrogate pairs on chunk boundaries.
- `epg-checkpoint-certificate.mjs`: with the real published-EPG, Discovery pause and orchestration tables: one batch completes the run, certifies it and clears the pause, Discovery is admitted afterwards; a non-matching certificate still completes and the repair certifies it; the repair of an incomplete checkpoint writes nothing and the certificate update needs the checkpoint `complete` with `queue_attempted`; a checkpoint of another run refuses; the `r2` marker leaves ADR 0175 unchanged; a lost lease writes nothing.
- `epg-checkpoint-worker.mjs`: the façade at legacy, `r2`, `r2` with writes held, closed (no tables at version 30, a deleted marker, no binding) and `d1`; R2 untouched in `d1`; `beginSync` success, failed fetch and step-less start; `finishSync` order in `d1` (queue before completion, queue error stays best-effort, a refused completion writes nothing) and in `r2` (the old order); the seal route wiring.

Local results (this session): the three new files pass; `epg-run-certificate` and `canonical-rated-admission-producer` pass after their pinned text and schema number were updated; the core suite result on the final tree is recorded in the pull request.

## Independent review of the first delivery (HEAD `6eb2cd0f`) and its fixes

- **Fence fail-open (P1).** The first delivery guarded with `UPDATE epg_checkpoint_cas … WHERE id=1`, which matches no row when the singleton row is missing, so a stale write could commit. Every guard is now an upsert of the row (`INSERT … ON CONFLICT DO UPDATE`), the marker read answers `closed` without the row, and the migration adds a trigger that refuses its deletion. `tests/epg-checkpoint-d1.mjs` section 12 deletes the row after the marker was read and shows that a stale revision, a stale generation, a lost lease, a run creation, a completion, the sweep and an ingest failure all refuse and change no row; the same test fails (a stale write commits) when the old `UPDATE` form is substituted.
- **Completion time (P2).** The typed `completed_at` and the body's `completedAt` are one value: `completeRun` copies a missing value (from `updatedAt`, else the clock) into the body and refuses a malformed one, `saveRun` refuses any change or removal of it after completion (`completion_time`), `loadRun` refuses a complete run whose two values differ. Section 13 covers each.

## Resolutions of the ADR's open questions

- **O1.** `EpgOrchestration.externalGate` answers `external_writer_fenced` in mode `cloudflare`, a fence in mode `external` (and then `beginExternalStep` takes a step lease), and no fence only when the orchestration tables do not exist at all, which cannot be a database that has the v30 checkpoint tables. So "no step, no write" never refuses a legitimate path in `d1` mode.
- **O3.** `0030` was the next free number on `main` at `4697de31`; the only open pull request at that time (a Letterboxd identity change) adds no migration.
- **O2.** Not measurable offline. The caps (90,000 characters per statement or film row, 900,000 per body) are unchanged, the statement limit is counted in characters as in the ADR, and the production sizes of `sync.json` and a watchlist entry are still unmeasured. A read-only size check before the activation confirms or revises them.
- **Orphan staging rows (review note).** Staged rows of an interrupted creation are removed by a bounded, fenced sweep at the start of the next creation (200 rows per pass, 5 passes) and by the switch batch, which deletes every row that is not the new run's.

## Limits and what is not proven

- The stand-in is sqlite, not D1: D1's real per-invocation statement budget, its handling of the row-value comparison and the `ON CONFLICT` upsert used by the ingest status, trigger behavior and batch size limits are not exercised. These need the owner-approved apply preflight of AIR-551 (a scratch or read-only check) before any activation.
- The Worker keeps the marker for two seconds per database binding. Every write in `d1` mode is also fenced by the authority generation inside its batch, and the cutover procedure drains the writers first; a stale `r2` view for at most two seconds after a flip is closed by that drain, not by this code.
- `loadRun` reads and verifies the whole watchlist while a run is in progress; its cost against the Worker memory and CPU limits is unmeasured. A completed run carries no watchlist.
- Nothing here activates, imports, exports, applies or retires anything; code rollback reverts none of the data.

## Not in this change

Applying `0030`, importing the R2 objects, switching the marker, the data-rollback export, retiring the R2 arm and every Cloudflare setting. Each needs its own owner GO under [AIR-551](https://trello.com/c/YAVPlcAe).
