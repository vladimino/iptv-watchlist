# GET and HEAD read side-effect audit (AIR-412)

Dated, bounded, offline. Captured 2026-11-10 UTC on `main` at `2e07e3d` plus the AIR-412 pull request. No production request, no Cloudflare call, no TMDB call, no migration and no flag change was made. Decision: [ADR 0107](../../adr/0107-get-head-read-side-effect-boundary.md) (Proposed). Inventory and baseline: [read side effects](../../reference/api/read-side-effects.md). Card: [AIR-412](https://trello.com/c/TuRMtgFF), umbrella [AIR-411](https://trello.com/c/6abdVoGq).

## Method

- The **production bundle** is built by `build.mjs` in a working directory of links to the repository (the repository's `dist` is not touched) and imported, so the code under test is the code that is deployed, not a re-assembly of source files.
- **R2** is an in-memory bucket that records every `put` and `delete`. **D1** is the sqlite stand-in with all 18 migrations applied and a recording hook on every statement and every batch; each statement is classified (`SELECT` is a read, `INSERT`, `UPDATE`, `DELETE`, `REPLACE`, DDL are writes, anything else is `UNCLASSIFIED`). The database file is also hashed before and after: a changed file with no classified statement is its own finding. Outbound `fetch`, `waitUntil`, continuation dispatch and Workflow `create` are recorded.
- **Authority modes:** the D1 scenarios set the published-EPG, discovery and owner-review markers to `d1`, publish a real generation through `PublishedEpg.publishGeneration` and, where the scenario says so, repair or withhold the R2 mirrors. The prediction domain is exercised on D1 intents wherever the bundle uses them. The scenarios are `r2`, `r2-pending`, `empty`, `d1`, `d1-mirror-missing`, `d1-mirror-stale`, `d1-held`, `d1-pending`.
- **Inventory:** exact GET routes and POST-only routes are extracted from the bundle; prefix and by-path routes are registered; MCP tools come from `tools/list`. Every read route is requested with GET and HEAD in every scenario; POST-only routes are asked with GET; read MCP tools are called in every scenario.
- **The instruments are tested:** `tests/get-write-audit-harness.mjs` runs a synthetic Worker that performs each kind of effect and checks that each is reported and that a read reports nothing. A mutation of `GET /api/started` that adds an R2 write was run once and failed the audit with the exact route and key.

## Result

58 read routes, 27 POST-only routes asked with GET, 15 pages, 15 MCP read tools and 10 write tools, 8 scenarios. Of the read routes, **14 HTTP routes (16 sampled requests) and 3 MCP tools write storage** in at least one scenario, one route sends an outbound request, and every other read has no effect in any scenario. No HEAD, no page and no POST-only route asked with GET has an effect. The whole audit takes about seven seconds.

| Finding | Where | Evidence |
| --- | --- | --- |
| The mirror repair writes on every read of a D1 generation, even with current mirrors | 12 HTTP routes and 3 MCP tools reach it through the published-generation pin; `programme` and `watchlist` run it twice | In `d1` and `d1-pending` each request runs `UPDATE published_epg_authority` and `UPDATE published_epg_cas` (twice for programme and watchlist) and no R2 `put`. `PublishedEpg.currentGeneration()` does not return `mirrorWatchlistEtag`, so the alignment test in `repairMirrors` compares the watchlist etag with `undefined`, is never true and always goes on to `writeMirrors` |
| With mirrors missing or old the same reads rewrite five R2 objects | same routes | `d1-mirror-missing`, `d1-mirror-stale`: `put` of the generation `programme.json`, root `programme.json`, root `watchlist.json`, the generation `watchlist.json`, `epg/published-generation.json`, then the marker `UPDATE`s. `cutover` held (`d1-held`) repairs nothing |
| `GET /api/enrichment/runs`, `GET /api/enrichment/status` settle an expired run lease | R2 and D1 | `r2-pending`: `put` of the run record and its diagnostic row. `d1-pending`: the same plus the fenced prediction-domain statements |
| `GET /api/events`, `GET /api/enrichment/status` deliver an undelivered stop event | R2 and D1 | `r2-pending`: run record, diagnostic row, `events/items/<ts>-stop-run-stopped.json` and the delivered flag. `d1-pending`: the same plus fenced D1 intents (twice on status: the stop event and the lease settlement) |
| `GET /api/enrichment/view` merges the personal-ratings seed | R2 (and D1 for the pin) | Only a build with a non-empty seed shows it (`r2-pending`: `put enrichment/view-index.json`). The repository's empty seed makes the merge a no-op, so this writer appears only in a private build |
| MCP annotations disagree with behavior | `prediction_queue_overview`, `prediction_film_diagnostics` | Annotated `readOnlyHint: true`; they run the pin repair in D1 authority. `enrichment_status` is annotated `readOnlyHint: false` and writes (same effects as the HTTP status route) |
| One outbound request on a read | `GET /api/integrations/tmdb/status` | One `GET https://api.themoviedb.org/3/movie/11` with the Worker secret; no storage write, spends provider quota. Registered as `outbound-read` |
| An unhandled error on an empty R2 | `GET /api/watchlist` in `empty` | Answers 502 with an uncaught `TypeError` when no programme is stored. Not fixed here (no functional defect is fixed by AIR-412); recorded for the owner's backlog |

Not writers (verified in every scenario): `footer/status` (made read-only by AIR-389), `catalog/film/<id>`, `ratings/status`, `letterboxd/ratings/status`, `monitor/status`, `discovery/status`, `pipeline/status`, `queue/status`, `profile`, `schema`, `runner`, `quality`, `diagnostics/*`, `moods/diagnostics`, `history`, `diary`, `started`, `status`, `filter-presets`, `/api/d1/*` and the admin posters, recovery and receipt reads.

## Limitations

- The ratings, metadata-cache and Film/Person authorities stay on R2 in every scenario; a writer that exists only under their D1 branch is not exercised. The scenario list is extensible in `tests/get-write-audit-lib.mjs`.
- The audit cannot reproduce a production-only state (a private ratings seed other than the one the `*-pending` scenarios use, an unusual marker value, a stored object shape the fixtures do not have). It reports what the code does on the states it builds.
- Scheduled work (the hourly tick, Workflows, MCP write tools) is not a GET and is outside this audit.
- No production request was made; nothing here shows what a production read did or will do.

## Reproduce

`node tests/get-write-audit.mjs` and `node tests/get-write-audit-harness.mjs` (also part of `npm test`). Set `AUDIT_PRINT=1` to print every observed effect by route and scenario.
