# Letterboxd ratings-only refresh — retired contract

[AIR-64](https://trello.com/c/WTnyO8bX) added an owner-triggered ratings-only refresh behind `RATINGS_REFRESH`. [AIR-92](https://trello.com/c/yP6I0sjp) retired it ([ADR 0040](../../adr/0040-retire-ratings-only-refresh.md)) after the [AIR-85](https://trello.com/c/NVS7Ywdq) preflight found the public films list answering HTTP 403 with an anti-bot page on page 2. This path never tried to get past that challenge, and no replacement scraper exists.

## What answers now

`POST /api/enrichment/ratings/refresh` answers `410 Gone` with `{"error":"gone","detail":"…"}` for every method, body and value of `RATINGS_REFRESH`. The Worker returns before it parses the body: no Letterboxd request, no lease, no bucket read, list or write. Nothing in the Worker reads `RATINGS_REFRESH` any more; the `feature_flags` readout lists it as retired so a stale binding stays visible ([feature flags](../feature-flags.md)).

`GET /api/enrichment/ratings/status` still only reads. It returns the stored `enrichment/ratings/status.json` (or an `idle` placeholder when none exists) with `generationId` and `pendingGenerationId` resolved from `enrichment/ratings/published.json` and `enrichment/ratings/pending.json`, and always `enabled: false`. The fields keep their AIR-64 meaning: `state` is `idle`, `healthy`, `degraded` or `blocked`; `lastSuccessAt` is the last complete films list the retired refresh read; `attempt` is its last call. No code path writes these objects any more, so the values are the last ones the refresh wrote.

The integration footer keeps `manualRefreshEnabled: false` on the `letterboxd_ratings` source.

## Where ratings come from

- The EPG commit still reads the public films list once, with its existing three tries on HTTP 403, and projects ratings into the view index. A 403 there leaves the previous ratings in place and marks `ratingPending` on the sync ([enrichment API](../api/enrichment.md)).
- The per-film lookup and the owner `PUT /api/enrichment/actual-ratings` write single ratings, and with `LETTERBOXD_FACTS=on` the fact records ([user facts contract](letterboxd-user-facts.md)).
- A watchlist removal event still receives a half-star rating when the per-film lookup records one.

## Removed films

With `REMOVAL_RATING_LOOKUP=on` ([ADR 0042](../../adr/0042-removal-rating-lookup-queue.md), [AIR-268](https://trello.com/c/7ePpEYev)) a removal event no longer waits for a complete films list. When the EPG commit builds the watchlist diff, it hands the removed films with their Letterboxd film URL to `lookupRemovalRatings`, which runs right after the commit's events are written and before the films list:

- **Queue.** `enrichment/removal-rating-lookups.json` keeps one entry per film id: `url`, `state` (`pending`, `rated`, `not_rated`, `not_found`, `conflict`, `gave_up`), `attempts`, `enqueuedAt`, `nextAttemptAt`, `lastAttemptAt`, `lastResult`, `lastError`, and `rating` once found. A film already in the queue is not added again. Entries older than 14 days are dropped and at most 100 are kept, finished ones first. Every write is a compare-and-swap.
- **Bounded requests.** One call requests the member page `/<user>/film/<slug>/` of at most five due films, oldest first. The attempt is recorded before the request, so a request killed mid-lookup counts the attempt and retries no sooner than an hour later. A film gets at most three attempts in all.
- **Outcomes.** A rating found goes through the existing per-film path (fact record, `actual.json`, view index, removal event with `ratingObservedAt`); the first confirmed rating on an event is never replaced. A page without the owner's rating is retried after 24 hours and becomes final `not_rated` after the third attempt; it never marks the film watched. A 404 is final `not_found`.
- **Upstream blocks.** A 403 or 429 stops the batch at once, no request is repeated, and the whole queue waits six hours (`pausedUntil`, `pausedBy`) because the block is about the source, not the film. A network or 5xx error retries that film after an hour.
- **Independence.** The lookup never throws into the commit: an error is reported in the summary and the EPG result is unchanged. Its summary is stored as `sync.json` `removalRatingLookup` (`checked`, `rated`, `notRated`, `failed`, `stoppedBy`, `pausedUntil`, `pending`, `queued`, `at`, `error`). A film left pending is retried on the next EPG commit.

## Kept objects

The retirement deletes nothing. `enrichment/ratings/status.json`, `published.json`, `pending.json`, `lease.json` and `generations/<id>.json` stay in R2 as written. The view index keeps every `actualRating` already projected from a generation. A leftover `pending.json` is no longer finished by anyone; `status` reports its id as `pendingGenerationId` and the view index is unaffected by it.

## Rollback

Reverting the code restores the AIR-64 route behind `RATINGS_REFRESH`, which is unset in production (read 2026-10-29 05:16 UTC). Bringing the refresh back for real is a new decision under a new ADR, not a flag change. Deleting `enrichment/ratings/` is a separate owner-approved storage operation; the view index keeps the ratings already projected.
