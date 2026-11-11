# Both CI test shards back under 180 s: the prepared-loader mutation check (AIR-374)

Dated 2026-11-11 (UTC). Offline measurements on the repository and the two post-merge job logs of GitHub Actions run [43030623224](https://github.com/vladimino/iptv-watchlist/actions/runs/43030623224) (`main` `1ac47ce`). **No production read or write, no Cloudflare setting and no network call was made.** Test infrastructure only: no Worker code, no assertion, no mutant and no scenario was removed.

## Baseline (GitHub Actions, `1ac47ce`)

| Job | Files | `Run tests` | Wall reported by the runner | Summed file time | Slowest files |
| --- | ---: | ---: | ---: | ---: | --- |
| `Test and build` (shard 1 of 2) | 165 | 163 s | 162.9 s | 901.0 s | `epg-r2-known-length` 75.2 s, `discovery-decisions-read` 70.1 s, `discovery-bounded-drain` 56.4 s, `film-person-cutover-record-mutation` 41.5 s |
| `Test shard 2 of 2` | 163 | 189 s | 187.9 s | 959.9 s | `generation-stage` 123.8 s, `film-person-connector-mutation` 121.8 s, `film-person-prepared-loader-mutation` 121.8 s, `generation-stage-withheld` 46.8 s, `discovery-seal-publish` 44.2 s |

Shard 2 held three files of 120 s each at once. The wall time is the summed file time divided by about 5.1 (jobs 6), so the only lever is less total work in that shard, and the two mutation checks that started late (they sit in the alphabetical tail of the plan) ended the shard after the rest.

## Where the time went

`film-person-prepared-loader-mutation` starts `tests/film-person-prepared-loader.mjs` once per mutant (73 mutants and one control). One run of that file takes 3.5 s of CPU (about 8 s on a busy machine) because it builds many databases and a 708 / 401 / 4 world for the CLI section; a mutant was killed only after every section before the one that kills it had run. Which section kills each of the 73 mutants (measured by running every section alone against every mutant):

| Section of the loader test | Mutants killed there |
| --- | ---: |
| 1 to 3 (plan, emit, apply; 0.35 s in total) | 27 |
| 4 (the fence, 1.3 s) | 8 |
| 5 (the plan refuses on any mismatch, 0.5 s) | 23 |
| 6 (bounded per run, 0.3 s) | 1 |
| 7 (accepted counts end to end, 0.8 s) | 5 |
| 8 (the sources, 0.3 s) | 5 |
| 9 (static) | 0 |
| 10 (the CLI, 2.3 s) | 4 |

## What changed

- `tests/film-person-prepared-loader.mjs`: sections 4 to 10 are guarded by `LOADER_SECTIONS` (unset: every section runs, exactly as before; set: sections 1 to 3 plus the listed ones). The helpers section 5 declares for sections 6 to 8 stay outside the guard. No assertion was changed. The probe of an output path inside the repository is removed before its assertions, so a mutant that lets the write through no longer leaves a `tmp-loader-out-*` directory in the working tree.
- `tests/film-person-prepared-loader-mutation.mjs`: the pattern of `film-person-capture-mutation.mjs`. Each mutant names the section that kills it (the last element, `0` for sections 1 to 3 only) and is run against that section first. **A mutant that passes its section is run against the whole file before it is called a survivor**, so a stale number costs time and never hides a survivor (checked by giving a mutant a section that cannot kill it: it was killed by the whole-file fallback and the output said `1 needed the whole file`). The unmutated control still runs the whole file and must pass; every section alone also passes unmutated. All 73 mutants are kept, each killed, none broken; no mutation text changed.
- `scripts/run-tests.mjs`: `film-person-connector-mutation`, `film-person-cutover-record-mutation`, `film-person-prepared-loader-mutation` and `film-person-prepared-loader` are appended to `START_FIRST`, so the slow ones start with the first files of their shard instead of in the alphabetical tail. Four entries keep the alternation even; each of the three mutation checks stays in the shard it was in (2, 1, 2), and four small files changed shard (`film-person-cutover-accepted` and `film-person-cutover-minimum` to shard 1, `film-person-connector` and `film-person-cutover-minimum-mutation` to shard 2). Counts stay 165 and 163 files.
- Not changed: `film-person-connector-mutation` and `film-person-cutover-record-mutation` themselves. Their test files are one sequential state (lease, T0, copy, T1, resync, run, T2, seal), so a section cannot be run alone; a killed mutant already stops at its first failing assertion.

## Result (local)

4 CPUs, Node 22.23.4, `TMPDIR` on a tmpfs, other sessions running on the same machine (load average 6 to 10), so only ratios between rows measured together mean anything.

| File | Before (wall, CPU) | After (wall, CPU) |
| --- | ---: | ---: |
| `film-person-prepared-loader-mutation`, alone | 30.2 s, 81.8 s | 15.0 s, 38.1 s |
| `film-person-prepared-loader-mutation`, alone, `TMPDIR` on disk and a busier machine | 144.7 s, 112.5 s | 14.7 s, 36.3 s |
| `film-person-connector-mutation`, alone (unchanged) | 33.3 s, 96.8 s | not changed |
| `film-person-cutover-record-mutation`, alone (unchanged) | 9.7 s, 26.5 s | not changed |

Full `npm test` after the change, 328 files, one process tree on the same busy machine: wall 179.7 s, summed file time 1013.8 s; `film-person-connector-mutation` 81.0 s, `film-person-prepared-loader-mutation` 54.8 s, `film-person-cutover-record-mutation` 53.7 s. This is the whole suite in one job on a shared machine and is not comparable with a CI shard.

## Result (GitHub Actions)

Not known when this was written. The CI runs of the pull request are the proof; the expectation from the numbers above is about 65 s less summed file time in shard 2 and an earlier start of the three mutation checks.

## For the next heavy mutation check

Give every mutant the section of the target test that kills it, run that section first and the whole file before calling a mutant a survivor (`film-person-capture-mutation.mjs`, `film-person-prepared-loader-mutation.mjs`). A target test that is one sequential state cannot do this; keep its mutant count to the guards that no other mutant already covers.
