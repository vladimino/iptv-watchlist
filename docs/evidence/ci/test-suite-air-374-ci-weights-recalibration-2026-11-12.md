# CI shard weights recalibrated after the suite grew (AIR-374)

Dated 2026-11-12 (UTC). Source: the job logs of nine GitHub Actions runs of the three-shard plan (27 shard jobs), parsed for the `ok <file> (<s>s)` lines and the `Wall ..., summed file time ...` line. **No production read or write.**

Runs: 43249279288, 43250532001, 43265966887, 43266516442, 43266698088, 43268368942, 43268613603, 43269330825 and 43270098315 (pull requests and `main`, heads 04a73c3 to b7f860f).

## Observed

| Run | Shard 1 `Run tests` (summed) | Shard 2 (summed) | Shard 3 (summed) |
| --- | --- | --- | --- |
| 43249279288 | 143.4 s (798) | 87.2 s (496) | 113.6 s (629) |
| 43250532001 | 198.0 s (1106) | 114.2 s (618) | 159.8 s (913) |
| 43265966887 | 123.2 s (695) | 161.8 s (923) | 120.8 s (669) |
| 43266516442 | 135.0 s (756) | 146.8 s (805) | 114.1 s (653) |
| 43266698088 | 209.0 s (1168) | 149.9 s (855) | 90.5 s (513) |
| 43268368942 | 180.9 s (1014) | 153.4 s (875) | 133.7 s (749) |
| 43268613603 | 215.2 s (1207) | 148.3 s (815) | 124.2 s (708) |
| 43269330825 | 206.4 s (1165) | 148.9 s (840) | 152.1 s (869) |
| 43270098315 | 205.1 s (1154) | 118.2 s (643) | 135.8 s (774) |

- Wall divided by summed file time is 0.175 to 0.185 in all 27 jobs (six files always running), so a shard's wall time is its summed time divided by about 5.7 and the plan can only change how much work a shard holds.
- All three shards had the same planned weight (about 699 each) in every run, yet in six of the nine runs shard 1 held 1014 to 1207 s of summed file time (181 to 215 s) while shards 2 and 3 held 513 to 923 s. In the three runs whose step times were read (43249279288, 43269330825, 43270098315) the job wall of shard 1 is 22 to 27 s above its `Run tests` step against 15 to 21 s for shards 2 and 3.

## Cause

- The table stopped being a model of the suite. About 20 files joined since the three-shard recalibration and the weight list lacked them or held them at the default: `film-person-e6-measure-mutation` (29 listed, 61 measured), `canonical-epg-person-producer-mutation` (8 against 39), `canonical-dictionary-producer-mutation` (12 against 29), `canonical-receipted-writers-mutation` (default against 29), `scheduled-task-prompt-v2` (20 against 39), `prediction-batch-start` and `prediction-batch-submit` (25 and 28 against 49 and 47), `epg-diagnostic-run` (12 against 19), `film-person-0019-preflight-mutation` (default against 10). Shard 1 held `generation-stage`, `film-person-connector-mutation`, `film-person-e6-measure-mutation` and `scheduled-task-prompt-v2` together, so its CPU-bound files ran side by side and each took 1.5 to 2 times its mean (`generation-stage` 132 s, `film-person-e6-measure-mutation` 106 s, `scheduled-task-prompt-v2` 76 s in 43270098315).
- About 30 files of 2 to 4 weight units each sat at the default 0.8 and about 250 files cost 0.5 on average, so the default was both too low for the first and too high for the second.

## Change

- `WEIGHTS` is recalculated: each file's share of its own job's summed time, scaled to 630, averaged over the jobs that ran it. Every file with 2 or more has an entry (121 entries, was 90); `DEFAULT_WEIGHT` is 0.5, the mean of the other 250 files (was 0.8). The serial-only files are weighted by their solo time (mean 9.9 s and 7.2 s) divided by the 0.233 s of wall one unit holds: `sqlite-session-semantics` 42 and `local-dev-smoke` 31 (were 50 and 40); they stay in different shards.
- `planTests` starts shard 1 with `FIRST_SHARD_OFFSET` = 33 units, so it ends 33 units (about 5%) lighter than shards 2 and 3. Reason: `Test and build` also runs the documentation governance check, the build, the Discovery Workflow bundle validation and the artifact upload outside `Run tests`, measured at about 9 s more job wall time than a plain shard job, and 33 units are about 7 s of wall at 0.233 s a unit. The mutation class is dealt first with the same offset, then the other files, as before.
- `tests/run-tests-runner.mjs`: the balance assertions now add the offset back to shard 1 (the shards are equal within the lightest weight) and require shard 1 to be the lightest by about the offset. The mutation-evenness assertion keeps its tolerance and counts the offset. Nothing else changed; every file still runs once, no test, check, timeout, mutation file or the 180 s gate was changed, and the workflow is untouched.

