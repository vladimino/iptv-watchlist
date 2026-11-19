# AIR-542 batch_start priority drift RCA

> Dated evidence, 19 November 2026 UTC. Not a runtime authority.

[AIR-542](https://trello.com/c/fog6xVqR): `IPTV Predictions v2 00` (about 19:55 Madrid) got HTTP 409 `queue_changed`, `cause=priority`, `queueRefreshed=true`, without a run. Worker log `prediction_step_timing` (`batch_start`, `preflights=2`, `queue_refresh` about 27 s, `wallMs` 39 555) ended at `preflight_refreshed`, never reaching `runner_lease`. The stored shows signature covered 17 401 Discovery-assigned rows; a later read saw 17 413. The concrete `priorityCause` of the second preflight is not visible in that log and is not claimed here.

## Cause in code

`batchStartWork` answered `queue_changed` whenever the preflight repeated after the single queue refresh was still `priorityDue` (`preflight_refreshed`), and again when the post-lease preflight was `priorityDue` or its revision or manifest hash differed (`preflight_lease`).

## Change

- `preflight_refreshed`: only `stale` and an unreadable shows signature still refuse. A priority that moved during the rebuild is accepted as lag (`priorityLagAccepted`). There is still exactly one rebuild per start.
- `preflight_lease`: `stale`, an unreadable signature, or a revision/manifest change not proven to be a re-rank still release the lease and refuse. The proof is `priorityOnlyRebaseCause` (not `priorityDue`, which says nothing about where a change came from): same programme run, profile and contract; unchanged plan, metadata and fingerprint of every film in both manifests; displaced films still pending, not retry-exhausted, not staged, still admitted and not current; unchanged retry records of the whole queue, and a changed manifest (a revision change that leaves it identical keeps the refusal). When proven, the start rebases once onto the preflight taken under the lease (`priorityRebased`) and persists the run.
- Unchanged: runner lease and epoch, D1 compare-and-swap, idempotent per-film submit, retry settlement, the AIR-529 rate cap, profile, contract and admission gates.

## Verification

Review at `19bd30e` found that the first version used `priorityDue` as the proof. Section 4 of `tests/prediction-hot-reconcile-same-generation.mjs` now races the preflight-to-lease boundary: a re-rank that already cleared `priorityDue` (owned run, hot film first), a re-rank beside a changed retry record, beside a retry-exhausted or removed displaced film, a still-due signature beside a retry change, an unreadable signature and a failed advance gate (all `queue_changed`), and a due signature alone (owned run). The same test no longer allows a 409 when a Discovery assignment lands during the rebuild: the start must answer 200 and the next start ranks on the new signature. Production acceptance needs a natural Prediction batch during Discovery and is pending (`Верификация`).
