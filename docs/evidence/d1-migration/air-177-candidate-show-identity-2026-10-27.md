# Candidate show identity: offline import of the production snapshot on schema v3

**Captured:** 2026-10-27, 08:00:04–08:58:46 UTC, offline on the owner's machine; code of the AIR-177 branch (base `main` `e3ebafa`, [ADR-0025](../../adr/0025-candidate-show-identity.md), migration `0003`)  
**Command:** `node scripts/offline-import.mjs --snapshot <private snapshot> --database <private SQLite>`, run three times on the same new database (created from `0001`–`0003`)  
**Input:** the [AIR-175 snapshot](air-175-r2-snapshot-identity-2026-10-26.md), re-verified offline first: `consistent_fenced`, 7,994 objects, aggregate `f71eee103b8e45a696def1805d050454bf3721e0cd688dc041c16bddcc0bdeb3`, `manifest.json` SHA-256 `c26e04536ff2ebc047e731ad0b0e39eed51a9550bc921f457026de06c7b1865a`, fence ok, still write-protected  
**Scope:** private SQLite only; no Cloudflare D1, R2 request, Worker, Scheduled Task, flag or Access change  
**Verdict:** **blocker 1 of the [dry-runs after ADR-0022](air-74-real-baseline-dry-run-2026-10-27.md) is resolved**: the programme-generation unit applies with every differing candidate show, nothing is missing from parity, and reruns are idempotent. The other AIR-74 blockers (scale, prediction version objects, class C) are unchanged  
**Used by:** [AIR-177](https://trello.com/c/9wYN9k58), [AIR-74](https://trello.com/c/5AdAmKPe)

Aggregates only; titles, slots and keys stay in the private database.

## Result against the previous run

| Measure | Before (main `29fc0d1`, schema v1) | After (AIR-177, schema v3) |
| --- | --- | --- |
| Programme-generation unit | `conflict: unapplied` (`UNIQUE constraint failed: candidate_show`) | **applied** |
| Units applied / receipts matching | 21,520 / 21,520 | **30,504 / 30,504** |
| Conflicts | 8,984 (1 generation + 8,983 decisions) | **0** |
| Parity missing (of 82,148) | 60,627 (51,643 `candidate_generation`, 8,983 `candidate_decision`, 1 `programme_generation`) | **0** |
| Parity mismatched | 4: `fingerprint_payload`, `film_show`, `film_generation`, `published_generation` | 1: `fingerprint_payload` (the one `fingerprint_kept` explanation, unchanged) |
| Class A blockers | `prediction_family_unportable` | `prediction_family_unportable` (unchanged) |
| Class C | 36 `film_unresolved` | 36 `film_unresolved` (unchanged) |
| Discovery evidence | stored 65, derived 60,482, `stale_evidence` 79 | the same |
| Reruns 2 and 3 | `applied: 0` | **`applied: 0`, `resumed: 30,504`**, identical parity and classes |

## The stored generation

| Table | Rows |
| --- | --- |
| `candidate_generation` | 51,643 |
| `candidate_show` | 32,400, every candidate show of the source (the source has no exact repeat) |
| Slots holding two entries | 4 slots, 8 rows, in 3 candidates (same channel, start and end; different EPG title) |
| `candidate_decision` | 8,983 (the 8,984th decision is the class C `film_unresolved` one) |
| `film_show` | 902 (no film-show overlap in this baseline) |
| Schema version | 3 |

The independent candidate-show parity (each candidate's distinct source entries against the stored rows) reports no mismatch.

## Limits

- This is the offline importer, which shares the importer, repositories and parity code with the executor but neither stops on class C nor stages the generation. The staged path at this scale is AIR-178; the executor dry-run waits for the remaining AIR-74 decisions.
- Run 1 took 46 minutes on the owner's machine; reruns 6 minutes each.
- The counts apply to the snapshot's `finishedAt`.