## Planned load, before and after

| | Shard 1 | Shard 2 | Shard 3 |
| --- | --- | --- | --- |
| Before: planned weight (files) | 698.8 (124) | 699.2 (123) | 699.0 (124) |
| After: planned weight (files) | 631 (122) | 664 (124) | 664 (125) |
| After: mutation weight | 155 | 189 | 191 |
| After: serial-only tail | `local-dev-smoke` 31 | `sqlite-session-semantics` 42 | none |

## Predicted, not measured

At 0.233 s of wall per unit (mean of the 27 jobs) the plan predicts `Run tests` of about 147 s (shard 1), 155 s (shard 2) and 155 s (shard 3), a margin of about 25 to 33 s to the 180 s gate; the job wall of shard 1 is then about 9 s above its step. On the slowest shard 2 or 3 job seen (923 s summed for 699 units) the same plan would take about 155 s. Runner speed varied up to 2 times on the same code, and the pre-change skew of shard 1 (1.4 to 1.7 times its share) came partly from heavy files running together, which a new table reduces but does not prove away: CI on the new HEAD decides, and it is not yet seen.

## Second data point: the first run of the new plan (run 43272848716, head fa34e13)

Parsed like the nine runs above (the `ok <file> (<s>s)` lines and the `Wall` line of the three job logs). **No production read or write.**

| Shard | Planned weight | `Run tests` wall | Summed file time | Wall per planned unit |
| --- | --- | --- | --- | --- |
| 1 | 631 | 123.5 s | 704 s | 0.196 s |
| 2 | 664 | 177.3 s | 1018 s | 0.267 s |
| 3 | 664 | 131.7 s | 787 s | 0.198 s |

The plan predicted about 147 / 155 / 155 s, so shards 1 and 3 came out 23 and 23 s lighter and shard 2 came out 22 s heavier, at the 180 s gate minus 3 s. Summed file time per planned unit was 1.12, 1.53 and 1.19 s.

### Finding

