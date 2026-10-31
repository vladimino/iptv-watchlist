# TMDB TV identity correction of four watchlist miniseries (AIR-291)

**Captured:** 2026-10-31, 07:10–08:40 UTC, in the agent container (Node 22), runtime code at `main` `dab57b9` ([PR #268](https://github.com/vladimino/iptv-watchlist/pull/268)), Worker version `48828515-cba8-48a4-8a53-f7c7ac5d5e7c` (deployed 07:02 UTC).  
**Card:** [AIR-291](https://trello.com/c/OWV3rL9q); decision [ADR 0057](../../adr/0057-tmdb-tv-identity-and-retired-movie-ids.md); procedure [runbook](../../runbooks/tmdb-tv-identity-correction.md).  
**Authorizations:** the owner approved the read-only preflight ("начинай", 07:07 UTC) and the single R2 write of the body with SHA-256 `c8aa44c2…` ("разрешаю", 07:36 UTC).  
**Write path:** the owner chose the Cloudflare API write (07:23 UTC). No S3 writer credential was available for the runbook's conditional put. He made it subject to an owner gate that shows exactly what is written. The runbook was amended to carry this alternative ([PR #272](https://github.com/vladimino/iptv-watchlist/pull/272)).  
**Verdict:** **CORRECTED.** The four Films hold their TMDB TV entry as the trusted `tmdb_tv` identity in the R2 projection and in D1. Their retired movie ids remain as untrusted entries. No change was detected in the verified scope: the four Films' D1 rows and the database-wide external-id checks. Full R2 parity was not captured (see [deviations and evidence limits](#deviations-and-evidence-limits)).

The evidence bodies (the TMDB answers and the Letterboxd pages) stay in the private AIR-286 artifact. Only ids, counts, hashes and timestamps are recorded here.

## Films

| Film | Retired movie id (TMDB `404`) | Trusted `tmdb_tv` | Letterboxd link checked |
| --- | --- | --- | --- |
| `film:1IUo` | 17266 | 9687 | 07:17:32 UTC, `tv/9687` |
| `film:3tCe` | 101915 | 8042 | 07:18:26 UTC, `tv/8042` |
| `film:daU4` | 378779 | 64099 | 07:18:57 UTC, `tv/64099` |
| `film:g97G` | 452736 | 1457 | 07:19:01 UTC, `tv/1457` |

The artifact was collected the same morning (07:17–07:19 UTC). Each movie id answered `404`, each Letterboxd page showed exactly one TMDB link, and each TV entry answered under the linked id.

## Preflight (read-only)

All reads went through the Cloudflare API: `GET` of R2 objects and `SELECT` on D1 `iptv` (`3fba0e0a…`).

- **Runtime.** The `main` run after the merge passed `Test and build` and `Deploy to Cloudflare`. `D1_ENRICHMENT_WRITE` is `on`, the cron is `37 * * * *`, the projector lease was idle, and the 06:37 UTC run was `complete` with no change.
- **R2.** `identity/tmdb-retirements.json` was absent. `sync.json` was `complete` (last update 2026-10-30 16:04 UTC), and the published generation was `08abd946…`. In `metadata.json`, `watchlist.json` and the published `programme.json`, the four records carried their movie id and no `tmdbLink` (`metadataAt` 2026-10-02).
  - **Other records.** No other record carried any of the eight numbers. This covered the published and root `discovered-films.json`, `discovery-resolution.json`, `discovery-latest.json` and `titles.json`.
- **D1.** The four Films had canonical `tmdb:<movieId>`, a trusted movie row and identity `resolved`. There was no `tmdb_tv` row in the database, and no other Film held any of the eight numbers.
- **Dry-run.** `scripts/tmdb-tv-identity-plan.mjs` ran with the artifact against a local SQLite copy of the planner's D1 rows for these Films. It reported `ready: 4`, `ownerReview: 0`, `refused: 0`, 0 collisions and 0 numeric overlaps, and `d1Readback` reported `pending` for all four.
- **Procedural deviation.** The card and the runbook require a fenced R2 snapshot before the write. None was taken, because no S3 read credential was available. The targeted Cloudflare API reads above are not an atomic cut of the bucket. See [deviations and evidence limits](#deviations-and-evidence-limits).

## Recovery points

| Store | Point |
| --- | --- |
| D1 Time Travel bookmark, preflight (07:2x UTC) | `0000002e-00000000-00005115-0f49a507b1981cab44da5c0e813a8f37` |
| D1 Time Travel bookmark, immediately before the write (07:36:49 UTC) | `00000031-00000000-00005115-89baab30ad4c1029767209139769a834` |
| R2 | No fenced snapshot. The key was absent before the write (`GET` → `404`), and the write touched no other key. |

## Write

This was one unconditional `PUT` through the Cloudflare API, the runbook's alternative method.

| Check | Value |
| --- | --- |
| Approved body | `r2Retirements.body` of the dry-run, compact JSON, 1,846 bytes, SHA-256 `c8aa44c218794edd001eeb9b7073d9cb1c5816b90d85748e9094003de7adfea6`; `tmdbRetirementSet` `ok`, 4 retirements |
| Pre-check | `GET` → `404` |
| Put | 2026-10-31 07:36:50 UTC, size 1,846, etag `52e45f2fbed6271c4399db07bb5f0551` (the MD5 of the approved bytes), version `7e5e6f1c…` |
| Read-back | SHA-256 and length equal to the approved body |

## D1 through the enrichment projector

The 07:37:30 UTC cron run (`mode: on`) read the object and carried the correction. No D1 statement was written by hand.

| Measure | Value |
| --- | --- |
| Outcome | `complete`, 7.7 s, 28 queries, lease released |
| `tmdbRetirements` | `valid: true`, `applied: 4`, `held: []`, `reasons: []` |
| Films / Persons in the view | 2,420 / 17,446 |
| Changed and written Films | 4 / 4 |
| Changed Persons, released entities, membership removed, errors | 0, 0, 0, 0 |

## Readback (read-only)

The comparison used the plan's `d1Expected` and `d1Before`, by SHA-256 of their stable JSON, against the same projection of current D1 rows.

| Film | State | Credits (all rows) | Prediction (`content_sha256`) | Watchlist / rating / redirects / aliases | Localization |
| --- | --- | --- | --- | --- | --- |
| `film:1IUo` | `corrected` | unchanged (11 Letterboxd, 11 TMDB) | unchanged | 1 / 0 / 0 / 1 | unchanged |
| `film:3tCe` | `corrected` | unchanged (9, 9) | unchanged | 1 / 0 / 0 / 1 | unchanged |
| `film:daU4` | `corrected` | unchanged (11, 11) | unchanged | 1 / 0 / 0 / 1 | unchanged |
| `film:g97G` | `corrected` | unchanged (11, 11) | unchanged | 1 / 0 / 0 / 1 | unchanged |

Across the database there are exactly 4 `tmdb_tv` rows. No Film trusts a retired movie id, and no Film trusts a TV number as a movie id. The `letterboxd` and `letterboxd_slug` rows are unchanged. Since every credit row is unchanged, the `coCredit` pairs derived from them are unchanged too.

## Repeat run (no-op)

The next cron run, at 08:37:30 UTC, applied the same object and changed nothing. This is the repeated-application check.

| Measure | Value |
| --- | --- |
| Outcome | `complete`, 10.5 s, 4 queries, lease released |
| `tmdbRetirements` | `valid: true`, `applied: 4`, `held: []`, `reasons: []` |
| Changed and written Films / Persons | 0 / 0, 0 / 0 |
| Released entities, membership removed, errors | 0, 0, 0 |

A read-only readback at 08:40 UTC found all four Films still `corrected`. Their identity hashes equal `d1Expected`. Their credit rows and prediction `content_sha256` equal the pre-write baseline. Watchlist membership and localization are unchanged, and the global counts are unchanged: 4 `tmdb_tv` rows, 0 trusted retired movie ids, 0 TV numbers trusted as movie ids.

## Deviations and evidence limits

- **Procedural deviation at preflight: no fenced R2 snapshot.**
  - **Scope.** The whole bucket. The write added one key that did not exist and touched no other key, so the four Films' R2 records were only read.
  - **Impact.** There is no atomic pre-write cut to compare full R2 parity against or to restore from. The D1 Time Travel bookmarks cover D1 only.
  - **Remedy.** It cannot be remedied after the fact.
  - **Waiver.** The owner's choice of the Cloudflare API write path did not explicitly waive the snapshot.
  - **Owner disposition:** not yet recorded.
- **Post-apply planner dry-run not run.** The runbook's readback includes a second planner dry-run that should report four Films unchanged and repeat the preservation and collision comparison. It was not run. The evidence above is different: two complete projector runs (the second a no-op) and a D1 hash readback against the plan. **Owner disposition:** not yet recorded (accept, or authorize a separate read-only planner check).
- **R2 records keep the movie id.** The records in R2 still carry the movie id as `tmdbId`. That is by design (ADR 0057): the object takes it out of the trusted identity. The admin Film record and the model's TMDB URI still show the movie id.

## Future operational caveats

These are expected observations, not acceptance gates for AIR-291.

- **Metadata refresh.** The four records are due for a metadata refresh after 2026-11-01 22:08 UTC. If the refreshed Letterboxd page no longer shows the confirmed divergence, the Film is held (`link_changed` or `attributes_changed`) and D1 keeps the corrected rows until review.
- **Rollback.** No rollback is pending. A future rollback needs its own owner approval. It first verifies that the object's current SHA-256 and version are still `c8aa44c2…` and `7e5e6f1c…`, then deletes the key. The next projector run reconciles D1.
