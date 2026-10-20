# IPTV Watchlist

Pet project that combines a public Letterboxd watchlist with an XMLTV/IPTV programme. A Cloudflare Worker builds a rolling viewing window, enriches film metadata, stores state in R2, and serves a compact private dashboard. The repository also contains the prediction queue, status surfaces, and their tests; personal ratings, production data, credentials, and generated deployments are deliberately excluded.

## Project layout

- `src/` — Worker source, sync pipeline, discovery and prediction orchestration. `src/continuation.js` is the internal-only entrypoint for one discovery chunk. `src/mcp.js` is the MCP endpoint: connection probes plus the EPG and prediction tools.
- `public/` — browser UI.
- `data/` — reviewed public title/person dictionaries used at build time.
- `tests/` — self-contained unit and contract tests.
- `build.mjs` — dependency-free Worker bundle builder.
- `.openai/hosting.json` — legacy Sites identity and R2 binding (contains no credential).
- `.github/workflows/ci.yml` — Cloudflare CI/CD.
- `wrangler.jsonc` — Cloudflare Worker configuration.

## Local setup

Node.js 20 or newer is sufficient; there are no runtime npm dependencies.

```bash
cp .env.example .env
npm test
npm run build
```

Local browsing uses dummy films from the repository and a gitignored local R2 store. `npm run dev` builds the Worker when the bundle is missing or older than the sources. See [docs/local-setup.md](docs/local-setup.md).

```bash
npm run dev
```

A machine that has the private export can point `.local-dev.json` at it. That file is gitignored. The script does not change production R2.

Configure the deployment environment rather than committing values:

- `LETTERBOXD_USERNAME` — public Letterboxd account whose watchlist is read.
- `EPG_XML_URL` — HTTPS XMLTV source URL.
- `TMDB_API_READ_ACCESS_TOKEN` — server-side TMDB read token.
- `BUCKET` — R2 binding declared by the hosting platform.
- `MCP_ACCESS_TEAM_DOMAIN` — Cloudflare Zero Trust team domain, `https://<team>.cloudflareaccess.com`, used to verify Access JWTs on `/mcp`.
- `MCP_ACCESS_AUD` — AUD tag of Access application `IPTV MCP`. Without it and the team domain, `/mcp` fails closed with `503`.

Runtime values are configured in Cloudflare. Worker `iptv` binds `BUCKET` to R2 bucket `iptv`, the authoritative production store since the 19 October 2026 cutover. The legacy Site keeps a separate R2 store as a temporary reserve and as the source of the historical snapshot. Do not run sync, prediction, or other writers there, and do not browse it for diagnosis: some of its GET routes can write. The tracked hosting manifest records only that legacy Site identity and binding.

## Tests

`npm test` runs the self-contained suite and does not contact Letterboxd, EPG, TMDB, or production. Historical source-adapter tests that depended on downloaded HTML/XML snapshots are not part of the public test command because those local captures are intentionally excluded.

## Live refresh

A visible tab rereads published snapshots about once a minute, and again as soon as the tab becomes visible. A hidden tab does not poll. Each pass requests `/api/events`, `/api/enrichment/footer/status`, `/api/enrichment/view`, `/api/started`, and `/api/programme`. It does not start EPG sync, watchlist sync, an enrichment run, or prediction. Search, sort, scroll, and selected filters stay as the user left them.

Those requests are GET, but two of them can still write. `GET /api/events` looks for an undelivered stop or start event and, only when one exists, saves the recovered event and related run record. `GET /api/enrichment/view` writes a built-in personal rating into `enrichment/view-index.json` when that film is missing from the index. The committed seed is empty, so that particular write does not happen until the seed contains an entry. `/api/enrichment/footer/status`, `/api/started`, and `/api/programme` only read on this pass. A filter with no current matches remains active and applies again when matching films return. Reloading the page restores those selections from the URL even when the current snapshot does not contain them. The same pass refreshes time-based presentation, including last chance and what is on now, even when the server snapshots are unchanged.

Outside that pass, two more GET routes can write. `GET /api/enrichment/status` recovers undelivered stop events in the same way, and both it and `GET /api/enrichment/runs` mark a run whose lease has expired as interrupted. Every other GET route leaves R2 unchanged. `tests/get-side-effects.mjs` derives the GET routes from the source and fails if a different set writes; update it together with this section.

## Internal continuation

