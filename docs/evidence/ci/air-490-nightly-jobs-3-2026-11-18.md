# AIR-490: nightly non-functional suite with `--jobs 3` (18 Nov 2026)

**Captured:** 18 November 2026 (UTC). **Method:** GitHub Actions job log of the failed scheduled run plus a local benchmark on a 4 vCPU machine. No Worker, R2, D1, Cloudflare or production write.

## Failure being addressed

Scheduled run [44310326343](https://github.com/vladimino/iptv-watchlist/actions/runs/44310326343) (`event=schedule`, created 2026-11-18T13:06:16Z, SHA `d30f0bed3fb6b0c8e059a4238a43de5fe752a318`) ran 42 files with `jobs=6`. `canonical-producer-driver-mutation.mjs` and `canonical-producer-driver-mutation-b.mjs` both reached the 300000 ms per-file limit (killed by the runner's timeout, not an assertion or surviving mutant); fail-fast left 27 files unstarted. The tests and the code they exercise are byte-identical to the last green manual run [44056058694](https://github.com/vladimino/iptv-watchlist/actions/runs/44056058694) (40/40, driver halves 225 s). The root cause of the slowdown is **not proven**; CPU oversubscription is plausible, because each driver mutation test starts up to four child processes and both halves run beside other heavy mutation files.

## Change

`.github/workflows/nonfunctional-tests.yml`: `npm test -- --suite non-functional --jobs 3` (default is `min(6, ceil(1.5 x CPUs))` = 6). No change to the per-file timeout, fail-fast, cron or required checks.

## Local benchmark (4 vCPU, nothing else running)

`npm test -- --suite non-functional --jobs 3`: **42 of 42 files passed**, wall 311.8 s, summed file time 922.5 s. The two driver halves took 131.7 s and 132.7 s against the 300 s limit.

An earlier local run of the same command was discarded: it overlapped with the pre-push hook's own `--suite all` and failed the 8 s wall-clock assertion of `film-person-reader.mjs` under 9 concurrent files. That is contention from the measurement setup, not a result about the change.

## GitHub runner result (`workflow_dispatch` on this branch)

Run [44341717643](https://github.com/vladimino/iptv-watchlist/actions/runs/44341717643), SHA `3e7dd5d9cd1998ba42ca96bddf2f19bbc34e640c`, `--jobs 3`, Node 20.20.2: the two driver halves finished in **140.8 s and 140.4 s** (limit 300 s; the scheduled run with `jobs=6` timed out on both). 40 of 42 files ran, wall 365.2 s. The run is red for a **different, pre-existing** reason: `footer-memory.mjs` (gated block `footer-memory-production-size`, AIR-519) spawns `scripts/footer-memory-profile.mjs`, which imports `node:sqlite`; that module does not exist in Node 20 (`ERR_UNKNOWN_BUILTIN_MODULE`) and the workflow, like the core jobs, tests on Node 20 (only the Wrangler dry-run step uses Node 22). AIR-519 (`b9abab3`, 18 Nov 2026 00:19 UTC) is an ancestor of the failed scheduled SHA `d30f0bed`, so this file was already in the 27 files that run never started because of fail-fast. `--jobs 3` did not cause it; it only lets the run get far enough to reach it. Not fixed here: the options (Node 22 for the nightly, a `node:sqlite`-free profile script, or an explicit skip on Node < 22) change test semantics or the tested Node version and are an owner decision.

## Limits

The local figures are not GitHub runner figures, and no `--jobs 6` local run was taken for comparison; the runner figures are above. Two files were not run on the runner (`footer-memory.mjs` failed, two after it were not started), so 42/42 on GitHub is **not** shown. Acceptance still needs a green natural `event=schedule` run with 42/42 and a punctual start (cron 04:17 UTC). Late schedule delivery (+8 h 49 min) is a separate GitHub-side question and is not addressed here.
