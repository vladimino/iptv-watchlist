# AIR-542 batch_start priority drift RCA

> Dated evidence, 19 November 2026 UTC. Not a runtime authority.

[AIR-542](https://trello.com/c/fog6xVqR): `IPTV Predictions v2 00` (about 19:55 Madrid) got HTTP 409 `queue_changed`, `cause=priority`, `queueRefreshed=true`, without a run. Worker log `prediction_step_timing` (`batch_start`, `preflights=2`, `queue_refresh` about 27 s, `wallMs` 39 555) ended at `preflight_refreshed`, never reaching `runner_lease`. The stored shows signature covered 17 401 Discovery-assigned rows; a later read saw 17 413. The concrete `priorityCause` of the second preflight is not visible in that log and is not claimed here.

## Cause in code

`batchStartWork` answered `queue_changed` whenever the preflight repeated after the single queue refresh was still `priorityDue` (`preflight_refreshed`), and again when the post-lease preflight was `priorityDue` or its revision or manifest hash differed (`preflight_lease`).

## Change

- `preflight_refreshed`: only `stale` and an unreadable shows signature still refuse. A priority that moved during the rebuild is accepted as lag (`priorityLagAccepted`). There is still exactly one rebuild per start.
- `preflight_lease`: `stale`, an unreadable signature, or a revision/manifest change not proven to be a re-rank still release the lease and refuse. The proof is `priorityOnlyRebaseCause`, computed from the queue delta (not from `priorityDue` and not from the manifest hash): same programme run, profile and contract; every queue field outside `PRIORITY_QUEUE_FIELDS` equal (`work`, `retries`, `lastBatch`, versions, recovery revision, shape) and the same set of queued films. An identical manifest under a rank-only revision continues; a differing manifest under an unchanged revision refuses; a differing manifest under a moved revision also needs unchanged per-film plan/metadata/fingerprint and no dropped film skipped as not admitted or current or staged. When proven, the start continues on the preflight taken under the lease (`priorityRebased`).
- Unchanged: runner lease and epoch, D1 compare-and-swap, idempotent per-film submit, retry settlement, the AIR-529 rate cap, profile, contract and admission gates.

## Verification

Reviews at `19bd30e`, `c795676` and `ae2ec09` found that the first version used `priorityDue` as the proof. Section 4 of `tests/prediction-hot-reconcile-same-generation.mjs` now races the preflight-to-lease boundary: a re-rank that already cleared `priorityDue` (owned run, hot film first), a re-rank beside a changed retry record, beside a retry-exhausted or removed displaced film, a still-due signature beside a retry change, an unreadable signature and a failed advance gate (all `queue_changed`), and a due signature alone (owned run). The second round added a rank-only revision with a byte-identical manifest (owned run on the same manifest hash) and a concurrent `work`/migration change (409, no run persisted); against `c795676` the first was refused and the second accepted. The same test no longer allows a 409 when a Discovery assignment lands during the rebuild: the start must answer 200 and the next start ranks on the new signature. Production acceptance needs a natural Prediction batch during Discovery and is pending (`Верификация`).

## Third round (`ae2ec09`)

The queue-delta proof compared `pending` and `work` as raw JSON. `buildPredictionQueue` orders `pending` by priority and gives it every hot film, and builds `work` for the films of `pending` only, so a real rebuild that promotes a film reorders and resizes `pending` and adds a `work` entry. The proof therefore refused the target race (`queue_changed`, `cause=revision`); the earlier tests hand-edited `hotPending`/`coldPending` and could not see it. Now `pending` is a priority field (only the union of `pending`, `hotPending` and `coldPending` is compared), keys are compared canonically, and `work` is compared per film where both queues hold an entry, with entries allowed to appear or disappear only for films that entered or left `pending`.

The new tests run the real `buildPredictionQueue` and commit it with `writeQueue` (CAS) between the baseline and post-lease preflights, with a same-generation Discovery assignment that promotes `tmdb_8`: owned run with `tmdb_8` first as hot, `pending` reordered and resized by the rebuild itself. A film that left the queue and a changed `work` classification after the real rebuild still give 409. Against `ae2ec09` the positive case fails with `cause=revision`. The tests first ran through an artefact (the signature counter made the baseline see a changed signature and refresh), which is why the signature is now state-based.
