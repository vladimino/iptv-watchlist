# AIR-498: production identity reject readback

**Captured:** 2026-11-16 07:32–07:37 UTC (16 November 2026 08:32–08:37 Europe/Madrid).
**Used by:** [AIR-498](https://trello.com/c/3dPOigK9). Plan: [identity correction plan](air-498-identity-correction-plan-2026-11-16.md). Inventory: [AIR-500 audit](air-500-false-film-identity-audit-2026-11-16.md).
**Deployed code:** `main` `7a018a3599788360847032894a3c9d587cc65805` (PR #668).

## Authorization

Owner handoff on AIR-498 (16 November 2026 08:26 Europe/Madrid) authorized **one** Access-authenticated `discovery_identity_correct@1` **reject** of TMDB movie id `9278` on observation key `беглец|1993`. No other key, Film retire, EPG/Discovery/Predictions start, or direct SQL.

## Preflight (read-only D1 `SELECT`, then GET offer)

Production D1 `iptv` (`3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb`). `rows_written` 0 on the SELECT path.

| Marker | Preflight |
| --- | --- |
| `schema_contract.version` | 23 (plan capture was 22) |
| `discovery_authority` | `d1` / `open`, generation **152512**, `programme_run_id` `3b7c7152-eb54-45f7-8985-92c377b57181` |
| `published_epg_authority` | `d1` / `open`, generation **510**, same `programme_run_id` |
| `discovery_intent` | empty |
| Resolver lease | `lease_id` null, `expires_at` 0 |

Target still matched the plan: `беглец|1993` active, decision `verified` / `tmdb_id=9278` / `film_id=tmdb_9278` / `identitySource=known_epg_alias`, 2 current-generation `published_epg_show` rows with `basis='discovery'` and `match_reason='беглец|1993'`. Neighbor `корпорация бессмертие|` verified on the same Film, 1 show. Admission `tmdb_9278` `current`. `prediction_fingerprint` and `prediction_pointer` present (hash prefix `4f24bfc2876b`). Concert admissions `tmdb_1326142` and `tmdb_238858` remained `current` and were not in the write set.

`GET /api/admin/discovery-recovery?key=беглец|1993` (Access session, no write): `identity.available=true`, `authority=d1`, `rejectable=["9278"]`, current `verified` / `9278`. Reconsider action ineligible. Coordination lease `not_recorded`.

## Write

One confirm then one execute on the Worker, same-origin JSON, `X-IPTV-Admin-Action: discovery_identity_correct`. No D1 UPDATE/DELETE from the operator, no R2 map put, no bulk API.

| Step | HTTP | Outcome |
| --- | --- | --- |
| `POST …/identity-confirm` | 200 | `effect=reject`, `tmdbId=9278`, plan `verified` → `needs_verification` with `rejectedTmdbIds=["9278"]`, `application.shows=cleared_assigned_rows` |
| `POST …/identity-correct` | 200 | `state=applied`, `durable=true`, `replayed=false`, receipt `decisionHash=3e0cf1c28e251b914c238a602561a668c936c58d79ec605ee9d7e452e50c5451` |

Idempotency key / receipt `requestId`: `7761f6a023e64ebebddbda18ffc79cd5`. Confirmation issued `2026-11-16T07:35:38.802Z`, applied `2026-11-16T07:36:03.722Z` (ownerIdentity `at`). History writer `discovery_identity_correct` at `2026-11-16T07:36:07.013Z` (previous writer was `import` only).

## After-image (read-only D1 `SELECT`)

| Object | After |
| --- | --- |
| Decision `беглец\|1993` | `needs_verification`; `tmdb_id`/`film_id` null; `rejectedTmdbIds=["9278"]`; `ownerIdentity.effect=reject` |
| Observation row | still `residence=active`; `confirmed_tmdb_id` still `9278` (ledger evidence field, not the decision) |
| Current discovery shows of this key | **0** (was 2) |
| Neighbor `корпорация бессмертие\|` | still `verified` / `9278` / `tmdb_9278`; **1** show |
| Shows of `film_id=tmdb_9278` | **1** (the neighbor only) |
| Admission `tmdb_9278` | still `current` |
| Fingerprint / pointer | still present, same hash prefix |
| EPG generation | still **510**, same `programme_run_id` |
| Discovery generation | **152514** (152512 at preflight; fence moved with the owner write, not an EPG publication) |
| Concerts `tmdb_1326142`, `tmdb_238858` | still `current` |

## Not proven

- That the next ordinary Discovery chunk will search a different id and will not fetch movie `9278` for this key (code contract + `rejectedTmdbIds`; no chunk was started).
- That `confirmed_tmdb_id` on the observation row will change; it is not written by this action.
- One `discovery_intent` row remained: `kind=identity_reject`, same observation key and idempotency key as this operation (the action record). Not deleted.
- Natural EPG republish of the slot as unresolved.

## Out of scope (untouched)

`tmdb_9278` Film admission, neighbor observation, fingerprint, pointer, ratings/watchlist, `tmdb_1326142`, `tmdb_238858`, other `needs_review` / `insufficient_evidence` rows. No EPG/Discovery/Predictions/Task/flag/migration run.

Rollback of this decision is a separate owner-approved write. A code revert does not restore the two deleted show rows.
