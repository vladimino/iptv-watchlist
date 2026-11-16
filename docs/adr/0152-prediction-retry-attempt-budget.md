# ADR 0152: Ten saved per-film prediction failures exhaust automatic retry

**Status:** Accepted (owner product behaviour on [AIR-505](https://trello.com/c/6sUquhw0); code only, no production prediction run, retry reset, catalog exclusion or Scheduled Task authorized)  
**Original decision date:** 2026-11-16  
**Recorded at:** 2026-11-16  
**Approval source:** Owner design on [AIR-505](https://trello.com/c/6sUquhw0) (16 November 2026, Europe/Madrid)  
**Related work:** [AIR-505](https://trello.com/c/6sUquhw0); [ADR 0015](0015-queued-prediction-recovery.md); [ADR 0122](0122-prediction-batch-runner-v2-dual-protocol.md)  
**Supersedes:** None. Qualifies the unbounded per-film retry of [ADR 0015](0015-queued-prediction-recovery.md).  
**Superseded by:** None

## Context

The prediction queue stores a monotonic `retries[filmId].attempts` and exponential `retryAt` (capped at six hours) for per-film `parse_error` / validation failures. The same Film ID could remain eligible forever: a rebuild copied retries only for films still outstanding, so dropping a film from `hotPending` did not survive the next EPG or profile refresh. Caller-reported `insufficient_evidence` also counted toward `format_error_storm`, so several content-specific failures could stop a run that still had good neighbours.

Owner review of Documentary/Concert candidates ([catalog policy exclusion](0150-documentary-and-concert-film-exclusion.md)) is a separate writer. Ten prediction failures do not prove a non-film and must not call that writer.

## Decision

1. **Budget.** After ten *saved* unsuccessful attempts of one Film ID for a retryable per-film result (`parse_error`, `validation_error`, Worker or caller-reported, including `insufficient_evidence`), `retries[filmId].attempts >= 10` is the eligibility gate. The film is excluded from v5 `next`, v2 `batch_start` / batch selection and ordinary queue rebuild. There is no `parked` enum and no new Film or Discovery lifecycle state.
2. **Counter.** Use the existing monotonic `attempts`. The same `runId` / identical submit replay does not increment. `deferred_budget`, `needs_regeneration`, `already_running`, transport rejects and systemic failures (`storage_error`, lease loss, catalog held, profile/contract change, quota, `format_error_storm` as a run stop) do not consume the per-film budget.
3. **Persistence.** Exhausted retry records stay in the D1-authoritative queue document, including when the film leaves the current catalog. Identities still in the current catalog (unpredicted / outstanding) keep their exhausted marker through rebuild; they are never dropped to make room for history. Exhausted identities that have left the catalog are bounded to 500 by recency of `failedAt`. A rebuild or EPG generation does not re-queue them. Success still deletes the retry record. This ADR does not add a retry-reset writer.
4. **Selection.** An exhausted film is removed from `hotPending` / `coldPending` / `pending` without incrementing `hotPredicted`. Remaining hot work continues; when every remaining hot film is exhausted, the cold lane proceeds. Coverage treats the film as not predicted.
5. **Storm.** `format_error_storm` remains for five consecutive *worker* contract failures (`reportedBy: worker`, or a v5 kind-only report with no `claimed.reason`). A caller-reported claim with a closed reason (`insufficient_evidence`, `preflight_validation_failed`, `json_unparseable`, `request_too_large`) does not increment that streak.
6. **Review.** Diagnostics expose `retryExhausted` and cause `prediction_retry_exhausted`. The cases are owner-review *candidates*. They are not sent to `catalog_policy_exclude@1`.

## Alternatives considered

- **A distinct `parked` ledger or Film status.** Rejected by the owner: it would diverge from `attempts` and invent a lifecycle state that is only a selection hold.
- **Automatic `catalog_policy_exclude@1` after ten failures.** Rejected: ten model failures do not prove Documentary/Concert.
- **Infinite backoff only.** Rejected: a rebuild would still reselect the film when `retryAt` elapsed.

## Consequences

Automatic hourly runs skip exhausted identities and keep processing neighbours. Rollback of the code does not clear stored `attempts`; a reverted Worker that ignores the gate can select those films again. An owner-approved retry reset is a later card.

## Recovery and migration boundary

This ADR authorizes no production write, retry reset, flag change or Scheduled Task. Deploying the Worker is not permission to run predictions or to exclude catalog films.

## Evidence

- **Original decision:** [AIR-505](https://trello.com/c/6sUquhw0)
- **Implementation:** this delivery
- **Dated verification:** offline tests in `tests/prediction-retry-exhausted.mjs`; production selection after deploy is a later natural-run observation
- **Uncertainty:** live exhausted counts after deploy are not recorded here
