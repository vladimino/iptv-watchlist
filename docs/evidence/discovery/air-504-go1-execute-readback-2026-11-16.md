# AIR-504: GO-1 execute and D1 readback

**Captured:** 2026-11-16 12:15–12:22 UTC (13:15–13:22 Europe/Madrid) for the first five Access writes; 12:22 UTC replay of `tmdb_238858`; 12:51:50 UTC Nazareth write after the synopsis→overview deploy; D1 `SELECT` after-image through the Cloudflare D1 query API, database `iptv` `3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb`.
**Used by:** [AIR-504](https://trello.com/c/jUaNE1Rs). Write set: [GO-1 inventory](air-504-write-set-2026-11-16.md). Writer: ADR 0153 / `catalog_policy_exclude@1` on `main` `e9b425f0` (PR #676); Nazareth after `0a6b8378` (PR #683).
**Authorization:** owner `GO` then Access login for the six-film write set; second owner `GO` for Nazareth after the classifier deploy. No GO-2. No Discovery/EPG/Predictions/TMDB/flags/Tasks start.

## What ran

Owner Access session against `https://iptv.vladimino.workers.dev`. Preview is GET. Execute is POST with `Origin` matching the Worker, `X-IPTV-Admin-Action: catalog_policy_exclude`, JSON `{filmId, idempotencyKey}`. One film per request. Keys `air504-go1-tmdb-<id>-20261116`. Tokens and JWT not recorded.

| film_id | Preview | Execute HTTP | Outcome |
| --- | --- | --- | --- |
| `tmdb_238858` | eligible `concert` | first POST: client timeout 90 s, 0 bytes; D1 later showed the write at `2026-11-16T12:15:50.083Z` | Replay POST (same key) HTTP 200, 23 s: `already_applied`, `durable`, `queue=removed` |
| `tmdb_1326142` | eligible `concert` | 200 | `written`, `queue=removed` |
| `tmdb_1356259` | eligible `concert` | 200 | `written`, `queue=removed` |
| `tmdb_252384` | eligible `concert` | 200 | `written`, `queue=removed` |
| `tmdb_364933` | first preview (pre-#683): `not_policy_excluded`; after `0a6b8378` deploy: eligible `concert` | 200, 36 s | `written`, `queue=removed` at `2026-11-16T12:51:50.091Z` |
| `tmdb_686970` | eligible `documentary` | 200 | `written`, `queue=removed` |

Nazareth first skip was a writer bug (synopsis not mapped to overview). PR #683 / `main` `0a6b8378` deployed 13:45 Europe/Madrid. Second owner GO: GET eligible `concert`, one POST, key `air504-go1-tmdb-364933-20261116`.

## After-image (D1 SELECT)

| Marker | After |
| --- | --- |
| `schema_contract.version` | 23 |
| `discovery_authority` | `d1` / `open`, generation **154668** (inventory 154657), same `programme_run_id` `3b7c7152-eb54-45f7-8985-92c377b57181` |
| `published_epg_authority` | `d1` / `open`, generation **510**, same run (sealed; not rewritten) |
| `prediction_domain_authority` | `d1`, generation 13545, `queue_generation` 1261 (inventory 13446 / 1248; queue refresh after each exclude) |
| `film_person_authority` | `prepared` / `open` |
| Resolver lease | `expires_at` 0 |

| film_id | admission | generation | discovery shows this run | queue `instr` | fingerprint | pointer |
| --- | --- | --- | --- | --- | --- | --- |
| `tmdb_238858` | `superseded` | 154663 | 0 (was 1) | 0 | none (was none) | none |
| `tmdb_1326142` | `superseded` | 154664 | 0 (was 2) | 0 | present | present |
| `tmdb_1356259` | `superseded` | 154665 | 0 (was 2) | 0 | present | present |
| `tmdb_252384` | `superseded` | 154666 | 0 (was 1) | 0 | present | present |
| `tmdb_364933` | `superseded` | 154668 | 0 (was 4) | 0 | present | present |
| `tmdb_686970` | `superseded` | 154667 | 0 (was 3) | 0 | present | present |

`ratings_view` / `watchlist_film`: still empty for these ids.

Decisions (all six GO-1 keys): `status=needs_verification`, `film_id`/`tmdb_id` null. History writer `catalog_policy_exclude` at:

- `tmdb_238858` / `rieu royale andré rieu coronation concert live in amsterdam|2013` — 12:15:50.083Z, generation 154662
- `tmdb_1326142` — 12:17:22.208Z, 154663
- `tmdb_1356259` — 12:18:14.182Z, 154664
- `tmdb_252384` — 12:18:47.007Z, 154665
- `tmdb_686970` — 12:19:22.079Z, 154666
- `tmdb_364933` / `nazareth no means of escape|` — 12:51:50.091Z, generation 154667

## Not proven

- Next natural Discovery chunk will not re-admit these six TMDB ids (code contract + `rejectedTmdbIds`; no chunk started).
- Next natural hourly Predictions tick will not enqueue them (queue refresh already ran as part of the writer; a later EPG-driven refresh is unobserved).
- Programme GET overlay for a signed-in user (Access GET of `/api/programme` not used).
- GO-2 remaining documentary / Music-only admissions.

## Out of scope

GO-2. AIR-498 `tmdb_9278`. Film/Person R2 objects. Ratings events. Prediction bodies. EPG republish. Direct SQL UPDATE/DELETE.
