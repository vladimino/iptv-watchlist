# AIR-319: D1 published EPG production cutover, 3 November 2026

**Verdict, updated at approximately 2026-11-03 20:42 UTC:** **First actual post-cutover D1 EPG generation publication succeeded** on a daily-task-created run completed with one separately owner-authorized manual step. Read-only MCP published-generation and downstream queue consumers agree on the new run. **Direct D1 row/R2 object parity and programme/watchlist/availability HTTP consumer acceptance remain PENDING.** This evidence grants no further writer or migration authority.

## Approved operator execution

The [AIR-319 handoff, 08:08 Madrid](https://trello.com/c/pQL8NUTC#comment-6ae9889676deb75637f0a289) reports distinct prior owner approvals for these actions:
- Around 06:23 UTC, initial `--apply` refused before SQL due to a live resolver lease. The later permitted attempt applied schema v8; marker remained `r2/open`, generation 0, null programme run.
- Around 06:30 UTC, `--load` copied the existing programme/watchlist generation into D1: generation 1 and watchlist generation 1, still `r2/open`.
- Around 06:57 UTC, after acknowledging producer drain and verifying idle leases, `--activate --confirm activate --target iptv --producers-drained` succeeded. Operator readback: `published_epg_authority.mode=d1`, `cutover=open`, `generation=1`, `watchlist_generation=1`, `programme_run_id=71820185-3cc1-4303-b674-14293dca938b`. At 07:08 UTC the operator confirmed the unchanged marker, idle sync/resolver/projector, and restored `D1_ENRICHMENT_WRITE=on`. No `0009`, revert or hold-recovery operation was performed.

These are **operator-reported D1 SQL results**, not a second direct coordinator query.

## Pre-publication independent limited readback (07:38 UTC)

The coordinator's existing owner-only IPTV MCP tools returned:
- `epg_status`: HTTP 200, stage `complete`, remaining 0, failures 0, same run id; its timestamp `2026-11-02T16:14:18.313Z` precedes activation.
- `epg_pipeline_status`: the same programme run id and `generationConflict=false`. R2 Discovery continuation was `orphaned` with an expired lease after an interrupted chunk; this is a separate discovery finding, not proof of D1 EPG publication failure.
- `prediction_queue_overview`: the same published run id, consistent true, partial false, 3011/3011 current predictions (100%).
- `feature_flags`: D1_ENRICHMENT_WRITE on; DISCOVERY_EXECUTOR absent, effective external.
- Already-opened production homepage and `/admin/health` browser tabs last opened after activation (about 07:20 UTC) displayed generation prefix `71820185` and 397 programme films. This is UI snapshot evidence, not raw HTTP document parity or independent D1 SQL mode verification.

The daily EPG Scheduled Task was enabled for 17:00 Europe/Madrid. Its last recorded attempt was scheduled for 2 November and marked `failed` in the ChatGPT task registry, while the corresponding Worker EPG state was `complete` with zero EPG failures; the stored task result described an incomplete/waiting Discovery continuation. These are distinct outcomes. At this morning observation, the last published EPG run was before D1 cutover. The later task-created run was successfully published through a manual recovery step, documented next; an uninterrupted daily Scheduled Task commit is not yet demonstrated.

## First successful post-cutover generation (20:22–20:25 UTC)

The external daily EPG Scheduled Task created run `00ff34fa-e518-4ac7-ae63-b2e46f803503` on 3 November. Its earlier publication attempts failed before a generation commit (memory kill, resolver-busy, and an R2 plain-ReadableStream length-contract `TypeError`). These led to two code-only fixes: [AIR-338](https://trello.com/c/B84isUMG), [PR #349](https://github.com/vladimino/iptv-watchlist/pull/349), and [AIR-339](https://trello.com/c/89Hs7z6Y), [PR #351](https://github.com/vladimino/iptv-watchlist/pull/351), merged as `ea2e0d65d77f8dd47d73b486abe319dd4a10b637`. Both post-merge jobs passed in [run 41710609114](https://github.com/vladimino/iptv-watchlist/actions/runs/41710609114). Neither deploy started EPG.

The owner then explicitly authorized **one** `epg_sync_step` on that same run after a read-only preflight. Exactly one call returned HTTP 200: `stage=complete`, `updatedAt=2026-11-03T20:22:44.960Z`, 395 watchlist films, 189,431 scanned EPG entries, 181,406 retained, 115,578,963 EPG input bytes, 255 unique EPG films and 971 showings. The reported discovery state was `paused`, `reason=epg_committed`, `remainingChunks=12`, `nextAction=continue`. **No discovery chunk or additional sync step was invoked.** [AIR-319 operational handoff](https://trello.com/c/pQL8NUTC#comment-6aea438b23f77f37834de976).

Read-only MCP `epg_status` afterwards reported the same run at `stage=complete`, remaining 0. `epg_pipeline_status` showed newly published `programmeRunId=00ff34fa-e518-4ac7-ae63-b2e46f803503`, active discovery candidates 35,862, unique archived 22,866, ledger total 58,728 (= 35,862 + 22,866). The archive manifest id remained `187558f5-cf3c-40c3-87d3-fe36cd752d72`. The diagnostic ring recorded `epg_commit` `completed`, HTTP 200, duration 148,895 ms, no error, at `2026-11-03T20:22:33.732Z`. This one real Worker execution traversed the previously failing commit and R2 upload path without a new memory kill, **not** proof of adequate isolate headroom for all future sizes. `epg_status.error` still contained the earlier plain-stream `TypeError` despite `stage=complete`: an old failure field, not the outcome of this successful step.

## Side-effect-free downstream readback (approximately 20:42 UTC)

- `prediction_queue_overview`: the queue and published-generation run ids matched `00ff34fa…`, `consistent=true`, `partial=false`, `state=drained`, 3,024/3,024 current predictions (100%), pending 0.
- `enrichment_queue`: `programmeRunId=00ff34fa…`, 2,549 hot, 475 cold, pending 0, refreshed at `2026-11-03T20:25:00.391Z`. These queue counts are not an EPG watchlist-membership count.
- `epg_pipeline_status`: Discovery continuation `paused/epg_committed`, 12 chunks, health `settled`, no continuation lease. `DISCOVERY_EXECUTOR` absent/effective external.
- `ratings_sync_status`: separate ratings pipeline `idle`, migration `complete`. Its latest scheduled run was pinned to the *old* programme run; two `event_missing` removal references were observed, without evidence tying them to this commit.
- `feature_flags`: `D1_ENRICHMENT_WRITE=on` and `DISCOVERY_EXECUTOR` absent/effective external. No changes were made.

These are read-only API-level consistency observations, not direct SQL reads of `published_epg_authority`, `published_epg_member` or `published_epg_show`, raw R2 etag/size/hash comparison of staged and mirrored objects, or independent programme/watchlist/availability response parity. No live read across those boundaries has been falsely claimed.

## Safety and outstanding acceptance criteria

The current Worker `src/worker.js` uses `PublishedEpg.repairMirrors` for `GET /api/programme` and `GET /api/watchlist`. In D1 mode, `src/published-epg.js` may repair R2 compatibility objects and update D1 mirror metadata. These HTTP GETs are not guaranteed read-only. The coordinator did **not** invoke them as unauthorized acceptance probes, so no direct document equality or pin-consistency acceptance can be claimed. A pipeline-status run id is not full raw parity. A separate explicitly permitted bounded inspection or operator-produced read-only result is required, with any possible mirror repair acknowledged.

The first actual post-cutover D1 EPG publish is now confirmed on a task-created run completed with one owner-approved manual step; an unattended daily-task success remains unverified. Do not close AIR-319 until remaining gates are resolved: (1) direct independent D1 authority/members/shows and raw R2 generation/mirror parity, or a qualified owner acceptance of those remaining unknowns; (2) programme/watchlist/availability and relevant consumers through a genuinely safe or separately authorized read route; (3) accepted documents, final exact-head CI and rendered owner visual approval of four Mermaid changes; (4) disposition of Discovery continuation and stale `epg_status.error` without unauthorized recovery.

This report documents exactly **one separately authorized production EPG step**; all subsequent checks were read-only. The approval has been consumed. No new EPG step/start, Discovery chunk, repair, 0009, AIR-320, AIR-324, migration, lease reset, Access, R2/D1 flag or Scheduled Task action is authorized by this evidence.
