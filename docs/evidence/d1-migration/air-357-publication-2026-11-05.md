# AIR-357 production recovery: publication complete

**Captured:** 2026-11-05, about 22:23 UTC (23:23 Europe/Madrid).
**Authorization:** owner standing GO for `epg_sync_step` on run `5744aef7-990d-4751-bb46-d979d9c5a2cc` while `nextAction=continue`.
**Run:** `5744aef7-990d-4751-bb46-d979d9c5a2cc`. Schema 12. No Discovery chunk, TMDB, prediction run, flag or Task change.

## Outcome

| Check | Result |
| --- | --- |
| `epg_status.stage` | `complete` at `2026-11-05T22:23:03.451Z` |
| `published_epg_authority` | generation **4**, `programme_run_id=5744aef7-…`, `watchlist_generation=4` |
| `discovery_transfer` | `committed` on the same run |
| `discovery_seal` | `phase=done`, `cursor_items=item_total=38941` |
| `discovery_authority` | `published_programme_run_id` and `programme_run_id` both `5744aef7-…` |
| Pipeline | no longer `discovery_incomplete`; `programmeRunId=5744aef7-…`, `candidates=38941`, `continuation.reason=epg_committed`, `remainingChunks=12` (not advanced) |
| Predictions snapshot | `consistent=true`, `programmeRunId=5744aef7-…`, `publishedGeneration.phase=published`, coverage 3107/3107 |

The previous published pointer was generation 3 / `7c1eaadb-08a6-40a1-b793-a345068144a5`. It flipped once.

## Last steps (this session)

1. Catalog: `catalogRemaining` 2011 → 1308 → 605 → 0, then `seal.phase=publish`.
2. Publish `epg_sync_step` timed out at the MCP client (`-32001`). The Worker still held `discovery_lease` (~28 s remaining). D1 already showed generation 4. No blind retry. After the lease expired, `epg_status` read `stage=complete`.
3. An earlier aborted catalog call left a live lease (~78 s). That call was waited out; `updatedAt` had not moved, then catalog was resumed once.

## Out of scope

Post-commit Discovery (`remainingChunks=12`) was not started. AIR-324 Workflow cutover was not touched.
