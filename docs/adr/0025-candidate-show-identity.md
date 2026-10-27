# ADR 0025: A candidate show is identified by its whole EPG entry, and every differing entry is kept

**Status:** Accepted (owner decision 2026-10-27; design and code only, it authorizes no D1 migration on the scratch or target database, no production write, flag or Task change)  
**Original decision date:** 2026-10-27  
**Recorded at:** 2026-10-27  
**Approval source:** owner decision on [AIR-74](https://trello.com/c/5AdAmKPe) recorded in [AIR-177](https://trello.com/c/9wYN9k58): keep **all** differing candidate shows, identify a show by channel, start, end and EPG title, collapse exact duplicates deterministically, never pick one of two conflicting shows  
**Related work:** [AIR-177](https://trello.com/c/9wYN9k58), [AIR-74 dry-runs after ADR-0022](../evidence/d1-migration/air-74-real-baseline-dry-run-2026-10-27.md), [ADR-0001](0001-d1-schema-v1.md), [ADR-0019](0019-live-d1-backfill-boundaries.md), [ADR-0021](0021-staged-atomic-generation-import.md)  
**Supersedes:** None (a new numbered migration, as [ADR-0001](0001-d1-schema-v1.md) prescribes for a later schema shape)  
**Superseded by:** None

## Context

Schema v1 keys `candidate_show` by `(programme_run_id, observation_key, channel_id, start_ms)`, and schema v2 keys `stage_candidate_show` the same way. The EPG can list two entries for one channel slot. In the AIR-175 production baseline, three candidates carry four shows that share channel, start **and end** with another show of the same candidate and differ only in the EPG title. The single programme-generation unit therefore failed on `UNIQUE constraint failed: candidate_show`, and with it 51,643 candidate rows and 8,983 decisions ([evidence](../evidence/d1-migration/air-74-real-baseline-dry-run-2026-10-27.md)). The staged planner refuses the same rows as a repeated key. In R2 both entries are kept in the discovery ledger.

## Decision

1. **Identity.** A candidate show is the whole EPG entry: `channel_id`, `start_ms`, `end_ms` and `epg_title`, within its programme run and observation. Two entries that differ in any of these are two shows, and both are stored. The channel display name (`channel`) is not part of the identity.
2. **Exact repeats.** Entries with the same identity are one show. All writers keep one, deterministically: entries are ordered by channel, start, end, EPG title and channel display name (missing values first), and the first of each identity is kept (`distinctCandidateShows` in `src/epg-repository.js`, used by the shared generation projection, the replay comparison and the readers). Nothing is chosen between differing entries.
3. **Schema v3.** Migration `0003` rebuilds `candidate_show` and `stage_candidate_show` with the same columns, without the narrow primary key, and adds unique indexes over `(programme_run_id, observation_key, channel_id, start_ms, IFNULL(end_ms, -1), IFNULL(epg_title, char(0)))`. A missing end or title maps to a value no real entry has, so an entry without one is still unique and an exact repeat is refused. Rows are copied; no other table references either table. `0001` and `0002` are not rewritten.
4. **Every run requires schema v3.** The backfill executor (plain and staged), the offline importer and the scratch G4 harness require migrations `0001`–`0003` and schema version 3; an older database stops with `schema_missing` or `schema_version_mismatch` before any write.
5. **Parity checks shows independently.** The importer's parity reads each candidate's source shows itself, keeps every distinct entry once and compares that set with the stored rows (`candidate_show` mismatch).

## Alternatives considered

- **Keep one of the conflicting entries and ledger the others as class C.** Rejected by the owner: it drops real EPG entries.
- **Refuse the whole generation as a source-quality failure.** Rejected: it blocks the import for an ordinary EPG overlap.
- **Widen the primary key with `end_ms` and `epg_title`.** Not possible as such: both are nullable, and SQLite treats NULLs in a key as distinct, so exact repeats without an end or title would not be refused.
- **Add a computed `show_key` column.** Rejected: every writer and reader would have to compute it identically; the expression index keeps the columns unchanged.

## Consequences

The generation unit carries every EPG entry the source has. Writers and readers stay column-compatible. A database must be migrated to v3 before any run, which needs its own owner approval on the scratch and target databases. The staged chunk plan and the commit's insert-select are unchanged; ADR-0021's gate at the real scale is AIR-178.

## Recovery and migration boundary

Code rollback restores the narrow key in code only; a database already on v3 keeps the wider identity, which the older code also writes correctly unless a generation holds two entries for one slot. Applying `0003` to the scratch or target database, and any rollback of it, are separate owner approvals. R2 stays authoritative.

## Evidence

- **Original decision:** owner decision recorded in AIR-177, 2026-10-27
- **Implementation:** the AIR-177 PR (`migrations/0003_candidate_show_identity.sql`, `src/epg-repository.js`, `src/generation-stage.js`, `src/offline-importer.js`, executor, importer and G4 harness)
- **Dated verification:** offline import of the AIR-175 snapshot with this code, 2026-10-27 ([evidence](../evidence/d1-migration/air-177-candidate-show-identity-2026-10-27.md))
- **Uncertainty:** whether film shows can carry the same overlap; the AIR-175 baseline has none, and `film_show` keeps its key

## Follow-ups

[AIR-178](https://trello.com/c/rpRDyobZ) proves the staged commit at the real scale on the scratch database, which first needs `0003` applied under its own approval.
