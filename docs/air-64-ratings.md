# AIR-64: Letterboxd ratings refresh

[AIR-64](https://trello.com/c/WTnyO8bX). The films list can answer HTTP 403 with an anti-bot page. That failure is not an EPG failure, and this path does not try to get past the challenge.

`RATINGS_REFRESH` is unset. `POST /api/enrichment/ratings/refresh` then returns 409 and does not fetch. Setting it to `on` allows one owner-triggered attempt. There is no schedule and no retry loop inside the request. A 403 waits an hour before another full attempt. A repair of named film ids is separate and can still run during that wait.

`GET /api/enrichment/ratings/status` only reads. `state` is `idle`, `healthy`, `degraded`, or `blocked`. `lastSuccessAt` is the last complete films list. `attempt` is the latest call and can be a repair; a repair does not move `lastSuccessAt` or turn `blocked` into `healthy`. `diary.cause: incomplete_page` is the empty diary table and is not the films 403. Diary history stays with [AIR-51](https://trello.com/c/33d4hKJ3).

A complete list is stored at `enrichment/ratings/generations/<id>.json` and named by `enrichment/ratings/published.json`. The view index is updated only after that pointer is stored. A later 403 does not replace either. A newer per-film `actual.json` written during the attempt is left in place.

The route does not write `programme.json`, `watchlist.json`, `sync.json`, events, or the prediction queue.

## Rollback

Unset `RATINGS_REFRESH`. The EPG commit is unchanged. Deleting `enrichment/ratings/` drops only this snapshot and status. The view index keeps the ratings already projected.
