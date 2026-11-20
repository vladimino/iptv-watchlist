# Hot queue parity: offline evidence

- **Date:** 20 Nov 2026 UTC.
- **Card:** [AIR-536](https://trello.com/c/G2DKOFyo). **PR:** PR_LINK_PLACEHOLDER.
- **Scope:** the read-only `prediction_hot_parity` MCP tool (`predictionHotParity` in `src/prediction-diagnostics.js`) and its contract in [prediction diagnostics](../../reference/api/prediction-diagnostics.md#hot-queue-parity). Offline only: a migrated sqlite D1 stand-in, a local R2 and the real Worker code in a Node `vm`. No production read, write, run, Task, flag, migration or model call was made for this report.

## Method

The expected side is not a second implementation of the queue rules. `predictionHotParity` pins the published D1 generation, reads the stored queue head, and runs `buildPredictionQueue` in memory at the call's own cutoff (a new `options.now`; every other caller keeps the wall clock) with the stored queue as `previous`. The two hot lanes are compared as sets, retry-exhausted ids excluded from both. A difference is classified clock-only when the Film, with the shows it has now, is classified at the queue's own build instant exactly as the queue classified it (`predictionPriority`, the queue's own predicate). After the evaluation the generation fence, the queue revision and the assigned-shows signature are read again; any change is `unknown`.

## Fixtures and results (`tests/prediction-hot-parity.mjs`, 3,200 Discovery-admitted films, one generation)

| Scenario | Result |
| --- | --- |
| Cold queue equal to the facts | `match`, 0 hot on both sides, 3,200 films evaluated |
| 3,100 films get completed shows in the same generation, queue not rebuilt (the false queue snapshot) | `mismatch`, `shows_signature_changed`, expected hot 3,100 against queue hot 0, examples bounded to 10 of 3,100; the queue would select 3,200 cold ids while 3,100 are hot |
| Natural rebuild | `match`, 3,100 hot on both sides |
| One hot id dropped, one unknown id added | `mismatch`: `absent_from_queue` 1, `no_longer_outstanding` 1, the examples name them |
| Hot film listed cold | `mismatch`, `reclassified_hot` |
| Film settled by a real submit, then an older queue snapshot put back (mismatched freshness) | `mismatch`, `no_longer_outstanding`; the settled queue itself is `match` |
| One retry-exhausted and one backed-off hot film | `match`; `retryExhausted` 1, `hotDeferredByRetry` 1 on both sides |
| New Discovery admission with a same-run show | `mismatch`, `absent_from_queue`; `match` after the rebuild |
| Window edge crossed 10 min after the build, lower edge for 3,000 films and upper edge for 200 films | `degraded`, `window_transition_deferred` (inside the 15-minute cap) |
| The same edge 20 min after the build | `mismatch`, `window_transition` (beyond the cap); at the build instant `match` |
| EPG rollover to another `programmeRunId` | `degraded`, `generation_rollover_pending` |
| D1 catalog read fails | `unknown`, `source_unreadable`, no error text in the answer |
| Unreadable assigned-shows signature | `unknown`, `shows_signature_unreadable` |
| No live D1 generation (lost authority) | `unknown`, `epg_authority_not_d1` |
| Generation moves, a concurrent CAS writer commits the queue, or Discovery assigns shows during the evaluation | `unknown`: `generation_changed_during_read`, `queue_changed_during_read`, `shows_changed_during_read` |
| Queue built under another profile | `unknown`, `queue_not_comparable_profile_changed` |
| Programme not recorded | `unknown`, never an empty hot lane |

Every call is wrapped so that a non-`SELECT` D1 statement, a write batch, or a changed stored queue document fails the test. The MCP audit (`tests/get-write-audit.mjs`) calls the tool in every read scenario.

## Cost on 3,200 films (stand-in, one parity read, a `match`)

176 ms wall, 39 statements (all `SELECT`), 25 D1 round trips, the assigned-shows signature read 3 times (before, and once more as the post-evaluation fence), `elapsedMs` reported in the answer 172. The test bounds the round trips at 40.

## Limits and verdict

- The numbers are from a local sqlite stand-in: they show the number of statements and that no write is issued, not production D1 latency, rows read or CPU. The production budget is **not measured**. The tool is a full catalog read and stays out of `prediction_batch_start`; it is an occasional owner check.
- `expected.hotOutstanding` is a count only when the verdict is `match` or `mismatch`; it is withheld on `unknown`.
- The comparison uses the stored retry records of the queue as the retry authority, so a retry record the queue lost is not detected as a difference.
- **Verdict:** offline acceptance of the card is met. Production verification (one read-only call after natural EPG, Discovery and Prediction runs, with `elapsedMs` and D1 latency evidence) and owner acceptance are **not done** and need the agreed read-only probe after the Worker deploy; no manual `batch_start`, reconcile POST, Task, model or D1/R2 write is part of it.
