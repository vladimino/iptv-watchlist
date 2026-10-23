# AIR-64: Letterboxd ratings refresh

[AIR-64](https://trello.com/c/WTnyO8bX). The films list can answer HTTP 403 with an anti-bot page. That failure is not an EPG failure, and this path does not try to get past the challenge.

`RATINGS_REFRESH` is unset. `POST /api/enrichment/ratings/refresh` then returns 409 and does not fetch. Setting it to `on` allows one owner-triggered attempt. There is no schedule and no retry loop inside the request. A 403 waits an hour before another full attempt. A repair of named film ids is separate and can still run during that wait.

`GET /api/enrichment/ratings/status` only reads. `state` is `idle`, `healthy`, `degraded`, or `blocked`. `lastSuccessAt` is the last complete films list. `attempt` is the latest call and can be a repair; a repair does not move `lastSuccessAt` or turn `blocked` into `healthy`. `diary.cause: incomplete_page` is the empty diary table and is not the films 403. Diary history stays with [AIR-51](https://trello.com/c/33d4hKJ3).

A complete list is stored at `enrichment/ratings/generations/<id>.json`. `enrichment/ratings/published.json` names it only after the view index has been projected for that generation. Until then `enrichment/ratings/pending.json` holds the unfinished id, and the previous projected generation stays the one status reports. The next refresh finishes that pending generation without calling Letterboxd. Every writer of the view index — this projection, a per-film rating, a fingerprint or prediction, the ratings seed, and the EPG films-list commit — rereads the object and retries when its ETag changed. A rating written here is not restored by a slower writer that read the index earlier. Rating observations are appended the same way, so finishing a pending generation does not drop a row recorded in between. The EPG commit still attempts the films list once, with its existing three tries on HTTP 403, and does not read `RATINGS_REFRESH`. The lease lasts 120 seconds and is renewed before each films page and before the index, pointer, and status writes. A request that no longer owns the lease does not write. A repair whose lookups all fail is `attempt.outcome: failed` and does not change the full-scan state. A later 403 does not replace a projected generation. A newer per-film `actual.json` written during the attempt is left in place.

The route does not write `programme.json`, `watchlist.json`, `sync.json`, or the prediction queue. A successful refresh can fill a half-star rating on an existing watchlist removal event. It does not create a second event. If that event write fails, the published ratings result stays successful and the request does not read Letterboxd again. A later refresh can fill the same event.

## Rollback

Unset `RATINGS_REFRESH`. The EPG commit is unchanged. Deleting `enrichment/ratings/` drops only this snapshot and status. The view index keeps the ratings already projected.
