# Discovery ledger split: AIR-222 stage 1 (read-only audit, fresh snapshot, rehearsal), 28 October 2026

[AIR-222](https://trello.com/c/9Y4G9DG6) · stage 1 only, read-only. Follows the [AIR-221 rehearsal](discovery-ledger-split-rehearsal-2026-10-27.md) and corrects its plan. Procedure: [discovery-ledger runbook](../runbooks/discovery-ledger.md#offline-split-air-221-rehearsal) and [r2-snapshot-export runbook](../runbooks/r2-snapshot-export.md).

**Captured at:** 2026-10-28, 05:31–08:29 UTC, from the agent container; exporter at `main` `e7c9214` (with [PR #186](https://github.com/vladimino/iptv-watchlist/pull/186)), split tool at the AIR-222 branch on top of that `main`. **Scope:** the authoritative production bucket `iptv` through the read-only S3 exporter (`GET`/`HEAD`/`LIST` only, bucket-scoped read-only token, nothing written to R2), then an offline rehearsal on the private snapshot. **Evidence lifecycle:** dated measurement of this cut. **Operational authority:** none. No production write, flag, Task, lease, sync, discovery or D1 change was made; `applySplit` was not run against production.

## 1. Read-only inventory (listing at 06:42:07 UTC)

| Item | Value |
| --- | --- |
| Objects / bytes | 8,626 / 628.3 MB (AIR-175, 26 Oct: 7,994 / 554.4 MB) |
| Published generation | `b2699929-0d83-4e8f-93f7-1f17de0edc24`, `phase: published`; generations kept under `epg/generations/`: 8, 515.2 MB |
| `epg/discovery-latest.json` (root) | 63,369,360 bytes, last modified 2026-10-27T16:06:16Z |
| `epg/generations/<P>/discovery-latest.json` | 63,369,360 bytes, **same ETag as the root**, last modified 2026-10-27T16:05:34Z |
| `epg/discovery-before-canonical.json` | 19.7 MB (a pre-canonicalization copy; not read by the Worker) |
| `epg/discovery-resolution.json` | 1,464,300 bytes, last modified 06:23:04Z (the 06:20 hourly run) |
| `epg/discovered-films.json` | 6,032,452 bytes, last modified 06:23:01Z |
| `programme.json` | 2,236,877 bytes, last modified 2026-10-27T16:06:22Z |
| `epg/discovery-archive/v1/current.json` | **absent**; no key under `epg/discovery-archive/` |
| `sync.json` | run `b2699929…`, stage `complete`, updated 2026-10-27T16:06:38Z |
| `epg/resolver-lease.json` | present, expired 06:24:41Z (no active discovery writer at listing time) |
| `enrichment/runner-lease.json` | present, active until 06:56:45Z (the hourly prediction runner) |
| `enrichment/writer-lease.json` | present, no expiry |

Reading: the full ledger is 63.4 MB and unchanged since the 27 October 16:06 UTC commit; the daily EPG commit is the only writer of it. The hourly Task (nominal :20 Europe/Madrid) writes decisions, the catalogue, continuation and prediction objects between about :22 and :27 every hour. The archive does not exist: production is in `full` mode by data as well as by flag, matching the MCP baseline in the card (`ledgerTotal` 53,346, no `archive` block).

## 2. Worker memory telemetry (Workers Observability, read-only)

Invocations of service `iptv` with outcome `exceededMemory`, all on `POST /mcp` from the Scheduled Task client (`openai-mcp/1.0.0 (Codex)`):

| Day (UTC) | Kills |
| --- | ---: |
| 26 Oct | 16 |
| 27 Oct | 5 |
| 28 Oct, to 07:00 | 6 |

Wall time of the killed calls reaches 65 s. The invocation metadata does not name the MCP tool, so this page does not attribute the kills to the discovery chunk or the prediction runner; the AIR-224 RCA owns that. What this page takes from it: production MCP calls are being killed by memory today, on the full ledger, and the first bounded commit is therefore not an experiment to run in production.

## 3. Fresh fenced snapshot

Exporter `scripts/r2-snapshot-export.mjs` at `main` `8d6b1ba`, output in a private directory outside the repository, `NODE_USE_ENV_PROXY=1`.

| Attempt | Window (UTC) | Result |
| --- | --- | --- |
| 1 | 05:31:12 – 06:39:25 | **NO-GO** `source_changed`: a film's `predictions.json` listed at 05:31 was no longer current when reached (the 06:20 hourly run rewrote it). 3,950 objects downloaded and checkpointed, 7,901 conditional `HEAD`s, 3,950 conditional `GET`s. No manifest. |
| 2 | 06:41:18 – 06:49:45 | **NO-GO** `source_changed` after 1,625 conditional `HEAD`s and 14 `GET`s: another film's `predictions.json` changed between the opening listing and its read, at about 06:45–06:49, outside the :22–:27 window assumed above. |
| 3 | 06:50:20 – 07:02:49 | **NO-GO** `source_changed` after 2,361 `HEAD`s and 18 `GET`s: a third film's `predictions.json` changed at about 07:00. |
| 4 | 07:38:00 – 07:38:47 | `--concurrency 16` (PR #186 merged as `e7ba32d`). **NO-GO** `source_changed` after 48 s: the owner's prediction recalculation was writing a bundle every minute or two. |
| 5 | 08:16:38 – 08:22:41 | `--concurrency 16`, started by a read-only watcher after 4.3 minutes without any write (the recalculation had stopped on its quota at 08:12). **GO: `consistent_fenced`.** |

**Write pattern of the bucket (listing at 06:50:28 UTC, objects modified in the previous 24 hours, by minute of the hour).** 658 objects. The hourly Task writes from about :17 to :50: prediction bundles (`enrichment/films/*`) at :18–:49, discovery decisions, catalogue, continuation and lease at :22–:23, run diagnostics, queue, profile and leases at :49–:50. The only quiet minutes are about :51 to :16, 25 minutes. The daily commit wrote the ledger, programme, watchlist and generation objects at 16:04–16:06 UTC on 27 October.

**Consequence.** Through the agent proxy the sequential exporter sustains about 3.4 conditional `HEAD`s per second on checkpointed objects and about 1 object per second for a download: a full pass needs about 70 minutes and a checkpointed one about 42, both longer than the quiet window. The [AIR-175 GO](d1-migration/air-175-r2-snapshot-identity-2026-10-26.md) had been taken under a Tasks freeze. The owner declined a freeze (a prediction recalculation of about 180 films was running) and chose a faster read-only exporter instead: [PR #186](https://github.com/vladimino/iptv-watchlist/pull/186) added `--concurrency` (1..16; per-object proof, listings, fence and manifest unchanged). With 16 workers a full pass takes 6 minutes. A read-only watcher (LIST every 90 s) started attempt 5 once the bucket had been quiet for 4 minutes.

**Snapshot identity (attempt 5).**

| Field | Value |
| --- | --- |
| Status (export, manifest, `--verify`) | `consistent_fenced` ×3, `noGoReasons` empty, 0 listing changes, fence ok |
| Objects / bytes | 8,723 / 659,175,433 (AIR-175: 7,994 / 581,345,885) |
| Aggregate SHA-256 | `23d2e9d7a705cee62d115f4cc2887b5728bdccc1893ce284b8a07b99547da6fa` |
| SHA-256 of `manifest.json` | `76409e3441b16b2302a9112fa5ec471585b4e56f593757ab65190b3fa6b5d9c0` |
| `startedAt` / `finishedAt` | 2026-10-28T08:16:38.648Z / 2026-10-28T08:22:41.617Z; 9 listing pages |
| Calls | 9 + 9 `LIST`, two conditional `HEAD`s and one conditional `GET` per object, 7 fence `HEAD`s; no write |
| Published generation | `b2699929-0d83-4e8f-93f7-1f17de0edc24` (unchanged since 27 Oct 16:06 UTC) |
| `sync.json` `updatedAt` | 2026-10-27T16:06:38.614Z |
| Continuation `at` / `hopId` | 2026-10-28T06:56:21.334Z / `caba9ff6…` |
| Latest enrichment run | `294dd99f…` |

The snapshot directory is write-protected and stays private outside the repository. By the owner's decision of 28 October it is also the immutable read-only baseline for the offline [AIR-74](https://trello.com/c/5AdAmKPe) work, which runs in the same session; AIR-74 re-verifies it first. It is consistent at `finishedAt` only.

## 4. Rehearsal on the fresh snapshot

`node scripts/discovery-ledger-split.mjs rehearse --snapshot <private> --output <private> --heap` with the corrected plan (section 1 of the [runbook](../runbooks/discovery-ledger.md#offline-split-air-221-rehearsal): source copy first, archive, pointer, then both ledger copies). 308 s, peak RSS 1.65 GB, in this container.

**Plan: READY**, no stop: 0 duplicate keys, 0 unmarked records, 0 active records of another run, 0 non-canonical keys on either side; the root ledger equals its generation copy.

| | Candidates | Size | Activity | Decisions |
| --- | ---: | ---: | --- | --- |
| Source ledger | 53,346 | 63.4 MB | 17,388 current, 2,609 historical, 33,349 expired | 3,554 verified, 4,934 `excluded_nonfilm`, 735 other, 44,123 none |
| Active (the published scan) | 19,821 | 27.1 MB | 17,388 current, 2,433 historical | 2,541 verified, 138 `excluded_nonfilm`, 426 other, 16,716 none |
| Archived | 33,525 | 44.4 MB in 64 segment versions (largest 0.76 MB), manifest 1.8 MB | 33,349 expired, 176 historical | 1,013 verified, 4,796 `excluded_nonfilm`, 309 other, 27,407 none |

Compared with the AIR-175 cut two days earlier: +1,703 candidates in the ledger, +1,931 active (the published scan is larger), −228 archived; 0 candidates match the current non-film screen without an `excluded_nonfilm` decision (18 on AIR-175). The plan is 69 writes, 163.7 MB: the 63.4 MB source copy, 64 segments, the manifest, the pointer and two 27.1 MB ledger copies.

| Check | Result |
| --- | --- |
| Install | 69 writes. Boundary exact (19,821 active). The Worker's own `loadJSON` returns the installed active ledger (`ledgerMode: bounded`); root and generation copy are byte-equal; the source copy equals the source ledger byte for byte. Decisions untouched |
| Reconstruction (R2 rollback) | 53,346 of 53,346 payloads equal: 0 missing, 0 differing, 0 extra. `ledgerTotal` 53,346 = source |
| Replay | 0 writes, 69 skipped |
| Resume | Kill after writes 1 (source copy), 33, 65 (last segment), 66 (manifest), 67 (archive pointer) and 68 (generation copy): each stopped, resumed and was byte-identical; `ledgerTotal` stayed 53,346 while stopped |
| Refusals | 6 of 6 refused with 0 planned writes: published generation changed, source ledger changed, EPG commit in progress, lease held, conflicting archive object, corrupt planned object |
| Next commit, `bounded` | 20,506 scanned: 992 leave, 1,677 return. Parity exact over 53,346 keys, boundary exact, `alsoArchived` 1,677 = leftover copies of the returning candidates, `ledgerTotal` = full mode, all 1,677 re-entered from the archive, decisions untouched, 2 manifests |
| Next commit, flag unset (`frozen`) | Starts from the 19,821 active candidates (21,498 after the scan), reads no source copy, writes nothing to the archive; parity exact over 53,346 keys, counts exact, decisions untouched |
| Chunk after the commit | HTTP 200 in all modes; 0 active decisions differ; 0 archived decisions differ (23 on AIR-175); 0 archive reads |
| Old space, commit (full / frozen / bounded) | 270 / 139 / 135 MB |
| Old space, chunk (full / frozen / bounded) | 178 / 95 / 91 MB |

**Verdict on the fresh cut: GO for the data split**, the same as AIR-221 on the older cut, now with the plan the Worker actually reads. The memory rows are Node old space, relative: the first commit after a split halves (270 → 139 MB frozen) and the chunk roughly halves (178 → 95 MB); neither number is a Workers isolate measurement.

## 5. GO/NO-GO package for stage 2 (for the owner decision; nothing here is approved)

**What stage 2 would do.** Install an offline-planned split into production R2 while the Worker stays in `full` mode by flag, then (separately) set `DISCOVERY_LEDGER_MODE=bounded`. Each phase is a separate owner approval.

| Phase | Action | Preconditions | Writes | Abort / rollback |
| --- | --- | --- | --- | --- |
| 2a. Fresh cut | `r2-snapshot-export` → `consistent_fenced`, `--verify` | hourly Task paused for the window (owner), daily commit not inside it | none to R2 | NO-GO = stop |
| 2b. Plan | `discovery-ledger-split plan` on that cut, then `rehearse --heap` | plan `READY`, rehearsal `GO` on the same cut | none to R2 | NO-GO = stop |
| 2c. Install | `applySplit` against production through an approved writer (not yet built: an R2-binding adapter over the S3 API with `If-None-Match: *` / `If-Match`) | same published generation ETag as the cut (`E0`), `sync.json` not in `epg`, resolver lease free, no archive pointer; the hourly Task paused so no chunk reads during the 164 MB of writes | 1 source copy (63.4 MB, write-once) + 64 segments (44.4 MB) + manifest (1.8 MB) + pointer (create-only) + 2 ledger copies of 27.1 MB (CAS) | any fence loss stops before the ledger copies are touched; a rerun completes or refuses; the source copy is never deleted |
| 2d. Observe in `frozen` | flag unset; next hourly chunk and status read the 24 MB active ledger; next daily commit runs the frozen path | 2c complete; MCP `epg_pipeline_status` shows `archive` block and `ledgerTotal` = source count | none by the operator | nothing to roll back: readers see active ∪ archive |
| 2e. `bounded` | set `DISCOVERY_LEDGER_MODE=bounded` (Worker variable) | 2d observed over ≥1 daily commit without `exceededMemory` on the commit path; owner approval | flag only | R1: set `frozen` (or unset). R2: offline reconstruction per the runbook, GO only within the Workers bound |

**Monitoring during 2c–2e (read-only):** `epg_pipeline_status` (`ledgerTotal`, `archive.manifestId`, `activeItems`), `epg_status` (stage, failures), Workers Observability `outcome = exceededMemory` per day on `POST /mcp`, R2 listing sizes of `epg/discovery-archive/v1/` and `epg/discovery-latest.json`.

**Risks the data rehearsal does not retire:**
- the first `frozen`/`bounded` commit in workerd: Node old space is relative; AIR-211 recorded commits killed at the same order of magnitude as today's full commit. On this cut the model gives 270 MB for today's full commit against 139 MB frozen and 135 MB bounded, and 178 → 95 MB for the chunk. Phase 2d exists to observe the frozen commit before `bounded` is set, without using a production commit as a memory experiment;
- the writer for 2c does not exist yet (the rehearsal's `applySplit` targets an R2 binding; production needs an S3-API adapter with the same conditional semantics, plus its own tests);
- a plan is bound to the ETags of its cut; a cut older than the next daily commit (16:00 UTC) is stale and must be redone.

**What the owner has to approve separately:** the Task pause window for 2a; the production writer and its credential for 2c; the install itself; the flag change for 2e.

## 6. Stage 2 preflight (28 October, 09:48–10:07 UTC), read-only

With both Scheduled Tasks paused by the owner at 09:48 UTC (verified by the owner's peek), this session checked the bucket for quiescence and re-cut it:

- listing at 09:51:46 UTC: 8,723 objects; the resolver lease expired at 06:58 UTC, the runner lease at 08:27 UTC, no writer lease; `sync.json` stage `complete`; archive pointer absent; the ledger and its generation copy unchanged since 27 October 16:06 UTC;
- a second export with `--concurrency 16` (09:52–10:00 UTC, no checkpoint reuse): `consistent_fenced`, 8,723 objects, **the same aggregate `23d2e9d7…`** as the 08:22 UTC cut, 0 listing changes, fence ok. The bucket is byte-identical to the cut the plan was made from, so the plan of section 4 applies unchanged;
- `discovery-ledger-install.mjs --dry-run` against production (read-only credential, 72 `GET`s, 1 `HEAD`, 0 writes): 67 planned objects absent, the 2 ledger copies still at the source version, 0 conflicts; published pointer ETag and run match the plan, `sync.json` `complete`, no active lease, archive pointer absent: **READY**, 69 writes (163.7 MB) pending.

Not done: no `--apply`, no write credential exists in this session, no flag change. The apply needs the separate approvals in section 5 and the [runbook's stage 2 section](../runbooks/discovery-ledger.md#stage-2-install-owner-approval-required-for-every-run-that-writes).

**Used by:** [AIR-222](https://trello.com/c/9Y4G9DG6), [ADR 0034](../adr/0034-bounded-discovery-ledger.md). **Superseded by:** none recorded.
