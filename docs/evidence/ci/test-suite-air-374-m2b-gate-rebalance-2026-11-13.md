# AIR-374 M2b: the shard 3 runtime gate (180 s) and the follow-up rebalance (13 Nov 2026)

**Captured:** 2026-11-13, from the retained CI logs of PR #593 (CI/CD run 43483457532, three jobs of one run, plus the Controller's recorded rerun). **Nothing was run in production.** The numbers are wall and summed file time of the `Run tests` step, read from the job logs.

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

## Prediction (not a measurement) and the first exact-HEAD readback

The Controller's readback of the CI run on `286672e` (which still had the invalid short-circuited runner, so about 10 to 15 s cheaper in its shard than the corrected one): `Run tests` 120 s in shard 1 and 139 s in shard 3 (shard 2 was still running at that readback); shard 3 was 183 and 202 s on the previous HEAD. The corrected runner is to be measured on the next exact-HEAD run.

Using the observed per-file times of the three jobs as the truth (the M2b runner planned at 25 s) and replaying the planner on the new weights: the summed file time per shard is 958 / 950 / 949 s (before: 963 / 863 / 1,050 s). With the observed ratio of wall to summed time (about 0.174) the largest shard is predicted near 167 s. That is under the 180 s gate, but with a margin of about 8 percent: the second shard 3 attempt was 10 percent slower than the first on the same HEAD, so a slow runner can still exceed the gate. The summed file time of the whole suite (2,876 s over three shards) is the structural cause; rebalancing cannot lower it.

## Limits

- The per-file times come from one run (three jobs) plus the Controller's second shard 3 attempt, not from the 30-job mean of the earlier recalibration.
- The real result is the exact-HEAD CI run of the follow-up commit; this page states the prediction and is to be completed with that run's `Run tests` wall times.
- If the gate is exceeded again, the options that keep all coverage are: a fourth shard (changes the CI workflow, the three-shard rule of the delivery process and the deploy dependency, so an owner decision), or optimising the heaviest older files (`generation-stage.mjs` 121.7 s, `epg-r2-known-length.mjs` about 100 s, `film-person-e6-measure-mutation.mjs` 95.4 s, `film-person-prepared-loader-mutation.mjs` 85.8 s). Neither is done here.
