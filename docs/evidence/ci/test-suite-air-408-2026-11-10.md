# Full `npm test` back to two or three minutes (AIR-408)

Dated 2026-11-10 (UTC). Offline measurements on the repository only. **No production read or write, no Cloudflare setting and no network call was made.** The CI baseline is the run quoted on the card ([run 42800227449](https://github.com/vladimino/iptv-watchlist/actions/runs/42800227449)); the GitHub Actions results of this change are in [CI results](#ci-results-of-this-change). Continuation of [AIR-378](test-runner-air-378-2026-11-07.md).

## Baseline

| Where | Files | Wall | Summed file time | Slowest |
| --- | ---: | ---: | ---: | --- |
| GitHub Actions run 42800227449, jobs 4 (Node 20) | 280 | 323.3 s | 1196.8 s | `generation-stage` 115.0 s, `projector-bulk` 79.4 s, `discovery-chunk-budget` 73.2 s, `discovery-production` 58.0 s, `film-person-baseline` 45.9 s |
| Local, `main` before this change, jobs 4 (Node 22.23.4, 4 CPUs) | 280 | 251.7 s | 894.7 s | `generation-stage` 74.2 s, `projector-bulk` 63.5 s, `discovery-chunk-budget` 47.6 s, `discovery-production` 37.5 s, `film-person-baseline` 36.3 s |

The local run is about 0.78 of the CI run in wall time, so a local number is only a ratio to the CI one and is never quoted as a CI result.

## Where the time went

Two measurements, both on the unchanged code, found the causes.

1. **A process per SQL statement.** `tests/d1-standin.mjs` and 43 test files ran `spawnSync('sqlite3', ...)` for every statement. A preload that counts the calls gave, for one run of each file:

   | File | `sqlite3` starts | Time inside them | File wall |
   | --- | ---: | ---: | ---: |
   | `projector-bulk` | 9,912 | 60.9 s | 62.1 s |
   | `discovery-chunk-budget` | 7,061 | 34.2 s | 41.8 s |
   | `discovery-production` | 6,901 | 30.1 s | 31.7 s |
   | `film-person-baseline` | 5,927 | 30.0 s | 30.5 s |
   | `d1-enrichment-bucket-unicode` | 6,238 | 21.1 s | 24.3 s |
   | `generation-stage` | 2,029 | 37.9 s | 65.7 s |

2. **A timer nobody cleared.** `footerGuard` in `src/enrichment.js` (AIR-389) arms a 10 s `setTimeout` for each footer source and clears it in `finally`, but only when the host has `clearTimeout`. The test contexts expose `setTimeout` only, so every file that reached the footer ran 10 s after its last assertion with 0.2 s of CPU: `ratings-epg`, `get-side-effects`, `discovery-activity`, `discovery-status-memory`, `discovery-pipeline-d1-status` and others.

The remaining long files were checked the same way: `epg-r2-known-length` and `epg-orchestration` run a real Miniflare/workerd and are bound by it; `events-type-filter` waits on the 25 ms pauses of the code under test; `generation-stage` is now bound by SQLite doing the 1.25x production-scale inserts.

## What changed

- **`tests/sqlite-session.mjs`**: a synchronous `sqliteSync(args, {input})` with the shape of the `spawnSync('sqlite3', ...)` call it replaces (`status`, `stdout`, `stderr`), backed by one long-lived `sqlite3` per database file and mode, owned by a worker thread. The caller blocks on `Atomics.wait` and reads the answer with `receiveMessageOnPort`, so no test became asynchronous. It needs only Node 20 APIs (CI stays on Node 20; no `node:sqlite`, no new dependency). The semantics are kept by construction: the same engine and `-bail` rule (a failing script makes the CLI exit, reports its status and stderr, and the next call has a fresh connection, so an unfinished transaction is rolled back as before); scripts that could leave state in a shared connection (a PRAGMA other than `foreign_keys=ON`, ATTACH/DETACH, TEMP objects, VACUUM, dot-commands, `BEGIN` without `COMMIT`, an in-memory database) run in a process of their own as before; a deleted or replaced file gets a new connection (device and inode are checked on every call); a script whose last statement has no `;` is closed with one before the marker line; **foreign-key enforcement is per connection and a fresh process starts with it off, so every call starts with `PRAGMA foreign_keys=OFF` and the script's own `PRAGMA foreign_keys=ON` applies to that call only** (review of `233db96`: a call that enabled it had left it on for the next call); scripts that read `last_insert_rowid()`, `changes()` or `total_changes()` or open a `SAVEPOINT` that is not released run in a process of their own. [`tests/sqlite-session-semantics.mjs`](../../../tests/sqlite-session-semantics.mjs) is the contract; five mutations of the helper (no closing `;`, no inode check, no `BEGIN` rule, no PRAGMA rule, no foreign-key reset) each fail it, including the sequences PRAGMA ON then none, none then PRAGMA ON, ON twice and ON, none, ON, each compared call by call with an independent fresh-process baseline.
- **`tests/d1-standin.mjs` and 43 test files** call it instead of starting a process. `scripts/offline-import.mjs` `openSqlite(file, {runner})` takes an optional runner (tests only; without it nothing changes) and the five tests that use it pass the session.
- **`src/enrichment.js` `footerGuard`** unrefs the timer when the host cannot clear it. Behaviour in the Worker (which has `clearTimeout`) is unchanged.
- **`scripts/run-tests.mjs`**: the default is `min(6, ceil(1.5 x CPUs))` files at a time instead of `min(4, CPUs)`, and the start-first list follows the new slowest files. `--jobs`, `--serial`, the per-file timeout, signal handling, failure propagation and the serial-only file are unchanged.
- No assertion was removed or weakened and no scenario was dropped. `generation-stage` keeps its 1.25x production-scale legacy/staged row-for-row parity, size and statement bounds, interruption/resume, lost/after-500, atomicity, stale-pointer, ownership, receipt, mutation and cleanup cases. No production algorithm changed.

## Result (local, 4 CPUs, Node 22.23.4)

Same machine, same method, per file at `--jobs 4`:

| File | Before | After |
| --- | ---: | ---: |
| `generation-stage` | 74.2 s | 61.3 s |
| `projector-bulk` | 63.5 s | 29.7 s |
| `discovery-chunk-budget` | 47.6 s | 24.5 s |
| `discovery-production` | 37.5 s | 14.9 s |
| `film-person-baseline` | 36.3 s | 14.7 s |
| `d1-enrichment-bucket-unicode` | 29.6 s | 8.6 s |
| `discovery-decisions-read` | 24.7 s | 20.5 s |
| `d1-enrichment-buckets` | 24.4 s | 8.4 s |
| `d1-enrichment` | 22.1 s | 10.7 s |
| `d1-enrichment-stored-pages` | 21.9 s | 7.4 s |
| `d1-enrichment-fairness` | 18.6 s | 7.5 s |
| `discovery-pipeline-d1-status` | 16.5 s | 2.7 s |
| `get-side-effects` | 10.4 s | 0.2 s |

| Run | Wall | Summed file time |
| --- | ---: | ---: |
| Before, jobs 4 | 251.7 s | 894.7 s |
| After, jobs 4 | 138.0 s | 515.9 s |
| After, jobs 4 (with the final runner and 282 files) | 148.6 s | 560.2 s |
| After, jobs 6 | 118.7 s | 655.7 s |
| After, jobs 8 | 114.6 s | 836.2 s |
| After, default (jobs 6), three runs | 121.7 s, 127.6 s, 127.2 s | 672.8 s, 703.6 s, 702.6 s |

More jobs than CPUs help because most files wait more than they compute (timers, child processes, workerd): jobs 6 is 20% faster than jobs 4 and jobs 8 adds 3% for 25% more summed time, so 6 is the cap. Per-file times are larger at jobs 6 because the files compete for the same CPUs; the wall time is what falls.

A race found on the way (a rare `sqlite session gave no answer` in `film-person-baseline` at jobs 6) was the wake-up flag being seen a moment before the message on the port; the helper now waits for the message itself. Twenty-four runs of that file, eight at a time, then passed.

## Limits

- The local numbers are not CI numbers: GitHub's runner is about 1.28 times slower than this machine in wall time. A local 127 s corresponds to roughly 160 s on CI; only the CI runs below decide whether the card's limit of 180 s holds.
- Node 20 (CI) was not available here, so the helper was checked against Node 22.23.4 and by reading its API use (`worker_threads`, `Atomics.wait`, `receiveMessageOnPort`, all in Node 20). The first CI run on Node 20 is its real test.
- The 10 s footer timer is a bug of the test host, not of the Worker; it is removed by the unref above, not by a shorter timeout.
- Not changed, and the next levers if CI stays above the limit: `generation-stage` (about 45 to 60 s, SQLite work at 1.25x scale; splitting it in two files would shorten the tail but not the summed time), `projector-bulk`, `epg-r2-known-length` and `epg-orchestration` (real workerd), and the 25 ms pauses waited for by `events-type-filter` (10.6 s, a polling test over the application's own timers).

## CI results of this change

To be filled from the three green runs on the exact HEAD of the pull request.
