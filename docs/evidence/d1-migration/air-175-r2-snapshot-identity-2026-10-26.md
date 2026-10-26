# Production R2 snapshot identity (attempt 3, consistent_fenced)

**Captured:** 2026-10-26, 20:59:11.221–22:19:33.637 UTC (manifest `finishedAt` 22:19:31.757 UTC), code at `main` `13d1c2d` ([PR #131](https://github.com/vladimino/iptv-watchlist/pull/131) exporter fix), `node scripts/r2-snapshot-export.mjs --output <private absolute path>` and `--verify` on the owner's machine  
**Scope:** the full authoritative production bucket `iptv`, read through a bucket-scoped **Object Read only** R2 API token while both Scheduled Tasks were frozen; `GET`/`HEAD` only, no write to R2, D1, Access, flags or Scheduled Tasks  
**Verdict:** **GO** — `consistent_fenced`; the independent `--verify` reproduced the same aggregate SHA-256 and status  
**Used by:** [AIR-175](https://trello.com/c/iYS0Lq9e); the single shared baseline for [AIR-169](https://trello.com/c/pFtiCeYW) and [AIR-74](https://trello.com/c/5AdAmKPe)

This page holds aggregates and identities only. The snapshot (object bytes, manifest, listing pages, reports) stays in one private, write-protected directory outside the repository; consumers receive its path privately from the owner. The procedure is [r2-snapshot-export.md](../../runbooks/r2-snapshot-export.md); attempts 1 and 2 and the root cause of their NO-GO are on the [previous page](air-175-r2-snapshot-2026-10-26.md).

## Snapshot identity

| Field | Value |
| --- | --- |
| Status (export, manifest, `--verify`) | `consistent_fenced` ×3, `noGoReasons` empty |
| Objects / bytes | 7,994 / 581,345,885 |
| Aggregate SHA-256 (export = manifest = `--verify`) | `f71eee103b8e45a696def1805d050454bf3721e0cd688dc041c16bddcc0bdeb3` |
| SHA-256 of `manifest.json` | `c26e04536ff2ebc047e731ad0b0e39eed51a9550bc921f457026de06c7b1865a` |
| Manifest `startedAt` / `finishedAt` | 2026-10-26T20:59:11.221Z / 2026-10-26T22:19:31.757Z |
| Listing pages | 8 |

The snapshot is consistent **at `finishedAt`** only. R2 keeps changing after it; a future cutover needs a new fenced inventory and delta (ADR-0019).

## Baseline identity

Read from the downloaded bytes; these label the cut, they are not a change log.

| Field | Value |
| --- | --- |
| Published EPG `programmeRunId` | `23570366-3f26-4dc2-a6e2-7ddfc2588fef` |
| `sync.json` `updatedAt` | 2026-10-26T15:58:00.750Z |
| Resolver continuation `at` / `hopId` | 2026-10-26T20:01:14.904Z / `48d58aaf-3d9c-4262-8fc4-6105078b11dc` |
| Latest enrichment run | `360555d3-c89d-478b-bf2a-b3eb2a510166` |

## Consistency proof

| Check | Result |
| --- | --- |
| Opening listing | Complete, 8 pages |
| Conditional reads | Every object: `HeadObject` `If-Match` before, `GetObject` `If-Match` with ETag and length check, `HeadObject` `If-Match` after; raw SHA-256 of the stored bytes |
| Closing listing vs opening | Equal: 0 changes (no `added_after`, `metadata_changed` or `missing_after`) |
| Fence (7 keys after the closing listing) | `ok` |
| Resumed objects | 0 (fresh download) |
| `--verify` | Re-read every stored object against the manifest: 7,994 objects, 581,345,885 bytes, same aggregate, fence `ok` |

## Prefixes

| Prefix | Objects | Bytes |
| --- | --- | --- |
| `enrichment/` | 7,623 | 18,731,157 |
| `epg/` | 33 | 557,331,662 |
| `events/` | 303 | 160,256 |
| root | 8 | 5,117,003 |
| `started/` | 27 | 5,807 |

## Requests

| Kind | Count |
| --- | --- |
| `ListObjectsV2` | 16 (8 opening + 8 closing) |
| `HeadObject` | 15,995 (2 per object + 7 fence) |
| `GetObject` | 7,994 |

No `401`/`403`, no protocol error, no NO-GO. Wall time 80 min 22 s from the operator's machine.

## Limits

- The freeze covered future scheduled runs; this page does not claim that no other writer existed. The proof is the equal listings, the per-object conditional reads and the fence, not the freeze.
- The snapshot authorizes no import, D1 write or cutover. Restoring the Scheduled Tasks is a separate coordinator action under the owner's decision.
