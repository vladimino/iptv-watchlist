# AIR-318 ratings domain — local contract, 3 November 2026

**Verdict:** code and local SQLite only. **No production migration, import, activation, seal or revert. No ratings run.**

Captured on branch `cursor/air-318-ratings-d1-ab33` from `origin/main` `f441abfc308d0dac198c522aa14e363bd1ae09c3`. Production D1 was not opened. The live ratings objects were not listed or copied. `scripts/ratings-domain-production.mjs` was not pointed at database `iptv`.

## What was checked

`node tests/ratings-d1.mjs` on the local SQLite stand-in. The same tree then passed `npm test` (207 self-contained files) and `npm run build`. Neither command opened production.

- Version 6 refuses `0010` and creates no ratings table. A complete version 8 becomes version 10 with `mode` `r2`, `cutover` `open` and generation 0. A downgrade to 9 aborts. Version 9 then `0010` stays on the owner-review tables and becomes version 10. `0010` then `0009` keeps version 10 and creates `owner_review_authority` at `r2`.
- A missing binding with `RATINGS_DB_REQUIRED` fails closed. Without that variable the caller stays on the objects. Dropping `ratings_view` after the tables exist fails closed.
- `applyDecision` returns `apply` for version 8 and version 9 when the prerequisite holds and the ratings tables are absent, `already_applied` when version is at least 10 and the four tables exist, and `partial_schema`, `schema_unexpected` or `published_prerequisite` otherwise.
- Import while `mode` is `r2` builds `ratings_view`: watched `1`, and an explicit null rating with `rating_known` 1. `routeRead` stays unhandled until the marker is open. Activate holds. A compare-and-swap during the hold throws `ratings_domain_not_authoritative`. Release returns `r2`. A later seal makes `routeRead` return the D1 body when R2 holds a conflicting object.
- The view overlay strips an R2 `actualRating` of 9, keeps the prediction fields, records watched true with an explicit null rating, keeps an out-of-watchlist alias, and leaves a fingerprint on another id untouched.
- A removal-queue reference resolves without a watched field. `recordFilmFacts` with watched false and rating 4 writes D1 and does not write the R2 fact or the view index. `confirmedFilmRating` returns 4. An owner watched mark of false on a typed movie id is stored. The conflicts document round-trips. A run checkpoint with `diaryPagesRead` 0 and a failed diary outcome survives a second insert and a bad etag. `projectView` keeps an out-of-watchlist row at watched true and `actualRating` null. Revert returns the marker to `r2`. Seal on `r2`, and import without `confirm`, are refused.

## What this does not show

Production D1 was not measured. Worker `batch` atomicity on Cloudflare was not measured. No live fact, diary, run or queue object was imported. The marker was not set to `d1` on `iptv`. `0010` was not applied. Counts of facts and queue rows are not claimed. The local suite and the Worker build are not a production read-back.
