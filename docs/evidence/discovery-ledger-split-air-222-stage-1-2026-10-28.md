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
| 2 | 06:42 – __TODO__ | __TODO__ |

__TODO_SNAPSHOT_IDENTITY__

## 4. Rehearsal on the fresh snapshot

__TODO_REHEARSAL__

## 5. GO/NO-GO package for stage 2

__TODO_PACKAGE__

**Used by:** [AIR-222](https://trello.com/c/9Y4G9DG6), [ADR 0034](../adr/0034-bounded-discovery-ledger.md). **Superseded by:** none recorded.
