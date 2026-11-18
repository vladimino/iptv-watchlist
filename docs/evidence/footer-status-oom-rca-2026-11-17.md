# Footer status memory overrun (`GET /api/enrichment/footer/status`), RCA, 17–18 November 2026

[AIR-519](https://trello.com/c/qBeEjTGE). Read-only. Sources: Cloudflare Workers Observability for the Worker `iptv` (per-request outcome, CPU and wall time only, 13–17 November 2026), read-only object sizes of the R2 bucket `iptv`, read-only `COUNT(*)`/`SUM(LENGTH())` and authority markers of the production D1 `iptv`, the code at `main` `2ff8671`, and an offline reproduction on synthetic, production-shaped data in Node and in a local workerd. No production route was called, nothing was written, and no film id, title, payload, header, cookie or token is quoted. Times are UTC.

## Observation

- Before the Film/Person marker moved to `d1`/`open` (16 November, 14:21 UTC, [evidence](d1-migration/air-499-film-person-open-2026-11-16.md)), every logged footer request of 15–16 November used **1.6–3.2 s of CPU** (wall 7.5–14 s) and answered.
- The first footer request after the flip (14:23:47) used **13.0 s of CPU and 34.7 s of wall**; the next one (14:28:55) was `Worker exceeded memory limit`. From then on the logged footer requests used **6.6–16.4 s of CPU** and up to 35 s of wall, with memory overruns on 16 November 14:28 and 17 November 16:48, 21:47 and 21:56, and a 503 on 17 November 14:54. Requests that answered 200 sat between them: the failure is intermittent.
- In the same window two `GET /api/catalog/available` requests (17 November 16:50, 34–37 s of wall) and one `GET /api/programme` (17 November 06:37) also overran memory, as did some hourly cron ticks on 13, 14 and 16 November. The limit (128 MB) belongs to the isolate, so every request running in it at that moment pays for the one that holds the most.

Production state read on 17 November: R2 `enrichment/view-index.json` 11.3 MB, `epg/discovered-films.json` mirror 8.0 MB, `programme.json` 2.6 MB, `watchlist.json` 1.4 MB; D1 `film` 11,352 rows, `film_external_id` 12,168, localizations 10,865; predictions `d1` (4,061 fingerprints, 3.1 MB of JSON; 4,061 pointers, 3.2 MB); ratings `d1`/`open` (4,487 `ratings_view` rows); Discovery and the published EPG on D1.

## Root cause

1. **A quadratic D1 metadata read (the trigger).** At `open` the footer stopped reading the frozen `metadata.json` and asks `catalogMetadataFromD1` for every id named by the view index, the catalog, the programme and the watchlist (about 11 thousand). For each id the function assessed its identity claims with `identityClaim(externals, …)`, which **filtered the whole list of external-id rows** read for the request (about 24 thousand), four times per id, each time allocating a new array. `GET /api/catalog/available` calls the same function at `open`, which is why it shows the same 35 s requests.
2. **Every large source held whole at once (the amplifier).** The footer read the view index, the catalog, the programme and the watchlist together (`Promise.all`) and kept each whole. In production each of them is more than its R2 object: `loadJSON` lays the D1 forecasts over the view index (every fingerprint and pointer row, parsed, plus a mood facet per film) and then the D1 ratings (another copy of every entry), and the catalog is every Discovery admission payload parsed. The coverage block then copied every catalog film with its showings.

The overrun is therefore not one allocation larger than the limit: one request needs about 60 MB of live heap over the module and keeps it for several seconds, so two overlapping requests (the 60-second poll, a second tab, another heavy route) reach the isolate limit.

## Reproduction

`scripts/footer-memory-profile.mjs` builds production-shaped fixtures once (`--build`): the R2 view index, a Film/Person D1 at `open` with conflicting claims, the catalog as Discovery admissions (`d1`/`open`), the published EPG generation written by `publishGeneration` itself, predictions `d1` (profile, queue, latest run, 4,061 fingerprints and pointers of production size) and ratings `d1`/`open` (4,487 rows). The run imports the **deployed bundle** `dist/server/index.js` (the code workerd runs) and answers the footer with an in-process D1 over `node:sqlite`; R2 objects are Buffers outside the V8 heap. `scripts/footer-memory-workerd.mjs` loads the same fixtures into a local D1 and R2 (`wrangler --local`) and reads the isolate heap of `wrangler dev` through the inspector while requests run.

An earlier version of this RCA used a hand-assembled `vm` context and reported 34 s of CPU per request: that context ran the quadratic loop far slower than the bundle does, and it did not load the D1 overlays. The figures below replace it.

### Node, deployed bundle, hard heap cap

Smallest `--max-old-space-size` (2 MB step, `--max-semi-space-size=1`) at which every request answers 200; the baseline with the bundle loaded and no request is 20 MB.

| Version | CPU, 1 request | 1 request | 2 at once | 4 at once | 8 at once |
| --- | --- | --- | --- | --- | --- |
| `main` `2ff8671` (before) | 3.7 s | 79 MB | 128 MB | 230 MB | — |
| first fix (D1 claims grouped, documents read one at a time) | 1.4 s | 58 MB | 73 MB | 107 MB | — |
| AIR-519 as merged (also streamed view index, catalog and metadata projected at the read) | 1.0–1.1 s | 49 MB | 62 MB | 91 MB | 146 MB |

Live heap after a full GC at every D1 and R2 call (`--phases`, final version), over the 21 MB baseline: the R2 view index projection holds +2.8 MB (+9 MB while it still kept the facts the overlays replace), the D1 forecast rows are transient, and the highest point (+29 MB) is the identity read with all projections held. Under a frozen clock (`--freeze`) the response body of every version is byte-identical to `main` except `generatedAt`; each request makes 5 R2 reads and about 210 D1 SELECTs, no write.

### workerd (local `wrangler dev`, same fixtures, same bundle)

Fresh isolate (module only): 16.3 MiB used. Three rounds per level, fresh isolate per level; the inspector samples between turns and cannot force a GC there, and a local workerd enforces no memory limit, so V8 keeps garbage until it needs room: `used` is an upper bound that includes garbage, `committed` is what V8 reserved.

| Version | 1 request | 2 at once | 4 at once |
| --- | --- | --- | --- |
| `main`: peak used / committed | 127.9 / 177.8 MiB | 128.6 / 192.7 MiB | 138.0 / 227.4 MiB |
| `main`: wall per round | 5.6–5.9 s | 10.0–10.6 s | 16.5–19.1 s |
| AIR-519: peak used / committed | 80.2 / 141.7 MiB | 94.7 / 157.3 MiB | 89.1 / 158.6 MiB |
| AIR-519: wall per round | 1.2–1.5 s | 2.4–2.7 s | 5.0–5.3 s |

## Fix

- `catalogMetadataFromD1` groups the external-id rows by scheme and value once and assesses each claim against the rows of its value only; `identityClaim` already kept only those rows, so the verdicts are those of the full scan. With `{identityOnly:true}` (the footer) it selects film membership without the localized-title subquery or the metadata join and returns only `id`, `tmdbId`, `identityBlocked`.
- The footer reads the small records together and then the large sources one at a time, each reduced as it is read: the R2 view index member by member (`forEachJsonObjectEntries`, the existing streamed parser with an object-member mode), dropping the facts a d1 authority replaces, then the same D1 overlays as `loadJSON` (no mood facet), with the authority re-read afterwards (a moved authority makes the index unknown); the Discovery catalog projected row by row after its identity check (`DiscoveryAuthority.routeRead(env, key, {project})`, unchanged without the option); the programme and watchlist projected once read; showings reduced to `start`.
- The coverage decides whether a film airs in the window from the completed programme's showings directly instead of copying each film.
- The blocks computed after the reads are guarded: a malformed stored record (a queue without `pending`, a run without `selectedIds`) leaves its block unknown and is named in `degraded`; the last run's `added`/`failed` are then `null` (shown «нет данных»), never a false 0. A `held`, unreadable or moving Film/Person marker still answers the typed 503.
- The page keeps the kind of the last failed footer read on the stale note as `data-failure` (`http_<status>`, `timeout`, `network`, `bad_json`, `render`), invisible and cleared by the next good read, and aborts a read after 45 s.

The route stays a pure GET: no R2 put or delete, no D1 write, no `waitUntil`, no Workflow, flag, Task or production run. No persisted status or writer was added.

## Headroom and what remains

With a module of about 16–20 MB, one footer request now needs about 29 MB of live heap and each further concurrent one about 14 MB: up to four at once fit in 128 MB under the hard cap (91 MB), eight do not (146 MB). The old read already needed 128 MB for two. What a footer request still holds is data its blocks use (the D1 forecasts the freshness rule reads, the programme's showings, the identity claims). Bounding it further, or independently of concurrency, needs a precomputed status read model, which is a persistence and writer decision (ADR and owner approval) and is not part of AIR-519.

## Tests

`tests/footer-memory.mjs` (core: the D1 metadata read equals the pre-AIR-519 algorithm rebuilt from the current source, identity-only equals the identity of the full read; copy-free coverage equals the overlay version; the footer blocks equal the blocks of the whole documents on a fixture with R2 authorities and on one with every production authority in D1 (published EPG, Discovery, predictions, ratings, Film/Person); a ratings authority moved mid-read leaves the index unknown; malformed records degrade one block with `null` run counts and recover; SELECT-only D1, no R2 write. Nightly scenario `footer-memory-production-size`: the bundle on the production-shaped fixtures, four concurrent requests twice under a 128 MB old space, which the old read exceeds, and under 10 s of CPU per request). `tests/json-array-stream-parity.mjs` covers the object-member mode; `tests/live-refresh.mjs` and `tests/status-footer-ui.mjs` cover the failure kind, its removal on recovery and «нет данных» for unknown run counts.

## Not done, on purpose, and limits

- No production route was called to confirm the fix; acceptance after deploy is the natural footer requests in Observability (CPU back near the pre-`open` 2 s, no memory overrun) and the owner's look at the page.
- Neither Node's V8 under a cap nor a local workerd is Cloudflare's isolate accounting; the fixtures are synthetic.
- The `GET /api/programme` and cron-tick memory overruns are not analysed here. `GET /api/catalog/available` shares the fixed D1 read and should improve with it; whether the remaining routes need their own bound is a separate question.
