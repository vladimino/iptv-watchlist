# AIR-374 CI shard recalibration after the shard times drifted past the gate (14 Nov 2026)

**Captured:** 2026-11-14, from the logs of ten successful CI/CD runs created between 00:25 and 01:46 UTC (30 shard jobs, 411 test files); compared with the recorded `Run tests` durations of the CI/CD runs of 13 Nov 2026 from 17:00 UTC. **Method:** read-only GitHub Actions API and job logs; per-file times from the runner's `ok  <file> (<s>s)` lines; a local re-plan of the shards with the repository's own `planTests`. No production access, no change to what any test checks.

## What drifted

`Run tests` per shard job (all CI/CD runs, failed and cancelled ones excluded, jobs under 90 s dropped):

| Window (UTC) | Samples | Median | p90 | Maximum | Over 240 s |
| --- | --- | --- | --- | --- | --- |
| 13 Nov 17:00-21:00 | 100 | 149 s | 186 s | 202 s | 0 |
| 13 Nov 21:00-23:00 | 57 | 142 s | 180 s | 187 s | 0 |
| 13 Nov 23:00 to 14 Nov 01:00 | 41 | 172 s | 205 s | 229 s | 0 |
| 14 Nov 01:00-01:50 | 26 | 190 s | 247 s | 309 s | 7 |

The number of test files went from about 400 to 417 in that period; the added files include the two halves of the S4-4 driver mutation test, the reader and synthetic-measurement tests and the schema 22 tests.

## What the per-file logs show

- **The suite is dominated by mutation files.** 34 mutation files take 1,418 s of a mean 3,333 s of summed file time (43%); the two S4-4 driver halves alone take 329 s (10%). The 25 slowest files are 53% of the suite.
- **The same file set runs at very different speeds.** The summed file time of the whole suite over the ten runs ranges from 2,869 s to 3,868 s (a factor of 1.35). For one shard the same 136 files took 870 s in one run and 1,482 s in another (walls 150 s and 257 s). A shard whose mean wall is about 190 s therefore reaches 240 s on a slow runner without any change of code. The 7 samples over 240 s in the last window sit on the slow runs.
- **The shards were not balanced by the measured cost.** With the CI means of the ten runs, the previous plan predicted a summed file time of 971 s for shard 1 and 1,177 s and 1,185 s for shards 2 and 3 (about 21% apart), against an allowance for shard 1 of about 5% (the build and documentation check outside `Run tests`). Shard 1 had 30 to 80 s of headroom while shards 2 and 3 were the ones over the gate.
- **The local estimates were off.** `canonical-producer-driver-mutation-b.mjs` averages 180 s and `canonical-producer-driver-mutation.mjs` 149 s in CI against about 65 s each alone, because the mutation files compete for the four vCPUs.

## What this change does

`scripts/run-tests.mjs`: every `WEIGHTS` entry is replaced by the mean share of its job's summed file time (scaled to 630, the method of the 12 Nov recalibration), the two serial-only files keep their solo-time weights, and `FIRST_SHARD_OFFSET` (33 to 20) and `FIRST_SHARD_HEAVY_CREDIT` (60 to 100) are refit on the same data. No test file, no mutation count and no assertion changes; every file still runs exactly once in exactly one shard.

Predicted shard load with the CI means (summed file time, predicted wall at 5.8 files-seconds per second, shard 1 with 9 s of build and documentation check):

| | Shard 1 | Shard 2 | Shard 3 |
| --- | --- | --- | --- |
| Previous plan | 971 s / 176 s | 1,177 s / 203 s | 1,185 s / 204 s |
| This plan | 1,062 s / 192 s | 1,116 s / 192 s | 1,155 s / 199 s |

Hold-out check (weights fitted on half of the runs, the plan evaluated on the other half): the largest predicted shard wall falls from 226 s to 213 s on one half and from 196 s to 191 s on the other. The prediction is a model, not a measurement: CI is the measurement.

## What this change does NOT do

- **It does not make the 240 s gate reliable.** The gain is about 5 to 13 s of the largest shard. A shard at a mean wall of about 195 s still exceeds 240 s when the runner is 1.23 times slower than the mean, and the slow runs of the last window were 1.3 times slower or more. Reaching the gate on a slow runner needs the mean-speed wall near 178 s, about 7% less total work after balancing.
- It does not reduce the total work, add a shard or change the gate. The owner decisions of 13 Nov 2026 (three shards, 240 s per shard) stand. Reducing the CPU cost of the mutation files, or a fourth job, is a separate decision.
- It does not claim a cause for the runner-speed differences, which were not investigated.

## Verification still owed

Several CI runs of this change with the `Run tests` step of each shard recorded. A single run proves little here: the same file set varied by a factor of 1.35 between runs.

Related: [recalibration of 12 Nov 2026](test-suite-air-374-ci-weights-recalibration-2026-11-12.md), [the 240 s gate](../../process/agent-workflow.md).
