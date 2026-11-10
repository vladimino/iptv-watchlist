# GET and HEAD read side effects

The maintained inventory of the read routes of the Worker, of its pages and of its MCP read tools, and the **baseline of the reads that still write**. The decision is [ADR 0107](../../adr/0107-get-head-read-side-effect-boundary.md) (Proposed); the dated findings are in the [audit of 2026-11-10](../../evidence/api/air-412-get-head-audit-2026-11-10.md); the picture is [read paths and repair owners](../../architecture/read-side-effects.md). The contract is executable: `tests/get-write-audit.mjs` (inventory, scenarios, comparison), `tests/get-write-audit-lib.mjs` (instrumented R2 and D1, scenario builder), `tests/get-write-audit-harness.mjs` (proves the instruments see every kind of effect) and `tests/get-write-baseline.mjs` (registry and baseline). This page grants no production access: the audit never calls Cloudflare, TMDB or production.

## Contract

A GET or HEAD, and every helper it calls, performs no R2 `put` or `delete`, no D1 `INSERT`, `UPDATE`, `DELETE` or DDL, creates no Workflow instance, dispatches no continuation, schedules no `waitUntil` work and sends no outbound request except a registered read-only GET. The effects the audit reports for one request:

| Effect | Reported as |
| --- | --- |
| R2 write | `put:<key>`, `delete:<key>` (a conditional put is a put; reverse-timestamp prefixes of journal keys are written `<ts>`) |
| D1 write | `d1:<VERB> <table>`; the exact normalized statements are compared too. A statement that is neither a read nor a recognized write is `d1:UNCLASSIFIED ...`; a changed database file with no classified statement is `d1:UNREPORTED_FILE_CHANGE` |
| Outbound request | `fetch:<METHOD> <url without query>`; a body is `METHOD+body` |
| Background work | `background:<n>` (`waitUntil`), `dispatch:<n>` (`DiscoveryContinuation`), `workflow:<n>` (a Workflow `create`) |

## Inventory

The routes are derived from the production bundle by the audit, then checked against the registry in `tests/get-write-baseline.mjs`.

- **Exact GET routes (28):** `/api/catalog/available`, `/api/enrichment/{diagnostics/accuracy, diagnostics/export, diagnostics/snapshot, discovery/status, footer/status, history, moods/diagnostics, pipeline/status, profile, quality, queue/status, ratings/status, runner, runs, schema, status, view}`, `/api/events`, `/api/integrations/tmdb/status`, `/api/letterboxd/diary`, `/api/letterboxd/ratings/status`, `/api/monitor/status`, `/api/programme`, `/api/started`, `/api/status`, `/api/ui/filter-presets`, `/api/watchlist`. A route with a required query is requested with one (`history`, `diary`).
- **Prefix and by-path routes**, each registered with the GET samples that stand for it: `/api/admin/` (overview, films, people, one film, one person), `/api/admin/health`, `/api/admin/limbo`, `/api/admin/posters`, `/api/admin/prediction-recovery`, `/api/admin/discovery-recovery` and `/api/admin/discovery-recovery/` (both receipt reads), `/api/d1/` (status, persons, review, one film, one person, one identity), `/api/catalog/film/<id>` (four ids), `/api/catalog/watched` and `/api/admin/letterboxd-archive/` (POST only, asked with GET), `/api/letterboxd/baseline/`, `/api/migration-export/`, `/api/ui/filter-presets/`. A prefix the dispatcher adds and the registry does not know fails the audit.
- **POST-only routes (27 extracted)** are asked with GET and must do nothing (they answer 404 or 405).
- **Pages (15):** `/`, `/admin`, `/admin/health`, `/admin/limb`, `/admin/limbo` (redirect), `/admin/posters`, `/admin/letterboxd`, `/admin/actions`, `/events`, `/film/<id>` and the static scripts and styles; GET and HEAD, assets only.
- **HEAD:** every read route is also requested with HEAD in every scenario. An API route answers 404 or 405 to HEAD and must have no effect.
- **MCP:** `tools/list` is the inventory. Read tools (15) are called in every scenario: `probe_read`, `probe_echo`, `feature_flags`, `epg_status`, `epg_pipeline_status`, `enrichment_schema`, `enrichment_profile`, `enrichment_runner`, `enrichment_queue`, `enrichment_status`, `prediction_queue_overview`, `prediction_film_diagnostics`, `prediction_validate`, `prediction_pending`, `ratings_sync_status`. Write tools (10) are registered and never called: `epg_sync_start`, `epg_sync_step`, `ratings_sync_start`, `ratings_sync_step`, `ratings_storage_migrate`, `prediction_start`, `prediction_next`, `prediction_submit`, `prediction_heartbeat`, `prediction_complete`. A tool in neither list fails. `readOnlyHint: true` means no effect in any scenario; the two defects below are the only exceptions.

## Scenarios

