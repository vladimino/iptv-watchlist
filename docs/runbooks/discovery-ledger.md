# Bounded discovery ledger: modes, verification and rollback (owner approval required)

This page describes how to operate the discovery ledger modes of [ADR 0034](../adr/0034-bounded-discovery-ledger.md), implemented in [AIR-220](https://trello.com/c/uPvMc5ww). It does not grant permission for anything. A deploy changes nothing by itself: the default `DISCOVERY_LEDGER_MODE` is `full`, the unchanged single growing ledger. Setting `bounded`, splitting the existing production ledger and any rollback are separate owner-approved operations ([AIR-221](https://trello.com/c/9ZiVygrd) rehearsal, [AIR-222](https://trello.com/c/9Y4G9DG6) rollout).

## What each mode does at the EPG commit

| `DISCOVERY_LEDGER_MODE` | Archive absent | Archive present (`epg/discovery-archive/v1/current.json` exists) |
| --- | --- | --- |
| unset or `full` | Single growing ledger, as before AIR-220 | Acts as `frozen`; never rebuilds the full ledger in the Worker |
| `frozen` | Same as `full` (no marker written) | No new archive write. Departures stay in the active ledger; re-entries and counts still use the archive |
| `bounded` | The first commit creates the archive from the departures of the previous ledger | Active ledger = the latest scan's candidates; departures go into new write-once segment versions, a manifest version, then a CAS of `current.json`; then the generation is published |

The commit runs this under the discovery lease. It stops without publishing if:

- the published generation pointer changed (its etag differs from the one read at the start);
- the lease was lost;
- `sync.json` no longer names the run in stage `epg`;
- the archive pointer CAS lost a race.

Such a stop leaves either the previous archive with some unreferenced versions, or the new archive plus the previous published generation. Both are consistent (ADR 0034, section 3). Retrying the same run is safe.

**The first bounded commit over today's full ledger parses that full ledger once, as every `full` commit does now.** That has the same memory risk as today. The production split is therefore planned and rehearsed separately (AIR-221/AIR-222), possibly as an offline split, and is not started by setting the flag on its own initiative.

In bounded mode no discovery chunk and no status read touches the archive. `POST /api/enrichment/discovery/scan` and `/reconcile` answer `409` whenever the mode is not `full` or an archive exists.

## Read-only verification (no write)

- `GET /api/enrichment/pipeline/status` (or MCP `epg_pipeline_status`):
  - **`full`**: no `archive` field.
  - **bounded or frozen:** `archive` = `{ledgerMode, activeItems, uniqueArchivedItems, manifestId, segments, items, bytes}`, and `ledgerTotal` = `activeItems + uniqueArchivedItems` (unique keys of active ∪ archive).
- `GET /api/enrichment/status`: `ledgerTotal` has the same meaning, and `recognizedFilms` counts verified decisions among the **active** candidates only.
- A consistent offline read for audits:
  1. Take the published active ledger `epg/generations/<runId>/discovery-latest.json`.
  2. Read the manifest version its `archive.manifestId` names.
  3. Read exactly that manifest's segment versions, checking `sha256`.
  4. For a key in both the active ledger and the archive, the active record wins.

  Do not follow `current.json` for history.

## Rollback

- **R1 (operational):** set `DISCOVERY_LEDGER_MODE=frozen`. Nothing is rebuilt or deleted, and the active ledger grows again from the next commit. Removing the value has the same effect while an archive exists.
- **R2 (code revert to an archive-unaware Worker):** only after an offline, fenced reconstruction:
  1. take a consistent snapshot;
  2. rebuild the full ledger locally, checking payload parity against active ∪ archive;
  3. have a GO/NO-GO reviewed. GO requires the rebuilt ledger's measured commit and chunk memory to be within the proven Workers bound; otherwise R2 is NO-GO;
  4. write it only under a separate approval.

  A plain code revert without these steps drops archived history.
- Archive objects are never deleted by the Worker. Removing unreferenced versions is a separate, owner-approved maintenance decision.

## Offline benchmark

`node scripts/discovery-ledger-benchmark.mjs --output /absolute/dir/outside/repo [--sizes 20,40,63,90]` builds synthetic stores and reports the active and archive sizes, plus the smallest Node old space at which the commit and a chunk complete in each mode. It is offline: no network, no R2, no production data. The numbers are relative to Node, not the Workers isolate limit. See the dated [benchmark evidence](../evidence/discovery-ledger-benchmark-2026-10-27.md).
