# AIR-501: execute and D1 readback of the last six reviewed films

**Captured:** 2026-11-18 15:54–16:51 UTC (16:54–17:51 Europe/Madrid): six Access writes, then a D1 `SELECT` after-image through the Cloudflare D1 query API, database `iptv` (`3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb`).
**Used by:** [AIR-501](https://trello.com/c/ShipZn0N). Write set: the six films of [ADR 0171](../../adr/0171-owner-reviewed-policy-exclusion-list.md), verified against the TMDB card ([evidence](air-501-tmdb-verification-2026-11-18.md)). Code on `main` `9131abd` (deployed 15:41 UTC). Writer: `catalog_policy_exclude@1` ([ADR 0153](../../adr/0153-catalog-policy-exclusion.md)).
**Authorization:** owner `GO на эти шесть` in chat after a fresh preview of the six (all `available`, `eligible`, generation 198553), on top of the same-day owner Access login. No Discovery, EPG, prediction, TMDB, flag, Task or migration start.

## What ran

Preview (GET) immediately before the writes. Execute is POST with `Origin` matching the Worker, `X-IPTV-Admin-Action: catalog_policy_exclude`, JSON `{filmId, idempotencyKey}`, one film per request, keys `air501-go3-<film_id>-20261118`. Tokens and JWT not recorded.

The natural Discovery Workflow drained its backlog without pauses and then the natural daily EPG publication ran (published EPG generation 512 to 513, programme run `cc26a2e7-ae15-4f15-8e21-62ff131e04fd`). While either held the resolver lease the writer refused: `409 lease_held` (many attempts, nothing written, lease never touched) and, during the EPG run, `503 storage_unavailable` (D1 readback before the next attempt: nothing written). The same key was retried every 25 seconds to 2 minutes. One POST for `tmdb_1603159` ended with a client timeout (`HTTP 000`); a D1 readback showed the write had been applied at 16:42:39.988Z, and a replay with the same key answered `already_applied`, `durable`, `queue=removed`.

| film_id | Title | Policy | Outcome |
| --- | --- | --- | --- |
| `tmdb_450202` | Britney Spears: Apple Music Festival | `concert` | `written`, `durable`, `queue=removed` (5th attempt) |
| `tmdb_1126350` | DJ BoBo - EVOLUT30N | `concert` | `written`, `durable`, `queue=removed` |
| `tmdb_1603159` | TesseracT: RADAR | `concert` | applied by the timed-out POST, replay `already_applied`, `queue=removed` |
| `tmdb_1623086` | Арктика. Очищение | `documentary` | `written`, `durable`, `queue=removed` |
| `tmdb_569928` | Большой белый танец | `documentary` | `written`, `durable`, `queue=removed` |
| `tmdb_1603299` | Северный морской путь, или Русская дорога в океане | `documentary` | `written`, `durable`, `queue=removed` |

## After-image (D1 SELECT)

| film_id | admission (state@generation) | decision | shows in the published run (all `basis`) | `watchlist_film` | `film_rated_admission` | queue chunks mentioning the id | history writer, time (UTC) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `tmdb_450202` | `superseded@198710` | `needs_verification`, `film_id` null | 0 | 0 | 0 | 0 | `catalog_policy_exclude`, 15:54:29.646Z |
| `tmdb_1126350` | `superseded@198712` | same | 0 | 0 | 0 | 0 | 15:54:58.969Z |
| `tmdb_1603159` | `superseded@198903` | same | 0 | 0 | 0 | 0 | 16:42:39.988Z |
| `tmdb_1623086` | `superseded@198904` | same | 0 | 0 | 0 | 0 | 16:49:37.566Z |
| `tmdb_569928` | `superseded@198905` | same | 0 | 0 | 0 | 0 | 16:50:34.999Z |
| `tmdb_1603299` | `superseded@198906` | same | 0 | 0 | 0 | 0 | 16:51:19.808Z |

Authority: Discovery `d1` / `open`, generation 198906; published EPG `d1` / `open`, generation 513, programme run `cc26a2e7-ae15-4f15-8e21-62ff131e04fd` (a natural publication; the writer does not move it). The distinct TMDB ids written by `catalog_policy_exclude@1` now number **166**, the size of `OWNER_POLICY_EXCLUDED_TMDB_IDS` ([ADR 0172](../../adr/0172-owner-policy-exclusion-blocks-reentry.md)), so the list and the production history agree. Ratings, fingerprints, immutable predictions and Film/Person R2 objects were not touched.

## Result for the AIR-501 shortlist

Sixteen of sixteen shortlisted admissions are retired: Tier A (4, [readback](air-501-tier-a-execute-readback-2026-11-18.md)), Tier B (6, [readback](air-501-tier-b-execute-readback-2026-11-18.md)) and these six. The shortlist came from catalog metadata and is not a certified population audit.

## Not proven

- That a later natural Discovery chunk will not re-admit these TMDB ids and that a later Predictions tick will not queue them (code contract, `rejectedTmdbIds` and the ADR 0172 list; no chunk was started by this work).
- Programme overlay as a signed-in user sees it (no Access GET of `/api/programme`).

## Rollback

No automatic undo. Restore is a separate owner-approved write of the admissions and decisions from `discovery_decision_history`. A code rollback does not re-admit superseded rows.
