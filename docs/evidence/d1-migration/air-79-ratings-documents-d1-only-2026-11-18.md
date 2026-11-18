# AIR-79 ratings documents D1-only slice (ADR 0162), 18 November 2026

**Trello:** [AIR-79](https://trello.com/c/485tlGLA). **Decision:** [ADR 0162](../../adr/0162-d1-only-authority-retire-rollback-toolchain.md). **Captured:** 18 November 2026 (UTC). Third per-domain slice of ADR 0162, after [owner reviews](air-79-owner-reviews-d1-only-2026-11-18.md) and the [metadata cache](air-79-metadata-cache-d1-only-2026-11-18.md). No production read or write was made for it; the production marker was read on 17 November ([marker read](air-79-d2-closeout-and-d1-preparation-2026-11-17.md#production-markers-read-on-17-november): ratings `d1` / `open`, generation 4079).

## Change

| Item | Verdict |
| --- | --- |
| `importDocuments`, `activateDocuments`, `releaseHeld`, `sealHeld` and `revertMarker` in `src/ratings-d1.js` | Removed |
| `--load`, `--activate`, `--release-hold`, `--seal-hold` and `--revert` of `scripts/ratings-domain-production.mjs` | Refused with `retired` before any request; the read-only status and the schema `--apply` are retained |
| `readRatingsAuthority` | A marker in mode `r2` fails closed with `ratings_domain_unavailable` (before, it was a valid R2 authority). With `RATINGS_DB_REQUIRED=on` (production) a schema without ratings tables now fails closed too; without that variable (local development and tests) the domain is the uninstalled stand-in and reads R2, as a missing binding or schema already did |
| `readOwned`, `putOwned`, `casOwned` | A held cutover is refused with `ratings_domain_not_authoritative` for readers as well as writers (before, readers fell back to R2); writes always carry `mode` `d1` |
| `overlayView`, `viewItems` (the `ratings_view` overlays of the view index and of the catalog film page) | A held cutover is refused with `ratings_domain_not_authoritative` instead of returning the R2 view index facts unchanged (found by the independent review of the first head); an `r2` marker is refused by `readRatingsAuthority`; only the uninstalled local domain keeps its input. Their callers (`loadJSON` of the view index, `LetterboxdFacts.readJSON`, the footer, Admin health, the catalog film page) now see the same refusal as for a broken marker; the film page answers `503` |
| `readRatingsRun` | Kept as a read-only operator diagnostic: the production status command also reads the run lease of a held cutover. It is not a serving path and has no R2 fallback for an installed domain |
| `ratingsGate` | Adds `held`, so the rated-archive ZIP preview reports a held cutover as `ratings_domain_unavailable` instead of comparing against R2; the ratings orchestration keeps its own `authority_held` class |
| `LetterboxdRatings.status` | Reads the stored run only while the domain is served, so a status read under a held cutover does not throw |
| Fenced writes, the epoch and generation fences, `listDocuments`, `readRatingsRun`, `ratingsRunActivity`, ratings and removal events in R2, raw Letterboxd inputs, the schema CHECK value `r2` | Retained |

## Tests

`tests/ratings-d1.mjs` sets the marker directly and writes through `putOwned` and `casOwned`. It proves the refusal of a marker in mode `r2` (also one restored after open), the held refusal for reads, writes and compare-and-swap, the open path, the `RATINGS_DB_REQUIRED` refusal without ratings tables against the local stand-in, and that every retired operator command is refused before any request. It also proves that `overlayView` and `viewItems` refuse a held cutover and an `r2` marker given deliberately stale R2 facts, serve the D1 view when open, and keep their input only for the uninstalled local domain (and refuse it with `RATINGS_DB_REQUIRED=on`). `tests/catalog-film.mjs` section 3g proves through the Worker that the catalog film page answers `503` `ratings_domain_not_authoritative` under a held ratings cutover instead of the stale R2 rating and watched mark; both fail against the first head. `tests/letterboxd-rated-candidates.mjs` proves a held marker leaves the row unverified, does not read the R2 fact and is reported as `ratings_domain_unavailable`. Full-chain fixtures that relied on the R2 marker put it at `d1` / `open` and seed the ratings view (`tests/catalog-film.mjs`), or drop the ratings tables to stand for the uninstalled local domain (`tests/film-history.mjs`, which also asserts a `503` for a marker in mode `r2`, and `tests/get-write-audit-lib.mjs`).

## Verification

Local, after a fresh `npm ci`: `npm run test:all` on the final checkout, `npm run build`, `git diff --check`; the result is in the pull request. No Mermaid diagram changed.