The EPG resolver works in bounded chunks. The EPG commit records a paused discovery series and does not start it. Each later `epg_sync_step`, or `POST /api/enrichment/discovery/resolve`, runs exactly one chunk and returns `discovery.nextAction`: `continue` means call again now, `wait` means do not call before `nextCatchUpAt`, and `stop` means wait for the next EPG commit. A separate request is a memory hypothesis, not a guarantee of a new isolate; that has to be checked in production after deploy. The `DiscoveryContinuation` entrypoint remains internal-only, so internet traffic cannot reach it and a public self-fetch is not a fallback. Statuses and failure reasons are described in [ENRICHMENT_API.md](ENRICHMENT_API.md#epg-resolver--hotcold-pipeline-v2).

## Execution filters

«Исполнение» filters the general execution dimensions already stored on a fingerprint: plot engine, pace, stakes, decision logic, competence, problem solving, plans, chemistry, payoff, ending, and technical plausibility. Choices inside one dimension use OR. Different dimensions use AND, as do mechanics, mood, genre, channel, year, runtime, and search. `unknown` and `not_applicable` are not choices. Filtering reads the compact object on the enrichment view; it does not call a model. Genre-specific execution fields stay out of this sidebar. Genres, mechanics, mood, channel, and execution open as compact pickers; the selected values stay visible as removable chips and in the page address. Counts for a picker leave that picker out. For execution, each dimension is counted without its own selection and with the other dimensions still applied.

Named presets store that same canonical query, not the films it currently matches. They live in R2 object `ui/filter-presets.json`. `GET /api/ui/filter-presets` only reads. Creating, renaming, replacing the saved conditions, and deleting send `If-Match`; a stale list gets HTTP 412 and is not overwritten. A stored document that is not a readable list of at most 30 presets is also left unchanged. Stale values inside an otherwise valid preset are still ignored one by one. Applying a preset replaces every app-owned filter, search, sort, and mode through `readUrlState()` / `urlForState()`, leaves unrelated query parameters in place, and does not change the saved preset. There is no built-in seed. For example, «Пересмотр 4.0+» is `viewing=rewatch` together with `prediction=4`, the predicted-rating threshold, not a filter on the saved personal rating.

Deploying this change does not add `execution` to existing `enrichment/view-index.json` records. Until a film's fingerprint is saved again, or a separately approved `POST /api/enrichment/fingerprint-view/backfill` copies the saved fingerprints into the index, some execution choices stay absent. That backfill reads stored fingerprints and does not call a model. This change does not run it.

## Experimental MCP endpoint

`/mcp` is the remote MCP server (Streamable HTTP, JSON responses, no sessions) used by ChatGPT. `probe_read` and `probe_echo` only test the connection. The other tools read EPG and prediction state or advance one existing sync or runner step; ChatGPT still generates fingerprints and predictions. A separate Cloudflare Access application, `IPTV MCP`, protects the path with Managed OAuth and handles the whole OAuth flow, including discovery and dynamic client registration. The Worker accepts a request only after verifying the signed `Cf-Access-Jwt-Assertion` against the team signing keys and that application's audience. Publishing the Worker does not start sync, prediction, or a Scheduled Task. Architecture, the tool allowlist, and the safe verification procedure are in [docs/mcp.md](docs/mcp.md).

## Operational safety

Do not manually run EPG sync, the prediction runner, recurring/scheduled jobs, diagnostic exports, or production backfills merely to test the code. They mutate durable production state and may consume external model/API quota. Use the local test suite; run production jobs only for an explicit operational task against an environment you own.

Generated `dist/`, archives, runtime caches, local diagnostics, `.env*`, personal rating seeds, and production credentials must remain untracked.

## Git-first delivery

GitHub `main` is the canonical production source. Before local changes, fetch and fast-forward from `origin/main`; dirty or diverged state must be resolved explicitly without discarding someone else's work. Changes are committed and pushed—production files are never edited or copied around Git.

Branch and pull-request CI runs only the self-contained test/build commands above. Successful GitHub Actions runs for `main` automatically deploy the verified artifact to Cloudflare Worker `iptv`. The former independent Workers Builds integration is disabled.

Production is Cloudflare Worker `iptv` at `https://iptv.vladimino.workers.dev/`, private behind Cloudflare Access. Scheduled Tasks are off, so automatic data refresh has not resumed. Unattended ChatGPT access to Cloudflare is a separate problem; do not relax Access to solve it. The historical Sites snapshot must not be imported over production R2 again. Publishing the legacy Site still requires a separate authorized Sites release, and that release must not resume writers there.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the working contract and [docs/deployment.md](docs/deployment.md) for deployment, backup, and rollback.

The historical Sites export is documented in [docs/migration-export.md](docs/migration-export.md). The completed Cloudflare restore and the ban on replaying it are documented in [docs/r2-import.md](docs/r2-import.md).
