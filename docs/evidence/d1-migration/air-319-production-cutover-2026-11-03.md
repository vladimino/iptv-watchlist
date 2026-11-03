# AIR-319: D1 published EPG production cutover, 3 November 2026

**Verdict, updated at 2026-11-03 22:09 UTC:** **First actual post-cutover D1 EPG generation publication succeeded**, and a later fenced read-only comparison found the D1 authority, documents, membership and shows equal to the R2 generation copies and stable mirrors. `GET /api/programme` and `GET /api/watchlist` were not called. At this snapshot their mirror-repair predicate was already aligned, so the comparison does not show a lag those routes would write. This evidence grants no further writer or migration authority.

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

These are read-only API-level consistency observations. At 20:42 UTC they were not yet direct SQL reads of `published_epg_authority`, `published_epg_member` or `published_epg_show`, and not a raw R2 etag/size/hash comparison. That comparison is the next section.

## Direct D1 and R2 parity (22:09 UTC)

Read-only. `node scripts/published-epg-production.mjs --target iptv` returned `writes: false`, `writeState: none`, schema 8, and idle sync, resolver and enrichment-projection leases. No `--apply`, `--load`, `--activate` or `--revert`. The same credential then ran only `SELECT` against production D1 and `HEAD`/`GET` against bucket `iptv`. The authority row and the seven object ETags were read again after the bodies; both slices matched. No mirror repair ran.

| Check | Result |
| --- | --- |
| Authority | `mode=d1`, `cutover=open`, `programme_run_id=00ff34fa-e518-4ac7-ae63-b2e46f803503`, `generation=2`, `watchlist_generation=2` |
| Mirror pointer | `mirror_programme_run_id` is that same run. Pointer object ETag prefix `b18e83dacac2` equals `mirror_etag`. Body is exactly `{programmeRunId, phase: published}` |
| Generation row | `phase=published`, `published_at=2026-11-03T20:22:44.960Z`. `payload_sha256` prefix `8de0b9136063` equals SHA-256 of `published`, the programme text and the watchlist text |
| Documents | Programme 39 ordered chunks and watchlist 26 ordered chunks, ordinals contiguous from 0. Concatenated text equals the root objects and the generation copies byte for byte. Programme 2,288,075 bytes, SHA-256 prefix `5e528ea18c0e`. Watchlist 1,542,383 bytes, SHA-256 prefix `aeceaf96632d` |
| Membership | Programme 395 and watchlist 395, each ordinal `0..394`, distinct film ids, order equal to that document's `films` |
| Shows | 971 D1 rows. The same 971 rows are extracted from the programme document by `programmeShows`. The multisets match |
| Watchlist ETag | Root `watchlist.json` ETag prefix `9ecfaff1d7b1` equals `mirror_watchlist_etag`. The generation copy has the same ETag and size |
| Programme ETag | Root and `epg/generations/00ff34fa-e518-4ac7-ae63-b2e46f803503/programme.json` share ETag prefix `3f29beb5ad0c` and size 2,288,075 |
| Discovery ledger | `epg/discovery-latest.json` and the generation copy are both 45,040,540 bytes, SHA-256 prefix `f5c01504af8d`, same ETag prefix `d6961603ec4d` |
| Stage rows | Two rows, both `published`: the previous run `71820185…` and this run. This run's stage counts are 790 members, 971 shows and 65 document parts. No `loading` or `validated` row |

The previous generation row is still `published` and is not the authority pointer. `GET /api/programme` and `GET /api/watchlist` were not issued. The measured bodies and ETags are what `repairMirrors` treats as already aligned, so this snapshot does not show a mirror lag. Events and removal references were not read again; the earlier ratings observation of two `event_missing` references on the previous programme run stands unchanged. The hourly Discovery continuation was not retried.

## Safety and outstanding acceptance criteria

The current Worker `src/worker.js` uses `PublishedEpg.repairMirrors` for `GET /api/programme` and `GET /api/watchlist`. In D1 mode, `src/published-epg.js` may repair R2 compatibility objects and update D1 mirror metadata when those objects differ. These HTTP GETs were not used for this acceptance. The 22:09 UTC read already compared the documents and ETags those routes would repair, and they matched.

The first actual post-cutover D1 EPG publish is confirmed on a task-created run completed with one owner-approved manual step; an unattended daily-task success remains unverified. Direct D1 authority, membership, shows and R2 mirror parity for generation 2 passed at 22:09 UTC. Still separate from that parity: a live HTTP availability render was not requested in this read; Discovery continuation and the stale `epg_status.error` field were not changed; document merge and Mermaid approval stay on the documentation pull request.

This report documents exactly **one separately authorized production EPG step**; all subsequent checks were read-only. The approval has been consumed. No new EPG step/start, Discovery chunk, repair, 0009, AIR-320, AIR-324, migration, lease reset, Access, R2/D1 flag or Scheduled Task action is authorized by this evidence.
