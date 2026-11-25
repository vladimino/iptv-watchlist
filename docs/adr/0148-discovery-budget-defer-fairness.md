# ADR 0148: A TMDB-touched Discovery candidate that cannot be stored is deferred per key, not as a series backoff

**Status:** Accepted  
**Original decision date:** 2026-11-15  
**Recorded at:** 2026-11-15  
**Approval source:** Product Owner explicit design approval, 15 November 2026, recorded at [PR #658 comment](https://github.com/vladimino/iptv-watchlist/pull/658#issuecomment-6899635604) (conversation provenance; not a GitHub comment authored by the owner). The 40 s chunk budget and 16 TMDB requests per chunk are unchanged; retuning them is a separate future decision.  
**Related work:** [AIR-492](https://trello.com/c/09ys5uPy), [ADR 0109](0109-discovery-keyset-candidate-selection.md), [AIR-425](https://trello.com/c/oxFXx6Bn)  
**Supersedes:** ADR 0109 in part: the stored `partial` / `wall_budget` / five-minute status `retryAt` when a candidate was started and TMDB ran, but no decision could be counted  
**Superseded by:** None

## Context

A D1 paged chunk still has a 40 s wall budget. TMDB is hot-sorted inside the selected keyset. When the first pending candidate consumes a request and then hits `BudgetExhaustedError`, a persist-limit `late` save, or a TMDB timeout, `checked` stays 0. The handled-prefix cursor does not advance past that key in observation order, and a status `retryAt` five minutes ahead makes the Workflow `wait(reason=backoff)`. The same hot candidate is selected again.

Read-only Workflow history for 13 November 2026, 06:00–17:00 Europe/Madrid, showed hours with `checked=0`, `tmdbCalls=1`, `retryAt` ≈ +5 min. Historical `src/discovery.js` at `a3018952` collapsed some thrown names to `error=unknown`; the primary exception and a logged `wall_budget` on those instances are **not** proven. `wall_budget` plus head-of-line plus series backoff is the causal mechanism reproduced offline. AIR-425 already removed full-ledger walk starvation (`tmdbCalls=0`, `cheapMs=0`). This record is not AIR-483 (`programme_changed` / `intent_uncertain`) and not AIR-480 slot assignment.

Raising `PAGED_CHUNK_BUDGET_MS` or shortening the five-minute backoff is out of scope. Marking the observation checked or verified without a stored identity is forbidden.

## Decision

1. Before a paged-chunk candidate starts TMDB, the chunk writes one fenced `writeDecisionDelta` fairness fence for that key (`retryAt` five minutes ahead, `deferReason: wall_budget`, no `attempts` increment, not `verified` / not `checked`) **while `persistLimit` still allows that one write**. TMDB then runs. A later stored identity overwrites the fence. If the request overruns `persistLimit` (`saveCandidate` `late`, `BudgetExhaustedError`, TMDB `TimeoutError` / `AbortError`), **no second defer write** is started; the pre-fence already rotates HOL. SQL `retry_at` excludes that row until the fence expires. A hop that cannot write the pre-fence does not start TMDB.
2. While other observations are still eligible now, the series status **does not** set `retryAt`; continuation is the ordinary `paused` hop with `remainingChunks-1`. When eligible-now `remaining` is 0 but `waitingRetry` (current-window rows fenced only by a future `retry_at` **and** `deferReason: wall_budget`) is positive, the hop stays `partial`, stores series `retryAt` at that `MIN(retry_at)`, and must **not** checkpoint `complete`. After that time the same generation resumes. Completing a generation requires eligible-now remaining 0 **and** `waitingRetry` 0. Uncertain-match `retry_at` without that defer reason does not keep the generation open.
3. `selectAfter` may include a deferred key in the handled prefix only when `writeDecisionDelta` listed that key in `written`. A CAS skip (`conflict`, `observation_gone`, `evidence_changed`) restores the in-memory previous decision and does not advance the cursor. Unprocessed pending keys without a stored defer are still not jumped (ADR 0109).
4. A hop that starts **no** TMDB candidate (selection overran, or writes so slow that nothing fits) still stores `error: wall_budget` and a five-minute series `retryAt`. TMDB HTTP 429 still sets a series `retryAt` from `Retry-After`.
5. Eligible-now `remaining` subtracts settled and keys that still carry this hop's fairness fence. `waitingRetry` is the SQL count of current-window unresolved rows ineligible only because of a future `retry_at` with `deferReason: wall_budget`. `deferred` is fences still standing at hop end (overwritten identities are not deferred). Series `error: wall_budget` is only when **no** TMDB call started and no fence landed. The 40 s checkpoint reserve is unchanged; the pre-fence uses the reserved defer write **before** TMDB. A CAS skip is not handled. No new table, index, flag, cron, Task or Workflow.

The 16 November 2026 natural-run failure (cheap/replay `writeMaxMs` starving TMDB with `tmdbCalls=0`) is a **budget-arithmetic** correction under this same decision: checkpoint reserve counts the final writes, not the pre-TMDB fence times the slowest cheap/replay batch, and cheap/replay yield one TMDB start while eligible candidates remain. It does not change fairness/order, `retry_at`, or the 40 s / 16-call caps.

What is **not** decided: changing the 40 s wall or the 16-request cap; hot-first order across the whole ledger; treating `unknown` in historical Workflow records as proven `wall_budget`.

## Alternatives considered

- **Raise the 40 s budget or shorten the five-minute backoff.** Forbidden by AIR-492; it does not stop head-of-line.
- **Advance `selectAfter` to the last selected row without a stored fence.** Already rejected in ADR 0109 (loses unprocessed keys). A hot-sorted HOL is often not the first key, so cursor-only skip would not rotate it.
- **Count the unfinished candidate as checked.** Violates conservation: no identity, no exact-once decision.
- **Keep series backoff whenever `checked===0`.** Reproduces the 13 November stall while thousands of other rows are eligible.

## Consequences

A persistently slow or aborting TMDB title no longer blocks the rest of a 7k–12k actionable set for hours. After five minutes the deferred key is eligible again. A 429 still cools the whole hop. Operators distinguish `deferred>0` / `error=null` (fairness fence) from `error=wall_budget` / status `retryAt` (nothing started).

## Recovery and migration boundary

Code rollback restores series backoff on zero `checked`. It does not delete `retry_at` already written. Deploy does not run a chunk, reset a lease, or change flags. Production acceptance is later **natural** Workflow cycles: no long streak of `0 checked / 1 TMDB / 5 min backoff` while the SQL remaining set stays large. One fast hour is not acceptance.

## Evidence

- **Original decision:** [AIR-492](https://trello.com/c/09ys5uPy)
- **Implementation:** this PR
- **Dated verification:** [AIR-492 evidence](../evidence/discovery/air-492-budget-starvation-2026-11-15.md); [cheap/replay follow-up](../evidence/discovery/air-492-cheap-replay-starvation-2026-11-16.md)
- **Uncertainty:** historical Workflow `error=unknown` is not a stored `wall_budget` code; offline tests prove the current main mechanism, not the 13 November exception text

## Follow-ups

Natural-run acceptance stays on AIR-492 (`Верификация`). AIR-480 addressed slots remain a separate card.

## Amendment: Workflow chunk budget (AIR-682, 25 November 2026)

The 40 s wall budget in this record, and the rejection of raising it, are superseded in part for a chunk run by the Discovery Workflow, which now has 300 s (Product Owner direct instruction on [AIR-682](https://trello.com/c/UWYTPEDB), 25 November 2026: "сделай задачу на увеличение этого бюджета до 5 минут по моему распоряжению. без экспериментов и обоснований"). The per-key deferral, the 16-request cap and the fairness rules are unchanged and apply to the longer budget. The status stays Accepted.
