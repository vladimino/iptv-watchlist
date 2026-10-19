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

Runtime values are configured separately in Cloudflare and legacy Sites. Their R2 buckets are independent. The tracked hosting manifest contains only the legacy Site identity and R2 binding; it is required to map each Git commit to the matching Sites version.

## Tests

`npm test` runs the self-contained suite and does not contact Letterboxd, EPG, TMDB, or production. Historical source-adapter tests that depended on downloaded HTML/XML snapshots are not part of the public test command because those local captures are intentionally excluded.

## Operational safety

Do not manually run EPG sync, the prediction runner, recurring/scheduled jobs, diagnostic exports, or production backfills merely to test the code. They mutate durable production state and may consume external model/API quota. Use the local test suite; run production jobs only for an explicit operational task against an environment you own.

Generated `dist/`, archives, runtime caches, local diagnostics, `.env*`, personal rating seeds, and production credentials must remain untracked.

## Git-first delivery

GitHub `main` is the canonical production source. Before local changes, fetch and fast-forward from `origin/main`; dirty or diverged state must be resolved explicitly without discarding someone else's work. Changes are committed and pushed—production files are never edited or copied around Git.

Branch and pull-request CI runs only the self-contained test/build commands above. Successful GitHub Actions runs for `main` automatically deploy the verified artifact to Cloudflare Worker `iptv`. The former independent Workers Builds integration is disabled.

Legacy Sites remains authoritative until data cutover. Publishing its code still requires a separate authorized Sites release procedure. Cloudflare CD does not migrate data. See the deployment document for the SHA mapping, release procedure, and rollback limits.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the working contract and [docs/deployment.md](docs/deployment.md) for deployment and rollback.

The read-only backup of the old Sites-managed R2 is documented in [docs/migration-export.md](docs/migration-export.md). The trial restore into Cloudflare R2, which does not run without a separate approval, is documented in [docs/r2-import.md](r2-import.md). GitHub/Cloudflare deployment alone cannot read the source bucket.
