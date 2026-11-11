# AIR-374 P4b: marker-gated fail-closed titles.json readers (programme, watchlist), slice 2, offline tests

**Captured:** 2026-11-11, local runs only (sqlite3-CLI D1 stand-in on the real migration chain, Worker-scope vm). No production, R2, D1, Cloudflare, connector or Trello access of any kind. Authority: owner decisions 3 and 4 of 11 Nov 2026 on [AIR-374](https://trello.com/c/ha7ais3w); [ADR 0099](../../adr/0099-canonical-film-person-d1-authority.md). This file holds counts only: no id, title or payload.

**Result:** code evidence only. At `legacy`, `r2` and `prepared` the two routes answer byte-identically to before (asserted against an environment with no database). It authorizes no marker move, no live probe and no production write.

## Step 1: the readers re-verified in code (origin/main `09d6113`)

| Reader | Reads | D1 has it? | Class | This slice |
| --- | --- | --- | --- | --- |
| `GET /api/programme`, `GET /api/watchlist` (`src/worker.js`) | `titles.json` (cached provisional titles) next to the independent `programme.json` / `watchlist.json` and the owner-review overlay | Yes: `film_dimension` localization (provisional) and the Film's trusted TMDB claim in `film_external_id`; the owner overlay is already D1-routed under its own marker | `titles.json`: freeze; `programme.json`, `watchlist.json`: exception | **Moved** |
| `ratingsFilmLabels` | `metadata.json` and `titles.json` | `metadata.json` is the mirror of the D1 metadata cache (`metadata_cache`); its id bridge (`catalogLidTmdb`) scans every record, so it is not one bounded read | freeze | Not moved (slice 3) |
| catalog film route optional context, catalog available route | `metadata.json` | same as above | freeze | Not moved |
| `src/admin/read.js`, `limbo.js`, `health.js` | `titles.json`, `people.json` | person and title localization present; each reader needs its own bounded shape | freeze | Not moved (slice 3) |
| `metadataSync`, `epgSync` | write `titles.json`, `people.json`, `metadata.json` | writers | freeze (producers P3a/P3b) | Not moved |
| `src/enrichment.js` footer and global export, `admin/letterboxd-archive.js` | `metadata.json` | as above | freeze | Not moved |
| Projector input, metadata cache mirror, EPG documents, view-index retention, immutable sources and receipts | various | n/a | exception | Not frozen |

The complete list, with `class` and `moved`, is the exported `CANONICAL_READER_REGISTRY` in `src/canonical-catalog-reader.js`; a test fails if a source file names a mirror and is in neither the registry nor the documented non-readers.

## Step 2: the slice and why

The largest coherent slice with proofs is the shared title read behind the two routes: one bundled helper (`catalogTitlesFromD1`), the same gate and the same post-read marker re-check for every GET. `ratingsFilmLabels` was left out because half of it needs `metadata.json` (an unbounded id bridge), so moving only its titles half would not freeze anything; the admin readers need their own shapes.

## Tests

| File | Covers |
| --- | --- |
| `tests/canonical-catalog-titles.mjs` (new) | Marker states legacy, r2, prepared, open, held, unknown (malformed row, missing companion table, failed read) x both routes; legacy, r2 and prepared byte-identical to an environment with no database; open equals the R2 path at the same data (text equal) and the frozen mirror is not read; held and unknown are `503` before any R2 read (no R2 object touched); `prepared` to `open`, `r2` to `prepared`, `open` to `held` and held-then-reopened mid-read all `503`; one title statement for 300 Films, SELECT only, no batch, bounded statement count; the real catalogue size (more than one chunk of 1500 ids) is several bounded statements, a row in the last chunk is found and the answer equals the R2 path; the 20000-Film runaway cap fails closed; deterministic route-level races block the owner-review read and the `sync.json` read and move the marker (prepared to open, r2 to prepared, open to held, held to open at a new generation): always a 503, never a stale 200, on both routes, plus the empty watchlist answer; a failing or malformed D1 read is `503`; registry shape, completeness scan, route wiring and bundle assertion. |
| `tests/canonical-catalog-titles-mutation.mjs` (new) | 31 mutants (15 helper, 16 route) all killed; the unmutated copies pass. |
| `tests/canonical-catalog-reader-mutation.mjs` | One mutation text made unique (the new helper repeats a comparison); 41 mutants still killed. |
| `tests/get-write-audit.mjs`, `tests/get-side-effects.mjs`, `tests/catalog-film.mjs`, `tests/canonical-catalog-reader.mjs` | Unchanged and green. |

## Named differences from the R2 path

A Film that D1 holds only under a redirect, or a provisional row with no trusted, non-conflicting TMDB claim, gets no cached title (the document's own title stays); on a consistent projection the R2 row would not have applied either (it needs a matching `tmdbId`). Reviewed rows are not fed as cache titles (reviewed titles come from the dictionary and the owner overlay, applied by the existing code). On the fixture the outputs are equal.

## Not proved

Not run against production or the real marker; byte-equality is on fixtures. A move between the last marker read and the send of the answer cannot be excluded. The helper does not prove that the production D1 localization rows equal today's `titles.json` (that is the differential harness of P6). The catalogue size (about 9.3k confirmed Films, about 6.7k in the programme window, figures given by the Controller, not measured here) is handled by chunking: about 5 statements; only a document above 20000 Films is refused.
