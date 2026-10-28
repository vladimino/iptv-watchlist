# AIR-74 offline GO/NO-GO on the 28 October snapshot (materialization rehearsal and D1 dry-runs, local only)

**Captured:** 2026-10-28, 11:18–RERUN_END UTC, in the agent container; code at `main` `bb706d6` plus the two commits of this change (rehearsal check, `letterboxd/display-exclusion.json` classification)  
**Input:** the [AIR-222 stage 2](../discovery-ledger-split-air-222-stage-2-2026-10-28.md) cut of production bucket `iptv` taken before the ledger split install: `consistent_fenced`, 8,723 objects, 659,175,433 bytes, aggregate `23d2e9d7a705cee62d115f4cc2887b5728bdccc1893ce284b8a07b99547da6fa`, `manifest.json` SHA-256 `d7b22d33e4d4216886b7c47f257852bdd78d5a7ba5b973c40ce5d7685b51e6d1`, `finishedAt` 2026-10-28T10:16:21.769Z. Re-verified offline first (`r2-snapshot-export.mjs --verify` re-hashes every object, no network); the directory stayed write-protected  
**Scope:** private files and SQLite databases only. No R2 request, no Worker call, no Cloudflare D1 (scratch or production), no flag, Scheduled Task or Access change  
**Verdict:** **Offline materialization GO; G5 NO-GO.** The historical version materialization plan rehearses clean on this snapshot. The D1 executor stops by contract on class A `prediction_version_object_missing`, which only the production materialization removes; class C and two dispositions also wait on the owner  
**Used by:** [AIR-74](https://trello.com/c/5AdAmKPe), [ADR-0019](../../adr/0019-live-d1-backfill-boundaries.md), [ADR-0026](../../adr/0026-historical-prediction-version-materialization.md); follows the [AIR-194 replay](air-194-superseded-redirect-replay-2026-10-27.md)

Aggregates only. Plans, ledgers, the acknowledged list, reports and SQLite files stay private.

**Caveat on the snapshot.** It predates the AIR-222 split install (10:41 UTC): its discovery ledger is the old single full ledger and it holds no `epg/discovery-archive/v1/`. It is a valid baseline for these offline proofs, not the current production inventory. A production run needs a fresh fenced snapshot after the materialization, and that snapshot will contain the discovery archive, which the importer does not map yet (see blocker 5).

## 1. Historical prediction version materialization (ADR-0026), offline

| Step | Result |
| --- | --- |
| `prediction-versions-materialize.mjs plan` | plan id = the aggregate above; 2,359 bundles; 105 records already linked by the live writer (13 bundles fully, 91 bundles with `current` linked and `history` pending); **2,346 records pending** (2,255 `current`, 91 `history`) in 2,346 bundles; 2,346 objects to write, 1,795,851 bytes; 47 batches; 0 malformed, 0 checksum mismatch, 0 unreadable, 0 unreferenced version objects; `plan.jsonl` SHA-256 `8b3bf613…` |
| `rehearse`, first | every batch 200 (dry and apply), 2,346 `materialized`, 47 replays, 0 incomplete, 0 pending, 0 object mismatch, 0 body changed, but **`ok: false`**: the check required a provenance block on all 2,359 bundles, while the 13 fully linked bundles are rightly outside the plan |
| Tool fix | the check now counts planned and outside-plan bundles, expects provenance on the planned ones only, and fails if a bundle outside the plan changed at all; the test fixture gains one fully linked bundle |
| `rehearse`, after the fix | **`ok: true`**: 47 batches 200/200, 2,346 `materialized`, 47 replays, 2,451 records linked, 0 pending, 0 malformed, 0 object mismatch, 0 body changed, provenance 2,346 of 2,346 planned, 13 outside the plan unchanged |
| `prediction-versions-plan.mjs` (read-only view) | same totals as the plan |

## 2. Offline importer (`offline-import.mjs`)

| Run | Result |
| --- | --- |
| 1 (11:20–11:21 UTC) | **stopped `unknown_key`** before any write: `letterboxd/display-exclusion.json` (the Finds display-only exclusion list of ADR-0028, 80,735 bytes, written 28 Oct 05:16 UTC) appeared after the AIR-175 baseline and matched no family. Fails closed by design |
| Owner decision (28 Oct) | the key is **`user_state`** (owner-curated input the Worker only reads; D1 home or stays-in-R2 decided before the read cutover) |
| 2 (11:22–12:37 UTC) | completed: coverage 8,723 = 4,842 mapped + 3,881 R2-only, **0 unmapped**; 31,030 units applied, 31,030 receipts `matching`, 0 conflicts, 0 stale or foreign; identity 6,000 direct, 2 via metadata TMDB id; discovery evidence 74 stored, 62,387 derived, 107 `stale_evidence`; class A `prediction_family_unportable` (2,331 unportable of 2,464 prediction keys, 104 applied); class C 38 `film_unresolved`; class S 0 |

Class B (R2-only): `derived_projection` 2,364, `run_record` 674, `user_state` 808 (**decision required**), `archive` 26, `runtime_coordination` 9.

Parity reports `ok: false` with 0 missing, 0 mismatched and 91 extra `prediction_current` rows. They are the 91 bundles whose `current` the live writer linked while their `history` is still unlinked: the importer writes the portable current record, the projection leaves the half-portable bundle out. The materialization links those 91 histories, after which the bundles are fully portable.

Class C rose from 34 (AIR-175 after AIR-190) to 38: 16 fingerprints, 16 prediction bundles, 5 actual ratings, 1 discovery decision, all `film_unresolved` (films that left the watchlist after enrichment, as in the [AIR-180 audit](air-180-class-c-audit-2026-10-27.md)).

## 3. D1 executor dry-runs (`d1-backfill.mjs --target sqlite`)

Each on its own new database from `0001`–`0003`, with an acknowledged list built from the importer's 38 class C records (SHA-256 `feb6e9eb…`). **This list is a dry-run input, not the owner's acknowledgement.**

| Run | Window (UTC) | Status | Applied | Pending | Receipts (matching / stale / foreign) | Class C passed |
| --- | --- | --- | --- | --- | --- | --- |
| plain 1 | 15:00:53–15:32:14 | `stopped: class_a_blocker` | 21,701 | 11,681 | 21,702 / 0 / 0 | 16 |
| staged 1 | 15:00:53–15:32:29 | `stopped: class_a_blocker` | 21,701 | 11,681 | 21,702 / 0 / 0 | 16 |
RERUN_ROWS

Both stop at the first prediction bundle with `prediction_version_object_missing` (class A, `prediction_family_unportable`), as in the AIR-194 replay. The staged path therefore never reaches the generation unit: `staged.gate` reports 0 commits, which is not a pass.

## 4. Remaining blockers for a production backfill

1. **Prediction version materialization in production** (class A). Offline GO above. Production needs, each separately approved: `PREDICTION_MATERIALIZATION=on` (with `PREDICTION_VERSION_OBJECTS` staying on), `validate` against the Worker, `apply`, the flag back off, a new fenced snapshot and a reconciling plan with 0 pending. The plan is tied to this snapshot: submits since 10:16 UTC rewrite bundles, which `validate` reports as `bundle_changed`, so a fresh plan from a fresh snapshot just before `validate` is the safer order.
2. **Class C acknowledgement.** 38 `film_unresolved` records; the owner reviews the private ledger and approves the list. The executor passed all 16 it reached.
3. **`user_state` disposition** (808 keys including `started/`, `events/`, `letterboxd/facts/`, `letterboxd/imports/`, `ui/filter-presets.json`, `letterboxd/display-exclusion.json`). Blocks the read cutover (AIR-77), not the backfill.
4. **Executor beyond predictions not yet proven on this baseline.** After the materialization the executor must reach the generation unit on the staged path (the real generation has not been staged on a production baseline; AIR-178 proved 64,554 synthetic candidates) and finish `completed` with parity `ok`, followed by two reruns that apply nothing.
5. **Discovery archive mapping.** Every snapshot after the AIR-222 install holds `epg/discovery-archive/v1/`, which the importer does not map; per the [runbook](../../runbooks/d1-backfill.md#procedure) such a snapshot is NO-GO for the discovery family until the importer reads the active ledger plus the manifest and segments it names.
6. **Production D1 steps** (separate approvals): create `iptv` and scratch databases, apply `0001`–`0003`, record the Time Travel bookmark, bounded runs with the probe, two reruns, then a delta from a newer fenced snapshot.

## Limits

- Offline only; nothing here is a production write or authorizes one.
- Counts hold at the snapshot's `finishedAt`; the live writer has linked more records since.
- The executor and the importer share the import code; the executor's D1 HTTP behaviour is not exercised by a SQLite dry-run.
