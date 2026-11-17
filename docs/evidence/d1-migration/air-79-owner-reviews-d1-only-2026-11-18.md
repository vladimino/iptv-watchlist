# AIR-79 owner reviews D1-only slice (ADR 0162), 18 November 2026

**Trello:** [AIR-79](https://trello.com/c/485tlGLA). **Decision:** [ADR 0162](../../adr/0162-d1-only-authority-retire-rollback-toolchain.md). **Captured:** 18 November 2026 (UTC). First per-domain slice of ADR 0162. No production read or write was made for it; the production marker was read on 17 November ([marker read](air-79-d2-closeout-and-d1-preparation-2026-11-17.md#production-markers-read-on-17-november): owner reviews `mode` `d1`, `writes` `open`, generation 1).

## Change

| Item | Verdict |
| --- | --- |
| `importOwnerReviews`, `activateOwnerReviews`, `revertOwnerReviews`, their helpers `prove`, `countTable`, `emptyDocument`, and `scripts/owner-review-authority.mjs` | Removed |
| The mode-`r2` commit (claim `generation`, then a conditional put of `admin/owner-reviews.json`) and the `r2` branches of `readBack`, `loadSnapshotReviews`, `loadForRead` and `overlayCatalogResponse` | Removed |
| `readAuthority` | A marker in any mode other than `d1` fails closed. A schema below version 9 without the tables now fails closed unless the explicit stand-in `OWNER_REVIEW_DB_OPTIONAL=standin` is set (before, it silently kept the R2 object) |
| `commit` | Reads the authority from the whole `env`, so the explicit stand-in reaches it (it passed only `env.DB`, which hid the flag) |
| The projector's read of `admin/owner-reviews.json` in mode `r2` (`src/d1-enrichment.js`) | Removed; the projector reads owner reviews from D1 only, and the stand-in adds no overlay |
| The writer fence (`commit` refuses unless `writes` is `open`), the mirror put after a `d1` commit, the fenced `d1` read, the explicit stand-in | Retained |

## Tests

`tests/owner-review-d1.mjs` sets the marker to `d1` directly and stores documents through `commit` (the same identity classification the import used). It proves that a marker in mode `r2` is refused with no row and no R2 write, that schema v6 is refused without the stand-in and kept with it, that the writer fence refuses a held commit in mode `d1`, and that the built Worker answers 503 `owner_review_unavailable` for a marker put back to `r2` as for a dropped table. Tests of the removed functions and script are gone.

Twenty-one other files depended on the former implicit fallback: their databases stop at schema v4 or v8, or run the full chain with the seeded `r2` marker. The shared projector harness (`tests/d1-enrichment-context.mjs`) opts in to the explicit stand-in; full-chain fixtures put the owner-review marker at `d1` with no rows, which gives the same empty overlay the `r2` marker with no object gave; `tmdb-tv-runtime` and the published-EPG cutover race in `published-epg-production` pass the stand-in in their own `env`. `projector-window-r2-inventory` counts one R2 write site fewer in `src/owner-review-d1.js` and no longer lists `admin/owner-reviews.json` as a projector input.

## Verification

Local, after merging `main` and a fresh `npm ci`: `npm run test:all` passed with the core suite at 420 of 420 files and the non-functional suite at 40 of 40; `npm run build` clean. Six test files (`filters-window`, `names`, `sources`, `synopsis`, `titles`, `unscheduled`) fail when run alone on `main` too (they need the runner's fixtures) and pass in the suite. The changed Mermaid figure in `docs/architecture/film-person-lifecycle.md` is checked on GitHub after the push; the result is in the pull request.
