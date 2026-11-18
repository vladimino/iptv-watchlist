# AIR-516 started marks read the canonical D1 Film, 18 November 2026

**Trello:** [AIR-516](https://trello.com/c/03h5WhiT). **Captured:** 18 November 2026 (UTC), code reading at `main` `3cf3c18`. No production read or write was made; every check is a local stand-in.

## Cause

`setStarted` in `src/worker.js` resolved the Film of `POST /api/started` from `loadJSON(env,'metadata.json')` (the frozen R2 compatibility mirror) and then `programme.json`. After the Film/Person cutover (`d1`/`open`) a retained canonical Film outside the programme and the watchlist therefore answered a false `404 Unknown film`, and a Film present in the mirror could carry a stale title or year. The reader was not listed in `CANONICAL_READER_REGISTRY`; the [AIR-79 audit](air-79-legacy-r2-runtime-audit-2026-11-17.md) recorded it as finding F-2.

## Change

| Item | Verdict |
| --- | --- |
| `CanonicalCatalogReader.catalogStartedFilm` (new, SELECT only) | The verified identity bridge, the owner retirement ledger and the Film's localization and year; marker read before and after, generation drift refused |
| `setStarted` | Reads no `metadata.json` and no `programme.json`; every refusal is answered before the first R2 write |
| Mark and event objects | `started/<id>.json`, `customMetadata.started`, `events/items/` keys, write order and repeat delivery of `lastEvent` unchanged |
| `CANONICAL_READER_REGISTRY` | One entry added, `moved: true` |

## Answers

| State | Answer | R2 writes |
| --- | --- | --- |
| Found (programme film, retained film, lid without TMDB claim) | `200`, event with D1 title and year, `tmdb` only for a trusted claim | mark and event |
| Unknown id | `404` | none |
| Conflicting, untrusted or ambiguous claim; identity that disagrees with the claim | `409` | none |
| Redirect source or owner-retired movie id | `410` | none |
| Held, not open, unreadable or missing D1, generation moved | `503` | none |
| `unstarted` of an existing mark whose Film no longer resolves | `200`, last known `lastEvent.film` | mark and event |

## Regression

`tests/started.mjs` runs the real Worker and reader over a sqlite stand-in with the real migration chain. It asserts that `metadata.json` and `programme.json` are never read (a ghost film named only there is `404`), the D1 title wins over a contradicting frozen title, zero R2 writes for every refusal, and that the test fails on the previous code. `tests/catalog-film.mjs`, `tests/film-history.mjs`, `tests/get-write-audit.mjs`, `tests/get-side-effects.mjs` and `tests/canonical-readiness-classes.mjs` pass unchanged.

## Not done

No production write, mark, migration, flag or Task. Production acceptance is a read-only check after the deploy and the owner's confirmation.