The weights were not the cause: the ten-run mean of every file moved by 1 to 3 units against the list (below). The cause was co-location of CPU-bound files in shard 2. Measured time against the weight-implied time (weight times 1.281 s, the run's summed time over its planned weight) for the files that explain the excess:

| File (shard 2) | Weight | Measured | Implied | Excess |
| --- | --- | --- | --- | --- |
| `prediction-batch-start` | 49 | 107.7 s | 62.8 s | +42 s |
| `film-person-connector-mutation` | 65 | 118.8 s | 83.3 s | +34 s |
| `generation-stage` | 71 | 124.1 s | 90.9 s | +33 s |
| `canonical-dictionary-producer-mutation` | 29 | 73.8 s | 37.1 s | +33 s |
| `projector-view-parity` | 30 | 70.3 s | 38.4 s | +29 s |
| `discovery-chunk-budget` | 32 | 56.3 s | 41.0 s | +15 s |

Their six excesses add up to 186 s of summed time, about 32 s of wall at 0.174 s of wall per summed second, and shard 2 was 22 s above its plan and 46 s above shard 1. The same files cost their weight when they ran apart: in shards 1 and 3 only `canonical-receipted-writers-mutation` (+31 s, with `film-person-e6-measure-mutation` and `generation-stage-withheld` beside it), `scheduled-task-prompt-v2` (+19 s) and `canonical-epg-person-producer-mutation` (+14 s) were far above their weight, and every other file there was within 6 s. Cause of the co-location: the deal put the mutation class first, then the other files by least load, so `generation-stage` (not a mutation file) landed on the shard the mutation class had left lightest, next to `film-person-connector-mutation` and `prediction-batch-start`. Shard 2 held three files that each cost 1.2 to 2 times their mean at the same time.

### Change

- (Superseded by the contention cohort of the third data point below.) `planTests` spreads the heaviest files by count. After the mutation class and before the remaining files, each of the `HEAVY_PER_SHARD` (3) times shard-count heaviest files that is not a mutation file goes to the shard that holds the fewest of those heaviest files so far (ties: the least loaded), where the mutation files among them were already counted. For three shards the nine heaviest files (`epg-r2-known-length`, `generation-stage`, `film-person-connector-mutation`, `film-person-e6-measure-mutation`, `discovery-decisions-read`, `prediction-batch-start`, `film-person-prepared-loader-mutation`, `generation-stage-withheld`, `prediction-batch-submit`) are three per shard, and which they are follows `WEIGHTS`, so the rule has no file list to rot. The serial-only rule, the mutation class and the shard 1 offset are unchanged.
- `WEIGHTS` is recomputed with the tenth run in the same way (each file's share of its own job's summed time, scaled to 630, mean over 30 jobs; entries of 1.5 or more, 133 entries, was 121; the two serial-only weights unchanged at 42 and 31). The ten-run weights differ from the nine-run ones by at most 3 units (`scheduled-task-prompt-v2` 39 to 42, `prediction-batch-start` 49 to 51, `canonical-dictionary-producer-mutation` 29 to 32, `projector-view-parity` 30 to 32) and about a dozen files of 1.5 to 2 units gain an entry of 2. They are shares, so the co-located shard's inflated times lower the weights of the other files a little and raise those of the files in it, which is the averaging working as intended; the fix for co-location is the rule, not the weights.
- `tests/run-tests-runner.mjs`: a new assertion that the nine heaviest files are spread three per shard over three shards. The mutation evenness bound changes from twice the lightest listed weight (4) to the lightest mutation file's weight (5): the same greedy deal of the same mutation class gave 194 / 189 / 189 (shard 1 with the offset added back) for the recomputed weights, a spread of 5, and the class has no file lighter than 5, so this is the bound that greedy deal of that class guarantees; it is the only assertion that was loosened, by one unit. Nothing else changed: every file runs once, no test, check, timeout, mutation file or the 180 s gate was changed, and the workflow is untouched.

### Planned load, before and after (this change)

| | Shard 1 | Shard 2 | Shard 3 |
| --- | --- | --- | --- |
| Before: planned weight | 631 | 664 | 664 |
| After: planned weight (files) | 636.5 (124) | 669.5 (123) | 669 (124) |
| After: with the 33-unit offset added back | 669.5 | 669.5 | 669 |
| Before: mutation weight | 155 | 189 | 191 |
| After: mutation weight | 161 | 189 | 189 |
| After: the nine heaviest files | `discovery-decisions-read`, `prediction-batch-start`, `film-person-prepared-loader-mutation` | `epg-r2-known-length`, `film-person-connector-mutation`, `prediction-batch-submit` | `generation-stage`, `film-person-e6-measure-mutation`, `generation-stage-withheld` |
| After: serial-only tail | `sqlite-session-semantics` 42 | none | `local-dev-smoke` 31 |

Before, shard 2 held `generation-stage`, `film-person-connector-mutation` and `prediction-batch-start`; now no shard holds more than three of the nine and `generation-stage` is apart from the other two.

### Predicted, not measured

The three shards now carry the same weight after the offset (669.5 / 669.5 / 669), so the plan predicts the same `Run tests` for all three: at the mean of 0.233 s per unit about 156 s, at the 0.196 to 0.198 s per unit that shards 1 and 3 showed when no heavy files met about 131 to 133 s. That is a margin of about 24 s (pessimistic) to 48 s (uncontended) to the 180 s gate; the weight cannot be spread thinner than the total (1979 units over three shards), so about 150 s predicted or less holds only if a unit costs 0.224 s or less. These are predictions: the 0.233 s mean was measured on runs whose shards were skewed, runner speed varied up to 2 times on the same code, and the heavy files still meet beside files of a similar weight (for example `prediction-batch-start` with `discovery-decisions-read` in shard 1). CI on the new head decides and is not yet seen.

## Third data point: the final head of the second tuning (run 43275433514, head c2ce9ca): rejected on performance

Parsed like the earlier runs (the `ok <file> (<s>s)` lines and the `Wall` line of the three job logs). **No production read or write.** The run was green: green CI does not enforce the 180 s objective, because the `Run tests` step has a timeout and not a gate at 180 s, so a plan can pass CI and still miss the objective. This one missed it for shard 2.

| Shard | Planned weight (files) | `Run tests` wall | Summed file time | Summed seconds per planned unit | Wall per summed second |
| --- | --- | --- | --- | --- | --- |
| 1 | 636.5 (124) | 117.3 s | 652.7 s | 1.03 | 0.180 |
| 2 | 669.5 (123) | 187.3 s | 1,121.6 s | 1.68 | 0.167 |
| 3 | 669 (124) | 157.8 s | 907.8 s | 1.36 | 0.174 |

The previous plan (run 43272848716) had shard 2 at 177.3 s, so the second tuning made shard 2 10 s worse while shard 1 kept about 62 s of unused room under 180 s. **The revised plan below is NOT yet demonstrated under 180 s; no run of it has been seen.**

### Why a balanced plan was not a balanced time

The planned weights were equal after the offset and the measured summed time was not (1.03, 1.68 and 1.36 s per unit): a weight is a file's average share over many shard compositions, and a file's time depends on what runs beside it. With six files at a time on 4 vCPUs the CPU-bound files stretch each other. Across all 12 runs (36 shard jobs, per-file times divided by the job's speed taken from the light files), the CPU-bound middle of the suite is stretched 1.7 to 2.8 times at its worst against its 25th-percentile observation, and it is not the nine heaviest files: in shard 2 of this run `canonical-receipted-writers-mutation` took 92 s (41 s at the job's speed otherwise), `scheduled-task-prompt-v2` 91 s (54 s), `projector-view-parity` 64 s (41 s), `discovery-chunk-budget` 59 s (42 s) and `d1-enrichment-buckets` 57 s (34 s), none of them among the nine; `film-person-connector-mutation` took 122 s (86 s) and `epg-r2-known-length` 120 s (85 s). Shard 1 held none of that: its light files and its heavy ones both ran at 0.82 to 1.0 of the average. Not every heavy file is sensitive: `generation-stage-withheld`, `discovery-bounded-drain` and `discovery-decisions-read` stayed within 1.2 times of their best across every shard, so a file's weight alone does not say whether it competes for the CPU.

### Replay: which description of the cohort reproduces the observations

A model of a shard's `Run tests` wall time from the shard's file list (weights as in `WEIGHTS`) was fitted on the 36 jobs and checked by leaving one whole run out at a time (12 folds):

| Candidate | Leave-one-run-out error (rmse) | Verdict |
| --- | --- | --- |
| Weight only (what the plan balanced) | 34.9 s | Rejected: predicts the same wall for the three shards of every old-plan run, which in eight runs had shard 1 at 123 to 215 s (mean 180 s) against 127 s for shard 3 |
| Every file of 30 or more is the cohort (all classes alike) | 30.5 s | Rejected: the non-mutation heavy files do not add stretch beyond their weight |
| Top nine by count (the rule of the second tuning) | not a predictor | Rejected: its shards 1, 2, 3 held 3, 3, 3 of them and took 117, 187, 158 s |
| Wall = 0.085 x total weight + 0.63 x weight of the mutation files of 20 or more | 27.1 s (fit 25.2 s) | Kept, with variants (cut-offs 10 to 25, one with an additional all-class heavy term) at 26.8 to 27.8 s |

The kept models put about 0.6 s of `Run tests` on each unit of mutation weight and 0.06 to 0.09 s on a unit of any other weight, seven to twelve times. Replay of the three plans with seven variants of the model (mean of the seven, the observed range in brackets): the old plan shards 1, 2, 3 are predicted 178, 137, 122 s (observed mean over eight runs 180, 137, 127 s); the plan of run 43272848716 is predicted 131, 161, 156 s (observed 124, 177, 132 s); this run's plan 131, 157, 159 s (observed 117, 187, 158 s). The models reproduce the ranking of the old plan and that shard 1 is the lightest in both new plans, and they put shard 2 at or near the top; they do not separate shard 2 from shard 3 (this run) and they under-predict shard 2 by 16 and 30 s, so the unexplained part of a job is large: the rmse is 25 s, mostly runner speed, since the identical shard-1 composition of the old plan took 123 to 215 s in eight runs.

### Change

- `planTests` replaces the nine-file count rule by a contention cohort: every mutation file and every other file of `HEAVY_MIN_WEIGHT` (20) units or more that is not serial-only (about 9% of the files, 55% of the weight). The cohort is dealt before the rest, heaviest pressure first, each file to the shard with the least pressure so far (ties: least loaded), where a file's pressure is its weight, times `HEAVY_MUTATION_PRESSURE` (6) for a mutation file. Shard 1 starts `FIRST_SHARD_HEAVY_CREDIT` (60) pressure units ahead, so it gets the largest cohort share because it has the most headroom; `FIRST_SHARD_OFFSET` still makes its total weight 33 units lower, so the overhead allowance is unchanged. The files that are not in the cohort fill the shards to the same total as before. Serial-only files stay in different shards, every file runs once, mutation coverage and every timeout are untouched.
- The parameters sit on a plateau: over cut-offs of 20 to 40, mutation pressure 4 to 8 and credit 30 to 90 the seven model variants predict the slowest shard at 153 to 162 s (mutation pressure 6 to 8) and 158 to 162 s (4), and 20 / 6 / 60 is not the minimum of that grid but a point inside the flat part.
- Fixed in `scripts/run-tests.mjs`: the header comment said `DEFAULT_WEIGHT 0.8 covers the rest` where the value is 0.5.
- `tests/run-tests-runner.mjs`: the assertion that the nine heaviest files are three per shard and the mutation-weight evenness bound (twice a unit) are replaced by stronger ones: the cohort is spread by count (at most one apart) for two and for three shards, its pressure is within 5% of the mean once shard 1's credit is counted, shard 1 carries the largest cohort pressure, no shard holds more than 1.15 times the mean mutation weight, and the two heaviest mutation files stay apart. The plan of c2ce9ca fails three of those (cohort counts 13 / 14 / 12, pressure 1,193 / 1,427 / 1,376 with shard 1 the lightest, and so outside 5% of the mean). Offset, serial-only and coverage assertions are unchanged.

### Planned load, before and after (this change)

| | Shard 1 | Shard 2 | Shard 3 |
| --- | --- | --- | --- |
| Before: planned weight (files) | 636.5 (124) | 669.5 (123) | 669 (124) |
| After: planned weight (files) | 636.5 (124) | 669.5 (123) | 669 (124) |
| Before: cohort files / weight / pressure | 13 / 388 / 1,193 | 14 / 482 / 1,427 | 12 / 431 / 1,376 |
| After: cohort files / weight / pressure | 14 / 434 / 1,414 | 14 / 483 / 1,343 | 13 / 457 / 1,312 |
| Before: mutation weight | 161 | 189 | 189 |
| After: mutation weight | 196 | 172 | 171 |
| After: serial-only tail | `sqlite-session-semantics` 42 | `local-dev-smoke` 31 | none |

The heavy and mutation files that cost shard 2 its time in this run (`film-person-connector-mutation`, `canonical-receipted-writers-mutation`, `film-person-cutover-record-mutation`, `discovery-chunk-budget`, `prediction-batch-submit`) go to shard 1; `epg-r2-known-length` goes to shard 3; shard 2 takes `generation-stage`, `film-person-e6-measure-mutation` and `prediction-batch-start`.

### Predicted, not measured, and not yet shown under 180 s

- The seven model variants predict `Run tests` of about 154 s (shard 1), 145 s (shard 2) and 149 s (shard 3) for the revised plan (each variant 139 to 157 s), a margin of 23 to 41 s to the 180 s objective. The model error is 25 s per job (rmse), so a shard job above 180 s is plausible at about one in seven per job (z about 1.0 on the slowest predicted shard), and about one in three that at least one of the three jobs exceeds it, if the error were normal and independent; that is a rough statement and not a measurement.
- Shard 2 was above its prediction by 16 and 30 s in the last two runs. If that part of the excess is a property of files that stay in shard 2 and not noise, the new shard 2 may land above 145 s as well. Nothing here shows it does not.
- **Three shards or four.** Even a perfect three-way split leaves little: the three shard walls of a run add up to 311 to 507 s over the 12 runs (433 and 462 s for the last two plan runs), so an even split gives 104 to 169 s per shard, 144 and 154 s for the last two, a margin of 11 to 36 s to 180 s before any job-to-job speed noise (25 s) and before the lumpiness of 20 to 70 unit files. No three-shard deal can bring every shard under about 165 s at the slowest observed runner speed: the slowest run's total divided by three is 169 s. With four shards the same model predicts about 117 / 105 / 111 / 113 s (planned weight 469 / 502 / 502 / 502), a margin of about 63 s, 2.5 times the model error; that would need `.github/workflows/ci.yml` (a fourth `Test shard 4 of 4` check, the shard counts, the deploy `needs`), done for three shards in #542. This change does not implement it; it is an owner decision. The new plan is shown to meet 180 s only by a CI run that is not yet seen; green Actions does not prove it, and the step times of its three `Run tests` steps have to be read from the logs.
