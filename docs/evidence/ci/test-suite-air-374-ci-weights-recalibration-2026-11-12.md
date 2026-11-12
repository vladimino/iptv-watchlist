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
