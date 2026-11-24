# AIR-629: local test runs on macOS (sqlite3 3.54, `/proc`, `node:sqlite`)

Date: 2026-11-24 (UTC). Machine: the owner's Mac (Apple Silicon, macOS Darwin 27.0.0), Node 20.20.2, `/usr/bin/sqlite3` 3.54.0 (Apple), Homebrew sqlite 3.54.1 at `/opt/homebrew/opt/sqlite/bin/sqlite3` (keg-only, not on `PATH`). Baseline: clean `origin/main` `cb1fb88f`. CI (Ubuntu, Node 20, the distribution's sqlite3) was green on the same commit. Nothing here touches production.

## What was wrong

| # | Observation | Reproduction |
| --- | --- | --- |
| 1 | With sqlite3 3.54 (both shells) `sqlite3 -cmd 'PRAGMA synchronous=OFF' -bail file` reads **no standard input** and exits 0. `tests/sqlite-session.mjs` started every shell that way, so every call answered `{status: 0, stdout: ''}` and nothing ran: `tests/film-admission.mjs` failed at its first refusal check, `tests/sqlite-session-semantics.mjs` at `[{"n":1}]` vs `[{"n":0}]`. | `printf 'SELECT 42;' \| sqlite3 -cmd 'PRAGMA synchronous=OFF' -bail t.db` prints nothing, exit 0; without `-cmd`, or without `-bail`, it prints 42. |
| 2 | Apple's `/usr/bin/sqlite3` 3.54.0 does not stop at the statement that fails under `-bail`: the rest of the same input line still runs. `BEGIN;INSERT …;INSERT <duplicate>;INSERT …;COMMIT;` on one line commits the rows before and after the failed insert (the suite relies on a refused write leaving nothing behind). Homebrew 3.54.1 stops, as Ubuntu's shell does. | `printf 'BEGIN;INSERT INTO t VALUES (10);INSERT INTO t VALUES (1);INSERT INTO t VALUES (20);COMMIT;' \| /usr/bin/sqlite3 -bail x.db` → exit 1, rows `1,10,20`; the same through Homebrew's shell → exit 1, rows `1`. |
| 3 | sqlite3 3.54 prints a text that holds a control character in quote mode as `unistr('…')` and a blob as `x'…'`; its JSON writer prints a real with 15 significant digits (`0.1+0.2` as `0.3`, `1.0` as `1`) while quote mode keeps 17. `quoteToJson` (AIR-418) did not know the `unistr` form, and the semantics test compared the two writers byte for byte. | `printf "SELECT 'a'\|\|char(10)\|\|'b';" \| sqlite3 -quote :memory:` → `unistr('a\u000ab')`. |
| 4 | `tests/epg-r2-known-length.mjs` `sampleHost()` read `/proc` (Linux only) and crashed with `ENOENT` on macOS; `npm test` stops starting files after a failure, so one file ended every local core run and the pre-push hook (`npm run test:all`). | `node tests/epg-r2-known-length.mjs` → `Error: ENOENT: no such file or directory, scandir '/proc'`. |
| 5 | `tests/footer-memory.mjs` and `tests/user-read-memory.mjs` (non-functional) failed because `scripts/footer-memory-profile.mjs` imports `node:sqlite`, which Node has since 22.5; the nightly workflow pins Node 22, the Mac runs Node 20.20.2. A Node-version difference, not a macOS one. | `ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: node:sqlite` in the spawned profile. |

## What changed

- `tests/sqlite-session.mjs`: `PRAGMA synchronous=OFF` is sent as input, never as `-cmd`. Every script read from standard input is framed by `.print __SQLITE_SESSION_START__` and `.print __SQLITE_SESSION_DONE__`; a call whose start marker does not come back, or that ends with status 0 without its end marker (a well-formed script), throws instead of answering, in the persistent session and in a process of its own alike. A script whose comment or literal does not end swallows the end marker itself, so it always runs in a process of its own and its status-0 answer is accepted, as a process per call always gave. `quoteToJson` reads `unistr('…')` and `x'…'`.
- `scripts/sqlite-cli.mjs`: `sqliteCliProblem(command)` runs one script the way the harness does (`-bail`, standard input, a failing statement in the middle of a line) and names what is wrong: no input run, statements after the failure, or no error reported. `resolveSqliteCli()` tries the `sqlite3` of `PATH`, then `/opt/homebrew/opt/sqlite/bin/sqlite3` and `/usr/local/opt/sqlite/bin/sqlite3`. `scripts/run-tests.mjs` calls it once per run, puts the first shell that passes first in `PATH` for every file and names it in `IPTV_SQLITE3_VERIFIED`; without a passing shell the run stops with the reasons. A test file run alone makes the same check on its first call unless `IPTV_SQLITE3_VERIFIED` names the shell on its `PATH`.
- `tests/sqlite-session-semantics.mjs`: five shim shells (runs nothing; forwards without `-bail`; passes the check then runs nothing; prints the start marker and exits 0; forwards honestly), each first in `PATH` of a process of its own that makes one session call and one one-shot call, must get the named refusal or the answer. The quote-to-JSON comparison asserts the exact real (`0.30000000000000004`) and compares the two writers at 15 significant digits only where the shell's own JSON writer rounds; where it does not (CI), byte for byte as before.
- `tests/epg-r2-known-length.mjs`: off Linux the workerd sample is `null` with `workerdSkipped`; the functional assertions are unchanged.
- `tests/suite-gate.mjs` `nodeSqliteOrSkip(id)`: outside CI on Node < 22.5 the three production-size memory scenarios print that they were skipped and return; on CI, or on Node 22.5+, they run as before.
- `docs/runbooks/local-setup.md` (new section on the shell of the test suite and Node 22), `README.md`.

## Measurements (local, this machine)

| Run | Result |
| --- | --- |
| `sqliteCliProblem` probe | about 27 ms per shell (10 runs: 269 ms); `resolveSqliteCli()` with Apple's shell refused and Homebrew's accepted: 33 ms. |
| `tests/sqlite-session-semantics.mjs` alone, Homebrew shell first in `PATH` | passes, 3.5 s wall (the five shim processes included). On Apple's shell first in `PATH` the file refuses at its first call: `kept running statements after one failed under -bail`. |
| `tests/run-tests-runner.mjs` | passes, 25.5 s wall. |
| `tests/epg-r2-known-length.mjs`, `tests/epg-path-a-feasibility.mjs` alone | pass (`workerd: null`, `workerdSkipped: "no /proc on darwin"`). |
| `tests/footer-memory.mjs`, `tests/user-read-memory.mjs` under `IPTV_TEST_SUITE=non-functional`, Node 20.20.2 | pass in 7 s and 1 s; the production-size scenarios print `skipped, node:sqlite needs Node 22.5 or later`. |
| Core suite, all 538 files, 6 at a time, Homebrew shell (ad-hoc runner without fail-fast, before the last fixes) | 378 s wall; the only failures were the three files fixed afterwards (`epg-r2-known-length`, the semantics file, and `epg-path-a-feasibility` on a non-realpath `TMPDIR` the ad-hoc runner set, which the real runner does not). |
| `git push` with the pre-push hook (`npm run test:all`) | see the pull request of AIR-629 for the hook's output on the pushed commit. |

Not measured: a Linux machine with sqlite3 3.54 (the probe would refuse or accept it the same way); Windows (the harness never supported it).
