# AIR-501: Tier A execute and D1 readback

**Captured:** 2026-11-18 10:55–11:00 UTC (11:55–12:00 Europe/Madrid): four Access writes, then a D1 `SELECT` after-image through the Cloudflare D1 query API, database `iptv` (`3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb`).
**Used by:** [AIR-501](https://trello.com/c/ShipZn0N). Write set: [empty-genre inventory](air-501-empty-genre-inventory-2026-11-18.md), Tier A. Writer: `catalog_policy_exclude@1` ([ADR 0153](../../adr/0153-catalog-policy-exclusion.md)).
**Authorization:** Access login by the owner in chat, then an explicit owner `GO на Tier A` for the four named films in the same session. Tier B and Tier C: no GO, nothing written. No Discovery, EPG, prediction, TMDB, flag, Task or migration start.

## What ran

Owner Access session against `https://iptv.vladimino.workers.dev`. Preview is GET (`available`, `eligible` for all four before the write). Execute is POST with `Origin` matching the Worker, `X-IPTV-Admin-Action: catalog_policy_exclude`, JSON `{filmId, idempotencyKey}`, one film per request, keys `air501-go1-<film_id>-20261118`. Tokens and JWT not recorded.

The first POST for `tmdb_110445` answered `409 lease_held` (a natural Discovery chunk held the resolver lease) and wrote nothing; the lease was not touched. The same key succeeded on the next attempt.

| film_id | Title | Policy | Execute | Outcome |
| --- | --- | --- | --- | --- |
| `tmdb_110445` | Пикник: 30 Световых лет | `ambiguous` | HTTP 200 | `written`, `durable`, `queue=removed` |
| `tmdb_192657` | Whitesnake: Made in Japan | `ambiguous` | HTTP 200 | `written`, `durable`, `queue=removed` |
| `tmdb_23710` | Shakira: Oral Fixation Tour | `ambiguous` | HTTP 200 | `written`, `durable`, `queue=removed` |
| `tmdb_24970` | Pink Floyd: Pulse | `concert` | HTTP 200 | `written`, `durable`, `queue=removed` |

## After-image (D1 SELECT)

| film_id | admission | generation | discovery shows (published run) | `watchlist_film` | `film_rated_admission` | decision | history writer, time (UTC) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `tmdb_110445` | `superseded` | 195074 | 0 (was 1) | 0 | 0 | `needs_verification`, `film_id` null | `catalog_policy_exclude`, 10:55:12.217Z |
| `tmdb_192657` | `superseded` | 195075 | 0 (was 2) | 0 | 0 | same | 10:55:46.344Z |
| `tmdb_23710` | `superseded` | 195076 | 0 (was 1) | 0 | 0 | same | 10:56:12.863Z |
| `tmdb_24970` | `superseded` | 195077 | 0 (was 1) | 0 | 0 | same | 10:56:41.269Z |

Prediction queue: no D1 `prediction_queue` chunk mentions any of the four ids. Authority: Discovery `d1` / `open`, generation 195077; published EPG `d1` / `open`, programme run `ae4c4209-3894-41aa-8798-bb82a2d11a2b`, generation 512, the same run as at the preview. The sealed generation was not rewritten by this write (the generation counter moved from 511 to 512 by a natural publication, not by the writer).

## Not proven

- That a later natural Discovery chunk will not re-admit these four TMDB ids (code contract and `rejectedTmdbIds`; no chunk was started).
- That a later hourly Predictions tick will not enqueue them.
- Programme overlay as a signed-in user sees it (no Access GET of `/api/programme`).
- Tier B (nine proven policy violations the writer cannot classify) and Tier C (three needing external verification): still admitted, still open.

## Rollback

No automatic undo. Restore is a separate owner-approved write of the admissions and decisions from `discovery_decision_history`. A code rollback does not re-admit superseded rows.
