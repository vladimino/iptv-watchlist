# AIR-501: Tier B execute and D1 readback

**Captured:** 2026-11-18 13:35–13:38 UTC (14:35–14:38 Europe/Madrid): six Access writes, then a D1 `SELECT` after-image through the Cloudflare D1 query API, database `iptv` (`3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb`).
**Used by:** [AIR-501](https://trello.com/c/ShipZn0N). Write set: [empty-genre inventory](air-501-empty-genre-inventory-2026-11-18.md), the six Tier B cards the writer reaches after [ADR 0169](../../adr/0169-writer-only-catalog-cleanup-classification.md) (`main` `d30f0be`, deployed 12:55 UTC). Writer: `catalog_policy_exclude@1` ([ADR 0153](../../adr/0153-catalog-policy-exclusion.md)).
**Authorization:** owner `GO по eligible` in chat on top of the standing Access session from the same day, after a fresh preview of the six. The six unreached cards (Tier B non-fiction and Tier C) received no GO and nothing was written for them. No Discovery, EPG, prediction, TMDB, flag, Task or migration start.

## What ran

Preview (GET) answered `available`, `eligible`, `linkedAdmissions` empty, one observation each, immediately before the writes. Execute is POST with `Origin` matching the Worker, `X-IPTV-Admin-Action: catalog_policy_exclude`, JSON `{filmId, idempotencyKey}`, one film per request, keys `air501-go2-<film_id>-20261118`. Every first POST answered HTTP 200; none hit `lease_held`. Tokens and JWT not recorded.

| film_id | Title | Policy | Outcome |
| --- | --- | --- | --- |
| `tmdb_761960` | Пикник: Традиционный весенний концерт | `concert` | `written`, `durable`, `queue=removed` |
| `tmdb_1063549` | Gaga Chromatica Ball | `concert` | `written`, `durable`, `queue=removed` |
| `tmdb_785554` | BLACKPINK: The Show | `concert` | `written`, `durable`, `queue=removed` |
| `tmdb_801575` | Кино в Севкабеле | `concert` | `written`, `durable`, `queue=removed` |
| `tmdb_534012` | Paul Rodgers: Free Spirit | `concert` | `written`, `durable`, `queue=removed` |
| `tmdb_988831` | Neil Young: Three More Decades | `documentary` | `written`, `durable`, `queue=removed` |

## After-image (D1 SELECT)

| film_id | admission (state@generation) | decision | discovery shows (published run) | `watchlist_film` | `film_rated_admission` | queue chunks mentioning the id | history writer, time (UTC) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `tmdb_761960` | `superseded@195873` | `needs_verification`, `film_id` null | 0 | 0 | 0 | 0 | `catalog_policy_exclude`, 13:35:06.918Z |
| `tmdb_1063549` | `superseded@195874` | same | 0 | 0 | 0 | 0 | 13:35:36.768Z |
| `tmdb_785554` | `superseded@195875` | same | 0 | 0 | 0 | 0 | 13:36:05.044Z |
| `tmdb_801575` | `superseded@195876` | same | 0 | 0 | 0 | 0 | 13:36:31.805Z |
| `tmdb_534012` | `superseded@195877` | same | 0 | 0 | 0 | 0 | 13:36:59.721Z |
| `tmdb_988831` | `superseded@195878` | same | 0 | 0 | 0 | 0 | 13:37:23.694Z |

Authority: Discovery `d1` / `open`, generation 195878; published EPG `d1` / `open`, programme run `ae4c4209-3894-41aa-8798-bb82a2d11a2b`, generation 512, unchanged by the writer. Ratings, fingerprints, immutable predictions and Film/Person R2 objects were not touched.

## Not proven

- That a later natural Discovery chunk will not re-admit these TMDB ids (code contract and `rejectedTmdbIds`; no chunk was started), and that a later Predictions tick will not queue them.
- Programme overlay as a signed-in user sees it (no Access GET of `/api/programme`).
- Still admitted and open: `tmdb_450202`, `tmdb_1126350`, `tmdb_1603159` (empty or placeholder synopsis, need external verification) and `tmdb_1623086`, `tmdb_569928`, `tmdb_1603299` (non-fiction with no performance or documentary word, need another path).

## Rollback

No automatic undo. Restore is a separate owner-approved write of the admissions and decisions from `discovery_decision_history`. A code rollback does not re-admit superseded rows.
