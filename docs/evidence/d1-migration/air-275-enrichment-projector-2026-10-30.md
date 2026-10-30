# D1 enrichment projector on the 2026-10-29 snapshot (AIR-275 phase 2)

**Captured:** 2026-10-30, in the agent container (Node 22.22), on the AIR-275 phase 2 branch `claude/air-275-enrichment-d1-writer` from `main` `453ae00`.  
**Input:** the private production snapshot of 29 October 2026, 19:31–19:58 UTC: `consistent_fenced`, 11,811 objects, 829,729,965 bytes, aggregate `062c9812…250dda`. This is the snapshot the production D1 reload of 30 October was built from.  
**Database:** a private copy of that reload's local build (schema v3) with `migrations/0004_projection_state.sql` applied.  
**Scope:** sections 1–5 use private files and local SQLite only, through the test D1 stand-in (`tests/d1-standin.mjs`), with no R2 or D1 request. Section 6 is a read-only production preflight. Section 7 is the owner-approved production rollout.  
**Card:** [AIR-275](https://trello.com/c/4x7hH0gI); decision [ADR 0056](../../adr/0056-d1-enrichment-write-through.md).  
**Verdict:** the projector converges and writes what the reload writes. A run fits the Worker's limits in Node. In production, `on` converged in two hourly runs after `dry`, and the third found 0 changes (section 7).

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
| After the review fixes (inputs from the published generation's copies, NULL metadata checksum), keys re-seeded from the snapshot's root copies, then a `dry` run | 0 Persons, 0 Films and 0 absent changed: the snapshot's root and generation copies give the same keys |
| After the second review (writer checks, etag fence, membership guard), the same `dry` run | The snapshot's writer state is idle. 394 watchlist members, 0 memberships lost, 0 changed |

**Reload comparison.** After the unlimited run, 13 tables were compared with the reload build, row for row, without their `updated_at` columns: `film`, `film_external_id`, `film_alias`, `film_dimension`, `film_metadata`, `film_person_credit`, `watchlist_film`, `film_redirect`, `person`, `person_alias`, `person_external_id`, `person_dimension` and `localization_conflict`.

- All row counts are equal.
- All rows are equal except the 394 `letterboxd_slug` external ids, whose provenance `observedAt` is the run's own clock (the reload's was the snapshot time).

**Budget.** About 4.2 queries per Film and 1.04 per Person. The 800-query budget per run therefore covers about 190 Films or 770 Persons. Without seeded keys, a first run over the whole domain would take about 40 hourly runs.

## 5. Not measured here

- Worker heap and CPU on the production isolate, including an isolate also serving a sync request.
- D1 latency per batch.
- AIR-286's D1-only credits on the real data. They are covered by `tests/d1-enrichment.mjs` on synthetic data.

## 6. Production D1 preflight before seeding (read-only)

**Captured:** 2026-10-30, 14:39 UTC (15:39 Madrid). These were SELECT statements against D1 `iptv` (`3fba0e0a…`, schema v3) through the D1 HTTP API, compared with the private reload build of the 29 October snapshot. Nothing was written.

**Baseline.** The one `import_receipt` for `manifest.json` names `062c9812…250dda`, imported at `2026-10-29T19:58:26.568Z`, the same in both.

| Table | Production | Build | Only in production | Only in build |
| --- | --- | --- | --- | --- |
| `film` | 2,402 | 2,402 | 0 | 0 |
| `film_external_id` | 3,190 | 3,190 | 0 | 0 |
| `film_alias` | 2,477 | 2,477 | 0 | 0 |
| `film_dimension` | 12,010 | 12,010 | 0 | 0 |
| `film_metadata` | 394 | 394 | 0 | 0 |
| `watchlist_film` | 394 | 394 | 0 | 0 |
| `film_redirect`, `localization_conflict` | 0 | 0 | 0 | 0 |
| `person` | 19,089 | 17,344 | 1,745 | 0 |
| `person_alias` | 19,091 | 17,346 | 1,745 | 0 |
| `person_external_id` | 17,344 | 17,344 | 0 | 0 |
| `person_dimension` | 34,688 | 34,688 | 0 | 0 |
| `film_person_credit` | 30,478 | 26,133 | 4,345 | 0 |

Rows were compared with all their columns, `updated_at` included. Every extra row in production is AIR-286 data:
- 1,745 `person:tmdb_*` people with one name alias each;
- 4,345 credits of `person:tmdb_*` people on watchlist Films, covering all 394.

The seed plan of the snapshot holds 19,746 keys: 17,344 Persons and 2,402 Films. It gives the 1,745 AIR-286 people no key. The seed tool's read-only plan against production stopped, as it must before migration 0004, with `schema_not_v4` (no projection tables, version 3).

## 7. Production rollout (owner-approved)

**Captured:** 2026-10-30, 15:44–19:37 UTC (16:44–20:37 Madrid). The owner approved each write step separately in chat, and the owner set the `D1_ENRICHMENT_WRITE` flag (to `dry` by 16:15 UTC, to `on` by 17:05 UTC; [flag register](../../reference/feature-flags.md)). Outcomes are the projector's own `summary.outcome` from its log line (`dry`, `budget`, `complete`); every invocation's Workers outcome was `ok`. Invocation CPU and wall time come from Workers telemetry for the cron trigger `37 * * * *`, not from the projector's log: a Worker's clock does not advance during CPU work, so the per-stage times in that log are not reliable.

| Step (UTC) | Time Travel bookmark before it | Result |
| --- | --- | --- |
| Read-only preflight, 15:44 | — | Same result as section 6. Flag `off`. |
| Migration 0004, 15:44 | `00000017-00000003-…d0cfb8ea` | The three projection tables exist and `schema_contract.version` is 4. No other table changed. |
| Key seed (`scripts/d1-projection-seed.mjs --target d1 --apply`), 15:46 | `00000017-00000007-…3dac7b0d` | 19,746 keys (2,402 Films, 17,344 Persons) in 79 requests, outcome `verified`. The 1,745 AIR-286 Persons got no key. The seed lease was released. |
| `dry`, run of 16:37 | — | Outcome `dry`. To write: 55 Films (18 new) and 102 Persons. 0 absent, 0 memberships lost. CPU 3.8 s, wall 10.6 s. |
| `on`, run of 17:37 | `0000001a-00000000-…967c5e98` (17:03) | Outcome `budget`. 102 Persons and 10 Films written, 0 errors. It stopped at the 60 s wall budget: D1 answered in about 0.3 s per request. |
| `on`, run of 18:37 | — | Outcome `complete`. The remaining 45 Films written, 0 errors. CPU 5.8 s, wall 17.5 s. |
| `on`, run of 19:37 | — | Outcome `complete`, 0 changed: converged. CPU 1.8 s, wall 5.6 s, 4 queries. |

**D1 after convergence (read-only SELECT, the counts per table and the `projected_at` of the keys; split of new and updated rows re-read 2026-10-30 23:15 UTC):**

| Measure | Value |
| --- | --- |
| `film` | 2,420: 18 new rows; the other 37 of the 55 Films written were updates |
| `person` | 19,189: 100 new rows. The other 2 of the 102 Persons written already had rows that AIR-286 wrote (their name alias carries AIR-286 provenance); they gained a key, not a row |
| `film_person_credit` | 30,676 |
| `watchlist_film` | 396 (2 Films added to the watchlist since the snapshot) |
| `projection_state` keys | 19,866: 19,709 seeded keys untouched, 37 seeded Film keys rewritten by updates, 18 new Film keys and 102 new Person keys |
| Projector lease, fence rows | free, 0 |
| AIR-286 `person:tmdb_*` credits | 4,345 on 394 Films, unchanged |

**Limits of this evidence:**

- Cloudflare does not report the Worker's peak memory. Every invocation ended `ok`, so no memory limit was hit. In Node the retained heap peaks at about 57 MB (section 3).
- D1 latency from the Worker varies: about 0.3 s per request at 17:37 UTC and clearly less at 18:37 UTC. The wall budget stays 60 s: the owner decided to keep it on 30 October after the phase report ([AIR-275 decisions comment](https://trello.com/c/4x7hH0gI#comment-6ae5218e79bd42334ffa0847)).
- The 2 Films added to the watchlist after AIR-286 have no AIR-286 TMDB credits. The owner decided on 30 October not to repeat AIR-286 for them now and to start AIR-44 instead ([AIR-275 decisions comment](https://trello.com/c/4x7hH0gI#comment-6ae5218e79bd42334ffa0847)); adding their credits stays open and separately gated.

**Rollback:** set the flag to `off` or `dry`. Rows already written stay. Restoring a bookmark restores the whole database and is an emergency step that needs separate owner approval.
