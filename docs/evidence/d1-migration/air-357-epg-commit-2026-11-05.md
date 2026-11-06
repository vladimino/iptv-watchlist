# AIR-357 production recovery: one EPG commit after schema 12

**Captured:** 2026-11-05, about 20:55–20:57 UTC (21:55–21:57 Europe/Madrid). **Authorization:** owner GO for exactly one `epg_sync_step` on run `5744aef7-990d-4751-bb46-d979d9c5a2cc`. No second step. No Discovery chunk, TMDB, Predictions, flag or Task change.

## Preflight immediately before the step

Unchanged from the [0012 apply read-back](air-357-0012-apply-2026-11-05.md): schema 12, idle `discovery_seal`, transfer `loading` for this run (37,000 batches), 328 `active` / 36,671 `retiring`, published generation 3 / run `7c1eaadb…`, `epg_status` still `stage=epg` / `error=discovery_incomplete`, lease expired.

## Call

One IPTV MCP `epg_sync_step({runId:5744aef7-990d-4751-bb46-d979d9c5a2cc})`. The MCP client returned `-32001 Request timed out` before a body arrived. That is an **unknown caller outcome**: the step was not repeated.

## Read-back after the timeout, then again after ~95 s

Immediately after the timeout: `epg_status` still showed `stage=epg` and `updatedAt` 16:08:56 UTC, but `discovery_lease` had a new `lease_id` with about 73 s remaining (a live writer). Seal row, transfer and observation counts were unchanged. No second step.

About 95 s later:

| Item | Value |
| --- | --- |
| `epg_status` | run `5744aef7…`, **`stage=seal`**, `updatedAt` 20:56:04 UTC, no `error`, `remaining=0` |
| `discovery_seal` | still one idle row (no job) |
| `discovery_transfer` | still `loading`, same run, 37,000 batches |
| `published_epg_authority` | unchanged, generation 3, run `7c1eaadb…` |
| Observation counts | unchanged (328 / 36,671) |
| `discovery_lease` | `expires_at=0` (released) |

## Reading

The Worker finished the commit after the MCP timeout. Staging to `seal` writes the generation ledger and the seal payload on R2 and moves `sync.json`; it does **not** call `sealBegin`. The idle D1 `discovery_seal` row is therefore expected until the next `epg_sync_step`. That next call is the first bounded seal step (`nextAction` would have been `continue` / `reason=ledger_seal` on a timely response). It is not authorized by this GO.

## What this is not

Not publication. Not a finished seal. Not a generation pointer move. The incident stays open.
