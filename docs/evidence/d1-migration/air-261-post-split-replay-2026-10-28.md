# Discovery archive import: replay on the real post-split snapshot (AIR-261)

**Captured:** 2026-10-28, 17:22–19:16 UTC, in the agent container; code at `main` `dbe61af` (with [PR #207](https://github.com/vladimino/iptv-watchlist/pull/207), `a149842`).  
**Input:** the private production snapshot taken for [AIR-74](https://trello.com/c/5AdAmKPe) at 16:49–16:57 UTC ([materialization validate evidence](../prediction/air-74-materialization-validate-2026-10-28.md)): `consistent_fenced`, 9,142 objects, 738,204,085 bytes, aggregate `2ce0866d07211afe969f8c0c02949079f7a6fae77d08c8333f08f5266385dd8c`, `manifest.json` SHA-256 `929579b71b1d8944e76f31140efaec7a50e98a57d45e1fe6b577f84b8f4835ba`. Re-verified offline first (`--verify` re-hashes every object). It is post-split: the active ledger reads `ledgerMode: frozen`, and `epg/discovery-archive/v1/` holds the pointer, one manifest, 64 segments and the source-ledger copy (67 keys, 109,519,086 bytes). The pre-split cut `23d2e9d7…` serves only as the reference for the no-loss check below.  
**Scope:** private files and local SQLite only. No new export, no R2 or D1 request, no flag, Task or migration change.  
**Card:** [AIR-261](https://trello.com/c/XeuDGZ8i); follows the [synthetic parity evidence](air-261-discovery-archive-import-2026-10-28.md).  
**Verdict:** **GO for the discovery archive.** The importer reconstructs the full discovery family from the active ledger and the published archive, matches an independent reconstruction exactly, loses nothing that the pre-split full ledger held, and is idempotent. **This is not a G5 GO**: three blockers in other families remain (section 4), one of them new.

Aggregates only. Ledgers, reports, SQLite files and the acknowledged list stay private; no candidate, title or film id is reproduced here.

## 1. Archive reconstruction, independent of the importer

A private script read the raw snapshot objects without importer code: the root active ledger and its generation copy, the manifest the active ledger names and exactly that manifest's segments, active record winning.

| Check | Result |
| --- | --- |
| Root and generation copies of the active ledger | byte-identical |
| Archive pointer `current.json` | names manifest `187558f5…`, the manifest the active ledger names |
| Manifest | 64 segments, all present, **64/64 SHA-256 match**, 33,525 items, 0 keys in two segments |
| Active ledger | 22,512 items; `archive.uniqueArchivedItems` 31,471, `alsoArchived` 2,054 (both equal the segment contents) |
| Reconstructed family | **53,983** keys = 22,512 active + 31,471 archive-only |
| Against the pre-split full ledger (53,346 keys) | **0 missing**; 637 keys new since the split; all 31,471 archive-only records **identical** to the pre-split records; the 21,875 pre-split keys still active were refreshed by later commits |

## 2. Offline importer (`offline-import.mjs`)

| Run | Window (UTC) | Result |
| --- | --- | --- |
| A, `main` as is | 17:23:44–17:24:20 | **stopped `unknown_key`** before any write: 38 keys under `enrichment/films/<id>/fingerprints/<sha256>.json` (19) and `…/fingerprint-generations/<sha256>-s1-p1.json` (19), the immutable fingerprint storage that `FINGERPRINT_VERSION_OBJECTS=on` writes since AIR-210. The discovery archive was read correctly in the same run (`discoveryArchive`: bounded, active 22,512, archived 33,525, ledger total 53,983, referenced 1 manifest and 64 segments, 0 unreferenced, pointer present) |
| B1, test-only classification | 17:25–18:04 | completed, see below |
| B2, rerun | 18:04:50–18:15:31 | **applied 0**, resumed 31,481, identical counts |
| B3, rerun | 18:15:31–18:27:05 | **applied 0**, resumed 31,481, identical counts |

Runs B1–B3 used a **test-only, uncommitted** change that lists those two key patterns as R2-only so that the replay could reach the discovery family. It is not a disposition decision; the fingerprint family needs its own mapping (blocker 1 below).

Run B1: coverage 9,142 = 5,174 mapped + 3,968 R2-only, 0 unmapped; 31,481 units applied, 31,481 receipts `matching`, 0 stale or foreign, 0 conflicts; identity 6,285 direct, 2 via metadata TMDB id; discovery evidence 99 stored, 63,041 derived, 122 `stale_evidence`.

**Discovery tables against the reconstruction** (SQLite after B1):

| Table | Rows | Check |
| --- | --- | --- |
| `candidate` | 53,983 | equals the reconstructed key set: 0 only in the reconstruction, 0 only in SQLite |
| `candidate_generation` | 53,983 | one published generation (`fc7e7d74…`) |
| `candidate_show` | 37,163 | in parity |
| `candidate_decision` | 9,279 | source map holds 9,281 entries: one is a plain string, not a decision object, and was present before the split; one `verified` decision is class C `film_unresolved` |

Parity: denominator 85,176, **0 missing, 0 mismatched**; 287 extra rows, all `prediction_current` (bundles whose `current` the live writer linked while the `history` is unlinked), not discovery.

## 3. D1 executor dry-runs (`d1-backfill.mjs --target sqlite`)

Plain and `--staged-generation`, each on its own new database from `0001`–`0003`, three runs each, with a dry-run acknowledged list of the 39 class C records (not owner-approved), same test-only classification.

| Path | Run 1 (18:27–18:59 UTC) | Runs 2 and 3 |
| --- | --- | --- |
| plain | `stopped: class_a_blocker` (`prediction_version_object_missing`); 21,875 applied, 11,958 pending, 21,876 receipts matching, 0 conflicts, coverage 0 unmapped | applied **0**, resumed 21,875, identical |
| staged | identical; `staged.gate` 0 commits (not a pass) | applied **0**, identical |

The executor reads the archive through the same preparation (no archive stop, full coverage), but it stops at the first prediction bundle before it reaches the discovery units, so its databases hold no candidate rows. The discovery parity above therefore rests on the importer, which shares the import code; the executor's discovery and generation units on this baseline remain to be proven after the prediction blocker is gone.

## 4. Blockers outside the discovery archive (not AIR-261)

1. **Immutable fingerprint storage keys are unknown to the importer (new).** 38 keys from AIR-210's `FINGERPRINT_VERSION_OBJECTS=on`; `main` fails closed on them. They need a mapping (or a declared disposition) in the importer, comparable to prediction version objects.
2. **Prediction version objects** (class A): 2,330 records unportable (2,043 `current`, 287 `history`) until the approved materialization is applied and reconciled.
3. **Class C** 39 `film_unresolved` records need the owner's acknowledged list.

## Limits

- Offline only; consistent at the snapshot's `finishedAt` (16:57:40 UTC).
- One manifest generation only: the daily commit after the split ran in `frozen` mode and wrote no new manifest, so the chain of `parentManifestId` was exercised synthetically ([synthetic evidence](air-261-discovery-archive-import-2026-10-28.md)), not on production data.
- The executor did not reach the discovery units on this baseline (section 3).
