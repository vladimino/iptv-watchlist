# AIR-492: cheap/replay write-cost starving TMDB — RCA and offline fix

16 November 2026. Code and tests on the AIR-492 follow-up branch against `main` at `6f96bab8`. No production chunk, TMDB, lease reset or Workflow create.

## Production (read-only, from the AIR-492 Trello comment of 16 November 2026, evening Europe/Madrid)

Cloudflare Workflow `iptv-discovery`, published programme `47663279-3e6b-423d-b696-b22edfcead91`, D1 Discovery `d1`/`open`. Natural instances `discovery_476632793e6b423db696b22edfcead91_1`–`_3`: after one hop at 18:06 UTC with `checked=3` / `tmdbCalls=6`, **22 consecutive completed zero-result chunks** through 20:53 UTC (`checked=0`, `added=0`, `tmdbCalls=0`, ≈5 min apart). Direct D1 `discovery_status` at `2026-11-16T20:53:33.855Z`: `error=wall_budget`, `retryAt` ≈ +5 min, `remaining=10216`, `deferred=0`, `waitingRetry=0`, `walkMs=1051`, `cheapMs=14672`, `writeMaxMs=2802`, `preCommitMs=18568`, `assignment.replayed=19` / `replayRemaining=19`, `revalidation.deferred=1`. Last `discovery_decision_history` resolver row at 18:06:22Z. External diagnostics mapped `wall_budget` to `unknown`. Distinct from 13 November (`tmdbCalls=1`) and from AIR-488 `slotScanConfirmation`.

## Mechanism on `main` before this follow-up

`persistLimit` reserved `(PAGED_FINAL_WRITES + PAGED_DEFER_WRITES) × writeCostMs` (7 × 2802 ms ≈ 19.6 s). Starting TMDB also required `now + 2 s + 2 × writeCostMs`. After cheap/replay (~14.7 s) the start threshold was already past persistLimit, so the hop never entered `persistBudgetDefer`, stored series `wall_budget`, and did not rotate HOL. Slot assignment still ran; TMDB resolution starved.

## Offline reproduction and fix

`tests/discovery-chunk-budget.mjs` case 17 (sqlite stand-in, fake clock, no network): 19 verified replay keys, 12 extra unresolved hot keys, every D1 write batch +2.8 s virtual. After the fix, two consecutive hops both start TMDB, do not store series `wall_budget`, and finish inside 40 s. Case 16 (3 s cheap writes with pending candidates) now starts TMDB instead of searching nothing. The 5 s-per-batch honest degradation still stores `wall_budget` with no TMDB. ADR 0148 late-TMDB +36 s control is unchanged. `diagnosticErrorCode({message:'wall_budget'})` is `wall_budget`. Bundled `workflow-entry.js` contains that allowlist branch.

40 s wall and 16 TMDB calls unchanged. No new flag, Task, schema or Workflow.

## Verdict

**Offline GO for the cheap/replay budget split.** Production acceptance remains natural Workflow observation on AIR-492: no long streak of `0 checked / 0 TMDB / wall_budget / 5 min` while SQL remaining stays large.

## Limits

No live D1 latency in this file. Production numbers above are quoted from the authorized Trello L0 comment, not re-queried here.
