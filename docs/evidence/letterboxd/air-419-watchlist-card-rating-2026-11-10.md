# AIR-419: confirmed rating missing on the main watchlist card (offline)

**Date:** 2026-11-10  
**Scope:** Offline reproduction against `main` at the AIR-419 branch; synthetic D1 ratings domain, in-memory R2, watchlist card HTML. No production Worker, Ratings run, EPG, D1 or R2 write.  
**Trello:** [AIR-419](https://trello.com/c/qjiztPZn)

## Symptom (owner, production)

Watchlist card for Toy Soldiers (1991) showed only «Прогноз 4.0». Ratings run `c58be457-14f2-45a4-82a8-7fc3331b95e7` applied Diary `1Vuo` / TMDB `10750` at 3.5★ the same afternoon (17:01 Madrid). «Александр» on the same page showed both badges. Events log was already truthful (AIR-393). Catalog `/film/tmdb_…` and AIR-379 removal events are out of scope.

## Method

1. Read `overlayView`, Diary `applyDiaryEvidence`, watchlist `film.id` (Letterboxd lid), and `public/app.js` card/`recommendation`.
2. Offline path: watchlist scan + Diary 3.5 on lid `1Vuo` with verified TMDB `10750` → D1 `ratings_view` → `GET /api/enrichment/view` → `card()` HTML. Fillers above one overlay page. A truncated unbounded `.all()` (first 1000 rows, no `LIMIT`) as a stand-in for a complete-table read that D1 does not guarantee.

## Root cause

Three stacked presentation gaps, none of them a missing D1 fact:

1. **Diary first write.** `applyDiaryEvidence` called `recordObservations` with `{letterboxd: lid}` only. When the link index already pointed at `tmdb-<n>` but the film document did not yet exist, `emptyRecord` stored `links.tmdb: null`. `projectionIds` then wrote `ratings_view` under the lid alone. A later watchlist/import record already holding both aliases was fine; a Diary-created document was not.
2. **Overlay read.** `overlayView` issued `SELECT … FROM ratings_view` with no keyset. Prediction overlay already pages at 300. A truncated complete-table read strips personal fields from every view-index key and then applies only the returned aliases: a lid with a prediction and no returned row keeps the forecast and loses the rating — the owner’s screenshot.
3. **Card lookup.** The main card read `enrichment.films[film.id]` only. Watchlist `id` is the lid; the overlay also adds `tmdb_<n>`. Split keys (prediction on `1Vuo`, rating on `tmdb_10750`) showed only the forecast.

Titles and years were not used. Alias conflict stays a refused link, not a merge.

## Fix (code)

- Diary observation writes include `tmdb` when the fact key is `tmdb-<n>`.
- `overlayView` reads `ratings_view` in pages of 300, refused above 20 000 rows.
- Watchlist card/`recommendation` use the lid entry and, when that entry has no numeric `actualRating`, the same film’s stored `tmdbId` as `tmdb_<n>`. Disagreeing numeric ratings on those two keys are not shown.

`GET /api/enrichment/view` remains query-only. No new ADR: the ratings marker and projection contract are unchanged ([ADR 0084](../../adr/0084-d1-authoritative-ratings.md)).

## Result

`tests/watchlist-card-rating.mjs`: 3.5 and forecast 4.0 on the `1Vuo` card, both aliases in the view DTO, paging past 1 000 truncated rows, lid-only, conflict, watched-without-rating, rating update, unrated, stale prediction, split keys, and a second GET with no R2/D1 write.

## Limits

Production `ratings_view` row counts and the live Toy Soldiers card were not re-read in this session. Acceptance still needs independent review, PR CI, both post-merge jobs, and a read-only production check after deploy. This report authorizes no Ratings, EPG, flag, Task or repair write.
