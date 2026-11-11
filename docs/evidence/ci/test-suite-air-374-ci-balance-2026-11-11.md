# CI shards balanced by weight, and three heavy test files cheaper (AIR-374)

Dated 2026-11-11 (UTC). Offline measurements on the repository and the job logs of GitHub Actions runs [43061461282](https://github.com/vladimino/iptv-watchlist/actions/runs/43061461282) (PR 530) and 43064082449 (PR 533). **No production read or write, no Cloudflare setting and no network call was made.** Test infrastructure only: no Worker code, no assertion, no mutant and no scenario was removed or skipped.

## Baseline

| Run | Shard | `Run tests` wall | Summed file time | Slowest files |
| --- | --- | ---: | ---: | --- |
| 43061461282 | 1 of 2 | 116.9 s | 655 s | `discovery-decisions-read` 58 s, `epg-r2-known-length` 44 s, `film-person-cutover-record-mutation` 35 s |
| 43061461282 | 2 of 2 | 190.6 s | 1134 s | `generation-stage` 169 s, `film-person-connector-mutation` 139 s, `generation-stage-withheld` 101 s, `film-person-prepared-loader-mutation` 88 s, `discovery-chunk-budget` 58 s |
| 43064082449 | 2 of 2 | 179.3 s | n/a | `generation-stage` 159 s, `film-person-connector-mutation` 130 s, `generation-stage-withheld` 92 s |

The runner speed varies about 2x between runs (shard 2 took 104 s on another run), so the target is margin, not a single number. The two shards differed by 480 s of summed file time because the split was by position in the plan, not by cost.

## What changed

- `scripts/run-tests.mjs`: `START_FIRST` is replaced by `WEIGHTS` (approximate seconds on a slow runner for the heaviest files, 2.5 s for any other). Files start heaviest first and are dealt greedily to the shard with the least weight so far. The split is deterministic, does not depend on which shard asks, and every file is still in exactly one shard. Shard weights: 918.5 and 920 before the later weight edits. A missing or stale name changes wall time only. `tests/run-tests-runner.mjs` now asserts weight balance, that the two heaviest files are in different shards, heaviest-first order and a stable split, instead of equal file counts and alternation.
- `tests/film-person-connector.mjs` and `tests/film-person-connector-mutation.mjs`: section 3b of the connector test (its own fixture, a third of the file) is skipped with `CONNECTOR_SKIP_3B=1`. Each connector mutant first runs without it and runs the whole file before it is called a survivor; the five mutants that only 3b kills are marked `full`. The control always runs the whole file. All 123 mutants were killed with no fallback run needed.
- `tests/generation-stage-lib.mjs`: `dump()` returns, per final table, the row count and the sqlite `sha3_query` digest of `SELECT * ORDER BY 1..n` (a total order over all columns, with value types and NULLs) instead of 650 MB of JSON lines. Two databases give the same digest exactly when they hold the same rows, so every `deepEqual` between dumps keeps its meaning; a failure names the table and its row count. It is used by `generation-stage`, `generation-stage-withheld` and `generation-stage-faults`.
- `tests/canonical-film-writers.mjs` and `tests/canonical-film-writers-mutation.mjs`: the twelve numbered sections are guarded by `FILM_WRITERS_SECTIONS` (unset: all run). Each of the 24 mutants names the section that kills it, runs it first, and runs the whole file before being called a survivor. Every section passes alone unmutated.

## Result (local, 4 CPUs, shared machine, so only ratios mean anything)

| File | Before (wall, CPU) | After (wall, CPU) |
| --- | ---: | ---: |
| `generation-stage` | 50.2 s, 23.1 s | 35.3 s, 17.8 s |
| `film-person-connector-mutation` | 38.0 s, 97.4 s | CPU about 90 s |
| `canonical-film-writers-mutation` | 4.7 s, 10.7 s | 3.0 s, 4.4 s |

## Result (GitHub Actions)

Not known when this was written; the CI runs of the pull request are the proof. The expectation: the weight balance moves about 230 s of summed file time from shard 2 to shard 1 (shard 2 from about 1134 s to about 900 s), and the three cuts remove about 15 to 20 percent of the heaviest files, so both shards should finish near 130 s on the slow runner.

## Not changed

`discovery-chunk-budget` and `film-person-prepared-loader-mutation` were not touched: no safe cut was found in the time available. The `WEIGHTS` figures for files outside the top ten of each shard are estimates.
