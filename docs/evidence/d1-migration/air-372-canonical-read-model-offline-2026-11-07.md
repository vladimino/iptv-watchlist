# AIR-372: offline evidence of the canonical Film/Person bulk read model

**Captured:** 2026-11-07 (UTC). **Method:** offline tests on a D1 stand-in over the sqlite3 CLI (`tests/canonical-read-model.mjs`), the full `npm test` and `npm run build`. No production read or write, no schema apply, no flag, no R2 access, no GET with a possible write. Nothing here measures production behavior, latency, row counts or parity.

## What was verified

- **Marker gate.** `canonicalReaderMode` answers `existing` for legacy, `r2` and `prepared` (the current runtime stays in charge), `d1` for `open`, and throws `film_person_held` or `film_person_unavailable` for `held`, a missing marker row and other unreadable states. `readFilms` and `readPersons` refuse (`canonical_read_not_authoritative`) in legacy, `r2` and `prepared`, fail closed when `held` or unreadable, and never name R2. At schema 13 (no source table) or without `owner_review_entry` the read fails closed, because the precedence cannot be proven.
- **Bulk reads.** Films and persons are read by id set. A batch of one id and of eighty ids cost the same number of queries; 170 ids cost about one more chunk of queries, not 170 (chunks of 80, at most 200 ids per call, `canonical_read_bounded` above that; invalid ids are `canonical_read_invalid`).
- **Redirects.** A chain resolves to its survivor with the chain reported; a loop answers `cycle` and a chain deeper than 8 answers `too_deep`, neither followed; an unknown id is `null`.
- **Typed identity.** `tmdb` and `tmdb_tv` with the same number stay distinct, a conflicting holder is reported untrusted, persons stay role-specific records (`person:actor/a` and `person:director/a` are two records), credits keep role and ordinal. Nothing joins by title, year or name.
- **Precedence.** A verified owner review (`owner_review_entry`, authority `owner`) beats a late automatic source and a reviewed dictionary value; a held or unlinked review is not an owner value; an automatic value stays below a reviewed one. Film titles and person names, including the names on credits and the filmography titles, use the same resolver as AIR-368.
- **Bounded filmography.** At most 500 credit rows per call, with `truncated` set when more exist.
- **Stale generation.** A marker that moves to `held`, or goes `held` and back to `open` at a new generation, between the reads and the final confirmation refuses the whole result (`film_person_generation_moved`).
- **Read-only and inactive.** A read changes no row and issues no batch; the module contains no write statement or R2 access; no source file imports or names it, and the build files do not bundle it. `GET /api/d1/*`, Finds, the Admin, the film page and the programme/watchlist overlays are not changed.
- **Mutation checks.** Removing the marker gate, the generation confirmation, cycle detection, the owner overlay, the id cap, the filmography truncation flag, the verified filter in the mapping and the owner-domain failure each fails the test. The SQL-side `identity_state='verified'` filter alone is redundant with the mapping filter and its removal is not detected (defense in depth).

## Scenarios available now and later

Available now: all of the above. To repeat later: marker-gated route wiring on `GET /api/d1/*`, Finds, person filmography, the Admin and the film page, and the programme/watchlist localization overlays under `open` (AIR-374, after the writer handoff of AIR-371); fixture parity of the read model against the R2-derived views and a read-only `SELECT` comparison on production (AIR-373, with separate permission); owner edit surviving refresh and cron on the live system (AIR-374).

## Not verified

Production behavior, real query latency, row counts, the real mix of reviewed, owner and automatic values, and parity with the current R2-backed responses. The existing endpoints that can write on a GET (`/api/programme`, `/api/watchlist`, Admin via `repairMirrors`) were not probed.
