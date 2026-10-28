# Discovery ledger split: AIR-222 stage 2 (production install of the planned split), 28 October 2026

[AIR-222](https://trello.com/c/9Y4G9DG6) · stage 2 (owner-approved production write), phase 2c. Follows [stage 1](discovery-ledger-split-air-222-stage-1-2026-10-28.md) (read-only audit, fresh snapshot, rehearsal, GO/NO-GO package, read-only preflight). Procedure: [discovery-ledger runbook, Stage 2 install](../runbooks/discovery-ledger.md#stage-2-install-owner-approval-required-for-every-run-that-writes) and [r2-snapshot-export runbook](../runbooks/r2-snapshot-export.md).

**Captured at:** 2026-10-28, 10:07–10:43 UTC, from the agent container; exporter, split tool and installer at `main` `247bf3c` (the AIR-222 stage 2 tooling of [PR #196](https://github.com/vladimino/iptv-watchlist/pull/196), unchanged since). **Scope:** one fresh fenced cut of the authoritative production bucket `iptv` (read-only token), a rehearsal and plan on that cut, a read-only dry run, then **two approved `--apply` runs with the separate write credential** (`R2_INSTALL_*`, Object Read & Write on bucket `iptv` only) and a read-only MCP check. **Evidence lifecycle:** dated record of this operation. **Operational authority:** the two apply runs below were each separately and explicitly approved by the owner in the session; nothing else was written. No flag, Scheduled Task, Access, D1, lease reset, sync, discovery, TMDB or model call. Snapshot, plan, receipts and logs stay in a private directory outside the repository; secrets are not recorded.

## 1. Preconditions (10:07 UTC)

- Both Scheduled Tasks («Обновление программы „В эфире“», daily 17:00 Madrid; «Почасовые прогнозы „В эфире“», hourly :20 Madrid) paused by the owner at 09:48 UTC and confirmed still paused by the owner at the apply gate (10:21 UTC).
- Read-only credential, account id and the write credential present as environment variables (names only; all five set).
- Window: the daily commit at 17:00 Madrid (16:00 UTC) voids a plan; the install finished at 10:41 UTC.

## 2. Fresh fenced snapshot (10:07:25 – 10:16:21 UTC)

`scripts/r2-snapshot-export.mjs --concurrency 16`, then `--verify`.

| Field | Value |
| --- | --- |
| Status (export, `--verify`) | `consistent_fenced` ×2, `noGoReasons` empty, 0 listing changes, fence ok (7 fence keys unchanged) |
| Objects / bytes | 8,723 / 659,175,433 (identical to the 08:22 and 09:52 UTC cuts of stage 1) |
| Aggregate SHA-256 | `23d2e9d7a705cee62d115f4cc2887b5728bdccc1893ce284b8a07b99547da6fa` (the plan's aggregate) |
| SHA-256 of `manifest.json` | `d7b22d33e4d4216886b7c47f257852bdd78d5a7ba5b973c40ce5d7685b51e6d1` (timestamps differ from stage 1; object set and bytes do not) |
| Listing pages | 9 |
| Published generation / `sync.json` `updatedAt` | `b2699929-0d83-4e8f-93f7-1f17de0edc24` / 2026-10-27T16:06:38.614Z |
| Continuation `at` / `hopId`; latest enrichment run | 2026-10-28T06:56:21.334Z / `caba9ff6…`; `294dd99f…` |

The snapshot directory was write-protected after `--verify`. The bucket was byte-identical to the cut the stage 1 plan was made from, so the same plan applies.

## 3. Rehearsal and plan on the fresh cut (10:16 – 10:19 UTC)

`scripts/discovery-ledger-split.mjs rehearse`: verdict **GO**, `reasons` empty, 171 s, peak RSS 1,666 MB. `plan-report.json` verdict **READY**; `plan.json` `manifestId` `187558f5-cf3c-40c3-87d3-fe36cd752d72` on the aggregate above, 69 writes (1 source copy, 64 segments, 1 manifest, 1 archive pointer, 2 ledger copies replaced by CAS), 163,740,564 bytes. Active 19,821 items (2,711,073 bytes), archive 33,525 items, source 53,346; parity exact in the next-commit and frozen-commit checks (`ledgerTotal` 53,346, missing/differing/extra 0), chunk full/bounded both HTTP 200 with 0 differing decisions.

## 4. Read-only dry run against production (10:20:09 – 10:20:49 UTC)

`scripts/discovery-ledger-install.mjs --plan … --output …` with the read-only credential: 72 `GET`, 1 `HEAD`, 0 `PUT`, 0 refused writes. States: 67 absent, 0 done, 2 source (the ledger copies at the expected ETag), 0 conflict. Fence: published pointer ETag and run match the plan, `sync.json` stage `complete`, no active discovery lease, archive pointer absent. Verdict **READY**, 69 writes pending.

## 5. Apply, first run (10:22:06 – 10:26:44 UTC): STOPPED by a transport failure

Owner approval for one `--apply --approved-production-writes` run given in the session at 10:21 UTC. The run repeated the preflight (READY, same states and fence), took the discovery lease and wrote under it.

| Field | Value |
| --- | --- |
| Verdict | **STOPPED** — `Request failed during a write; the outcome is unknown, re-run the dry-run before any retry` |
| Calls | 1 `HEAD`, 409 `GET`, 134 `PUT`, 0 refused writes, nothing deleted |
| Receipts (133) | the archive source copy and all 64 archive segments (65 objects, 107,737,670 bytes, 10:23:12 – 10:26:44 UTC) plus 68 lease renewals |
| Failed request | the 134th `PUT`, the archive manifest (1,781,363 bytes): the response was lost in the agent proxy path; no R2 precondition failure, no fence loss, no lost CAS |

Per the runbook, no blind retry. A second read-only dry run (10:27:20 – 10:30:34 UTC; 72 `GET`, 1 `HEAD`, 0 `PUT`) showed the real state: **66 done** (the manifest had landed with the planned bytes), **1 absent** (the archive pointer), **2 source** (the ledger copies untouched), 0 conflict; fence unchanged (pointer ETag and run match, `sync.json` `complete`, lease not active, archive pointer absent). Verdict READY, 3 writes pending. At this point the Worker still read the unsplit ledger and no archive was published: the stop was lossless.

## 6. Apply, second run (10:36:55 – 10:41:47 UTC): INSTALLED

Separate owner approval for the completing run given in the session at 10:36 UTC, Tasks still paused.

| Field | Value |
| --- | --- |
| Verdict | **INSTALLED** |
| Preflight | 66 done, 1 absent, 2 source, 0 conflict; fence as above; READY, 3 writes |
| Applied / skipped | 3 / 66 (`pointer`, `active-generation`, `active-root`) |
| Calls | 2 `HEAD`, 226 `GET`, 8 `PUT` (3 planned objects + 5 lease renewals), 0 refused writes, nothing deleted |
| Writes (UTC) | archive pointer `epg/discovery-archive/v1/current.json` (53 bytes) 10:41:15; generation copy of the active ledger 10:41:25 and root `epg/discovery-latest.json` 10:41:38, both 27,110,739 bytes, SHA-256 `8b6dd0d9…`, each by compare-and-swap on the source ETag |
| Post-check (Worker code over the S3 store) | `workerReadsActive` true, `activeItems` 19,821, `rootSha256Matches` true, `archivePointer` true |

Across both runs the 69 planned objects were written once each (the manifest's receipt is the dry-run confirmation); 161,959,201 bytes carry receipts and the 1,781,363-byte manifest was confirmed in place, 163,740,564 bytes in total, equal to the plan. The active ledger shrank from 63.4 MB to 27.1 MB on both copies.

## 7. Read-only MCP check (10:43 UTC)

- `epg_pipeline_status` (HTTP 200): `ledgerTotal` 53,346; `archive` block present: `manifestId` `187558f5-cf3c-40c3-87d3-fe36cd752d72`, `segments` 64, `activeItems` 19,821, `uniqueArchivedItems` 33,525, `items` 33,525, `bytes` 44,368,310; candidates 53,346, statuses verified 2,541 / no_confident_match 375 / ambiguous 33 / duration_mismatch 17 / excluded_nonfilm 138 / needs_verification 1 (equal to the plan's active decision counts). `archive.ledgerMode` reads `bounded`: this is the installed active ledger's own envelope field (the status route never reads the flag), not the runtime mode.
- `epg_status` (HTTP 200): run `b2699929…`, stage `complete`, remaining 0, failures 0.
- Continuation unchanged from stage 1: `running` at 06:56 UTC, `hopId` `caba9ff6…`, health `orphaned` with the lease expired; its next chunk belongs to phase 2d.

## 8. Not done (deliberately)

- `DISCOVERY_LEDGER_MODE` untouched (unset): the Worker's effective mode is `full`, which acts as `frozen` while an archive exists ([feature flags](../reference/feature-flags.md)); the next commit reads the split ledger and writes no archive.
- Both Scheduled Tasks still paused at the time of writing; resuming them with their original schedules is the owner's action, not this session's.
- No observation of a chunk or a daily commit yet (phase 2d), no `bounded` decision, no AIR-74 work, no other production write.

**Used by:** [AIR-222](https://trello.com/c/9Y4G9DG6), [ADR 0034](../adr/0034-bounded-discovery-ledger.md). **Superseded by:** none recorded.
