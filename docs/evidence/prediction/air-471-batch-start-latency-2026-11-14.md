# AIR-471: `batch_start` latency and stage telemetry (offline)

**Capture:** 14 November 2026 (UTC), offline: the real Worker code over a sqlite D1 stand-in and an in-memory R2, counted by the `prediction_step_timing` instrumentation (`tests/prediction-batch-start-budget.mjs`). "main" is `f314b339` (the commit this change branches from).
**Scope:** code, tests, instrumentation and docs of [AIR-471](https://trello.com/c/rFBAixZe), follow-up of the [AIR-468 RCA](air-468-batch-start-rca-2026-11-14.md). No production read or write, no Scheduled Task, no `prediction_batch_start` against production.
**Verdict:** Offline PASS for the D1 reduction and the behaviour parity. The target of at most 60 D1 calls on a **current queue is not met** (82; R2 is within it at 48). Production latency is not measured here and is not claimed.

## What changed

| Change | Effect | Safety |
| --- | --- | --- |
| The queue refresh and settlement (`batchRefreshQueue`) select with the requested `manifestSize` as limit; it defaulted to 100 films (scan cap 300, up to 3 rounds) | A refresh scans about the five films the manifest needs instead of a hundred | A film behind that window leaves the queue when a later start reaches it; every film that would block the manifest is still settled in the same start (up to 3 rounds, as before) |
| The freshness check of a start reads each film's fingerprint and **current** prediction, not the replaced versions (`currentOnly` through `loadJSON` to `routeRead`) | No lineage query and no R2 body per replaced version | The start never looked at replaced versions (freshness uses the current record, the manifest holds the stored fingerprint); other readers keep the full read |
| The start's read-only passes share the authority marker read through the AIR-441 request scope; the scope is dropped before the idle outcome, the settlement of the previous run, the queue refresh, the lease acquire and the post-lease preflight | About 40 of the roughly 50 marker batches of a start disappear | Every write and the post-lease revalidation read the marker afresh; a marker or queue change between the two preflights still ends as `queue_changed`; the object scope is not used |
| Stage-level telemetry in the `batch_start` line: `stages`, `preflights`, `refreshRounds`, `scannedFilms`, `settledFilms`, `leaseRefused`, `liveLeaseAgeMs`, and named R2 classes for what was `r2:other` | Where the time and calls go per start; a repeated start is correlated with the live lease | Counters and closed names only; no storage call is added; a failure of the timing code changes nothing |

Not done on purpose: no early `already_running` before the preflight (it would change the precedence of the 409 answers for a missing profile, a missing snapshot and a held catalog while a lease is live, for a refusal that is not on the owner's path); no idempotent start and no adoption of a run; no change of `manifestHash`, response fields, byte limit, dry run or pin.

## Counts (manifestSize 5 unless noted)

| Scenario | R2 calls main -> now | D1 calls main -> now | D1 statements main -> now |
| --- | --- | --- | --- |
| Current queue (40 films) | 48 -> 48 | 131 -> 82 | 245 -> 118 |
| Second start while the lease is live (`already_running`) | 9 -> 9 | 41 -> 21 | 73 -> 23 |
| Stale queue (profile moved), 100 films | 59 -> 59 | 664 -> 118 | 1197 -> 161 |
| Three films without admission at the head, 100 films | 56 -> 56 | 1156 -> 143 | 2077 -> 186 |
| `manifestSize` 100, 130 films | 48 -> 48 | 1083 -> 464 | 1957 -> 500 |

Manifest bytes, film ids, `manifestHash` and response fields are identical to main in these scenarios (the existing `prediction-batch-start` and `prediction-manifest-size` tests pass unchanged). The R2 count does not move offline because the stand-in has no replaced prediction versions with R2 bodies; the saving on films that have them (one body per replaced version per pass) is shown only as the absence of lineage queries and is **not** quantified here.

Where the remaining 82 D1 calls of a current-queue start go (stage line): two preflights of about 17 each (two reads per selected film, the discovery admission authority checks, the profile, the queue), the lease and settlement checks, and 36 in `persist` (run, lease and queue bookkeeping that the start owns). The per-film reads and the post-lease preflight are the revalidation of selected inputs that ADR 0122 and this card keep; the discovery authority reads (four per admission lookup) belong to another module and are not scoped here. Getting under 60 would need batching the per-film reads or scoping the discovery authority read, both larger changes than this card, so the target is **escalated to the owner**, not bypassed.

## Behaviour checked (same test file)

- `stages` names are closed, sequential and their counts add up; the line holds no film id, key or statement.
- A refused start carries `leaseRefused: 1` and `liveLeaseAgeMs`, names the live holder and creates no run.
- A refresh scans at most the films the five-film manifest needs; three settled films leave the queue and none is delivered.
- A film with replaced prediction versions: the start issues no lineage query and still delivers its stored fingerprint as `prediction_only`.
- A change of a selected film's input between the first preflight and the lease, with the queue revision unchanged, is refused as `queue_changed` with no run row and the lease released.
- The existing concurrency tests (a queue write before and after the lease acquire) keep their result.

## Not claimed

- Production wall time, p95 or throughput: the natural-run objective (p95 `batch_start` below 30 s, no repeated start, no abandoned lease) is measured only after a separate owner GO in [AIR-451](https://trello.com/c/NN3N6kRp), with N and a confidence interval stated.
- Why a repeated start arrives about 60 s after the first (client side, unproven in the RCA).
- Any Scheduled Task enable, run or edit; Task A stays paused.

## Reproduce

```
node tests/prediction-batch-start-budget.mjs
node tests/prediction-batch-start.mjs
node tests/prediction-manifest-size.mjs
node tests/prediction-step-timing.mjs
```
