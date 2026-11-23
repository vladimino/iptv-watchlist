# User read memory overrun (`exceededMemory` on the four page GETs), RCA and fix, 23 November 2026

[AIR-586](https://trello.com/c/Z5ks97Qs). Read-only. Sources: Cloudflare Workers Observability of the Worker `iptv` (per-request outcome, status, version, wall and CPU time, and the `discovery_catalog_read` lines of [AIR-579](d1-migration/air-579-post-925-l0-observation-2026-11-23.md); 16–23 November 2026), the Worker version list (deploy messages only), the code at `main` `5088a6a`, and an offline reproduction of the deployed bundle on synthetic, production-shaped fixtures. No production route was called, nothing was written, no flag, Task, Workflow or data operation was run, and no film id, title, payload, header, cookie, IP or token is quoted. Times are UTC, with Madrid (CET, UTC+1) where the owner saw the page.

## What the owner saw

Opening «В эфире» several times on 23 November returned HTTP 503 for `GET /api/programme`, `/api/enrichment/view`, `/api/catalog/available` and `/api/enrichment/footer/status`: the footer report disappeared, and «Программа актуальна» was replaced by «Программа временно недоступна» or «Ошибка обновления».

## Observation

### The clusters

From 19 November every failure of these routes with outcome `exceededMemory` is a **cluster**: the requests of one page load or one live refresh, sent within a second, fail **together with the same wall time to the millisecond**. The isolate limit (128 MB) belongs to the isolate, and when it is exceeded Cloudflare ends every request running in it, so a cluster is one isolate that held all of them.

| Window (UTC) | Madrid | Worker version (deploy) | Requests | Outcome |
| --- | --- | --- | --- | --- |
| 16–17 Nov, about 30 events | | many versions | mostly `footer/status` alone (five times with `catalog/available`), 30–41 s wall | `exceededMemory`: the AIR-519 quadratic read, [fixed](footer-status-oom-rca-2026-11-17.md) |
| 19 Nov 17:42:23, 20 Nov 16:03:06 and 18:37:56 | 18:42, 17:03, 19:37 | `16a59836`, `481a6d47`, `037f69c7` | `enrichment/view`, `catalog/available`, `footer/status` (3 at once, 6.9–8.3 s) | `exceededMemory` |
| 21 Nov 16:06:03 (first with the programme) | 17:06 | `b079cc5d` | all four | `exceededMemory` |
| 22 Nov, 12 clusters 12:56–23:51 | 13:56–00:51 | eight versions (`ee0724bb` … `3bc1c3f2`) | all four, 5.4–9.3 s | `exceededMemory` |
| 23 Nov 10:20:38, 13:59:12 | 11:20, 14:59 | `bd46a1d3`, `39c583ec` | all four | `exceededMemory` |
| 23 Nov 18:16:25, 18:22:06 | 19:16, 19:22 | `e0e6fe7a` (AIR-583, deployed 17:00:36) | all four, 8.9–9.6 s | `exceededMemory` |
| 23 Nov 19:24:08, 19:27:57, 19:28:06, 19:29:17, 19:29:24 | 20:24–20:29 | `5b50cc66` (AIR-585, deployed 19:19:41) | all four, 7.5–8.8 s | `exceededMemory` (20 requests) |

Other `exceededMemory` events of the week are other routes and not part of this RCA: the owner Limbo pair on 18 November ([AIR-528](owner-limbo-memory-air-528-2026-11-18.md)) and three single `POST /mcp` calls (19 November 17:49, 20 November 16:26, 23 November 14:47). Between the clusters the same four requests answered 200 (for example three full page loads at 18:46:59–18:48:30 on 23 November). The failure is intermittent and is **not tied to one deploy**: it spans at least fifteen versions. The 503 the browser shows for these requests is Cloudflare's answer to the ended isolate, not a Worker response.

### Each of the four reads the whole Discovery catalog

The `discovery_catalog_read` line (one per resolved whole-catalog read) shows, for every page load or refresh of 23 November 18:12–19:30, **one read of all 12,255 admitted catalog films by each of the four routes**, within 2–8 seconds of each other: `catalog/available`, `programme` and `enrichment/view` without a projection (`projected: false`, every payload parsed whole), the footer with its AIR-519 projection. In the 19:27:51–19:28:04 cluster, `catalog/available` and `programme` logged their reads before the isolate was ended; `view` and `footer` did not get that far. The catalog grew from 9,300 films (17 November, [AIR-519](footer-status-oom-rca-2026-11-17.md)) to 12,160 at 16:54 and 12,255 at 19:30 on 23 November.

### The page asks them together

`public/app.js` `runLiveRefresh` (every 60 s, and on `focus` and `visibilitychange`, which is what opening the tab does) called the six loaders in one `Promise.all`: events, started, **programme, view, Finds and footer at once**. The first load (`init`) awaits the programme and then starts **view, Finds and footer at once**. These are exactly the two cluster shapes: four routes on a refresh, three (no programme) on a first load.

### 503 with outcome `ok`

Twenty-seven 503 answers of these four routes in the seven days ending 23 November 20:00 had outcome `ok` (fifteen from 21 November; five in the card's window 17:00–20:00 on 23 November: 17:05:26, 17:33:30 and 19:11:58 `catalog/available`, 19:12:01 and 19:21:05 `footer/status`): the Worker itself answered 503, the isolate was not ended. Most are on `catalog/available` and `footer/status` with 0.4–8.6 s of CPU, after a full catalog read (where the AIR-579 line existed, 23 November, the `discovery_catalog_read` line of the same request is there); a few answered almost at once (22 November 17:37:28, version `46842770`, four seconds after a deploy: `programme` and `footer/status` with 2–4 ms of CPU and 2.2 s of wall, together with a 503 of `GET /api/started`). The answer body is not logged, so **the refusal code of these answers is not established**. What the code can answer with 503 on these paths is a typed refusal: Discovery user-read refusals (`discovery_fence`, `discovery_incomplete`, `discovery_unavailable`, `discovery_not_authoritative`, `discovery_bounded`, with `Retry-After: 1`), the Film/Person catalog reader refusal of the footer (`identity_unavailable`, a moved Film/Person generation), the Watchlist authority (`storage_unavailable`), the owner-review read, or the programme's own «Первое обновление ещё выполняется». Of those checked against the Discovery Workflow activity, six fall inside a running chunk (23 November 17:33:30, 19:11:58 and 19:12:01 in chunk 25, 19:21:05 in chunk 26; 22 November 16:55:58 and 18:11:05), which moves the authorities those refusals fence on, and at least four do not (23 November 04:40:50, 16:54:00 and 17:05:26; 22 November 12:10:27), so no single cause is claimed. They are a separate, smaller phenomenon from the memory clusters and are not mixed with them. AIR-586 adds the attribution (below) so the next one names its code.

## Root cause

1. **Every user read held the whole catalog.** `catalog/available` materialised every admission payload (12,255 parsed objects) although only films with a show in its window can be offered; `programme` did the same to present its own `catalogFilms` entries (a few thousand TMDB ids); `enrichment/view` did the same to read the genres the freshness rule needs. While parsing, `readCatalog` also kept every raw payload text beside its parsed object until the loop ended.
2. **The page sent them together.** One refresh put three or four such reads, plus the footer, into one isolate at the same moment. On the production-shaped fixtures that needs **125 MB of old space** (below), at the isolate limit of 128 MB, which also counts memory that is not old space. Whether a given refresh fails depends on what the isolate already holds and on how the four overlap, hence the intermittent clusters.
3. **Growth made it routine.** The same four reads at once needed 116 MB with the 9,300-film catalog of 17 November and 125 MB with the 12,255 films of 23 November. No single commit is the regression: the clusters span at least fifteen deploys from 19 November.

## Reproduction

`scripts/footer-memory-profile.mjs` (AIR-519) builds production-shaped fixtures (`CATALOG=12255` sets the catalog size; R2 view index 11.3 MB, programme 2.7 MB, watchlist 1.3 MB, catalog 11.9 MB of JSON in D1 `discovery_admission`, Film/Person, predictions, ratings, Discovery and the published EPG all on D1) and answers the requests with the **deployed bundle** `dist/server/index.js` over an in-process D1. `--paths a,b,c,d` sends the routes at once, `--sequential` one after the other. Figures are the smallest `--max-old-space-size` (2 MB steps, `--max-semi-space-size=1`, frozen clock, twice in a row) at which every request answers 200; the baseline with the bundle loaded is 22 MB.

| Requests (catalog 12,255) | `main` `5088a6a` | AIR-586 |
| --- | --- | --- |
| `programme` alone | 65 MB | 48 MB |
| `enrichment/view` alone | 76 MB | 61 MB |
| `catalog/available` alone | 90 MB | 76 MB |
| `footer/status` alone | 52 MB | 52 MB |
| the four at once (the old page) | **125 MB** | 113 MB |
| the four one after the other, two rounds (the new page) | 96 MB | **85 MB** |
| `view`, `catalog/available`, `footer` at once, catalog 9,300 | 116 MB | |

What the production page now causes is the last-but-one row against the old page's four at once: **125 MB → 85 MB**, about 40 MB of room under the limit. With the response bodies compared under a frozen clock, every route answers byte-identically to `main` on these fixtures (`programme` 1.32 MB, `view` 5.41 MB, `catalog/available` 1.11 MB, footer 3 KB).

A false lead, recorded so it is not chased again: a series of requests in one process showed the live heap growing by the size of each answer (9.2 MB per `view` request, all of it large-object space). The harness kept every response body in its result list; it now keeps only the first. The Worker retains nothing between requests.

## Fix

- **`readCatalog`** (`src/discovery-authority.js`) releases each raw payload text as soon as it is parsed, for every caller, and a projection that answers `undefined` leaves that film out.
- **`GET /api/programme`** keeps only the catalog films of the TMDB ids its `catalogFilms` entries name (`programmeCatalogProjection`); `presentCatalogFilms` looks each entry up by TMDB id, so the presentation is unchanged.
- **`GET /api/enrichment/view`** takes the policy verdict on the whole stored film, leaves out a film it excludes, and keeps `id`, `tmdbId`, `genres` and `genreIds` (`GENRE_CATALOG_PROJECTION`). On those fields the policy can only answer what it answered on the whole film or a verdict that does not exclude, so `allEnrichmentFilms` keeps the same films with the same genres.
- **`GET /api/catalog/available`** reads the programme first and keeps whole only the catalog films that have any show at all (completed programme shows under a D1 published run, the record's own shows otherwise); every other film is kept as the skeleton the identity bridge and the display title exclusion read (`id`, `tmdbId`, `canonicalIdentity`, `title`, `original`, `aliases`, `year`) and is skipped by the loop before anything else of it is read (`availableCatalogProjection`). The test is a superset of the window, so every film the answer can offer is whole.
- **The page** (`public/app.js`) sends the four large reads one after the other: every call of the programme, view, Finds and footer loaders, from the first load, a live refresh (focus, visibility, the 60 s poll), the cold retry or a button, takes one shared turn (`heavyTurn`), so at most one is in flight; a loader already waiting for its turn is shared. A read still open after 60 s is cancelled through its turn's `AbortController` (the request, the Retry-After wait, the retry and the body), and the next turn starts only after that loader has settled, so a hung read cannot stop the page and the page never has two large requests open; the footer reader has its own 45 s abort. A refresh asks the programme first (`loadHeavyReads`), with events and started beside them. The footer reader stays byte-identical to the admin pages' and is called through its turn (`loadFooterTurn`). A failed first programme read says «Не удалось загрузить программу (HTTP n). Повторим автоматически.» instead of «Программа ещё не готова» (which now only follows the route's own first-update answer) and is retried once after 5 s. Until a first programme is read, the count and the empty state say «Программа временно недоступна» / «Программа не загрузилась», even when another read (the view) renders the grid meanwhile; before, that render replaced them with «0 фильмов · 0 показов». A failed refresh keeps the last programme on screen with «Ошибка обновления» until the next good read, as before. A good view answer after a failed one now clears «Прогнозы сейчас недоступны» even when its data did not change (before, an unchanged answer returned early and left the flag set).
- **Attribution of Worker 503s.** A 503 the Worker answers itself on these four paths writes one line `{"event":"user_read_refused","path","status":503,"code","reason","error","notReady","retryAfter"}`; each code field is logged only when it has the shape of an internal code, so never an id, a title, a payload or a message text.

The routes stay pure GETs: no R2 put or delete, no D1 write, no `waitUntil`, no new cache, store, flag, migration or architecture. Discovery authority fences, the read-only contracts and the typed refusals are unchanged.

## Tests

`tests/user-read-memory.mjs` (new): on the generated bundle, a catalog with duplicate and contradicting identities, policy-excluded documentaries and concerts, a Letterboxd id bridged to a TMDB id, title-exclusion namesakes (both rule tags) and records without shows or from another run: the programme presentation, the view's film map and the Finds answer (completed-only and record shows, a programme of another run) are equal on the projected and the whole catalog; the D1 read with a projection leaves out what it drops and equals the projection of the whole object; the refusal log line has exact keys and never carries a non-code text. Mutations that keep every film whole in the programme or skeletonise every Finds film fail it. Nightly scenario `user-reads-memory-production-size`: the four routes one after the other, two rounds, on the 12,255-film fixtures under a 92 MB old space, which the `main` reads exceed. `tests/live-refresh.mjs`: never two large reads in flight, the programme first, a cold 503 is not «не готова» while the route's own first-update answer still is, a warm 503 keeps the last programme with «Ошибка обновления» and the next good read restores the status. `tests/heavy-read-turns.mjs`: the real first load with a failing programme read, the first view read held open while focus, visibility and the cold retry fire: never two large reads in flight from the first load to the end of the refresh, a waiting loader is shared, and the page recovers (a turn that does not serialise fails it); a held read past 60 s is cancelled, the next large read starts only after it settled, and the next refresh recovers the view (a bound that releases the turn without cancelling fails it). `tests/finds.mjs` follows the new order.

Visual QA (local Chromium, desktop 1440×900 and iPhone 13, the built bundle answering over the 12,255-film fixtures, the first programme read answered with a bare 503 as an exceeded isolate does): during the failure the page reads «Программа временно недоступна», «Не удалось загрузить программу (HTTP 503). Повторим автоматически.» and «Ошибка обновления»; the automatic retry restores the programme (278 films), Finds and the footer; no horizontal overflow and no page error at either width. The server log shows the large reads strictly one after the other.

## Limits and what remains

- Node's V8 under a hard cap is not Cloudflare's isolate accounting, and the fixtures are synthetic (their per-film payload is larger than production's, so the figures are conservative).
- The page bound cancels the browser's request; it does not prove that the Worker stopped working on it, so a cancelled read may still overlap with the next one in the isolate until it finishes there.
- A second open tab, or another heavy request in the same isolate (an MCP call, the footer of another page), still overlaps; the four at once now need 113 MB instead of 125 MB.
- The 503s with outcome `ok` stay unattributed until the next one logs its code.
- Acceptance after deploy is natural: no `exceededMemory` cluster on these four routes while the owner uses the page, the `discovery_catalog_read` lines of `programme`, `view` and `catalog/available` showing `projected: true`, and the owner's look at the page.
