# AIR-276: Letterboxd slug alias coverage on a production snapshot (2026-10-30)

**Card:** [AIR-276](https://trello.com/c/PeWwEti8). **Decision:** [ADR 0052](../../adr/0052-letterboxd-slug-film-alias.md). **Related:** [AIR-275](https://trello.com/c/4x7hH0gI) (D1).
**Code:** PR #243 heads `cd470bd` (over `main` `137de6a`) and `071ed03`, run in the AIR-275 session. Both runs gave the same counts.
**Snapshot:** owner-approved `consistent_fenced` R2 export, 11,811 objects, aggregate SHA-256 prefix `062c98125b41c465`, exported 2026-10-29 19:31:42–19:58:26 UTC. The snapshot itself stays private.
**Scope:** read-only `scripts/letterboxd-slug-inventory.mjs`. No Letterboxd or TMDB request, no R2 or D1 write. The run reported `writes: 0` and `requests: 0`.

## Result

| Measure | Count |
| --- | --- |
| Films in the projection | 2,402 |
| Films with a Letterboxd lid | 394 |
| TMDB-only Films (no slug by rule) | 2,008 |
| Lid Films with a slug | 394 |
| Lid Films without a slug | 0 |
| Slug `current` (own permalink) | 394 |
| Slug `ambiguous` (records disagree; `071ed03` run) | 0 |
| Slug only `observed` (diary) | 0 |
| Slug `historical` | 0 |
| Films with a conflicting slug | 0 |
| Slug collisions | 0 |
| Letterboxd records (watchlist and programme) | 394 |
| Records with a valid film permalink | 394 |
| Records with another URL | 0 |
| Diary history entries in the snapshot | 0 |

- **Reconciliation of the projected sidecars:** create 2,406; update, unchanged, orphan and conflict 0. The snapshot holds no stored lifecycle sidecars, so every sidecar would be new. This is a dry-run plan, not a write.

## Reading

- The `071ed03` run adds `metadata.json` as a permalink source and the `ambiguous` status. It changed nothing on this snapshot: every metadata permalink matches its watchlist or programme permalink, and no lid has disagreeing records.

- Every Film with a lid has a valid permalink in its stored record, so slug coverage of the Letterboxd catalog is complete without any request.
- No diary slugs exist yet: `letterboxd/diary/history.json` is absent because `LETTERBOXD_DIARY_HISTORY` has not run in production.
- No historical slugs exist, because no earlier sidecar carried one.
- No two Films share a slug.

## Local D1 readback

A local SQLite build in the AIR-275 session read the same snapshot. Its code was `main` `137de6a` plus PR #243 at `cd470bd`, run with `--target sqlite --staged-generation`. The build completed: 34,220 statements applied, parity 0/0/0 of 88,878, class A empty.

| `film_external_id` where `scheme = 'letterboxd_slug'` | Count |
| --- | --- |
| Rows | 394 |
| Rows with `trusted = 1` | 0 |
| Rows with `conflicting = 1` | 0 |
| Distinct Films | 394 |
| Films with a slug but no `letterboxd` id | 0 |

This is a local database, not production D1. The `071ed03` inventory rerun gave the same counts. `221d5f4` changes only how diary sighting times merge, and this snapshot has no diary entries.

## Not established

- The production D1 readback: the production load follows the merge of PR #243, with its own owner approval.
