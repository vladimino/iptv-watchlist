# Targeted prediction recovery of one film: writer audit and NO-GO

| | |
| --- | --- |
| Card | [AIR-281](https://trello.com/c/bjKa4hRj) |
| Date | 31 Oct 2026 (UTC) |
| Method | Code reading of `main` at `bbb9efe` (`src/enrichment.js`, `src/discovery.js`, `src/prediction-diagnostics.js`, `src/domain/data-health.js`, `src/domain/admin-actions.js`), offline tests in this repository |
| Production reads or writes | **None.** No R2, D1, MCP, Scheduled Task, flag or Access read or change; no model call |
| Verdict | **NO-GO for a targeted prediction writer on the current queue.** Delivered instead: a read-only per-film recovery assessment with no action |

## Question

Can the owner page offer a safe, scoped requeue of one film's prediction, with a dry run, a compare-and-swap (CAS) condition and an idempotent receipt, as the [guarded action contract](../../reference/api/admin-actions.md) requires, without a global lease or retry reset, a whole prediction run or a model call?

## What the queue is

- `enrichment/prediction-queue.json` is a **derived projection**. `refreshPredictionQueue` (`src/enrichment.js`, around line 607) rebuilds `hotPending`, `coldPending`, `pending` and the per-film `work` plan from the programme, the catalog, the view index and the taste profile, and keeps `retries` only for films that are still outstanding. Membership is never edited per film.
- Refresh callers: profile update (line 86), prediction `next` / start (line 851), batch progress and completion (lines 903, 924), EPG commit (line 1189), resolver checkpoint (`src/discovery.js` line 472) and `POST /api/enrichment/queue/reconcile` (line 1213).
- Every refresh ends in `saveJSON(env, predictionQueueKey, queue)`: a whole-object put with **no etag condition**. Retry records written on rejection (line 892) and on completion (line 928) are read-modify-write of the same object, also without CAS.
- The prediction runner's mutation routes (`next`, `submit`, `complete`, `heartbeat`, start) run under `predictionWriter` (line 599), a 90-second lease object taken with an etag condition. The EPG commit, profile update, resolver checkpoint and reconcile refreshes do **not** take that lease.
- Retry policy: `retryAt = now + min(6 h, 1 h · 2^(attempts − 1))`; there is no terminal state. `queueReadyIds` (line 770) takes the hot lane while any hot work remains, otherwise the cold lane, minus films whose `retryAt` is in the future.

## Decision matrix

| Film state (assessment cause) | Would a per-film queue write help? | Verdict |
| --- | --- | --- |
| `queued_ready` | No. The film is already returned by `queueReadyIds`; only a run processes it | ordinary schedule |
| `ready_no_runs` | No. The queue has not been checked for more than 24 hours; the cause is the external Scheduled Task | check the Task |
| `retry_backoff` | Only by clearing `retryAt`, which bypasses the backoff policy the card forbids touching | respect backoff |
| `repeated_failures` (≥ 5 attempts) | No. A contract rejection (`validation_error`, `parse_error`, `format_error_storm`) repeats on the same input; an infrastructure failure (`storage_error`, `quota`, `time_budget`, `model_unavailable`, `api_error`, lease loss or expiry, external termination) is not in the film at all; any other kind (including the catch-all `model_error`) is unclassified | fix caller output / fix the infrastructure / investigate |
| `queue_refresh_pending` | Briefly: the next refresh overwrites membership, and adds the film itself | wait for refresh |
| `waiting_behind_hot` | Only by breaking the hot-first rule | ordinary schedule |
| `in_flight`, `run_active` | It would race the live run's lease | wait |
| `prediction_current`, `index_ahead_of_queue` | Nothing to do | none |
| `index_inconsistent`, `not_in_catalog` | No. The cause is the view index or the identity subsystem | other subsystem |
| `profile_missing`, `snapshot_partial`, `queue_unavailable`, `film_unreadable`, `queue_state_unknown` | No. The evidence is incomplete; the guarded contract refuses such a preview | reread |

No row has a case that is both recoverable by a write and safe. In addition, no per-film write into the queue object can carry CAS semantics while the other writers put the whole object blindly: an edit made between two refreshes is lost without any error.

## Alternatives for a future writer

Each needs its own card, an accepted ADR, the Mermaid changes it implies and owner approval before implementation. None is implemented.

1. **Per-film override object honoured by the refresh.** A separate object per film (for example `enrichment/recovery/<id>.json`) written with `onlyIf` etag CAS, holding `{filmId, requestedAt, expiresAt, reason, profileVersion, profileHash, programmeRunId, previousRetry}`. `refreshPredictionQueue` would read overrides under the `predictionWriter` lease and place an overridden film at the head of its lane while the override's profile and programme still match (fencing by the profile hash and the run id). Idempotency: the scope key is `filmId + profileHash + programmeRunId`; a second request with the same key returns the first receipt. Rollback: delete the override object; the before-image is the absent object. It still must not clear `retryAt` (backoff stays authoritative), so its only effect is ordering, which helps none of the matrix rows above except a cold film behind hot work, where it would deliberately break the priority rule.
2. **Owner-triggered whole-queue reconcile under the writer lease (partial mitigation only).** Wrap `POST /api/enrichment/queue/reconcile` in `predictionWriter` and add an etag condition to its queue put. A guarded action would then be "reconcile the queue now", scoped to the whole queue, with the queue etag as the CAS input and the refreshed queue as the receipt. This fences only the manual reconcile against runner mutations; the EPG commit, profile update and resolver checkpoint refreshes and the runner's own retry writes stay blind, so the lost-retry race below remains. It is not a per-film action and not a remedy for queue safety.
3. **Cross-writer conditional queue writes (the remedy for the race; prerequisite of 1).** Every writer of `enrichment/prediction-queue.json` (all refresh triggers, the rejection and completion retry writes) reads the object with its etag, computes the next value from that read and writes with `onlyIf: {etagMatches}`; on a conflict it re-reads and recomputes, with a bounded number of attempts, as `mergeStoredJSON` already does for other objects. Retry records then survive any interleaving, because a refresh that read an older `retries` map cannot overwrite a newer one. A lease-holding runner keeps renewing its lease immediately before the write (`beforeWrite`), so a writer that lost its lease cannot commit (fencing by the lease id). Alternatives within it: move `retries` into their own object written with CAS, so refreshes never carry them forward; or serialize every queue writer under one lease. Idempotency: a refresh is a pure function of its inputs, and a retry write is keyed by `lastRunId` (already skipped when equal). Rollback: revert the code; no stored format changes when `retries` stay in the queue object.
4. **Do nothing; explain.** The read-only assessment shows why the film waits and which ordinary mechanism handles it. This is the delivered option.

## Risk found for owner triage

Several writers put the whole queue object without an etag condition, and the EPG commit, profile update, resolver checkpoint and reconcile refreshes do so outside the prediction writer lease. Every refresh carries forward the `retries` map it read at its start. A refresh that interleaves with a rejection or completion retry write therefore replaces the just-written retry record with the older map. A refresh rebuilds **membership** from its inputs; it does **not** recover a lost `retryAt` or `attempts`. The consequences are:

- the film becomes eligible immediately instead of after its backoff, so the next run sends it to the model again (premature model work, the same failure repeated);
- the attempt counter restarts, so the next backoff is the shortest (1 h) instead of the escalated one, and the five-attempt escalation to `repeated_failures` is delayed;
- two refreshes that interleave can also drop each other's membership, which the next refresh does repair.

The manual reconcile route is one unfenced writer, not the only one. Options for the owner: accept the risk, address it in a separate queue reliability card (alternative 3 is the remedy; alternative 2 alone is a partial mitigation for the manual route), or defer. This audit and its delivery change nothing about it; the race is pre-existing and outside this read-only scope.

## Delivered

A read-only route `GET /api/admin/prediction-recovery?film=<id>` and the «Разобрать прогноз» panel on `/admin/limbo` ([contract](../../reference/api/admin.md#prediction-recovery-get-apiadminprediction-recovery)). The route reads through a bucket wrapper that exposes only `get`; the assessment's `targetedAction.available` is always `false` and `writer.exists` is `false`. Tests: `tests/prediction-recovery.mjs` (every cause and the decision order), `tests/admin-prediction-recovery-api.mjs` (read set, pin, torn and failed reads, verdicts through the Worker entry, canary text, no write, list or outbound request), `tests/admin-prediction-recovery-page.mjs` (copy, fail closed, escaping, Madrid times, toggle, recheck after a change), `tests/get-side-effects.mjs` (read set, no put).

## Limits

- Code reading only. No production queue, lease or retry state was observed; the matrix says what the code does, not how often each state occurs.
- The lost-update risk is derived from the absence of conditions in the code, not from an observed incident; how often refreshes and retry writes interleave in production was not measured.
- Line numbers refer to `bbb9efe` and drift with later changes.
