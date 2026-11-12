# CI shard balance, mutation class dealt apart (AIR-374 P6)

Dated 2026-11-12 (UTC). Source: the job logs of two GitHub Actions runs of PR #539 at 727a98f, parsed for the `ok <file> (<s>s)` lines. **No production read or write.**

## Observed

| Run | Shard 1 `Run tests` (files, summed file time) | Shard 2 `Run tests` (files, summed file time) |
| --- | --- | --- |
| 43179499163 | 102.6 s (173, 577.9 s) | 204.9 s (174, 1203.9 s) |
| 43180054837 | 119.1 s (173, 675.0 s) | 205.6 s (174, 1207.5 s) |

The previous table gave both shards the same estimated weight (about 920), but shard 2 carried six of the seven film-person/projector files that run five to ten times slower in CI than alone (`epg-r2-known-length` 15 s alone, 134 s in CI; `generation-stage-withheld` 11 s and 108 s; `film-person-connector-mutation` 26 s and 131 s), while `generation-stage` (weighted 103) took 71 s and `discovery-decisions-read` (83) took 48 s. The per-file CI time is not a property of the file: it grows with the number of CPU-bound files that run beside it. The solo sums of the two shards were close (238 s and 212 s); the CI sums were 626 s and 1205 s.

## Change

- `WEIGHTS` in `scripts/run-tests.mjs` is recalibrated from the mean of the per-file times of these two runs (68 entries of 4 s or more; `prediction-authority-scope` is new in the table; `DEFAULT_WEIGHT` stays 0.8, the mean of the other 279 files).
- `planTests` deals the `*-mutation.mjs` files first, as a class of their own, by the same greedy longest-processing-time rule, and then the other files on top of those loads. Each shard carries about the same share of the mutation files (weight 230 against 232, six files each) and the same total weight (921 against 921). Every file still runs exactly once; no test or mutation was removed or skipped.
- `tests/run-tests-runner.mjs`: the "two heaviest files apart" assertion became "the mutation files are shared evenly and the two heaviest of them are apart".

## Predicted and measured

CI measured 0.170 to 0.178 s of wall per summed file second in all four shard jobs, so an even 921 gives about 157 to 164 s before any drop in contention; with the mutation files apart the summed time is expected to fall, but that is not measured. Local runs (4 vCPU, jobs 6) do not reproduce the CI contention and are not evidence for the 180 s gate; CI decides.
