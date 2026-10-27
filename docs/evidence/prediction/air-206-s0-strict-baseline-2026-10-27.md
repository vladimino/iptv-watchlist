# Selective prediction compatibility: strict baseline (stage S0)

**Captured:** 2026-10-27, 23:00–23:07 UTC, read-only
**Code:** `main` `0fefdfb` (AIR-202 publisher, AIR-203 evaluator, AIR-204 queue counters and AIR-205 consumers merged and deployed per the cards; the deployed version itself was not read)
**Sources:** owner-only IPTV MCP read tools only: `enrichment_queue` (= `GET /api/enrichment/queue/status`), `prediction_queue_overview`, `enrichment_profile` (= `GET /api/enrichment/profile`), `prediction_film_diagnostics` for five film ids taken from the repository's `data/film-titles.json`. All are read-only and outside the GET routes that may write (`tests/get-side-effects.mjs`)
**Not done:**
- no write, refresh, run, backfill, flag, Scheduled Task, Access or publication;
- `GET /api/enrichment/view`, `/status`, `/runs` and `/api/events` were not called, because they may write;
- footer status and the catalog route were not read, because they have no MCP tool and need no separate check here: they count the same index as the queue.

**Approval:** owner approval of S0 in the AIR-206 conversation, 27 October 2026 ([AIR-206](https://trello.com/c/87mg3VNi))
**Verdict:** **GO for the next owner decision.** Strict is in force, every evaluator invariant holds, and the profile has no lineage yet, so `selective` would decide exactly as `strict` until a profile version is published under the change-impact contract. One measurement gap remains (impact facet coverage, below)

## Queue and its compatibility block

Queue refreshed at 2026-10-27T22:23:10.942Z (trigger of the last batch: `scheduled`, stage `noop`); programme generation `b2699929-…`, published and consistent.

| Field | Value |
| --- | --- |
| `compatibility.mode` | `strict` (switch unset) |
| `evaluatorVersion` / `profileVersion` | 1 / 1 |
| `films` / `missing` | 2,333 / 0 |
| `strict` | current 2,333, stale 0 |
| `selective` | current 2,333, compatible 0, stale 0 |
| `reasons` | `exact`: 2,333 |
| `wouldKeep` / `wouldRequeue` / `strictDisagreements` | 0 / 0 / 0 |
| Pending, hot / cold remaining | 0, 0 / 0 (queue `drained`) |
| Coverage (overview) | 2,333 / 2,333 current (100 %), window 1,892 / 1,892 |

`hotCount` 1,897 and `coldCount` 436 sum to the 2,333 evaluated films. The overview reports `consistent: true` with no reasons: queue, programme, published generation and profile agree.

## Profile

- `version` 1, `schemaVersion` 1, `updatedAt` 2026-10-04T18:41:55.630Z, `profileHash` `14cbed70…9753`.
- **No `lineage` and no `changeImpact`**: the current record predates the change-impact publisher. The first publication under the contract starts the lineage with this version's link.
- Profile text is not reproduced here.

## Film diagnostics sample

| Film id | Fingerprint | Prediction | `cause` / `mode` | Index |
| --- | --- | --- | --- | --- |
| `H11k` | not recorded | not recorded | `not_recorded` | agreed |
| `2Eao` | schema 1, current | current, profile match | `current` / `strict` | agreed |
| `w0e6` | schema 1, current | current, profile match | `current` / `strict` | agreed |
| `BNNu` | schema 1, current | current, profile match | `current` / `strict` | agreed |
| `d2hI` | schema 1, current | current, profile match | `current` / `strict` | agreed |

`H11k` is a dictionary id that is not a queue film today (`lane: none`). The film diagnostics carry the `mode` field added with the shared freshness rule.

## Findings

1. **Strict baseline confirmed.** Every evaluated prediction is exact under both rules. The two invariants (`wouldRequeue`, `strictDisagreements`) are 0.
2. **Selective would currently change nothing.** With no lineage and no newer version, every prediction is exact. Setting the switch (S2) is a no-op for decisions until a version is published under the change-impact contract (S4).
3. **Gap: impact facet coverage is not observable with read-only tools.** The counters cannot show how many index entries already carry `impactFeatures`: every prediction is exact, and an exact prediction needs no features. Entries written before the queue change lack the facet, and under `selective` their predictions would count as `film_features_unknown`, i.e. stale, after the next selective publication. The fingerprint-view backfill (S1) or the runner's repair under `selective` closes the gap; neither was run.

## Limits

Point-in-time reads at one queue refresh; not evidence of the deployed Worker version, flag bindings (not read from Cloudflare settings) or Scheduled Task state. Five sampled films are not a census.
