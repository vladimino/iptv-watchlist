# AIR-368: offline evidence of the automatic localization source model

**Captured:** 2026-11-07 (UTC). **Method:** offline tests on a D1 stand-in over the sqlite3 CLI (`tests/localization-sources.mjs`), the full `npm test` and `npm run build`. No production read or write, no schema apply, no flag, no R2 access. Nothing here measures production behavior, latency, row counts or parity.

## What was verified

- **Migration `0014`.** It refuses a database below a complete version 13 (versions 12, 11 and 9 tested) before it creates a table, creates two empty tables, writes no row and leaves the `0013` marker at `r2` / `open` / generation 0. The tables refuse a source of `owner`, `dictionary` or `reviewed`, a malformed source token, an empty value, invalid JSON provenance and an entity that does not exist.
- **Precedence.** `resolveLocalization` returns owner > reviewed dictionary > automatic. A source row observed in 2099 does not beat an owner or reviewed value; a blank owner value is not an owner value; the automatic tier is ordered by the fixed source order, then the newer observation, then the source name, independent of input order. Values held back are reported, not written.
- **Inconsistent input.** Automatic candidates with an empty value, a reserved or malformed source, unparsable provenance, or provenance claiming `owner`, `dictionary` or `reviewed`, are rejected and never promoted, in the pure resolver, the compare adapter and rows read from D1.
- **Compare-only adapter.** A late `metadataSync` value against an owner or reviewed value is `held_by_owner` / `held_by_reviewed`; equal is `same`; a reviewed or owner value is `not_automatic` and never a candidate; nothing is written.
- **Fenced writer.** Refuses in legacy, `r2`, `prepared` and `held` (zero rows written) and answers `localization_source_unavailable` at schema 13. When `open`: one batch, entity revision moved by one, a lost revision is `film_person_revision_conflict`, a marker that moved to `held` between the read and the write is `film_person_fence`, a missing entity is refused, a stale or equal observation is skipped, a newer one replaces the value, and a replay with the same request id and content opens no batch while other content under the same id is `localization_replay_mismatch`.
- **One instant ordering (review fix).** `observed_at` is stored as normalized UTC and the table refuses any other text; input is ISO 8601 with an offset or is refused. Tested: an older instant with a lexically greater offset form is stale, a newer one with a lexically smaller form wins, the same instant under another offset is stale (or a replay under the same request id), a concurrent newer write between the preflight and the batch is not overwritten, and a Film merge keeps the later instant either way. Removing the normalization, the input check, the CHECK, the JS comparison or the SQL guard each fails the test.
- **Merge.** A merge adopts the retired Film's source rows (the survivor keeps its own row of a shared source unless the retired Film observed it later), leaves none on the retired id, and a retired id takes no new rows; before schema 14 a merge behaves as in AIR-367.
- **Reads.** `readLocalization` needs the marker `open`; `held` throws `film_person_held` and `prepared` is not a D1 read authority. Reads are chunked by 80 ids, two queries per chunk. No R2 binding is touched.
- **Inactive.** No source file imports `localization-sources`, the build and package files do not name it, and the projector's writer `src/canonical-repository.js` is unchanged and does not write the source tables.

## Scenarios available now and later

Available now: all of the above. To repeat later: producers calling the writer with generation fencing, competing producers and unknown commit results (AIR-371); the bulk read model with owner precedence on every D1 consumer (AIR-372); counts and parity of source rows against `titles.json` / `people.json`, owner reviews and the frozen mirrors (AIR-373); the handoff and a natural owner edit surviving refresh and cron (AIR-374).

## Not verified

Production behavior, source counts, the real mix of provisional and reviewed rows, owner-review parity and the disposition of the R2 mirrors. A production `SELECT` needs separate permission, and no GET with a possible write is used.
