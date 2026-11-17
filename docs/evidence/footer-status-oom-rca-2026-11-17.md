# Footer status memory overrun (`GET /api/enrichment/footer/status`), RCA, 17 November 2026

[AIR-519](https://trello.com/c/qBeEjTGE). Read-only. Sources: Cloudflare Workers Observability for the Worker `iptv` (per-request outcome, CPU and wall time only, 15–17 November 2026), read-only object sizes of the R2 bucket `iptv`, read-only `COUNT(*)` of the production D1 `iptv`, the code at `main` `2ff8671`, and an offline reproduction on synthetic, production-sized data. No production route was called, nothing was written, and no film id, title, payload, header, cookie or token is quoted. Times are UTC.

## Observation

- Before the Film/Person marker moved to `d1`/`open` (16 November, 14:21 UTC, [evidence](d1-migration/air-499-film-person-open-2026-11-16.md)), every logged footer request of 15–16 November used **1.6–3.2 s of CPU** (wall 7.5–14 s) and answered.
- The first footer request after the flip (14:23:47) used **13.0 s of CPU and 34.7 s of wall**; the next one (14:28:55) was `Worker exceeded memory limit`. From then on the logged footer requests used **6.6–16.4 s of CPU** and up to 35 s of wall, with memory overruns on 16 November 14:28 and 17 November 16:48, 21:47 and 21:56, and a 503 on 17 November 14:54. Requests that answered 200 sat between them: the failure is intermittent.
- In the same window two `GET /api/catalog/available` requests (17 November 16:50, 34–37 s of wall) and one `GET /api/programme` (17 November 06:37) also overran memory, as did some hourly cron ticks on 13, 14 and 16 November. The memory limit belongs to the isolate, so every request running in it at that moment pays for the one that holds the most.

Sizes measured read-only on 17 November: `enrichment/view-index.json` 11.3 MB, `epg/discovered-films.json` 8.0 MB, `programme.json` 2.6 MB, `watchlist.json` 1.4 MB, `enrichment/prediction-queue.json` 1.1 MB; D1 `film` 11,352 rows, `film_external_id` 12,168 (11,352 `tmdb`, 406 `letterboxd`), `film_dimension` localization 10,865.

## Root cause

1. **A quadratic D1 metadata read (the trigger).** At `open` the footer stopped reading the frozen `metadata.json` and asks `catalogMetadataFromD1` for every id named by the view index, the catalog, the programme and the watchlist (about 11 thousand). For each id the function assessed its identity claims with `identityClaim(externals, …)`, which **filtered the whole list of external-id rows** read for the request (about 24 thousand: the rows of the requested Films plus the rows of the same values) — four times per id, each time allocating a new array. That is roughly 10⁹ row checks: on the reproduction **33.6 s of the 34 s of CPU** of one request were spent in that filter (CPU profile, self time of the `identityClaim` arrow). `GET /api/catalog/available` calls the same function at `open`, which is why it shows the same 35 s requests.
2. **Large documents held for the whole request (the amplifier).** The footer read the four large documents together (`Promise.all`) and kept them whole: parsed, they are about 63 MB of V8 heap (view index ≈27 MB, catalog ≈25 MB, programme ≈6 MB, watchlist ≈3 MB, queue ≈2 MB, measured on the synthetic objects). Its coverage block also copied every catalog film with its completed-programme showings (`withCompletedShows`). Held for 35 s instead of 2 s, they overlapped with the next 60-second poll, other tabs and the other heavy routes of the same isolate, and the isolate went over its limit.

The memory overrun is therefore not a single allocation larger than the limit: it is a request that keeps about 60 MB alive for half a minute, so the isolate's concurrent requests add up. The earlier [502 RCA of 8 November](footer-status-502-rca-2026-11-08.md) (a closed Discovery ledger) is a different failure: the guards it added are intact.

## Reproduction

`scripts/footer-memory-profile.mjs` builds synthetic data once (`--build`) with the measured sizes and the shapes the code writes (view-index items with `fingerprint`, `impactFeatures`, `prediction` and `moodFacet`; catalog films with showings; a Film/Person D1 at `open` with 11,352 Films in the sqlite stand-in, including conflicting claims), then runs the Worker's footer route in a Node `vm` (the same V8 engine as workerd, not workerd itself). R2 objects are kept as Buffers outside the V8 heap, so the smallest `--max-old-space-size` at which every request answers measures the footer's own heap need. The synthetic objects are slightly larger than production (view index 12.9 MB, catalog 9.0 MB), and the published programme is read through R2 (the catalog keeps its showings), so the figures are conservative.

| Version | CPU, 1 request | Wall, 1 request | Smallest old space: 1 / 2 / 4 concurrent requests |
| --- | --- | --- | --- |
| `main` `2ff8671` (before) | 33.5–33.9 s | 33.6–34.4 s | 61 / 106 / 201 MB |
| D1 read fix only | 1.1 s | 1.9 s | 67 / 112 / 215 MB |
| AIR-519 (D1 read fix and bounded footer) | 1.1 s | 0.9–1.0 s | 46 / 73 / 132 MB |

Baseline of the harness without any request: 22 MB. The old-space figures are a binary search with a 4 MB step (`--max-semi-space-size=1`), on one machine; they compare versions, they are not the Worker's absolute limit. Under the same frozen clock (`--freeze`) the response body of the AIR-519 version is byte-identical to the one of `main` except `generatedAt` (all blocks: collection, recommendations, coverage, predictions, EPG/TMDB, watchlist, last run, integrations). Each request made 18 R2 reads and 58 D1 SELECTs, before and after; no request wrote.

## Fix

- `catalogMetadataFromD1` groups the external-id rows by scheme and value once and assesses each claim against the rows of its value only (and looks the requested keys up in a `Set`). `identityClaim` already kept only the rows of its scheme and value, so the verdicts are those of the full scan; a test rebuilds the old algorithm from the current source and compares the records on a D1 with conflicting, untrusted and doubled claims.
- The footer reads the small records together and then the four large documents **one at a time**, each reduced as it arrives to the fields its blocks read (the view index keeps `watched`, `actualRating`, `watchlist`, `prediction`, `fingerprintHash`, `impactFeatures`; films keep identity, `genres`, `epgLastAiring` and the showings the coverage reads; the watchlist keeps `id`/`tmdbId`; the D1 metadata keeps `id`/`tmdbId`/`identityBlocked`). `prediction` is kept whole because the freshness rule and the confidence read several of its fields.
- The coverage decides whether a film airs in the window from the completed programme's showings directly instead of copying each film (same answer; a test compares it with the copying version, with and without the completed-only rule).
- The blocks computed after the reads are guarded: a malformed stored record (a queue without `pending`, a run without `selectedIds`, both of which threw before) leaves its block unknown and is named in `degraded` instead of failing the route. A `held`, unreadable or moving Film/Person marker still answers the typed 503.
- The page keeps the kind of the last failed footer read on the stale note as `data-failure` (`http_<status>`, `timeout`, `network`, `bad_json`, `render`), invisible and cleared by the next good read, and aborts a read after 45 s so a hung request cannot stop the polling.

The route stays a pure GET: no R2 put or delete, no D1 write, no `waitUntil`, no Workflow, flag, Task or production run. No new persisted status or writer was added.

## Tests

`tests/footer-memory.mjs` (core: equivalence of the D1 metadata read, the coverage and the projected footer blocks with the whole-document blocks, the degraded malformed record, SELECT-only D1 and no R2 write; nightly scenario `footer-memory-production-size`: the production-sized reproduction with four concurrent requests twice, under 176 MB of old space, which the old version exceeds, and under 15 s of CPU per request). `tests/live-refresh.mjs` and `tests/status-footer-ui.mjs` cover the failure kind and its removal on recovery.

## Not done, on purpose, and limits

- No production route was called to confirm the fix; acceptance after deploy is the natural footer requests in Observability (CPU back near the pre-`open` 2 s, no memory overrun) and the owner's look at the page.
- The figures come from Node's V8, not from workerd's isolate accounting; the reproduction is synthetic.
- The `GET /api/programme` and cron-tick memory overruns are not analysed here. `GET /api/catalog/available` shares the fixed D1 read and should improve with it; whether the remaining routes need their own bound is a separate question.
