# AIR-572: stale Producer chain superseded, membership baseline recorded and writer switched to the Letterboxd Sync, 23 Nov 2026

**Card:** [AIR-572](https://trello.com/c/ugyHjnc4). **Scope:** three owner-authorized production operations through the owner-only MCP tools `producer_chain_operator` ([PR #959](https://github.com/vladimino/iptv-watchlist/pull/959), `main` `0cfa6be`) and `watchlist_membership_operator`, following [ADR 0203](../../adr/0203-watchlist-membership-letterboxd-single-writer-projection.md) (Accepted, contract A) and the [membership projection runbook](../../runbooks/watchlist-authority-d1.md#membership-projection-schema-37-adr-0203), steps 2 and 3. One call per operation, each with its own owner GO in the executor session; no retry was needed. All times UTC.

## Preflight (read-only, 22:27)

| Read | Result |
| --- | --- |
| `producer_chain_operator` `status` | published run `d8dc6ec8-b7e0-43a2-a02a-25269f00ba2f`, generation 518; Film/Person open, generation 2; hold `true`; `blocked` null; one open chain, not truncated: `bf89ba90-07eb-46ac-9723-15d309517830`, input generation 517, `pending`, owner epoch 22, revision 22, lease expired at 14:05:37, `claimed` false, `runLinked` false, `eligible` true |
| `watchlist_membership_operator` `status` | marker `producer` generation 0, baseline null; Watchlist version 4, drained 4; Sync `cloudflare`, epoch 1; Producer held, non-terminal chains 1 |
| `watchlist_membership_operator` `baseline_dry_run` | version 4, `drift`: current 392, stored 392, add 8, remove 8, keep 384, unresolved 0 (same as the 22:20 read) |

## Operations

| Time | Call | Answer |
| --- | --- | --- |
| 22:28 | `producer_chain_operator` `supersede`, `expectedProgrammeRunId` `bf89ba90-07eb-46ac-9723-15d309517830`, `expectedRevision` 22 | HTTP 200, `superseded` true, `writes` 1; chain `superseded` at revision 23; non-terminal chains 0 |
| 22:41 | `watchlist_membership_operator` `baseline_apply`, `expectedVersion` 4, `expectedMarkerGeneration` 0 (pins re-read just before) | HTTP 200, `baseline_recorded`, written 16, failed 0, remaining 0, unresolved 0 |
| 22:42 | `watchlist_membership_operator` `switch`, `expectedVersion` 4, `expectedMarkerGeneration` 0 (pins re-read just before) | HTTP 200, `switched` true; marker `sync` generation 1, baseline version 4 |

## Readback (read-only, 22:42)

- `watchlist_membership_operator` `status`: marker `sync` generation 1, baseline version 4; Watchlist version 4, drained 4; Sync `cloudflare`, epoch 1; Producer held, non-terminal chains 0.
- `baseline_dry_run`: version 4, `already_current`: current 392, stored 392, add 0, remove 0, keep 392, unresolved 0.
- `producer_chain_operator` `status`: published `d8dc6ec8-…`/518 unchanged; Film/Person open/2; hold `true`; no open chain.

## What this proves and what it does not

- The stale chain of run 517 is terminal; nothing else in the Producer store was reported changed (the published run and generation, the Film/Person generation, the Watchlist version and the Sync epoch read the same before and after).
- `watchlist_film` matches Watchlist version 4 (16 membership changes) and its writer is the Letterboxd Sync (roll-forward; there is no switch back).
- **Not yet proven:** the first membership effect written by the Sync in mode `sync` (the next natural Watchlist promotion), and a live Producer pass. The Producer was still held at the end of this record; lifting the hold is the separate AIR-572 code change that this record accompanies.
- No Letterboxd, EPG, Discovery or Predictions run, no Workflow instance, lease, flag, Task, cron, Access, R2 or schema change was made by hand.