| Scenario | Storage |
| --- | --- |
| `r2` | R2 authority, healthy; no D1 binding |
| `r2-pending` | R2 authority; an undelivered stop event, a run whose lease expired, an expired runner and resolver lease, a personal-ratings seed not yet merged into the view index |
| `empty` | R2 authority, nothing seeded (missing seed) |
| `d1` | D1 authority for the published EPG, discovery and owner review; a real published generation; R2 mirrors current |
| `d1-mirror-missing` | D1 authority; the R2 compatibility mirrors are missing |
| `d1-mirror-stale` | D1 authority; the R2 mirrors belong to an older generation |
| `d1-held` | D1 published EPG with `cutover` held (the fence) |
| `d1-pending` | `d1` with the same pending work as `r2-pending`; the prediction domain on D1 intents |

Every probe starts from a copy of the scenario's database file and a fresh bucket, so a request never sees what an earlier one wrote and a repeat is a separate, equal probe. The `*-pending` scenarios run a build of the same bundle with a non-empty personal-ratings seed (the repository ships an empty one for a private build to replace). The ratings, metadata-cache and Film/Person authorities stay on R2 in every scenario.

## Baseline: the reads that write today

Exact ordered effects per scenario are in `tests/get-write-baseline.mjs`; nothing outside this table writes in any scenario.

| Baseline entry | Reads | Effects | Removed by |
| --- | --- | --- | --- |
| `epg-mirror-repair-pin` | `GET /api/catalog/available`, `/api/admin/overview`, `/api/admin/films` (three forms), `/api/admin/people` (two forms), `/api/admin/health`, `/api/admin/limbo` (two forms) | D1 authority: `UPDATE published_epg_authority` and `UPDATE published_epg_cas` (the mirror marker and its fence), also with current mirrors; mirrors missing or old: also `put` of the generation `programme.json`, root `programme.json`, root `watchlist.json`, the generation `watchlist.json` and `epg/published-generation.json`. `cutover` held: none | [AIR-414](https://trello.com/c/GJefgNm8) |
| `epg-mirror-repair-presentation` | `GET /api/programme`, `GET /api/watchlist` | The same, twice per request (the pin and the presentation helper) | AIR-414 |
| `enrichment-view-seed` | `GET /api/enrichment/view` | The repair above in D1 authority; `put enrichment/view-index.json` when a private build carries a ratings seed the index lacks | [AIR-413](https://trello.com/c/orvuzDW5), AIR-414 |
| `enrichment-runs-recovery` | `GET /api/enrichment/runs` | A run whose lease expired: `put` of the run record and of its diagnostic row; D1 prediction domain: `UPDATE prediction_domain_authority`, `UPDATE prediction_domain_cas`, `INSERT INTO prediction_domain_intent`, `DELETE FROM prediction_domain_intent`, `UPDATE prediction_domain_cas` | [AIR-415](https://trello.com/c/NHyIKM6z) |
| `enrichment-status-recovery` | `GET /api/enrichment/status` | Stop-event recovery (run record, diagnostic row, `events/items/<ts>-stop-<run>.json`, the delivered flag), expired-lease settlement, the D1 prediction fence statements twice, and the pin repair | AIR-415, [AIR-416](https://trello.com/c/f7FX4Elk), AIR-414 |
| `events-recovery` | `GET /api/events` | Stop-event recovery before the page is read: the four R2 objects above and, in D1, the prediction fence statements | AIR-416 |
| `tmdb-status-probe` | `GET /api/integrations/tmdb/status` | One outbound `GET https://api.themoviedb.org/3/movie/11` with the Worker secret; no storage write | none (registered outbound read) |
| `mcp-enrichment-status` | MCP `enrichment_status` | The same as `GET /api/enrichment/status`; annotated `readOnlyHint: false` for this reason | AIR-415, AIR-416, AIR-414 |
| `mcp-prediction-overview-pin` | MCP `prediction_queue_overview`, `prediction_film_diagnostics` | The pin repair in D1 authority. **Annotation defect:** both are annotated `readOnlyHint: true` | AIR-414 |

The normalized D1 statements of the repair are `UPDATE published_epg_authority SET mirror_programme_run_id=?, mirror_etag=?, mirror_watchlist_etag=COALESCE(?, mirror_watchlist_etag) WHERE id=? AND mode=? AND cutover=? AND programme_run_id=? AND generation=?` and `UPDATE published_epg_cas SET ok=changes() WHERE id=?`; those of the prediction fence are `UPDATE prediction_domain_authority SET generation=? WHERE id=? AND mode=? AND writes=? AND generation=?`, `UPDATE prediction_domain_cas SET ok=changes() WHERE id=?`, `INSERT INTO prediction_domain_intent (key, token, generation, body_sha256) VALUES (?,?,?,?)` and `DELETE FROM prediction_domain_intent WHERE key=? AND token=?`.

## Changing a read route or a writer

- **A new read route, page or MCP tool:** it is found by the audit. Register a prefix in `PREFIX_ROUTES` (one GET sample per distinct read), a tool in `MCP_READ_TOOLS` or `MCP_WRITE_TOOLS`; it must have no effect.
- **Fixing a baseline writer:** delete its entry in the same PR that moves the write to its owner writer. The audit then fails on any effect of that read. An entry the audit cannot reproduce fails the test as stale.
- **A new writing read** is not added to the baseline: it needs an ADR change.
- **A scenario that a fix needs** (for example the ratings domain on D1) is added to `SCENARIOS` in `tests/get-write-audit-lib.mjs`; the harness test shows how the instruments are verified.
