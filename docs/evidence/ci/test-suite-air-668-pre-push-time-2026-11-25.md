# AIR-668: why a push took about 20 minutes, and the pass record

Date: 2026-11-25 (UTC). Card: [AIR-668](https://trello.com/c/wOSFGAFZ). Environment: Claude Code cloud container, 4 vCPU (`availableParallelism()` 4, so 6 jobs), Node v22.23.5, Linux. Code: branch `claude/air-668-pre-push-dedupe`, commit `9c77dbb`.

## What the 20 minutes were

The AIR-667 session (PR #1003) reported about 20 minutes to push. Its transcript shows two full runs of the same content, one after the other:

| Step (UTC, 25 Nov 2026) | Duration |
| --- | --- |
| Pre-PR `npm run test:all` by hand (core about 76–94 s, non-functional 256.5 s), ended 15:14:35 | about 6 min |
| `git commit && git push`: pre-commit, then the pre-push hook running `test:all -- --isolate-measurements` again, 15:14:43 to 15:24:23 | 9 min 40 s |

The hook's suite was not slower because of fewer jobs, a missing TTY, `npm ci` or a build: it uses the same runner with the same job count (6) and runs neither `npm ci` nor the build. It costs more than the manual run for one reason only, the serial tail added by `--isolate-measurements` (PR #998, the same day). The rest is the duplicate run itself.

## Measured on the final commit

Each figure is one run on an otherwise idle container, wall time from start to exit.

| Run | Core wall | Non-functional wall | Total |
| --- | ---: | ---: | ---: |
| `npm run test:all` (pre-PR rule, 300 s per-file limit) | 223.2 s | 217.9 s | 445 s |
| Pre-push hook, suite forced (`IPTV_PREPUSH_RERUN=1`), the previous behaviour | 218.6 s | 263.9 s | 487 s |
| Pre-push hook after that `test:all`, pass record present | not run | not run | under 1 s |

- The 12 isolated measurement files took 170.2 s summed when they ran in parallel and 128.8 s summed when they ran one at a time; isolation turns them into a serial tail that adds about 46 s to the non-functional stage (217.9 s against 263.9 s).
- Previous flow on this machine: 445 s + 487 s = 932 s (15.5 min) of tests before the push reached the network. With the pass record: 445 s, about half.
- The hook output names the covering run: `9c77dbb86e04 by the run of 2026-11-25T15:54:51.600Z on tree 1542a0fc931b`.

## What changed

- `scripts/run-tests.mjs`: a `--suite all` run of the repository's own `tests/` that passes in full, with the same working-tree content at its end as at its start, appends that tree (and the Node version) to `.git/iptv-test-all-passed` (`scripts/test-pass-record.mjs`, at most 50 lines).
- `.githooks/pre-push`: skips the suite only when every pushed commit has a recorded tree on the current Node version, or differs from one only outside the paths that need the suite (the documentation-only rule the hook already had). Otherwise it runs the suite, but only when the working tree is the content of every pushed commit, and pushes only when the run's record then covers them; `IPTV_PREPUSH_RERUN=1` forces a run under the same rule.
- Review of PR #1007 closed three holes, each with a regression that fails on the earlier code: the tree is hashed from disk in a fresh index (a copied index let `--assume-unchanged` or `--skip-worktree` attest HEAD for edited bytes); changed paths are listed raw and with `--no-renames` (a move from `src/` to `docs/` listed only the new path, and a quoted non-ASCII name did not match `^src/`, so both looked documentation-only, also in the hook's older exemption); and a miss no longer tests whatever is checked out (pushing another branch passed on a run of the current one, an inherited weakness of the hook).
- The set of tests that must pass before a push is unchanged: core and non-functional, all files, the same isolation in the hook. No test is skipped, disabled or removed.

## Limitations

- One sample per configuration on one machine; laptop times differ (the owner's Mac runs the mutation files several times slower). The ratio, not the seconds, is the result.
- The record is local and can be bypassed like the hook itself; it is not evidence for a reviewer. CI still runs the required core suite on every PR.
- A pass on a dirty tree that is then committed is recognised (the tree is computed from the working tree); a run during which files change is not recorded.
- The tree is what `git add -A` would commit, so clean filters such as `core.autocrlf` apply, as they do to the commit itself. A tracked file that matches `.gitignore`, or a file absent in a sparse checkout, is missing from the snapshot: the trees then differ and nothing is covered (fail closed).
- Pushing a branch that is not checked out now needs its own checkout and `test:all`; the hook refuses it instead of testing something else.
