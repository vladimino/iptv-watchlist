# IPTV Watchlist — «В эфире»

A private film guide built from a public [Letterboxd](https://letterboxd.com/) watchlist and an XMLTV/IPTV programme. It combines films on the watchlist with recently aired and upcoming broadcasts, adds discovered catalog films and metadata, and displays personal film-taste predictions when available.

**Production:** Cloudflare Worker `iptv` at [iptv.vladimino.workers.dev](https://iptv.vladimino.workers.dev/), protected by Cloudflare Access. **Authoritative storage:** Cloudflare R2 bucket `iptv`. GitHub `main` is the canonical code source. The former ChatGPT Site is a reserve, **not** a parallel writer. D1 schemas, repositories and offline migration tools exist, but D1 is **not production-authoritative**. See [deployment](docs/runbooks/deployment.md), [system context](docs/architecture/system-context.md) and [persistence/migration architecture](docs/architecture/persistence-and-migration.md).

## What the site does

- **Programme and availability.** Displays a rolling 72-hour catch-up archive and upcoming programme, including on-air and last-chance showings. The current published EPG generation determines which broadcasts are known. The interface also supports films without a current showing.
- **Finding films.** Search by title and optionally people and plot; filter by genre, year, runtime, channels, film characteristics and availability. Saved filters, sorting and list navigation work with the film detail view.
- **Film details.** A film page includes available poster, synopsis, localized/original title, cast, director, broadcasts and saved predictions. Users can mark a film as started and compare saved characteristics with another loaded film by its canonical id. Shared mechanics and moods sit beside a two-column table of short execution values. The other film's name opens its film page, and Back returns to this comparison. A difference is not a ranking unless that dimension's own vocabulary is a quality scale. Unknown, missing, and not-applicable values are not low scores, and the comparison does not recommend similar films.
- **Personal predictions.** A versioned taste profile and film fingerprints support predicted ratings and explanations. Prediction freshness is separate from broadcast times. Actual Letterboxd ratings remain a different data source; a missing prediction or rating is not fabricated.
- **Status and history.** The dashboard shows coverage/freshness and processing status. An Events page presents recorded additions, removals and other lifecycle events; inferred watches are not confirmed viewing history.

Features operate on stored snapshots: opening the page does **not** run model inference or trigger an EPG sync. Some legacy GET/read paths can recover or initialize persisted state; see [safe operational boundaries](docs/runbooks/deployment.md) and [GET side-effect tests](tests/get-side-effects.mjs).

## Data and operations

```text
Public Letterboxd watchlist + configured XMLTV programme
                         |
                  authorized EPG sync
                         |
                Cloudflare Worker iptv
                         |
            published EPG generation in R2
                         |
                browser programme and film views

TMDB metadata/discovery ----> verified catalog records in R2
Published taste profile ----> external ChatGPT model runner ----> predictions in R2
```

The Worker publishes a coherent EPG generation before switching its published pointer. Candidate scoring and TMDB detail verification are separate: an ambiguous match does not automatically become a canonical film. Discovery continues in bounded chunks **only after explicit requests**.

EPG/watchlist and prediction orchestration are performed by **external ChatGPT Scheduled Tasks** through an owner-only MCP endpoint, not by Worker Cron. Tasks and active flags can change independently of GitHub deployments; historical documentation is not proof of their current state. Publishing Worker code neither invokes MCP writers nor runs sync, discovery, predictions or migration. The Worker has one cron trigger, for the D1 enrichment projector only ([ADR 0054](docs/adr/0054-d1-enrichment-write-through.md)); it is inert while `D1_ENRICHMENT_WRITE` is unset. See [EPG architecture](docs/architecture/epg-and-availability.md), [discovery architecture](docs/architecture/discovery-and-resolution.md), [prediction pipeline](docs/architecture/prediction-pipeline.md), [scheduling](docs/architecture/scheduling-and-orchestration.md) and [MCP contract](docs/reference/api/mcp.md).

Letterboxd ratings refresh is a distinct, gated operation. HTTP 403 must not be bypassed; previously successful rating generations are retained when a new fetch cannot complete. See the [ratings contract](docs/reference/integrations/letterboxd-ratings.md).

## Local development

Requires Node.js 20 or later. `npm test` additionally needs the `sqlite3` command-line tool, because the D1 schema and repository tests shell out to it; `npm run dev` does not. GitHub Actions' Ubuntu runner ships it, and Claude Code cloud sessions install it through `.claude/hooks/session-start.sh`. Local development uses fixture data and a local R2-compatible store; a private production snapshot is not needed.

```bash
npm ci
npm test
npm run build
npm run dev
```

The development server starts at `http://127.0.0.1:8787`. For fixture behavior, watch mode, private snapshot isolation and safe reset instructions, follow [local setup](docs/runbooks/local-setup.md). Keep credentials in the appropriate local or Cloudflare environment; never commit them.

## Repository and documentation

| Entry point | Purpose |
| --- | --- |
| [Documentation home](docs/README.md) | Map of maintained docs and historical evidence |
| [Architecture diagrams](docs/architecture/README.md) | Thirteen implemented pages covering system context, runtime, security, EPG, identity, predictions, data, UI and failures |
| [ADR register](docs/adr/README.md) | Accepted architectural decisions and their evidence |
| [Technical reference](docs/reference/README.md) | API, domain, data and integration contracts |
| [Runbooks](docs/runbooks/README.md) | Deployment, safe operations and recovery |
| [Process](docs/process/README.md) | Delivery, review and Trello conventions |
| [Evidence registry](docs/evidence/README.md) | Dated experiments, parity and verification reports |
| [Agent guide](AGENTS.md) · [Contributing](CONTRIBUTING.md) | Repository rules and contributor workflow |

Code lives in `src/`, the browser interface in `public/`, reviewed public localization data in `data/`, tests in `tests/`, and reproducible build logic in `build.mjs`. GitHub Actions in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs tests/build for PRs and publishes a tested artifact on `main`; [`wrangler.jsonc`](wrangler.jsonc) declares the Worker and production R2 binding.

**Safety:** no production EPG/prediction runs, retries, feature-flag changes, Access changes, lease resets, legacy-Site writes or R2/D1 migrations without separate explicit owner authorization. A successful deploy does not authorize a production write. Code rollback is not a rollback of R2 data or external Scheduled Tasks.
