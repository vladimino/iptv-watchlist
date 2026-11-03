# IPTV Watchlist — «В эфире»

A private film guide built from a public [Letterboxd](https://letterboxd.com/) watchlist and an XMLTV/IPTV programme. It combines films on the watchlist with recently aired and upcoming broadcasts, adds discovered catalog films and metadata, and displays personal film-taste predictions when available.

**Production:** Cloudflare Worker `iptv` at [iptv.vladimino.workers.dev](https://iptv.vladimino.workers.dev/), protected by Cloudflare Access. **Storage authority is per domain:** D1 database `iptv` (schema v9) owns the metadata cache, mutable prediction state and the published EPG/programme/watchlist generation (`published_epg_authority.mode=d1`, `cutover=open`); R2 bucket `iptv` remains authoritative for Discovery ledger/decisions, ratings/viewing facts, Film/Person sources outside the D1-owned cache, and Admin owner reviews. Migration `0009` is applied, the object is imported, and the owner-review marker is `r2` at generation 1 ([import record](docs/evidence/d1-migration/air-314-owner-review-import-2026-11-03.md)). R2 also stores immutable prediction bodies, raw inputs/archives and compatibility mirrors, not competing published-EPG pointers. GitHub `main` is the canonical code source. The former ChatGPT Site is a reserve, **not** a parallel writer. The [dated EPG cutover evidence](docs/evidence/d1-migration/air-319-production-cutover-2026-11-03.md) distinguishes activation from functional acceptance; a D1 schema or import alone does not prove a cutover. See [deployment](docs/runbooks/deployment.md), [system context](docs/architecture/system-context.md) and [persistence/migration architecture](docs/architecture/persistence-and-migration.md).

## What the site does

- **Programme and availability.** Displays a rolling 72-hour catch-up archive and upcoming programme, including on-air and last-chance showings. The current published EPG generation determines which broadcasts are known. The interface also supports films without a current showing.
- **Finding films.** Search by title and optionally people and plot; filter by genre, year, runtime, channels, film characteristics and availability. Saved filters, sorting and list navigation work with the film detail view.
- **Film details.** A film page includes available poster, synopsis, localized/original title, cast, director, broadcasts and saved predictions. Users can mark a film as started and compare saved characteristics with another loaded film by its canonical id. Shared mechanics and moods sit beside a two-column table of short execution values. The other film's name opens its film page, and Back returns to this comparison. A difference is not a ranking unless that dimension's own vocabulary is a quality scale. Unknown, missing, and not-applicable values are not low scores, and the comparison does not recommend similar films.
- **Personal predictions.** A versioned taste profile and film fingerprints support predicted ratings and explanations. Prediction freshness is separate from broadcast times. Actual Letterboxd ratings remain a different data source; a missing prediction or rating is not fabricated.
- **Owner data page.** `/admin` searches the films and people of the published programme and lists quality queues (missing or provisional localization, unresolved identity, missing or stale metadata), reading one pinned snapshot; some underlying GET routes can repair compatibility mirrors as documented below. Its data health view at `/admin/health` ranks the problems the bounded read-only sources can prove (stuck or waiting retries, stale metadata, missing posters, a stale programme) and names what it cannot read as unknown; it offers no action buttons. `/admin?view=health` is replaced in the browser by `/admin/health`. `/admin/posters` shows poster coverage (restorable by a verified TMDB id or not) and lets the owner run one confirmed, bounded restoration through the existing poster maintenance route. `/admin/limb` lists the films and discovery observations that are not progressing; for one observation whose automatic attempts ended on unchanged airings, the owner can confirm one guarded action that sends it back to the ordinary resolver queue without any TMDB call of its own. `GET /admin/limbo` redirects to `/admin/limb`. `/admin/letterboxd` lets the owner upload a Letterboxd account export and see, without any write, how fresh and complete it is and what an import would change; the archive is read in memory within that one request and stored nowhere. See the [admin read API](docs/reference/api/admin.md).
- **Status and history.** The dashboard shows coverage/freshness and processing status. An Events page presents recorded additions, removals and other lifecycle events; inferred watches are not confirmed viewing history.

Features operate on stored snapshots: opening the page does **not** run model inference or trigger an EPG sync. Some GET/read paths can write or repair persisted state, including `GET /api/programme` and `GET /api/watchlist` through `repairMirrors` in D1 EPG mode; see [safe operational boundaries](docs/runbooks/deployment.md) and [GET side-effect tests](tests/get-side-effects.mjs).

## Data and operations

```text
Public Letterboxd watchlist + configured XMLTV programme
                         |
                  authorized EPG sync
                         |
                Cloudflare Worker iptv
                         |
            published EPG generation in D1
                         |
                browser programme and film views
           (R2 published JSON is a mirror)

Discovery ledger/decisions in R2 --> verified catalog Film records
D1 profile, prediction queue and pointers --> external ChatGPT model runner
Immutable fingerprint/prediction bodies --> R2 objects
D1 metadata working cache --> R2 compatibility mirror
Ratings/viewing facts and Admin owner reviews --> R2
```

The Worker publishes a coherent EPG generation in D1 before switching the D1 published pointer. While D1 is the active EPG authority, published R2 JSON is a compatibility mirror, not a fallback source of truth. Candidate scoring and TMDB detail verification are separate: an ambiguous match does not automatically become a canonical film. Discovery continues in bounded chunks **only after explicit requests**.

EPG/watchlist and prediction orchestration are performed by **external ChatGPT Scheduled Tasks** through an owner-only MCP endpoint, not by Worker Cron. Tasks and active flags can change independently of GitHub deployments; historical documentation is not proof of their current state. Publishing Worker code neither invokes MCP writers nor runs sync, discovery, predictions or migration. The Worker has one cron trigger, for the D1 enrichment projector only ([ADR 0056](docs/adr/0056-d1-enrichment-write-through.md)); it is inert while `D1_ENRICHMENT_WRITE` is unset. See [EPG architecture](docs/architecture/epg-and-availability.md), [discovery architecture](docs/architecture/discovery-and-resolution.md), [prediction pipeline](docs/architecture/prediction-pipeline.md), [scheduling](docs/architecture/scheduling-and-orchestration.md) and [MCP contract](docs/reference/api/mcp.md).

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

**Safety:** no production EPG/prediction runs, retries, feature-flag changes, Access changes, lease resets, legacy-Site writes or R2/D1 migrations without separate explicit owner authorization. A successful deploy does not authorize a production write. Code rollback does not revert R2/D1 data, D1 authority markers or external Scheduled Tasks; each authority revert requires its own fenced approval.
