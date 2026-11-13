# AIR-374 M2b: the shard 3 runtime gate (180 s) and the follow-up rebalance (13 Nov 2026)

**Status (13 Nov 2026, later the same day):** superseded as a work item. The Product Owner replaced the 180 s per-shard gate with 240 s per shard as a permanent policy ([agent workflow](../../process/agent-workflow.md#test-suite-performance-quality-gate)) and withdrew the optimisation targets. The measurements below are kept as the record of the runs that led to it; nothing in them was rewritten.

**Captured:** 2026-11-13, from the retained CI logs of PR #593 (CI/CD runs 43483457532, 43486898627 and 43490089489, three jobs each, plus the Controller's recorded rerun). **Nothing was run in production.** The numbers are wall and summed file time of the `Run tests` step, read from the job logs.

## Measured (HEAD `b2ce385`, before this follow-up)

| Job | Wall (s) | Summed file time (s) | Files |
| --- | --- | --- | --- |
| Test and build (shard 1) | 160.9 | 962.6 | 134 |
| Test shard 2 | 155.1 | 862.8 | 132 |
| Test shard 3, attempt 1 | 183.3 | 1,049.7 | 134 |
| Test shard 3, attempt 2 (Controller rerun, same HEAD) | 201.7 | not recorded | 134 |

Both shard 3 attempts were over the 180 s gate. The earlier HEAD `62194bf` measured 190.5 s. The slowest files of shard 3 (attempt 1): `epg-r2-known-length.mjs` 96.8 s, `film-person-connector-mutation.mjs` 78.1 s, `generation-stage-withheld.mjs` 74.0 s, `canonical-producer-schema-mutation.mjs` 59.1 s, `film-person-capture-mutation.mjs` 57.5 s, `epg-producer-m2b-mutation.mjs` 44.3 s (50.9 s on attempt 2).

## Findings

1. **The shards were unbalanced by actual time, not by weight.** The summed file time of the three jobs was 963 / 863 / 1,050 s although the planner deals equal weight. Three producer mutation files were under-weighted by two to five times against their observed CI time: `canonical-producer-run-mutation.mjs` (weight 6, 43.8 s), `canonical-producer-schema-mutation.mjs` (weight 18, 59.1 s) and the new `epg-producer-m2b-mutation.mjs` (weight 9, 44.3 s).
2. **The M2b mutation runner paid a Node process start-up and a `src/` copy for each of its 47 mutants.** A first one-process version (commit `286672e`) looked four times cheaper (about 11 s) but was INVALID: the test kept one module-scoped temporary directory, so after the unmutated baseline had created `copy-1.sqlite` every later call met an existing file, `loadCopy` correctly refused it and the 47 mutants "died" at that stale fixture, not at the altered rule (found by the independent review of that HEAD). The corrected runner (the next commit) gives every `check()` call a fresh working directory with `try/finally` cleanup, makes the verifiers' thrown errors assertion failures, and proves itself with controls: the unmutated module passes twice in a row in the one process, a semantically neutral change survives, and every kill must be an assertion failure, not a setup error (the kill reason of each mutant can be printed with `M2B_MUTATION_REASONS=1` and was read: the refusal code or the named assertion of the altered rule). It takes about 16 s alone in one process (the cheap results-file refusal checks run first, so a mutant of a verifier rule fails early), against about 14 s of wall for four parallel processes, and about 39 s inside a full local run on six jobs; the CPU of the process-per-mutant version was not measured separately.
3. **No coverage was removed.** The suite still has 400 files and the M2b mutation runner still kills all 47 mutants.

## Change

`scripts/run-tests.mjs` weights only (scheduling): `canonical-producer-run-mutation.mjs` 6 to 25, `canonical-producer-schema-mutation.mjs` 18 to 40, `epg-producer-m2b-mutation.mjs` 9 (after 32 and 11 in intermediate commits: 9 gives the most even split when the file is planned at about 25 s), and six small adjustments found by a search that minimises the largest shard of the observed per-file times (each weight kept within a factor of two of its observed share, so the weights do not chase noise). The two serial-only files keep their solo-time weights.

## Measured after the follow-ups

| HEAD | Shard 1 wall (s) | Shard 2 wall (s) | Shard 3 wall (s) | Summed file time per shard (s) | Note |
| --- | --- | --- | --- | --- | --- |
| `62194bf` (first run) | not recorded | not recorded | 190.5 | not recorded | over the gate |
| `b2ce385` | 160.9 | 155.1 | 183.3 and 201.7 (rerun) | 963 / 863 / 1,050 | shard 3 over the gate twice |
| `286672e` (weights tuned on one run, invalid one-process runner) | 120.7 | 195.5 | 138.5 | 722 / 1,101 / 775 | the pressure moved to shard 2; the prediction of 948 / 950 / 949 s did not hold |
| `65237a4` (corrected runner) | 164.3 | 178.8 | 179.3 | 984 / 999 / 1,026 | all three under 180 s, shard 3 by 0.7 s: a margin of practically zero |

**Why the prediction failed.** The per-file times of one run are not constant: a file runs 1.2 to 1.5 times slower in a heavy shard and up to twice as fast in a light one (for example `discovery-decisions-read.mjs` 54.7 s in shard 1 and 83.5 s in shard 2, `prediction-batch-start.mjs` 52.3 and 73.1 s). Equalising the sum of the times of one run therefore does not equalise the next run; shares of a job's own total hide the absolute scale and cannot show it either. What the three shards had in common at `65237a4` is about 3,000 s of summed file time for 180 s of wall: the suite is at the capacity of three shards, and rebalancing cannot lower it.

**The corrected M2b mutation runner** measured 45.9 s in the CI run of `65237a4` (about 16 s alone locally, 39 s in a full local run); a later commit builds the seeded fixture once per process and brings it to about 12 s alone. In CI the runner remains one of the files that compete for the CPU.

## Limits

- The per-file times come from one run (three jobs) plus the Controller's second shard 3 attempt, not from the 30-job mean of the earlier recalibration.
- The margin under the gate is practically zero at `65237a4` (0.7 s in shard 3); a slower runner (the second attempt of `b2ce385` was 10 percent slower than the first) exceeds it. The result of the commit that follows is a further data point, not a proof of stability.
- If the gate is exceeded again, the options that keep all coverage are: a fourth shard (changes the CI workflow, the three-shard rule of the delivery process and the deploy dependency, so an owner decision), or optimising the heaviest older files (`generation-stage.mjs` 121.7 s, `epg-r2-known-length.mjs` about 100 s, `film-person-e6-measure-mutation.mjs` 95.4 s, `film-person-prepared-loader-mutation.mjs` 85.8 s). Neither is done here.
