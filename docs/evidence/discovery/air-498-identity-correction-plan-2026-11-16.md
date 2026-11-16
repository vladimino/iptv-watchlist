# AIR-498: disposition plan for confirmed false Discovery identities

**Captured:** 2026-11-16 00:20–00:40 UTC (16 November 2026 01:20–01:40 Europe/Madrid). Read-only D1 `SELECT` plus code on `origin/main`; no production write.
**Used by:** [AIR-498](https://trello.com/c/3dPOigK9). Inventory source: [AIR-500 audit](air-500-false-film-identity-audit-2026-11-16.md). This plan does not authorize a write until a separate owner GO names the exact key below.
**Code read:** `origin/main` `6f61e019` (ADR 0080, ADR 0085, ADR 0142 decision 4, `ownerDecision` / `assignedRowsDelete` in `src/discovery-authority.js`, `discovery_identity_correct@1`).

## Method

Side-effect-free D1 `SELECT` against production `iptv` (`database_id` `3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb`). No Worker GET, no identity-correct POST, no TMDB, no EPG/Discovery/prediction run, no flag or lease change. `rows_written` stayed 0.

## Live authority at capture

| Marker | Value |
| --- | --- |
| `schema_contract.version` | 22 |
| `discovery_authority` | `d1` / `open`, generation 145044 (was 144333 in the AIR-500 capture), `programme_run_id` `3b7c7152-eb54-45f7-8985-92c377b57181` |
| `published_epg_authority` | `d1` / `open`, generation 510, same `programme_run_id` |
| `discovery_intent` | empty |

The published EPG generation has not moved since AIR-500. Discovery generation has. The confirmed observation is still active and verified.

`discovery_identity_correct@1` is the D1 path (`identityStoreAuthority` accepts `publishedEpg.discoveryAuthority === 'd1'` and `supported: true`; confirm/execute call `putIntent` / `ownerDecision`). The historical R2-only sentence of ADR 0080 is not the live write. Do not apply an R2 resolution-map put.

## Confirmed inventory (write set)

AIR-500 classified 9 832 current movie admissions: 6 499 `valid_film`, 76 `needs_review`, 3 257 `insufficient_evidence`, and **one** confirmed wrong observation. That observation is the only write candidate.

| Field | Before-image 16 Nov 2026 01:20–01:40 Europe/Madrid |
| --- | --- |
| Observation key | `беглец\|1993` (active) |
| EPG title / year / duration | Беглец / 1993 / 130 (`confirmedTmdbId` `9278`) |
| Decision | `verified`, `tmdb_id` `9278`, `film_id` `tmdb_9278`, `identitySource` `known_epg_alias`, `rejectedTmdbIds` null |
| History writers | `import` × 1 |
| Admitted film | `tmdb_9278` current, Корпорация «Бессмертие», 1992, runtime 110 |
| Other observations of the same film | active `корпорация бессмертие\|` (`verified`, `known_epg_alias`); archive `корпорация бессмертие\|1992` (`verified`, `tmdb_detail`) |
| Current-generation discovery shows | 2 rows `match_reason=беглец\|1993`; 1 row `match_reason=корпорация бессмертие\|` |
| `ratings_view` | no row |
| Fingerprint / prediction pointer | **present** for `tmdb_9278` |
| Proposed operation | one `discovery_identity_correct@1` **reject** of TMDB id `9278` on key `беглец\|1993` |

### Expected effect of that one reject (not executed)

| Object | Change |
| --- | --- |
| Decision `беглец\|1993` | `needs_verification`; `tmdbId`/`filmId` cleared; `9278` on `rejectedTmdbIds`; owner identity on this key |
| Current discovery shows of this key | deleted in the same batch (the 2 rows) |
| Decision and show `корпорация бессмертие\|` | unchanged (1 show remains) |
| Admission `tmdb_9278` | unchanged |
| Fingerprint / pointer / queue for `tmdb_9278` | unchanged |
| EPG generation / published run id | unchanged |
| Next ordinary Discovery chunk | must not fetch movie `9278` for this observation; may search a different id |

Replay: same confirmation returns the stored receipt. Compensation: restore the before-image only with a later owner-approved write. A code revert does not restore the decision or the two shows.

Guards: resolver lease, D1 fence, decision-hash CAS, 10-minute confirmation TTL, one key, one id, one effect. Partial success of a second key is not in this group: the group has one key.

## Out of the write set

`needs_review` and `insufficient_evidence` from AIR-500 are **not** deleted and are **not** treated as confirmed. That includes the original examples:

| Id | Verdict | Why it stays out |
| --- | --- | --- |
| `tmdb_1326142` | `needs_review` | Title and runtime match the Music-only catalog film. XMLTV `categories` still absent on the active ledger. `parse_error` is a queue signal. |
| `tmdb_238858` | `needs_review` | Same. |
| Other 74 `needs_review` rows | `needs_review` | AIR-500. Concert-shaped Music-only, runtime conflicts, two alias titles, three extra `parse_error` films. Follow-up: [AIR-501](https://trello.com/c/ShipZn0N) (future admissions), [AIR-502](https://trello.com/c/CBurd3gC) (missing categories), [AIR-503](https://trello.com/c/t9fZCHLQ) (runtime RCA). |

No bulk API. Queue recompute is not required for this confirmed key because the Film stays admitted.

## Residual after a successful GO

The 76 review rows and 3 257 insufficient-evidence admissions remain. Concert-shaped predictions stay until a later, separately approved inventory. AIR-498 is not Done until the owner accepts the post-write readback of `беглец|1993` **or** explicitly accepts leaving that key unwritten.

## Owner GO request

Please approve **only**:

1. Owner UI (or equivalent Access-authenticated) `discovery_identity_correct@1` reject of TMDB movie id `9278` on observation key `беглец|1993`.
2. Readback: decision status, `rejectedTmdbIds`, count of current-generation shows with that `match_reason` (expect 0), admission `tmdb_9278` still `current`, fingerprint still present, published EPG generation still 510 unless an unrelated natural publication moved it.

Refuse: any reject or retire of `tmdb_1326142`, `tmdb_238858`, the other Music-only admissions, or `tmdb_9278` itself; any Discovery/EPG/prediction start; any bulk writer.
