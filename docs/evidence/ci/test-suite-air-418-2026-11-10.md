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
- `tests/film-person-capture.mjs` and `tests/film-person-capture-mutation.mjs`: the mutation file ran the whole capture test once per mutant (37 runs, 67.1 s one after another). Two changes, no assertion removed (193 `assert` calls before and after, plus two that check the section selection):
  - the pure `verifyDerived` cases (no database, no bucket) run first, so their mutants are killed in a fraction of a second (67.1 s to 44.6 s);
  - the capture test's 21 independent blocks are numbered sections; with `CAPTURE_SECTIONS` unset every one runs, as before. Each mutant names the section that kills it and is run against that section first. **A mutant that passes its section is run against the whole file before it is called a survivor**, so a wrong or stale section number costs time and never hides a survivor (checked by giving one mutant a wrong section: it was still killed, by the whole file, and the output said so). The section of each mutant was found by running every mutant against every section. All 37 mutants are killed; the file takes 8.9 s alone.
- `tests/get-write-audit-lib.mjs`: a probe that wrote nothing to D1 (no write statement and an unchanged file hash) leaves its database copy as the template, so the next probe of the scenario reuses the copy and its `sqlite3` process; any D1 write retires the copy. The audit takes 4.6 s alone instead of 6.7 s, with the same findings.
- `scripts/run-tests.mjs`: the scheduling hint lists the new files. No runner contract changed.
- Not changed: `epg-r2-known-length`, the job count (6; 5 and 4 were measured locally on the changed suite at 115.8 s and 125.4 s against 106.6 s), every threshold.

## Result (local)

| Where | Files | Wall | Summed file time | Slowest |
| --- | ---: | ---: | ---: | --- |
| Local, adapter and split only, jobs 6 | 295 | 106.6 s | 577.3 s | `film-person-capture-mutation` 71.8 s, `generation-stage` 43.7 s, `epg-r2-known-length` 26.8 s, `generation-stage-withheld` 23.5 s |
| Local, plus the `verifyDerived` order, jobs 6 | 295 | 103.8 s | 561.7 s | `film-person-capture-mutation` 55.7 s, `generation-stage` 39.6 s, `discovery-decisions-read` 27.5 s, `epg-r2-known-length` 26.2 s |
| Local, this change complete, jobs 6 | 295 | 95.4 s | 505.0 s | `generation-stage` 38.6 s, `film-person-capture-mutation` 34.7 s, `epg-r2-known-length` 25.3 s, `discovery-decisions-read` 20.4 s |

Files alone: `prediction-queue-budget` 82.0 s to 5.8 s; the three `generation-stage` files 25.0 s, 12.1 s and 2.9 s (44.7 s as one file).

## Result (GitHub Actions)

| Run | HEAD | Files | `Run tests` | Wall reported by the runner | Summed file time |
| --- | --- | ---: | ---: | ---: | ---: |
| [42856218757](https://github.com/vladimino/iptv-watchlist/actions/runs/42856218757), attempt 1 | `0d6eba8` (adapter and split only) | 297 | 150 s | 149.2 s | 851.9 s |
| 42856218757, attempt 2 | `0d6eba8` | 297 | 145 s | not read | not read |
| [42858739038](https://github.com/vladimino/iptv-watchlist/actions/runs/42858739038), attempt 1 | `dd4b793` (plus the `verifyDerived` order) | 297 | 207 s | 206.8 s | 1163.0 s |
| 42858739038, attempt 2 | `dd4b793` | 297 | 126 s | 125.3 s | 706.2 s |

| [42863138066](https://github.com/vladimino/iptv-watchlist/actions/runs/42863138066), attempt 1 | `6c8ac04` (this change complete) | 297 | 166 s | 166.0 s | 920.6 s |
| 42863138066, attempt 2 | `6c8ac04` | 297 | 201 s | 200.4 s | 1123.1 s |
| 42863138066, attempt 3 | `6c8ac04` | 297 | 156 s | 156.3 s | 860.4 s |

**The acceptance (three runs on one HEAD, each at most 180 s) is not met.** Seven runs of the changed suite: 126, 145, 150, 156, 166, 201 and 207 s (median 156 s; the baseline was 317 s). The spread is the runner, not the code: the summed file time of the same HEAD goes from 706 s to 1163 s, and in a slow run every file is slower by about the same factor (`generation-stage` 60.6 s and 106.5 s, `epg-r2-known-length` 50.7 s and 82.2 s). The wall time is the summed time divided by about 5.6 in every run, so the suite is bound by the total work, not by one long file or by scheduling: jobs 4 and 5 were slower locally, and the longest file is well under the wall time.

What remains is real work, not harness overhead: the 1.25x generations (about 40 s of sqlite and SQL text alone), Miniflare in `epg-r2-known-length`, and files whose time is simulated latency or production code (`discovery-decisions-read` hashes every decision with WebCrypto; `discovery-chunk-budget` and `run-tests-runner` wait on timers). To hold 180 s on a slow runner the work would have to fall by about another 15 %; the levers still known (comparing the 1.25x tables inside sqlite instead of through the pipe, one legacy publication less in the withheld file, seeding the large statement shapes) add up to a few percent. The measure that does not depend on the runner's speed is to run the suite as two parallel shards of the CI job; that changes the workflow and what the `Run tests` step covers, so it is the owner's decision and is not part of this change.

## For new heavy tests

- Use `tests/d1-standin.mjs` or `sqliteSync` from `tests/sqlite-session.mjs`, never a `sqlite3` process per statement, and build a migrated database once and copy the file.
- A test that reads a large stored document needs nothing special: the adapter learns the statement shape. A test that starts `sqlite3 -json` itself on large values pays seconds per megabyte.
- Independent sections that each build a large fixture belong in separate files, so the runner can run them side by side; list a file that takes more than about ten seconds in `START_FIRST`.
- Compare large row sets as text, not as parsed objects.
- A check that runs another test file many times (a mutation check) should run the part that decides, with the whole file as the fallback, as `film-person-capture-mutation.mjs` does.
