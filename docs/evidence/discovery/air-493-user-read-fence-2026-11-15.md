# AIR-493: user catalog and enrichment 502 from the Discovery generation fence, 15 November 2026

Read-only RCA plus offline reproduction. No production endpoint was called in this report, nothing was written, and no payload, header, cookie or token is quoted. Times are Europe/Madrid unless labelled UTC.

## Observation (production, L0)

- Owner screenshot ~18:44 Europe/Madrid: `GET /api/catalog/available` and `GET /api/enrichment/view` HTTP 502. Compact footer showed «Коллекция / Прогнозы / Новые 4.0+: нет данных». That is a load failure, not a proven empty store.
- Cloudflare Workers Observability, Worker `iptv`, 18:08–18:45 Europe/Madrid (17:08–17:45 UTC): 32 HTTP 502, Worker outcome `ok`. Structured `route_error` with `code`/`message` `discovery_fence` on both paths.
- 16:00–18:05 Europe/Madrid: those 502s were not found. EPG published 17:08 Europe/Madrid, `epg_status` healthy, Discovery D1 `ready/open/committed`, Workflow `running`, lease live. Published and Discovery run ids matched.
- Deployed `main` `6579cf53` (PR #655) changes typed Discovery conflict diagnostics, not `routeRead` or these HTTP handlers. Correlation with that deploy is not causation.

## Call graph (code at that SHA)

1. `GET /api/catalog/available` → `catalogAvailableRoute` → `catalogGenerationCopy` → `DiscoveryAuthority.routeRead` of `epg/generations/<run>/discovered-films.json` → `readCatalog` (one `SELECT` of `discovery_admission` where `state='current'`). Uncaught `discovery_fence` → Worker `catch` → `502 {"error":"discovery_fence"}`.
2. `GET /api/enrichment/view` → `enrichmentView` → when the freshness rule needs genres, `loadJSON(..., 'epg/discovered-films.json')` → the same `routeRead`. Same catch.
3. `routeRead` read `discovery_authority.generation` before and after `readKey` and threw `discovery_fence` on any change. `writeContinuation`, `writeStatus` and other Discovery writers increment that generation on every batch.

## Offline reproduction

sqlite D1 stand-in, published generation, two current admissions. During the catalog `SELECT`, a continuation write plus an extra generation increment run. Before the fix, `routeRead` of `discovered-films.json` throws `discovery_fence`. After the fix it returns both films, while a paged decisions read that sees a generation bump between pages still throws `discovery_fence`. `GET /api/catalog/available` is HTTP 200 with no R2 catalog fallback; an EPG pin change mid-read is HTTP 503 `discovery_fence` with `Retry-After: 1`, never 200 `films: []`. Tests: `tests/discovery-user-read-fence.mjs`.

## Verdict

The 502 storm is an over-wide read fence, not missing catalog rows and not an EPG outage. The retained generation fence still protects multi-page ledger and decision reads. Natural production confirmation (502 rate on those two paths while Discovery stays `running`) is a post-deploy observation on [AIR-493](https://trello.com/c/AKoSOprC), not claimed here.
