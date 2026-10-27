# D1 backfill dry-runs on the production snapshot after ADR-0022 (local SQLite)

**Captured:** 2026-10-27, offline on the owner's machine; code at `main` `29fc0d1` (ADR-0022 merged)  
**Input:** the [AIR-175 snapshot](air-175-r2-snapshot-identity-2026-10-26.md), `consistent_fenced`, 7,994 objects, aggregate `f71eee103b8e45a696def1805d050454bf3721e0cd688dc041c16bddcc0bdeb3`, `manifest.json` SHA-256 `c26e04536ff2ebc047e731ad0b0e39eed51a9550bc921f457026de06c7b1865a`, re-verified offline before the runs; the directory stayed write-protected  
**Scope:** private SQLite files only; no Cloudflare D1 (production or scratch), no R2 request, no Worker, Scheduled Task, flag or Access change  
**Verdict:** **NO-GO for G5.** The ADR-0022 change works (79 stale decisions imported, 0 evidence refusals) and reruns are idempotent, but four blockers remain: one programme-generation unit fails on duplicate candidate shows, the real generation is 2.3× the size G4 proved, every prediction lacks its version object, and 36 class C records need the owner's acknowledgement  
**Used by:** [AIR-74](https://trello.com/c/5AdAmKPe), [ADR-0019](../../adr/0019-live-d1-backfill-boundaries.md), [ADR-0021](../../adr/0021-staged-atomic-generation-import.md), [ADR-0022](../../adr/0022-stale-decision-evidence-import.md); follows the [first dry-run](air-74-sqlite-dry-run-2026-10-26.md)

Aggregates only. Private reports, ledgers and SQLite files stay outside the repository; candidate titles, slots and keys are not reproduced here.

## Runs

| Run | Command (paths private) | Result |
| --- | --- | --- |
| Executor, plain path | `d1-backfill.mjs --target sqlite` on a database from `0001`, 05:13:23–05:52:15 UTC | `stopped: unacknowledged_record` at the first class C record (`film_unresolved`, fingerprint); 19,207 units applied, 13,654 pending, 19,208 receipts all matching, 0 conflicts |
| Executor, staged path | `--staged-generation` on a database from `0001`+`0002`, 05:13:23–05:52:32 UTC | identical stop and counts; the generation unit was not reached, so no stage was opened (`staged.gate` reports 0 commits; its `go: true` means "no commit over budget", not a pass) |
| Offline importer, full | `offline-import.mjs` (no `stopOn`, imports everything it can) on a fresh database, 05:53:12–06:29:44 UTC | completed; figures below |
| Offline importer, rerun 1 / rerun 2 | same database, 06:29:44–06:38:03 / 06:38:03–06:44:58 UTC | `applied: 0`, `resumed: 21,520`, identical parity and classes: **idempotent** |

The executor stops at the first unacknowledged class C record by contract, so the full import used the offline importer, which shares the importer, repositories and parity code but never stops; it shows the complete class C list and every failing unit.

## Inventory and provenance

| Measure | Value |
| --- | --- |
| Source keys | 7,994: mapped 4,688, R2-only 3,306, **unmapped 0** |
| Units applied (full run) | 21,520, receipts 21,520 all `matching`; no stale or foreign receipt |
| Discovery evidence | `stored` 65, `derived` 60,482, **`stale_evidence` 79** (ADR-0022), 0 refusals |
| Identity | 5,803 direct, 3 via redirect |
| Class B (R2-only) | `derived_projection` 2,340, `run_record` 604, `user_state` 330 (**decision required**), `archive` 23, `runtime_coordination` 9 |

## Blockers

### 1. The programme generation unit fails on duplicate candidate shows

The single `programme_generation` unit (397 films, 902 film shows, **51,643 candidates**, 32,400 candidate shows) stops with `UNIQUE constraint failed: candidate_show (programme_run_id, observation_key, channel_id, start…)`; the importer records it as `conflict: unapplied`. Three candidates carry four shows that repeat the channel and start time of another show of the same candidate while differing in end time or EPG title (overlapping EPG entries); there is no exact duplicate. Everything that depends on the generation follows: 51,643 `candidate_generation` rows missing from parity, 8,983 decisions in conflict ("Decision is not in the published generation"), and parity mismatches on `film_show`, `film_generation` and `published_generation`. Parity therefore reports 60,627 missing of 82,148 and `ok: false`.

### 2. The real generation is 2.3× the size G4 proved

G4 ([AIR-174](air-174-scratch-g4-2026-10-26.md)) proved the staged import at 1.25× of 22,199 candidates (27,749). The published generation in this baseline has **51,643 candidates** (32,400 candidate shows; many candidates have no current show). ADR-0021's GO is conditional on the scratch gate at the measured scale, so the commit budget and chunk counts are unproven for this size.

### 3. No prediction is portable (class A)

The mandatory `prediction` family has 2,335 keys: **2,321 `unportable` (`prediction_version_object_missing`)** and 14 class C `film_unresolved`; 0 applied. The current-prediction bundles point at immutable version objects that production never wrote, because `PREDICTION_VERSION_OBJECTS` has stayed off ([AIR-164](https://trello.com/c/iZzON44A)). ADR-0019 already names this: the prediction family cannot be imported before an approved materialization of version objects. Class A is blocking (`prediction_family_unportable`).

### 4. Class C records awaiting acknowledgement

36 records, all `film_unresolved` (a film id that resolves to no Film): fingerprint 14, prediction 14, actual rating 7, discovery decision 1. The list with source key, checksum and reason is in the private ledger. The executor will not pass them without the owner's acknowledged list (ADR-0019 item 8); acknowledging records a known gap, never lossless parity.

## Owner and coordinator decisions needed

| # | Decision | Options seen | Blocks |
| --- | --- | --- | --- |
| 1 | How to import candidate shows that share channel and start with another show of the same candidate | widen the show key with the end time; keep the earliest-ending show and ledger the rest as class C; treat them as a source-quality refusal of the whole generation | the generation unit and every candidate/decision row |
| 2 | Re-prove ADR-0021's staged commit at the real scale (51,643 candidates, ×1.25 for growth) on the scratch D1 | separate owner approval for a scratch run, as AIR-174 | G5 for the generation unit |
| 3 | Materialize immutable prediction version objects | enable `PREDICTION_VERSION_OBJECTS` and run an approved backfill of version objects, or decide another portable form | the mandatory prediction family (class A) |
| 4 | Acknowledge the 36 class C records | review the private ledger and produce the `--acknowledged` list | the executor's stop rule |
| 5 | Disposition of `user_state` (330 keys: `started/`, `events/`) | D1 home or recorded stays-in-R2 decision | the read cutover (AIR-77), not the backfill |

After 1–4, the executor dry-run is repeated on the same snapshot (plain and staged) with `--acknowledged`, followed by two reruns that must apply nothing.

## Limits

- The offline importer is not the executor: it shows what the shared import would produce, not the executor's batch or staged behaviour on D1.
- The executor's staged path has not run a generation on this baseline.
- Counts apply to the snapshot's `finishedAt`; production has moved on since.
