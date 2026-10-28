# Discovery ledger split: AIR-222 stage 1 (read-only audit, fresh snapshot, rehearsal), 28 October 2026

[AIR-222](https://trello.com/c/9Y4G9DG6) · stage 1 only, read-only. Follows the [AIR-221 rehearsal](discovery-ledger-split-rehearsal-2026-10-27.md) and corrects its plan. Procedure: [discovery-ledger runbook](../runbooks/discovery-ledger.md#offline-split-air-221-rehearsal) and [r2-snapshot-export runbook](../runbooks/r2-snapshot-export.md).

**Captured at:** 2026-10-28, 05:31–__TODO_END__ UTC, from the agent container, code at the AIR-222 branch on top of `main` `8d6b1ba`. **Scope:** the authoritative production bucket `iptv` through the read-only S3 exporter (`GET`/`HEAD`/`LIST` only, bucket-scoped read-only token, nothing written to R2), then an offline rehearsal on the private snapshot. **Evidence lifecycle:** dated measurement of this cut. **Operational authority:** none. No production write, flag, Task, lease, sync, discovery or D1 change was made; `applySplit` was not run against production.

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

**Write pattern of the bucket (listing at 06:50:28 UTC, objects modified in the previous 24 hours, by minute of the hour).** 658 objects. The hourly Task writes from about :17 to :50: prediction bundles (`enrichment/films/*`) at :18–:49, discovery decisions, catalogue, continuation and lease at :22–:23, run diagnostics, queue, profile and leases at :49–:50. The only quiet minutes are about :51 to :16, 25 minutes. The daily commit wrote the ledger, programme, watchlist and generation objects at 16:04–16:06 UTC on 27 October.

**Consequence.** Through the agent proxy the exporter sustains about 3.4 conditional `HEAD`s per second on checkpointed objects and about 1 object per second for a download. A fully checkpointed pass over 8,638 objects needs about 42 minutes, longer than the 25-minute quiet window, so without a pause of the hourly Scheduled Task a `consistent_fenced` cut cannot be produced from here; the [AIR-175 GO](d1-migration/air-175-r2-snapshot-identity-2026-10-26.md) was also taken under a Tasks freeze. Attempts 2 and 3 added only 32 objects to the checkpoint: the listing order puts the 7,104 prediction bundles first, and each attempt stops among them. Further attempts without a pause cannot reach the remaining ~4,700 objects either, so no attempt 4 was made. A Tasks freeze is a separate owner decision ([runbook](../runbooks/r2-snapshot-export.md#procedure-each-run-needs-its-own-approval)); it was not applied.

__TODO_SNAPSHOT_IDENTITY__

## 4. Rehearsal on the fresh snapshot

__TODO_REHEARSAL__

## 5. GO/NO-GO package for stage 2 (draft for the owner decision; nothing here is approved)

**What stage 2 would do.** Install an offline-planned split into production R2 while the Worker stays in `full` mode by flag, then (separately) set `DISCOVERY_LEDGER_MODE=bounded`. Each phase is a separate owner approval.

| Phase | Action | Preconditions | Writes | Abort / rollback |
| --- | --- | --- | --- | --- |
| 2a. Fresh cut | `r2-snapshot-export` → `consistent_fenced`, `--verify` | hourly Task paused for the window (owner), daily commit not inside it | none to R2 | NO-GO = stop |
| 2b. Plan | `discovery-ledger-split plan` on that cut, then `rehearse --heap` | plan `READY`, rehearsal `GO` on the same cut | none to R2 | NO-GO = stop |
| 2c. Install | `applySplit` against production through an approved writer (not yet built: an R2-binding adapter over the S3 API with `If-None-Match: *` / `If-Match`) | same published generation ETag as the cut (`E0`), `sync.json` not in `epg`, resolver lease free, no archive pointer; the hourly Task paused so no chunk reads during the ~70 MB of writes | 1 source copy (63 MB, write-once) + ≤64 segments + manifest + pointer (create-only) + 2 ledger copies (CAS) | any fence loss stops before the ledger copies are touched; a rerun completes or refuses; the source copy and the previous generation copies are never deleted |
| 2d. Observe in `frozen` | flag unset; next hourly chunk and status read the 24 MB active ledger; next daily commit runs the frozen path | 2c complete; MCP `epg_pipeline_status` shows `archive` block and `ledgerTotal` = source count | none by the operator | nothing to roll back: readers see active ∪ archive |
| 2e. `bounded` | set `DISCOVERY_LEDGER_MODE=bounded` (Worker variable) | 2d observed over ≥1 daily commit without `exceededMemory` on the commit path; owner approval | flag only | R1: set `frozen` (or unset). R2: offline reconstruction per the runbook, GO only within the Workers bound |

**Monitoring during 2c–2e (read-only):** `epg_pipeline_status` (`ledgerTotal`, `archive.manifestId`, `activeItems`), `epg_status` (stage, failures), Workers Observability `outcome = exceededMemory` per day on `POST /mcp`, R2 listing sizes of `epg/discovery-archive/v1/` and `epg/discovery-latest.json`.

**Risks the data rehearsal does not retire:**
- the first `frozen`/`bounded` commit in workerd: Node old space is relative; AIR-211 recorded commits killed at the same order of magnitude as today's full commit. Phase 2d exists to observe the frozen commit (127 MB in the synthetic model, 262 MB → 194 MB bounded on AIR-175) before `bounded` is set, without using a production commit as a memory experiment;
- the writer for 2c does not exist yet (the rehearsal's `applySplit` targets an R2 binding; production needs an S3-API adapter with the same conditional semantics, plus its own tests);
- a plan is bound to the ETags of its cut; a cut older than the next daily commit (16:00 UTC) is stale and must be redone.

**What the owner has to approve separately:** the Task pause window for 2a; the production writer and its credential for 2c; the install itself; the flag change for 2e.

**Used by:** [AIR-222](https://trello.com/c/9Y4G9DG6), [ADR 0034](../adr/0034-bounded-discovery-ledger.md). **Superseded by:** none recorded.
