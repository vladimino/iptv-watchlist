# CI shard weights from measured per-file times (AIR-374 P4b)

Dated 2026-11-11 (UTC). Source: the complete job logs of two GitHub Actions runs of this repository, read with `gh api .../actions/jobs/<id>/logs` and parsed for the `ok <file> (<s>s)` lines. **No production read or write.** Times are CI seconds of a slow runner with 6 parallel jobs; they differ by up to a factor of two between runs, so the weights below are estimates and CI decides.

## Logs used

| Run | Jobs | Files | Per-shard `Run tests` wall | Summed file time |
| --- | --- | ---: | --- | --- |
| 43075087471 (PR 532 at d1758a5; the failing run) | 130712704690 (shard 1), 130712705275 (shard 2) | 338 | 124.3 s and 180.2 s | 691.6 s and 1065.7 s (total 1757.6 s) |
| 43067908205 (PR 534 branch before the balance) | 130687677522 (shard 1), 130687678132 (shard 2) | 334 | 165.7 s and 124.8 s | 972.5 s and 700.8 s (total 1673.2 s) |

The run for PR 530 (43073886336) was cancelled and carries no per-file data.

## Finding

The previous hand-written table gave two shards of equal estimated weight (917 and 918), but the real split was 692 s against 1066 s. The estimates were wrong for several heavy files (for example `discovery-decisions-read` weighted 58, measured 62 to 104 s; `film-person-capture-mutation` 30 against 47 to 57; `projector-bulk` 26 against 45 to 55; `sqlite-session-semantics` 8 against 27 to 31) and the roughly 270 files under 4 s were costed at 2.5 s each (about 680 s) while they sum to about 211 s.

## Change

`WEIGHTS` in `scripts/run-tests.mjs` is now the mean of the per-file times of the two runs, rounded to whole seconds, for every file with a mean of 4 s or more (68 entries, including the files new since PR 534: `canonical-receipts` 8, `canonical-receipts-mutation` 31, `canonical-catalog-reader-mutation` 23, `canonical-catalog-titles-mutation` 15, `canonical-film-writers-mutation` 7, `canonical-person-state-mutation` 7; `canonical-differential-mutation` stays at the earlier estimate of 31 because that file is not in this branch). `DEFAULT_WEIGHT` is 0.8 (the measured mean of the 271 files under 4 s). The planner is unchanged: files are dealt heaviest first to the lighter shard. No test case, assertion or mutant was removed.

| Predicted by the new weights | Shard 1 | Shard 2 |
| --- | ---: | ---: |
| Files | 170 | 168 |
| Weight (estimated CI seconds of summed file time) | 874 | 874 |
| Before: the previous assignment, measured in run 43075087471 | 692 | 1066 |
| Predicted `Run tests` wall at the measured 0.17 to 0.18 wall per summed second | about 149 to 157 s | about 149 to 157 s |

The wall prediction is the weakest part: it rests on the two measured ratios (124.3/691.6 and 180.2/1065.7) and on a total that is unchanged. The suite's total work did not shrink, so about 150 s is the floor of an even split; a further margin needs less work, not a different split.

`tests/run-tests-runner.mjs` passes unchanged.
