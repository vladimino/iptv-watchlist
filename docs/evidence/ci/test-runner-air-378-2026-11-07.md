# Test runner: profile and bounded parallel execution (AIR-378)

Dated 2026-11-07 (UTC). Offline measurements on the repository only. **No production read or write, no Cloudflare setting and no network call was made.** The CI baseline is quoted from the GitHub Actions job steps cited on the card; the CI "after" numbers are added below once the PR run exists.

## Baseline

| Where | `Run tests` | `Test and build` | Source |
| --- | ---: | ---: | --- |
| GitHub Actions, 11 green runs on 2026-11-07 (Node 20) | 410 to 478 s, median about 454 s | 434 to 501 s | job steps of runs [42404448850](https://github.com/vladimino/iptv-watchlist/actions/runs/42404448850), [42403429158](https://github.com/vladimino/iptv-watchlist/actions/runs/42403429158), [42407267104](https://github.com/vladimino/iptv-watchlist/actions/runs/42407267104) and the other eight |
| Local, one file at a time (Node 22.23.4, 4 CPUs) | 401.6 s for 239 files | n/a | per-file timing of the previous runner's behaviour |

`npm ci` takes 4 to 5 s, `npm run build` 0 to 1 s and the bundle 2 to 3 s, so the time is in the tests. The CI job has `timeout-minutes: 10` (600 s): the baseline used 73 to 84% of it.

## Profile of the sequential run

239 files, 401.6 s. The time is concentrated in a few files:

| Files | Count | Summed time |
| --- | ---: | ---: |
| under 0.5 s | 178 | 24.1 s |
| 0.5 to 1 s | 16 | 11.8 s |
| 1 to 3 s | 16 | 28.8 s |
| 3 to 10 s | 19 | 110.2 s |
| 10 s and over | 10 | 226.6 s (56%) |

| Slowest files | Time |
| --- | ---: |
| `generation-stage.mjs` | 60.7 s |
| `discovery-chunk-budget.mjs` | 41.4 s |
| `discovery-production.mjs` | 30.2 s |
| `d1-enrichment.mjs` | 19.8 s |
| `epg-r2-known-length.mjs` | 15.4 s |
| `discovery-authority.mjs` | 14.4 s |
| `local-dev-smoke.mjs` | 12.4 s |
| `prediction-domain-production.mjs` | 11.3 s |
| `film-person-authority.mjs` | 11.1 s |
| `d1-backfill.mjs` | 10.1 s |

The ten slowest files are 56% of the time and the longest alone is 60.7 s, so with N workers the wall time cannot go below that file: starting the slowest files first matters.

## Isolation audit

Every test file stays in its own Node process. The audit of `tests/*.mjs` for anything two processes could share:

| Resource | Finding | Decision |
| --- | --- | --- |
| Listening ports | Seven files bind a local HTTP server on port `0` (an ephemeral port, no fixed port). `local-dev-smoke.mjs` probes a free port, closes it, then starts Wrangler on it and waits for it to be free again between two boots: another process could take it in between. | `local-dev-smoke.mjs` is serial-only; the others run in parallel |
| Temporary directories | 59 files use `fs.mkdtemp`; the others use the process id in the name. No fixed shared directory is written. | parallel |
| Fixed paths | `/tmp/iptv/discovery.sqlite`, `/tmp/iptv/cloud.sqlite` and `/tmp/reviews.json` appear only as arguments to scripts that must refuse them (`status 2`); they are never created. | parallel |
| Repository files | Tests only read `build.mjs`, `src/` and `public/`; none writes `dist/` or any tracked path (checked after every full run below with `git status`). | parallel |
| Environment and working directory | No test changes the working directory; children get their own environment. | parallel |
| Wall-clock thresholds | One file asserts a duration (`catalog-d1.mjs`, 20 reads under 5 s, normally well under 1 s). | parallel; watched in the repeat runs |
| Child processes | `sqlite3` and `node scripts/...` run to completion inside the file. `local-dev-smoke.mjs` starts a detached Wrangler and stops it in `finally`. | parallel except the one above |

The runner starts each file as the leader of its own process group and kills that whole group on timeout, on exit and on interruption, so no grandchild survives a file.

Pre-existing, unchanged and out of scope: some tests leave directories behind in the system temporary directory (`air319-*`, `air320-*`, `iptv-seal-restart-*`; some are many hours old). The names are unique, so it is not a race, but it is untidy.

## Result (local, 4 CPUs, Node 22.23.4)

| Mode | Wall time | vs one at a time | Files run | Failures |
| --- | ---: | ---: | ---: | ---: |
| one at a time | 401.6 s | baseline | 239 | 0 |
| 4 at a time, name order | 142.3 s | -64.6% | 239 | 0 |
| 4 at a time, slowest first, run 1 | 133.3 s | -66.8% | 240 | 0 |
| 4 at a time, slowest first, run 2 | 129.3 s | -67.8% | 240 | 0 |
| 4 at a time, slowest first, run 3 | 136.3 s | -66.1% | 240 | 0 |
| 2 at a time, slowest first | 215.0 s | -46.5% | 240 | 0 |

The 240th file is the new `tests/run-tests-runner.mjs`. Summed file time rose from 401.6 s to 488 to 513 s at four workers (CPU contention, about +20 to +28%), which the wall time absorbs. After every full run `git status` showed no change outside the two files of this change. The default is `min(4, CPUs)`: a 2-CPU runner gets 2 workers, which the 2-worker row shows is still -46.5%.

## Limits of this evidence

- Local timing is on Node 22 and a 4-CPU machine; CI uses Node 20 and a runner whose CPU count depends on the repository's runner type. The CI "after" figures are the comparable ones and are recorded below.
- Four parallel and one 2-worker run are a small sample. No flake was seen, and the file with a wall-clock assertion passed every time.
- The target of the card (median `Run tests` down at least 40%, about 270 s or less) is judged on the CI figures, not on these.

## Failure behaviour (covered by `tests/run-tests-runner.mjs`)

A non-zero exit, a signal and a timeout each fail the run and name the file with its exit code, signal or time limit and its full stdout and stderr. The runner starts no new file after the first failure, lets the files already running finish and counts the files it did not start. `--serial` restores the previous behaviour, one file at a time in name order. Bad `--jobs` or `--timeout-ms` values are refused with status 2 before any file runs.
