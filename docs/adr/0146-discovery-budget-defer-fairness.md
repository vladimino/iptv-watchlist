# ADR 0146: A TMDB-touched Discovery candidate that cannot be stored is deferred per key, not as a series backoff

**Status:** Accepted  
**Original decision date:** 2026-11-15  
**Recorded at:** 2026-11-15  
**Approval source:** Product Owner scope on [AIR-492](https://trello.com/c/09ys5uPy) (RCA plus minimal fairness fix; no new flag, Task, Workflow, schema or EPG ownership change)  
**Related work:** [AIR-492](https://trello.com/c/09ys5uPy), [ADR 0109](0109-discovery-keyset-candidate-selection.md), [AIR-425](https://trello.com/c/oxFXx6Bn)  
**Supersedes:** ADR 0109 in part: the stored `partial` / `wall_budget` / five-minute status `retryAt` when a candidate was started and TMDB ran, but no decision could be counted  
**Superseded by:** None

## Context

A D1 paged chunk still has a 40 s wall budget. TMDB is hot-sorted inside the selected keyset. When the first pending candidate consumes a request and then hits `BudgetExhaustedError`, a persist-limit `late` save, or a TMDB timeout, `checked` stays 0. The handled-prefix cursor does not advance past that key in observation order, and a status `retryAt` five minutes ahead makes the Workflow `wait(reason=backoff)`. The same hot candidate is selected again.

Read-only Workflow history for 13 November 2026, 06:00–17:00 Europe/Madrid, showed hours with `checked=0`, `tmdbCalls=1`, `retryAt` ≈ +5 min. Historical `src/discovery.js` at `a3018952` collapsed some thrown names to `error=unknown`; the primary exception and a logged `wall_budget` on those instances are **not** proven. `wall_budget` plus head-of-line plus series backoff is the causal mechanism reproduced offline. AIR-425 already removed full-ledger walk starvation (`tmdbCalls=0`, `cheapMs=0`). This record is not AIR-483 (`programme_changed` / `intent_uncertain`) and not AIR-480 slot assignment.

Raising `PAGED_CHUNK_BUDGET_MS` or shortening the five-minute backoff is out of scope. Marking the observation checked or verified without a stored identity is forbidden.

## Decision

1. When a paged-chunk candidate **increments `tmdbCalls`** and then cannot be stored (budget exhaustion after that call, TMDB `TimeoutError` / `AbortError`, or `saveCandidate` `late`), the chunk writes one fenced `writeDecisionDelta` for that key: same previous payload if any, same `evidenceKey`, **no** `attempts` increment, **not** `verified` / not counted in `checked`, `retryAt` five minutes ahead, `deferReason: wall_budget` in the JSON payload. SQL `retry_at` already excludes that row from `selectActionableObservations` until the fence expires.
2. The series status **does not** set `retryAt` in that case. Continuation is the ordinary `paused` hop with `remainingChunks-1`, not `reason: backoff`. Other eligible keys of the same generation are selected on the next hop.
3. `selectAfter` may include a deferred key in the handled prefix (it has a stored fence). Unprocessed pending keys without a stored defer are still not jumped (ADR 0109).
4. A hop that starts **no** TMDB candidate (selection overran, or writes so slow that nothing fits) still stores `error: wall_budget` and a five-minute series `retryAt`. TMDB HTTP 429 still sets a series `retryAt` from `Retry-After`.
5. `remaining` subtracts deferred keys as well as settled ones. `deferred` is a bounded count on the chunk summary and step diagnostic. No new table, index, flag, cron, Task or Workflow.

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
- **Dated verification:** [AIR-492 evidence](../evidence/discovery/air-492-budget-starvation-2026-11-15.md)
- **Uncertainty:** historical Workflow `error=unknown` is not a stored `wall_budget` code; offline tests prove the current main mechanism, not the 13 November exception text

## Follow-ups

Natural-run acceptance stays on AIR-492 (`Верификация`). AIR-480 addressed slots remain a separate card.
