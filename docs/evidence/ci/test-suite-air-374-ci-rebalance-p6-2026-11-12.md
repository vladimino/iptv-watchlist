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

## Follow-up: five runs, one plan (2026-11-12 UTC)

Source: the job logs of runs 43185880919, 43186573244 (post-merge, attempt 2) and 43188491322, parsed the same way. **No production read or write.** The post-merge run's shard 2 failed on `sqlite-session-semantics` (the 20 s call bound under contention); its shard 1 is counted, its shard 2 is not.

| Run, shard | Plan | Wall | Summed file time | Wall / summed |
| --- | --- | --- | --- | --- |
| 43185880919, 1 | P6 weights | 128.0 s | 737 s | 0.174 |
| 43185880919, 2 | P6 weights | 114.5 s | 685 s | 0.167 |
| 43186573244, 1 | P6 weights | 189.3 s | 1090 s | 0.174 |
| 43188491322, 1 | P6 weights, sqlite serial | 203.6 s | 1174 s | 0.173 |
| 43188491322, 2 | P6 weights, sqlite serial | 158.0 s | 902 s | 0.175 |

### Cause

- Wall / summed is 0.167 to 0.178 in all nine shard jobs of the day: six files are always running and the runner is saturated, so a shard's wall time is its summed file time divided by about 5.8. The plan changes only how much work a shard holds; it cannot change that ratio.
- Between 43185880919 and 43188491322 shard 1 held the same 173 files and the same plan. Its summed time went from 737 s to 1174 s (1.59 times). The 16 slowest files went from 543 s to 887 s (1.63 times) and the other 157 files from 194 s to 286 s (1.48 times); every large file slowed by 1.1 to 2.0 times (`generation-stage` 74 to 141 s, `epg-r2-known-length` 61 to 120 s, `discovery-decisions-read` 52 to 98 s, `local-dev-smoke` 5.2 to 8.1 s). A uniform slowdown of this size is the runner (CPU speed or a noisy neighbour), not one file or one pairing. The same plan has measured 128 s, 189 s and 204 s for shard 1 on three runners.
- Shard 1 was also the heavier one: on the old weights it held more estimated work than its weight said (`generation-stage` and `discovery-decisions-read` were under-weighted at 71 and 48 against means of 104 and 70 once normalised), 1174 s against 902 s in the same run.
- `sqlite-session-semantics` alone took 9.0 s in 43188491322 (42.6 to 47.9 s when it ran inside the parallel phase), and `local-dev-smoke` 5.2 to 8.1 s.

### Change

- `WEIGHTS` is recalibrated from the nine shard jobs of the five runs: each file's share of its own job's summed time, scaled to 921 per shard, averaged over the jobs that ran it. This removes the runner speed from the per-file number; 72 files have 4 or more.
- The two serial-only files are weighted by their solo duration times 5.8 (`local-dev-smoke` 40, `sqlite-session-semantics` 50), because they run after the parallel phase and add their whole time to a shard's wall time; before this they carried 7 and 44. The deal already counted serial files; now they count what they cost, and the two are in different shards.
- Resulting shard loads: shard 1 895 parallel plus 50 serial (174 files), shard 2 905 parallel plus 40 serial (173 files); mutation weight 213 against 208.
- No concurrency cap: the 0.17 ratio says the CPUs are already saturated, so fewer files at once would lengthen the wall time (jobs 4 took 149 s against 119 s for 6 in AIR-408), and nothing in the nine jobs shows a time-out or a mutation file starving outside a slow runner. No test, check, timeout or gate was changed.

### Predicted, not measured

At 945 per shard and 0.172 s of wall per summed file second the plan predicts about 105 to 160 s per shard on the runners seen today (summed 600 to 930 s); the slow runner seen in 43188491322 (1.6 times) puts a balanced shard near 175 to 185 s, inside the 180 s gate only at its edge. Balance cannot remove the runner variance; a third shard (about 630 per shard, 70 to 125 s) would, but it changes the CI workflow and the required check names, so it needs the owner's decision. CI on the new HEAD is not yet seen.
