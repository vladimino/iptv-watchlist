# AIR-273: removal rating lookup returned `not_found` for a rated film (2026-10-29)

**Card:** [AIR-273](https://trello.com/c/TVB01Xm0). **Related:** [AIR-268](https://trello.com/c/7ePpEYev) ([ADR 0043](../../adr/0043-removal-rating-lookup-queue.md)), [AIR-271](https://trello.com/c/k7kDc6Lf) (activation), [AIR-267 evidence](air-267-recent-ratings-diagnostics-2026-10-29.md), [AIR-272](https://trello.com/c/Oezn5dLP) (flag cleanup, blocked on this card).
**Capture:** 2026-10-29 17:18–17:21 UTC. **Code:** `main` with AIR-268 and AIR-270 deployed; `REMOVAL_RATING_LOOKUP=on` since 2026-10-29 09:18 UTC.
**Scope:** read-only. R2 GET through the Cloudflare API, and single public GETs from the agent container without retries. No production write, sync, retry, queue change, flag or Task change.

## Verdict

The lookup behaved as specified, but the source it reads does not exist for this kind of rating. The member film page `/<user>/film/<slug>/` exists only when the film has a diary entry (a "watched by" page with a watch date). A film rated **without a diary entry** answers a genuine HTTP 404 there. The lookup records that 404 as terminal `not_found` on the first attempt, so the removal event gets no rating although the rating exists on Letterboxd.

The owner confirmed the scenario: the film was rated without a diary entry, and Letterboxd removed it from the watchlist as part of the same action. This is the normal way a watched film leaves the watchlist, so the gap is functional, not an edge case.

## Production state (R2, read-only)

| Object | Observed |
| --- | --- |
| `enrichment/removal-rating-lookups.json` | one entry, film `ESyU`: `state: not_found`, `lastResult: not_found`, `attempts: 1`, `lastError: null`, film URL `https://letterboxd.com/film/supergirl-2026/`; enqueued, attempted and checked at 17:08:34 UTC |
| `sync.json` (run `8287ad56`, owner-initiated sync) | `removalRatingLookup` checked 1, rated 0, notRated 0, failed 0, pending 0, queued 1. The films list failed separately: `ratingAttempt` `error` / `blocked`, 403 on page 2 |
| removal event `8287ad56-…-watchlist` | one removed film (`ESyU`), no `rating` |
| `enrichment/films/ESyU/actual.json` | absent |
| `letterboxd/facts/links.json` | `letterboxd:ESyU` → `tmdb-1081003` present |

In `src/enrichment.js`, `lastResult: not_found` comes only from `refreshPersonalRating` returning `status: not_found`, which it does exactly on HTTP 404. `removalLookupOutcome` then makes that state final. The aggregate summary does not count it as a failure, which is why `failed: 0`.

## Letterboxd responses (agent container, one request each)

| URL | Result |
| --- | --- |
| `/<user>/film/supergirl-2026/` | **404**, page title "Letterboxd - Not Found" (not a challenge) |
| `/film/supergirl-2026/` | 200; `og:url` confirms the slug |
| `/<user>/films/` page 1 (release date, newest first) | 200; `ESyU` present with class `rated-7`, i.e. **3.5 stars** |
| member film pages of three other rated films from the same page | 200; titles "‘…’ watched by …", "Watched on", JSON-LD `Review` with `datePublished`: diary entries |
| `/<user>/films/year/2026/` | 403 `Just a moment…` challenge; probing stopped |
| `/<user>/film/supergirl-2026/activity/` | 403 challenge |

The container's egress is not the Worker's. It reproduced the Worker's 404, and the Worker's own films-list read reached page 1 in the same sync before failing on page 2.

## Coverage and limits

- Diary entry present: the member page works (AIR-34 / AIR-268 path), and so do retries.
- Rating without a diary entry: no per-film page. The rating is visible only in the member's film lists. Of those lists, only `/<user>/films/` page 1 has answered without a challenge (72 films, newest release first). `rated-date`, the year filter, page 2 and the activity page were challenged.
- So a rating-only film is recoverable only when it is among the 72 newest releases the member has logged or rated. An older film rated without a diary entry has no reliable source, and must be reported honestly as unresolved, not as success.

## Decision (owner, 2026-10-29)

Option **B**: no new Letterboxd request. The routine EPG films-list read already loads page 1 successfully before page 2 is challenged. Use that page's **positive** ratings for the films removed in the same run only, as rating observations; never clear anything because a film is absent from a partial page.

This changes the accepted rule that a partial scan is not an observation ([ADR 0024](../../adr/0024-letterboxd-scan-summary.md), [ADR 0043](../../adr/0043-removal-rating-lookup-queue.md)). It therefore needs its own ADR, plus architecture planning with the owner before any implementation.

Not decided yet:
- the ADR wording;
- how a queue entry already in `not_found` for such a film is reconciled;
- whether a per-film 404 should stay terminal;
- how unresolved older films are shown.
