# AIR-494: core shard weights after AIR-490 (15 Nov 2026)

**Captured:** 2026-11-15, Europe/Madrid. **Method:** read-only GitHub Actions API and job logs of successful `CI/CD` runs created after AIR-490 merged (`0ffd480eed31`, 12:21 UTC). Per-file times from the runner's `ok  <file> (<s>s)` lines. Local re-plan with `planTests`. No production access. No test assertion, suite classification, `TEST_JOBS`, timeout or workflow wiring was changed.

## Sample

33 successful post-AIR-490 runs (99 shard jobs) give job and `Run tests` walls. Per-file fitting uses 12 of those runs (36 jobs); 8 later runs are hold-out. Failed and cancelled runs are excluded. File counts on a shard vary by one when a commit adds a core file; fitting uses the files that actually ran.

Fit run ids: `43713412568`, `43714759267`, `43715323425`, `43715780882`, `43716342641`, `43731307040`, `43732019271`, `43737148626`, `43738057502`, `43739015333`, `43743192153`, `43745248019`.

Hold-out run ids: `43743787095`, `43745590128`, `43746478542`, `43746533269`, `43746867835`, `43747093952`, `43747369025`, `43747661039`.

## Baseline (current `WEIGHTS`, `FIRST_SHARD_OFFSET=80`, `FIRST_SHARD_HEAVY_CREDIT=160`)

Mean over the 33 runs:

| | Test and build | Shard 2 | Shard 3 | Critical path (max of three) |
| --- | ---: | ---: | ---: | ---: |
| `Run tests` | 54.2 s | 72.9 s | 70.2 s | 80.2 s |
| Full job | 78.6 s | 90.2 s | 87.7 s | 99.3 s |
| Extra outside `Run tests` | 24.4 s | 17.4 s | 17.5 s | |

Shard 1's extra (build, Discovery bundle check, artifact upload, and on pull requests the documentation governance check) is about **7 s** more than a plain shard job. The first-shard offset of 80 units, still calibrated so mutation files stay off shard 1, leaves the core `Run tests` step about 19 s lighter than shard 2. Runner jitter is large: the same shard's `Run tests` step ranges from the high 30 s to the low 90 s across this window.

Observed `Run tests` walls on the card's three example runs remain: 37 / 71 / 92 s (`43746533269`), 38 / 56 / 59 s (`43747093952`), 69 / 71 / 60 s (`43746867835`).

Mean summed file time of the 12-run fit, throughput 5.47 file-seconds per wall-second:

| | Shard 1 | Shard 2 | Shard 3 | Max full job (model) |
| --- | ---: | ---: | ---: | ---: |
| Summed file time | 319 s | 425 s | 405 s | |
| Predicted `Run tests` | 58 s | 78 s | 74 s | |
| Predicted full job | 83 s | 95 s | 92 s | **95 s** |

Hold-out predicted full jobs: 76 / 85 / 81 s, max **85 s**.

The heaviest core files (fit mean wall): `generation-stage.mjs` 55.0 s, `discovery-decisions-read.mjs` 43.5 s, `epg-r2-known-length.mjs` 41.7 s, `generation-stage-withheld.mjs` 33.9 s. Serial-only solo means: `sqlite-session-semantics.mjs` 8.8 s, `local-dev-smoke.mjs` 7.4 s.

## Options evaluated

1. **Do nothing.** Nightly mutation scheduling stays as AIR-374 left it. Core jobs stay unbalanced by about 12 s of modelled full-job wall on the fit set.
2. **Replace the shared `WEIGHTS` map with core CI shares, keep `FIRST_SHARD_HEAVY_CREDIT=160`.** Shard-1 still avoids the heavy core files. No useful gain on the critical path.
3. **Replace the shared `WEIGHTS` map (share-of-job-sum, scaled to 630) and drop the heavy credit to 10.** Best modelled core critical path (fit max job 90 s, hold-out 81 s) but inflates files that currently sit on the lighter shard 1 (for example `generation-stage.mjs` 112 units against a 55 s mean) and moves the nightly `all` mutation counts from 10 / 11 / 10 to 8 / 12 / 11.
4. **Chosen: a separate `CORE_WEIGHTS` map (mean seconds, entries of 2 or more; serial-only files keep solo-time / 0.233) and `CORE_FIRST_SHARD_HEAVY_CREDIT=10`, used only when `suite==='core'`.** `WEIGHTS`, `FIRST_SHARD_HEAVY_CREDIT=160`, `HEAVY_MUTATION_PRESSURE=6` and `FIRST_SHARD_OFFSET=80` stay the nightly plan. Fit predicted full jobs 89 / 90 / 91 s, max **91 s** (about 4 s off the previous 95 s). Hold-out 81 / 79 / 81 s, max **81 s** (about 4 s off the previous 85 s). Core file counts 131 / 135 / 134. Serial-only files remain on different shards.

A lower first-shard offset (24–40) equalised `Run tests` but made `Test and build` the slowest full job again, so the critical path did not improve.

## What this change does not do

It does not promise 50 s `Run tests` on each runner: the sum of the three mean test steps is about 197 s, so the arithmetic floor at equal test steps is about 66 s, plus shard 1's extra 7 s of job work. The 180-second quality threshold stays non-blocking. It does not change what any test asserts, how files are classified, `TEST_JOBS`, timeouts, or CI/deploy wiring. Natural post-merge runs of this change remain the measurement of whether the modelled 4 s critical-path cut appears through runner jitter.

Related: [AIR-490 suite split](air-490-nonfunctional-suite-2026-11-15.md), [14 Nov weight recalibration](test-suite-air-374-ci-weights-recalibration-2026-11-14.md), [180 s quality threshold](core-shard-180s-quality-threshold-2026-11-15.md).
