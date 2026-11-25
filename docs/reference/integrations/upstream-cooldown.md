# Shared upstream cooldown (AIR-604, UC1)

Contract of the shared, durable cooldown per upstream scope ([ADR 0211](../../adr/0211-catalog-enrichment-producer.md) decision 5, Accepted; card UC1 of [ADR 0207](../../adr/0207-letterboxd-admissions-coordinated-in-d1-only.md) decision 7). It is **delivered dormant**: the mode row is absent or `off`, and the schema ([migration 0045](../../../migrations/0045_upstream_cooldown.sql)) is in the repository and **not applied to any database**. Applying it and every mode change are separate owner production operations; this document describes the delivered code, not the present production state (read that live).

## What it is, and is not

- One row per **scope** in `upstream_cooldown`: `tmdb` (the one bearer), `letterboxd` (Worker egress to `letterboxd.com` and `boxd.it`), `wikidata` (`query.wikidata.org`). A scope is a rate-limit or credential domain, never a producer. A cooldown of one scope never blocks another scope.
- It is **not a request-rate limiter**: no token bucket, no shared spacing. Each caller keeps its own spacing and its own retry policy. A skipped request costs the caller **no attempt, no failure and no quarantine budget**: the caller maps it to its existing not-now path.
- The EPG XMLTV source, the Monitor's Telegram and webhook calls and the Cloudflare Access certificate fetch are out of scope (single caller with their own pause, or infrastructure).

## Signals

| Response | Cooldown |
| --- | --- |
| 429 | `rate_limited`; `Retry-After` (seconds or an HTTP date) clamped to 30-3,600 s, otherwise 300 s |
| Cloudflare challenge (`cf-mitigated: challenge`, or a challenge page) | `challenge`; the same clamp, otherwise 900 s |
| 403 | `forbidden`; the same clamp, otherwise 900 s |
| 404, 5xx, timeout, network error, success | none: one entity or a transient fault stays the caller's local retry |

The write is `INSERT … ON CONFLICT(scope) DO UPDATE` with `until_at = MAX(until_at, excluded.until_at)`; the reason and `Retry-After` follow the latest `until_at` only. It is commutative, so concurrent writers never shorten a cooldown, and triggers refuse a direct shortening and any delete. An expired row is inert and is overwritten, never deleted.

## Modes (`upstream_coordination`, singleton row `id = 1`)

| Mode | Behaviour |
| --- | --- |
| `off` (default; an absent row, an absent table or an unreadable row) | today's behaviour; the only D1 read is the mode row; no cooldown is read or written |
| `observe` | writers write cooldowns and count each "would have skipped" decision (`stats.wouldSkip`); nothing is skipped |
| `enforce` | callers skip a scope while its cooldown is active |

**Fail-safe:** an absent or unreadable table or mode row means `off` for that call; a failed cooldown write is swallowed and the caller's local backoff still applies. Coordination never blocks production work and never makes a caller more aggressive. The mode is read once per caller run; the cooldown row is read before each request. Rollback is `off`, which needs no code revert.

## Callers

Code: `src/upstream-cooldown.js` (scoped as `UpstreamCooldown` in the Worker bundle, `build.mjs`). A caller gets a coordinator through `upstreamCoordinator(env, caller)` (`src/sources.js`), which is `null` where the module is not in scope; `null` is today's behaviour.

| Scope | Caller (writer path) | A skip becomes |
| --- | --- | --- |
| tmdb | Discovery chunks, the owner poster route and the poster weekly cron, `movieDetail` of the Diary check, the Watchlist admission and the archive step (`tmdbRequest`, `movieDetail`) | Discovery: `error.retryAt = until` (the existing 429 not-now path, no attempt charged); poster cron and route: the same `retryAt` outcome (`rate_limited`, no `retryAttempts` increment); identity checks: transport stop `upstream_cooldown`, no attempt |
| tmdb | `GET /api/integrations/tmdb/status` (**read-only**: `peek`, never writes) | answers `503 {connected:false, stage:'upstream_cooldown'}` without a request; on a 429 of a sent request it reports the status as before and writes nothing |
| letterboxd | Sync Watchlist scan (`getHTML`), legacy Watchlist sync, metadata-sync film pages | scan: the existing non-charging `rate_limited` outcome, reason `upstream_cooldown`; metadata sync: the film is skipped without a failure and `run.upstreamCooldownSkips` counts it |
| letterboxd | Diary page (`syncHistory`) | the existing `rate_limited` Diary outcome, stop reason `upstream_cooldown_page_N`; no ratings attempt |
| letterboxd | identity checks of the Diary and the Watchlist admission and the archive step (`follow`, film-page fetch) | transport stop `upstream_cooldown` (a recognised transport reason: no attempt, queue place kept) |
| letterboxd | removal-phase rating refresh | checked **before** the claim: `pausedUntil = max(pausedUntil, until)`, `pausedBy = upstream_cooldown`, `lookup.stoppedBy = upstream_cooldown`; no claim, no attempt; the run outcome comes from the Diary part, so it is not a failure; a 403, 429 or challenge of a sent lookup writes the cooldown |
| wikidata | metadata sync, EPG localization, the archive enrich step (`localizeFilmTitles`, `localizePeople`, `localizeByLetterboxd`) | the step stops asking Wikidata, records the skip (`coordinator.stats.skipped`, `run.upstreamCooldownSkips`) and counts no localization error |

**Not adopted here (and why):** the catalog-enrichment producer of ADR 0211 does not exist yet; it adopts the same coordinator when it is delivered. `src/letterboxd-tmdb-search.js` is a script-side offline tool, not a Worker caller. A challenge page behind a `200` is detected for the Diary page and for the bounded identity fetches (body read); other callers detect status and header signals.

## Read side effects

No GET, HEAD or MCP read writes the cooldown. The TMDB status probe stays the one registered outbound read of the baseline (`tmdb-status-probe`, ADR 0107); it reads the mode and the cooldown and writes nothing. `tests/get-write-audit.mjs` is unchanged.

## Tests

`tests/upstream-cooldown.mjs` (migration, policy, monotonic write, modes, fail-safe), `tests/upstream-cooldown-callers.mjs` (Discovery, the status probe, the page reader, Wikidata, identity fetches), `tests/removal-ratings-cooldown.mjs` (removal phase through the real pipeline) and the Diary page cases of `tests/letterboxd-diary.mjs`.
