# Discovery archive import: synthetic full-ledger parity (AIR-261)

**Captured:** 2026-10-28, from the agent container, on branch `claude/air-261-discovery-archive-import` (base `main` `49edea7`).
**Scope:** offline importer and D1 backfill executor reading the [ADR 0034](../../adr/0034-bounded-discovery-ledger.md) bounded discovery ledger. Synthetic Worker stores and local SQLite only. No R2 read, no production export, no D1 database, no flag or Task change.
**Card:** [AIR-261](https://trello.com/c/XeuDGZ8i), the discovery blocker 5 of the [AIR-74 offline GO/NO-GO](air-74-offline-go-no-go-2026-10-28.md).
**Verdict:** **synthetic GO for the importer**: a bounded snapshot imports the same discovery rows as the full ledger, and every listed archive defect stops the run before any write. **Real-snapshot replay not done**: no post-split fenced snapshot exists in this container, and a new production export needs its own owner approval.

## Method

`tests/discovery-archive-import.mjs` runs the same twelve daily scans through the Worker's own `publishGenerationWithLedger` twice: once with `DISCOVERY_LEDGER_MODE=full` and once with `bounded` from day 0. Two extra commits are killed after the archive pointer swap and before publication (crash window 3 of the ADR). The first is followed by a successful commit of the same scan, which leaves archive copies of keys that are still active. The second leaves `current.json` one manifest ahead of the published ledger.

Each store, plus a watchlist and a resolution with decisions on an active key, an archived key, a key in both and a key with no candidate, is written as a snapshot directory in the exporter layout. Both snapshots go through `scripts/offline-import.mjs` into separate SQLite files.

## Results

| Measure | Full snapshot | Bounded snapshot |
| --- | --- | --- |
| Active ledger items | 100 | 53 |
| Archived keys read (named manifest) | – | 80 |
| `alsoArchived` (active keys with an archive copy) | – | 33 |
| Unique archived keys | – | 47 |
| `ledgerTotal` (unique keys) | 100 | 100 |
| Segment versions read | – | 46 of 238 |
| Manifest versions read | – | 1 of 14 |
| Archive objects classified `unreferenced` | – | 205 |
| Run stopped / parity ok / unprojected | no / yes / 0 | no / yes / 0 |

`candidate_generation`, `candidate`, `candidate_show` and `candidate_decision` are equal row for row between the two databases, including observation JSON, evidence keys, activity and decision provenance. The decision on the archived key attaches to its archived candidate; the decision without a candidate stays class C `decision_without_candidate` in both. A rerun of the bounded snapshot applies 0 units.

The parity expectation reconstructs active ∪ archive with its own code, apart from the importer's reader, so a candidate the reader dropped would be reported missing.

## Fail-closed cases

Each case is the bounded snapshot with one change. Every one exits 3 with the stated reason and creates no database file.

| Change | Stop reason |
| --- | --- |
| a named segment version removed | `archive_segment_missing` |
| a named segment rewritten without updating the manifest | `archive_segment_sha256_mismatch` |
| the named manifest removed | `archive_manifest_missing` |
| a key copied into a second segment (manifest updated) | `archive_duplicate_key` |
| a payload whose key differs from its item key | `archive_segment_invalid` |
| `current.json` naming an unrelated manifest | `archive_pointer_conflict` |
| `current.json` removed | `archive_pointer_missing` |
| `uniqueArchivedItems` off by one | `archive_counts_mismatch` |
| one key dropped from `alsoArchived` | `archive_counts_mismatch` |
| a bounded ledger without `manifestId` | `archive_manifest_unnamed` |
| the root ledger differing from the published generation's copy | `discovery_ledger_copies_differ` |
| a key under `epg/discovery-archive/v2/` | `unknown_key` |

## Limits

- Synthetic scale: 100 candidates and 64 segments. The production archive held 107.7 MB in 64 segments after the AIR-222 install. The importer keeps the named segments in memory, as the runbook already requires for the whole snapshot.
- No real snapshot after the [AIR-222 install](../discovery-ledger-split-air-222-stage-2-2026-10-28.md) was replayed. That replay belongs to the next fenced cut, which needs a separate owner approval of the export.
- The snapshot exporter's fence does not include `current.json` yet ([runbook](../../runbooks/r2-snapshot-export.md)). The importer's pointer-chain check refuses a cut whose pointer is off the named manifest's chain; it does not prove the pointer was unchanged during the cut.
- Archive objects that no retained manifest references stay in R2 and are not imported. Their removal is a separate maintenance decision under ADR 0034.
