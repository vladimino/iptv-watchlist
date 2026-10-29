# AIR-267: Letterboxd recent ratings — source, 403 and EPG diagnostics (2026-10-29)

**Card:** [AIR-267](https://trello.com/c/vYe0wGYM). **Related:** [AIR-34](https://trello.com/c/0hQjPzIf) (ratings on watchlist-removal events), [AIR-64](https://trello.com/c/WTnyO8bX), [AIR-85](https://trello.com/c/NVS7Ywdq), [AIR-92](https://trello.com/c/yP6I0sjp) ([ADR 0040](../../adr/0040-retire-ratings-only-refresh.md)).
**Code read:** `main` at `6091e4e`. **Capture:** 2026-10-29 06:35–06:50 UTC.
**Scope:** read-only. One public GET per Letterboxd URL from the agent container, read-only R2 GET/LIST and Workers Observability queries through the Cloudflare API. No Worker request, no production write, no flag, Task or Access change, no retry, no challenge solving.

## Verdict

| Question | Answer |
| --- | --- |
| Can `/vladimino/films/by/rated-date/` feed recent ratings from a server runtime? | **NO-GO as tested.** The first page answered `403` with `cf-mitigated: challenge` (Cloudflare "Just a moment" page) on the single request. Not retried. |
| Is page 1 of the current `/vladimino/films/` a recency source? | **No.** It answered `200` with 72 films, but the default order is **Release Date, newest first**, not rating or watch date. A new rating of an older film lands deep in a 31-page list. |
| Why does the latest `sync.json` show `ratingPending` with `ratingError: null`? | The EPG commit request was very likely **killed for memory** after `finishSync` saved `stage: complete` and before the ratings step wrote any outcome. Observability shows `Worker exceeded memory limit.` on `POST /mcp` 10 s after that save. |
| What does the footer show for ratings now? | `letterboxd_ratings` comes from the **frozen** AIR-85 `enrichment/ratings/status.json` (`blocked`, `anti_bot`, 2026-10-29 04:57 UTC). After AIR-92 nothing updates that object. |

## 1. Source matrix

| # | URL | Runtime | Time (UTC / Madrid) | Result | Evidence |
| --- | --- | --- | --- | --- | --- |
| 1 | `https://letterboxd.com/vladimino/films/by/rated-date/` | agent container (egress proxy; Cloudflare edge `IAD`) | 06:35:58 / 07:35:58 | Not sent: the environment egress policy refused `CONNECT letterboxd.com:443` (403 from the proxy, not from Letterboxd) | proxy status `connect_rejected` |
| 2 | same | same, after the owner allowed `letterboxd.com` | 06:44:50 / 07:44:50 | **403**, `text/html`, 5,548 bytes, `server: cloudflare`, `cf-mitigated: challenge`; body has "Just a moment", `challenge-platform`, "Enable JavaScript and cookies" | headers and body inspected locally, not stored |
| 3 | `https://letterboxd.com/vladimino/films/` | same | 06:44:50 / 07:44:50 | **200**, `text/html`, 210,453 bytes, `cache-control: no-store`; parsed with the Worker's own `parsePublicFilmsPage` | 72 entries, all with a rating, half stars present, total 2,162 films, `next` = page 2, 31 pages |
| — | `/vladimino/films/page/2/` | Worker (EPG and AIR-85) | 2026-10-29 04:57 UTC (AIR-85) | 403 anti-bot on page 2 | stored `enrichment/ratings/status.json`; not requested today |
| — | `/vladimino/diary/` | Worker (AIR-85 run) | 2026-10-29 04:57 UTC | parsed, `diary.state: healthy` | stored status; not requested today |

Requests used the Worker's headers (`User-Agent: Mozilla/5.0 (compatible; WatchlistAirtime/1.0)`, `Accept: text/html`, `Accept-Language: en-US,en;q=0.9`). The container egress is not the Worker egress: a challenge here is strong but not conclusive evidence for the Worker. A Worker-runtime check needs a route that does not exist after AIR-92 and a separate owner approval.

### Page facts (row 3)

- 72 poster items per page (`griditem` count and `LazyPoster` count both 72); the pager shows 1, 2, 3 … 31.
- Each item carries the Letterboxd film id (`lid` in `data-postered-identifier`) and the owner's half-star rating as class `rated-1`…`rated-10`.
- The sort menu offers **When Rated → Newest First** at `/films/by/rated-date/` and **When Added → Newest First** at `/films/by/date/`. The page shows no rating date, so the scan time is an observation time, never a `ratedAt`.
- Not established: whether a re-rating moves a film to the top of `rated-date` (the page could not be read), and whether `rated-date` is challenged for every client or only for this egress.

## 2. Code paths (`main` `6091e4e`)

| Step | Location | Behavior |
| --- | --- | --- |
| Films list scan | `refreshRatingsFromFilms`, `src/enrichment.js` | Starts at `/<user>/films/` (release-date order), follows `a.next` up to 60 pages, 3 tries per page on 403 with 500 ms and 1 s waits, 15 s timeout. Any non-2xx throws `Letterboxd films HTTP <code> on page <n> (anti-bot challenge)`. Requires `seen.size === total`, so one blocked page fails the whole scan. |
| Parser | `parsePublicFilmsPage` | Reads the `title="<n>&nbsp;films"` total, `lid` and `rated-N` per `griditem`, and the `next` link. |
| With `LETTERBOXD_FACTS=on` (production) | `LetterboxdFacts.applyFilmsListScan` | One summary observation per scan; absence clears nothing. |
| EPG ordering | `completeWithRatings`, `src/worker.js` | `finishSync` first (watchlist, watchlist scan facts, events, **`sync.json` with `stage: complete` and `ratingPending` kept**, prediction queue refresh), **then** the films list. Success deletes `ratingPending` and sets `ratingObservedAt`; a thrown error sets `ratingError` and `ratingRepair`. |
| Fallback on failure | `repairRemovedBaselineRatings`, `repairRecentDiaryRatings` | Up to 10 per-film lookups of departed baseline films, and page 1 of `/<user>/diary/`, each rating change confirmed by a per-film page. |
| Per-film lookup | `refreshPersonalRating` | `/<user>/film/<slug>/`, reads the owner's `Review` JSON-LD rating; writes the fact, `actual.json`, the view index and calls `enrichRecentRemovalRatings`. |
| AIR-34 removal events | `enrichKnownRemovalEvent`, `enrichRecentRemovalRatings`, `withRemovalRatings` | Adds a confirmed half-star rating and `ratingObservedAt` to an existing watchlist-removal event; never creates an event; a later different rating does not overwrite the first. |
| Next sync step | `syncStep`, `stage === 'complete'` branch | Goes to discovery continuation. **The ratings step is not retried**; `ratingPending` stays until the next EPG run. |

## 3. Persisted state and the footer

Read from production R2 at about 06:40 UTC:

| Object | Fields |
| --- | --- |
| `sync.json` | run of 2026-10-28, `startedAt` 15:58:57, `updatedAt` 16:00:17.876 UTC, `stage: complete`, `ratingPending: ["public-films-list"]`, **no** `ratingError`, `ratingRepair` or `ratingObservedAt`; events: one watchlist removal (no rating), one EPG event |
| `enrichment/ratings/status.json` | `state: blocked`, attempt `full` 04:57:19–04:57:23 UTC on 2026-10-29, `cause: anti_bot`, `HTTP 403 on page 2`, `lastSuccessAt: null`, `diary.state: healthy` |
| `enrichment/ratings/published.json`, `pending.json` | absent |
| `enrichment/ratings/lease.json` | present, expired (`expiresAt: 0`) |
| `letterboxd/facts/scans/` | only `watchlist.json` and `watchlist.pending.json` (both 2026-10-28 16:00 UTC); **no films-list scan summary has ever been written** since the facts writer went on |
| `enrichment/diagnostics/rating-observations.json` | last `letterboxd_public_films` observations on 2026-10-18 (5); per-film observations up to 2026-10-25 |

`ratingObservedAt` is carried from run to run only when it exists, and it is absent; together with the empty scan prefix this says the films list has not completed since at least the facts rollout on 2026-10-27.

**Workers Observability**, `iptv`, 2026-10-28 15:58:30–16:02 UTC: a log event `Worker exceeded memory limit.` on `POST /mcp` at **16:00:27.733**, ten seconds after `sync.json` was saved as complete. Between 2026-10-27 16:05 and 2026-10-28 06:56 UTC there are 13 `exceededMemory` outcomes on `POST /mcp` (status 503, 37–66 s wall), most at 17–25 minutes past the hour. The logs do not name the MCP tool or the run, so the link between the 16:00:27 event and the commit is a strong timing correlation, not a proof. Older HTTP responses from Letterboxd are not logged anywhere; none are reconstructed here.

**Footer trace** (`integrationHealth`, `src/enrichment.js`): rating events are taken from `ratings.lastSuccessAt`/`lastFailureAt` (the status document), `sync.ratingObservedAt` and `sync.ratingError`. Today only the status document has a dated event, so `letterboxd_ratings` reads `degraded` / `ratings_blocked` at 04:57 UTC. The pending ratings of the 2026-10-28 commit are invisible: with a dated event present, the `ratings_pending` branch is not reached. After AIR-92 the status document never changes, so this reading stays until a sync records `ratingObservedAt` or `ratingError`.

## 4. Feasibility of a first-page incremental

| Source | Order | Recency use | Risk |
| --- | --- | --- | --- |
| `/films/` page 1 (current scan start) | release date | none for recent ratings | — |
| `/films/by/rated-date/` page 1 | rating date, newest first | ideal: 72 latest ratings would cover normal use | challenged on the first request from a server runtime |
| `/films/by/date/` page 1 | when added (first logged) | new watches only; a re-rating does not move | not tested today |
| `/diary/` page 1 | watch date | new watches with their rating; parsed by the Worker in AIR-85 | re-rating without a new diary entry is not visible; diary rating is per entry |
| `/<user>/film/<slug>/` | one film | exact current rating for a known film | one request per film; fine for a bounded list (removed watchlist films) |

A checkpoint on a recency page would compare the first 72 ids and ratings with the last observed page and stop when the overlap is full. Absence from page 1 never means "unrated" or "removed". Recovery beyond page 1 hits the same page-2 challenge seen in AIR-64/85.

## 5. Last-good protection

Holds today: the films-list failure throws before any write; with `LETTERBOXD_FACTS=on` absence clears nothing; the view index keeps existing `actualRating`; removal events keep their first confirmed rating.

## 6. Recommendations (owner decision required)

1. **Do not build on `rated-date` from the Worker without one bounded proof.** If the owner wants it, the only next step is a separately approved, single Worker-runtime request of page 1, which needs a small code route (none exists after AIR-92). Expect the same challenge.
2. **Make the ratings step visible and memory-isolated** (robustness/observability card): write a ratings attempt marker before the fetch, or run the films-list read as its own sync step after `stage: complete`, so a killed request leaves `ratingError`/`ratingAttemptAt` instead of a silent `ratingPending`; let the next step retry it once.
3. **Footer after AIR-92**: stop treating the frozen `enrichment/ratings/status.json` as a live event, or label it historical, so `ratings_pending` from `sync.json` is shown.
4. **AIR-34 delivery without the films list**: for each watchlist-removal event, look up the removed films with the per-film page (bounded, already implemented as `refreshPersonalRating` + `enrichRecentRemovalRatings`), optionally seeded from diary page 1. This covers "rated, then removed from the watchlist" without any list scan.

Each item is a separate atomic card; none is implemented here.
