# D1 enrichment projector on the 2026-10-29 snapshot (AIR-275 phase 2)

**Captured:** 2026-10-30, in the agent container (Node 22.22), on the AIR-275 phase 2 branch `claude/air-275-enrichment-d1-writer` from `main` `453ae00`.  
**Input:** the private production snapshot of 29 October 2026, 19:31–19:58 UTC: `consistent_fenced`, 11,811 objects, 829,729,965 bytes, aggregate `062c9812…250dda`. This is the snapshot the production D1 reload of 30 October was built from.  
**Database:** a private copy of that reload's local build (schema v3) with `migrations/0004_projection_state.sql` applied.  
**Scope:** private files and local SQLite only, through the test D1 stand-in (`tests/d1-standin.mjs`). No R2 or D1 request, and no flag, Task or migration change.  
**Card:** [AIR-275](https://trello.com/c/4x7hH0gI); decision [ADR 0054](../../adr/0054-d1-enrichment-write-through.md).  
**Verdict:** the projector converges and writes what the reload writes. A run fits the Worker's limits in Node. **Not a production measurement:** `dry` in the Worker is the first one.

Aggregates only. Film ids, titles and payloads stay private.

## 1. Lifecycle view cost

| Run of `readLifecycle` on the snapshot | Before the reader indexes | After | Output SHA-256 |
| --- | --- | --- | --- |
| Full store (offline import) | 40.3 s | 2.5 s | identical |
| Enrichment store (projector) | 39.4 s | 1.2 s | identical |

The cost was per-Film linear scans of the discovery resolution and the catalog. The indexes keep the first match and the original order. Both outputs hash the same before and after.

## 2. Change keys

Two views of the same snapshot, built for clocks three days apart, give the same change key for all 2,402 Films and 17,344 Persons. The key replaces the run's own clock value before hashing.

Leaving fingerprints, predictions, the profile, the sync state and the discovery ledger out of the store changes no key.

## 3. Memory and CPU of one run

Retained heap after a forced collection, at each stage:

| Stage | Retained heap |
| --- | --- |
| Start | 10 MB |
| R2 records loaded (about 11 MB of JSON) | 27 MB |
| View (`entitiesOnly`) | 48 MB |
| Inputs | 52 MB |
| Change keys for 19,746 entities | 57 MB |

- **Heap limit.** A whole `dry` run, stand-in included, completes under `--max-old-space-size=96`. It runs out of heap at 64.
- **CPU.** About 1.3–1.6 s for the view, out of an 8 s run. Most of the rest is the stand-in's sqlite3 processes, which the Worker does not have.
- **Limits.** The Worker isolate limit is 128 MB, with `cpu_ms` 120,000.

## 4. Writes

| Case | Result |
| --- | --- |
| Keys seeded from the snapshot (`scripts/d1-projection-seed.mjs`), then a run | 19,746 keys seeded in 8.7 s. The run changed 0 Persons, 0 Films and 0 absent; 4 D1 queries, no batch. |
| No keys, one run with an unlimited budget | 17,344 Persons and 2,402 Films written, 0 errors. 28,437 queries and 3,096 batches (238,250 statements), 196 s on the stand-in. |
| The next run after that | 0 changed |

**Reload comparison.** After the unlimited run, 13 tables were compared with the reload build, row for row, without their `updated_at` columns: `film`, `film_external_id`, `film_alias`, `film_dimension`, `film_metadata`, `film_person_credit`, `watchlist_film`, `film_redirect`, `person`, `person_alias`, `person_external_id`, `person_dimension` and `localization_conflict`.

- All row counts are equal.
- All rows are equal except the 394 `letterboxd_slug` external ids, whose provenance `observedAt` is the run's own clock (the reload's was the snapshot time).

**Budget.** About 4.2 queries per Film and 1.04 per Person. The 800-query budget per run therefore covers about 190 Films or 770 Persons. Without seeded keys, a first run over the whole domain would take about 40 hourly runs.

## 5. Not measured here

- Worker heap and CPU on the production isolate, including an isolate also serving a sync request.
- D1 latency per batch.
- AIR-286's D1-only credits on the real data. They are covered by `tests/d1-enrichment.mjs` on synthetic data.
