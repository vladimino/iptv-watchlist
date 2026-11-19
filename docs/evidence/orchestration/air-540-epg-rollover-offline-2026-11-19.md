# EPG Workflow controlled rollover: offline test evidence (19 November 2026, UTC)

Scope: [AIR-540](https://trello.com/c/YAVfVHrs), [ADR 0176](../../adr/0176-controlled-epg-workflow-rollover.md). Method: `tests/epg-workflow-rollover.mjs`, an offline vm Worker with the real `src/epg-orchestration.js`, a sqlite D1 stand-in with the migrated `epg_orchestration_document` table, a scripted pipeline, a Workflow binding stand-in and a fixed clock (2026-11-19T20:00:00Z, run key 2026-11-19). `tests/mcp.mjs` covers the Access gate. No production read or write, no Cloudflare call, no network.

## Verified offline

| Case | Result |
| --- | --- |
| `dry_run` | `eligible` with the six pins; the documents' bodies and revisions are identical before and after; no create |
| `apply` | one swap to `series+1` of the same run key, epoch and run id; one create `{runKey, series, epoch}`; budget 4/5, failure, checkpoint, progress time, cooldown carried; lease and mode rows untouched; no `handoff` written; no pipeline call |
| Old instance wakes | `not_owner`, stops, control revision unchanged, no create |
| Successor `act` | records its `versionId`; `dry_run` then reads `already_current`; repeat of the request id reads back `handed_over`, zero writes |
| Refusals (zero writes, documents untouched) | missing `confirmGo`; each of six stale pins; active owner; wake past or under 120 s; live lease; quarantine; complete; `starting`; unclaimed seal; other run in `sync.json`; switching, external, moved epoch; authority held; day rolled without claim; absent owner |
| Unknown | no version metadata, unreadable platform status, unreadable `sync.json`: `unknown`, apply refused with zero writes |
| Version equal | `already_current`, apply refused |
| Claimed seal across midnight | admitted; the claim is carried and still does not name the old instance |
| Cooldown sleep | admitted; cooldown and 4/5 budget carried; no quarantine created or cleared |
| Lost compare-and-set | a lease row inserted between read and swap: `cas_lost`, control untouched, no create. Control revision moved after the preflight: `stale_pin` |
| Unknown create | swap stands, `successor_uncertain` (202); a repeat with other pins is `request_id_reused`; with the same pins it recreates the same id with no second swap; another `requestId` is a stale pin; `ensure` recreates the same id and spends no budget |
| Crash between swap and create | `ensure` creates the same id; a second `ensure` reads `in_progress`; no `series+2` |
| Readback proof after the swap (review fix) | `sync.json` unreadable, missing or another run with a higher stage after the swap: `readback_unproven` (202), swap stands, one create; the earlier code accepted all three |
| Replay gating (review fix) | each of the six pins altered: `request_id_reused`, zero writes, no create; authority held, epoch changed, mode switched, version metadata gone, platform status or `sync.json` unreadable after a lost create: nothing created; the same replay in a safe state recreates the same id |
| Argument validation | invalid shapes answer 400 and write nothing |

## Limits

- Not established: that Cloudflare runs a new instance on the version deployed at its creation, that `CF_VERSION_METADATA` inside a Workflow step reports the instance's own version, and the platform's behaviour of an instance that wakes after a swap. The first live apply, under a separate owner GO, is the only check.
- The Mermaid sequence in the architecture page was written for GitHub rendering; its rendered QA is a review step on the PR, not part of this evidence.
- No live `apply` ran; the tool has not been exercised on production.
