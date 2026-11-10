# Full `npm test` back under 180 s after the AIR-373 and AIR-417 tests (AIR-418)

Dated 2026-11-10 (UTC). Offline measurements on the repository only. **No production read or write, no Cloudflare setting and no network call was made.** Test infrastructure only: no Worker code, no assertion and no scenario was removed. Card: [AIR-418](https://trello.com/c/5HEzNlvh). Previous work: [AIR-408](test-suite-air-408-2026-11-10.md).

## Baseline

| Where | Files | Wall | Summed file time | Slowest |
| --- | ---: | ---: | ---: | --- |
| GitHub Actions run [42848067999](https://github.com/vladimino/iptv-watchlist/actions/runs/42848067999) on `main` `18bf0aa`, jobs 6 | 290 | 317.0 s | not recorded here | `generation-stage` 186.9 s, `prediction-queue-budget` 136.7 s, `epg-r2-known-length` 90.0 s, `film-person-capture-mutation` 86.0 s |
| Local, `main` `e49d7ef` before this change, jobs 6 (Node 22.23.4, 4 CPUs) | 292 | 178.3 s | 688.3 s | `prediction-queue-budget` 82.4 s, `film-person-capture-mutation` 80.1 s, `generation-stage` 79.4 s, `epg-r2-known-length` 35.0 s |

A local number is only a ratio to the CI one and is never quoted as a CI result.

## Where the time went

Each of the four slowest files was run alone, with nothing else on the machine:

| File | Alone | What it waits for |
| --- | ---: | --- |
| `prediction-queue-budget` | 82.0 s | 78.5 s inside the test sqlite adapter; 55 reads `SELECT chunk_text ... FROM prediction_queue ORDER BY seq` took 74.3 s, about 1.35 s each |
| `generation-stage` | 44.7 s | 28 s of sqlite work (92 write batches of the 1.25x generations, 366 MB of SQL; 109 full dumps of the final tables, 650 MB of output) and the parsing of those dumps |
| `epg-r2-known-length` | 15.8 s | Miniflare and workerd; not changed |
| `film-person-capture` (one run) | 3.4 s | the mutation file runs it 37 times, 67 s of CPU in total |

1. **The `sqlite3` CLI writes JSON slowly when a value is large.** `sqlite3 -json` on a table of nineteen 90 KB text values (1.7 MB) took 5.9 s; the same query in `-quote` mode took 0.006 s. The CLI's JSON writer emits a large value character by character. The stored prediction queue document is exactly such a value, so every read of it through the D1 stand-in cost more than a second. Quote mode is not a general replacement: it makes one write per value, and 90,000 small rows through a pipe took 0.70 s against 0.10 s in JSON mode (540,012 `write` calls against 2,302), which made `generation-stage` slower (41 s to 64 s) when it was tried for every call.
2. **One process for three independent sections.** `generation-stage` ran the published 1.25x generation, the withheld 1.25x generation and the fault matrix in sequence; no section used another's database. Alone they take about 25 s, 12 s and 3 s.
3. **Parsing rows only to compare them.** `dump()` parsed every row of every final table and serialized it again before sorting, 650 MB over the file, to compare two databases row for row.

## What changed

- `tests/sqlite-session.mjs`: a `-json` call runs in JSON mode unless the same statement shape (the start of the script with literals removed) returned large values before in this process; then it runs as `.mode quote` with headers and `quoteToJson` turns the output into the JSON text the CLI prints. The choice changes the time of a call only. `tests/sqlite-session-semantics.mjs` checks the conversion **byte for byte** against the CLI's own `-json` output for integers, reals, large integers, the infinities, NULL, the empty string, quotes, backslashes, commas, line breaks, tabs, non-ASCII, text that looks like a number, like NULL or like a blob, a duplicate column name and no row, and runs the adaptive path end to end against a process per call.
- `tests/generation-stage.mjs` is three files with shared fixtures in `tests/generation-stage-lib.mjs`: `generation-stage.mjs` (published 1.25x), `generation-stage-withheld.mjs` (withheld 1.25x), `generation-stage-faults.mjs` (the fault matrix). Every assertion is kept: 141 `assert` lines before, 139 in the three files plus the two in the shared helpers. `dump()` compares the rows as the lines sqlite printed, sorted; two databases are equal row for row exactly when those are equal.
- `scripts/run-tests.mjs`: the scheduling hint lists the new files. No runner contract changed.
- Not changed: `film-person-capture-mutation` (all 37 mutants are still killed), `epg-r2-known-length`, the job count (6), every threshold.

## Result (local)

| Where | Files | Wall | Summed file time | Slowest |
| --- | ---: | ---: | ---: | --- |
| Local, this change, jobs 6 | 295 | 106.6 s | 577.3 s | `film-person-capture-mutation` 71.8 s, `generation-stage` 43.7 s, `epg-r2-known-length` 26.8 s, `generation-stage-withheld` 23.5 s |

Files alone: `prediction-queue-budget` 82.0 s to 5.8 s; the three `generation-stage` files 25.0 s, 12.1 s and 2.9 s (44.7 s as one file).

## Result (GitHub Actions)

The runs on the pull request are recorded in the pull request and on the card: the acceptance is three complete runs on one final HEAD, each `Run tests` step at most 180 s.

## For new heavy tests

- Use `tests/d1-standin.mjs` or `sqliteSync` from `tests/sqlite-session.mjs`, never a `sqlite3` process per statement, and build a migrated database once and copy the file.
- A test that reads a large stored document needs nothing special: the adapter learns the statement shape. A test that starts `sqlite3 -json` itself on large values pays seconds per megabyte.
- Independent sections that each build a large fixture belong in separate files, so the runner can run them side by side; list a file that takes more than about ten seconds in `START_FIRST`.
- Compare large row sets as text, not as parsed objects.
