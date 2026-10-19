# IPTV Watchlist

Pet project that combines a public Letterboxd watchlist with an XMLTV/IPTV programme. A Cloudflare Worker builds a rolling viewing window, enriches film metadata, stores state in R2, and serves a compact private dashboard. The repository also contains the prediction queue, status surfaces, and their tests; personal ratings, production data, credentials, and generated deployments are deliberately excluded.

## Project layout

- `src/` — Worker source, sync pipeline, discovery and prediction orchestration.
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

Configure the deployment environment rather than committing values:

- `LETTERBOXD_USERNAME` — public Letterboxd account whose watchlist is read.
- `EPG_XML_URL` — HTTPS XMLTV source URL.
- `TMDB_API_READ_ACCESS_TOKEN` — server-side TMDB read token.
- `EPG_SITE_SERVICE_TOKEN` — optional service credential used by the hosted update workflow.
- `BUCKET` — R2 binding declared by the hosting platform.

Runtime values are configured in Cloudflare. Worker `iptv` binds `BUCKET` to R2 bucket `iptv`, the authoritative production store since the 19 October 2026 cutover. The legacy Site keeps a separate R2 store as a temporary reserve and as the source of the historical snapshot. Do not run sync, prediction, or other writers there, and do not browse it for diagnosis: some of its GET routes can write. The tracked hosting manifest records only that legacy Site identity and binding.

## Tests

`npm test` runs the self-contained suite and does not contact Letterboxd, EPG, TMDB, or production. Historical source-adapter tests that depended on downloaded HTML/XML snapshots are not part of the public test command because those local captures are intentionally excluded.

## Live refresh

A visible tab rereads published snapshots about once a minute, and again as soon as the tab becomes visible. A hidden tab does not poll. Each pass requests `/api/events`, `/api/enrichment/footer/status`, `/api/enrichment/view`, `/api/started`, and `/api/programme`. It does not start EPG sync, watchlist sync, an enrichment run, or prediction. Search, sort, scroll, and selected filters stay as the user left them.

Those requests are GET, but two of them can still write. `GET /api/events` looks for an undelivered stop or start event and, only when one exists, saves the recovered event and related run record. `GET /api/enrichment/view` writes a built-in personal rating into `enrichment/view-index.json` when that film is missing from the index. The committed seed is empty, so that particular write does not happen until the seed contains an entry. `/api/enrichment/footer/status`, `/api/started`, and `/api/programme` only read on this pass. A filter with no current matches remains active and applies again when matching films return. Reloading the page restores those selections from the URL even when the current snapshot does not contain them. The same pass refreshes time-based presentation, including last chance and what is on now, even when the server snapshots are unchanged.

## Operational safety

Do not manually run EPG sync, the prediction runner, recurring/scheduled jobs, diagnostic exports, or production backfills merely to test the code. They mutate durable production state and may consume external model/API quota. Use the local test suite; run production jobs only for an explicit operational task against an environment you own.

Generated `dist/`, archives, runtime caches, local diagnostics, `.env*`, personal rating seeds, and production credentials must remain untracked.

## Git-first delivery

GitHub `main` is the canonical production source. Before local changes, fetch and fast-forward from `origin/main`; dirty or diverged state must be resolved explicitly without discarding someone else's work. Changes are committed and pushed—production files are never edited or copied around Git.

Branch and pull-request CI runs only the self-contained test/build commands above. Successful GitHub Actions runs for `main` automatically deploy the verified artifact to Cloudflare Worker `iptv`. The former independent Workers Builds integration is disabled.

Production is Cloudflare Worker `iptv` at `https://iptv.vladimino.workers.dev/`, private behind Cloudflare Access. Scheduled Tasks are off, so automatic data refresh has not resumed. Unattended ChatGPT access to Cloudflare is a separate problem; do not relax Access to solve it. The historical Sites snapshot must not be imported over production R2 again. Publishing the legacy Site still requires a separate authorized Sites release, and that release must not resume writers there.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the working contract and [docs/deployment.md](docs/deployment.md) for deployment, backup, and rollback.

The historical Sites export is documented in [docs/migration-export.md](docs/migration-export.md). The completed Cloudflare restore and the ban on replaying it are documented in [docs/r2-import.md](docs/r2-import.md).
