# AIR-471: `batch_start` latency and stage telemetry (offline)

**Capture:** 14 November 2026 (UTC), offline: the real Worker code over a sqlite D1 stand-in and an in-memory R2, counted by the `prediction_step_timing` instrumentation (`tests/prediction-batch-start-budget.mjs`). "main" is `f314b339` (the commit this change branches from).
**Scope:** code, tests, instrumentation and docs of [AIR-471](https://trello.com/c/rFBAixZe), follow-up of the [AIR-468 RCA](air-468-batch-start-rca-2026-11-14.md). No production read or write, no Scheduled Task, no `prediction_batch_start` against production.
**Verdict:** Offline D1 reduction and parity with the baseline demonstrated (one deliberate difference below). The card's clean-path target of at most 60 D1 calls is **not met** (82; R2 is within the 60 at 48); on 14 Nov 2026 the owner accepted 131 -> 82 D1 calls and 48 R2 calls as a sufficient first optimization and made the 60 D1 target a non-blocking stretch target; post-lease revalidation, lease fencing, CAS, input checks and telemetry correctness must not be relaxed to improve counters. Production latency is not measured here and is not claimed.

## What changed

| Change | Effect | Safety |
| --- | --- | --- |
| The queue refresh and settlement (`batchRefreshQueue`) select with the requested `manifestSize` as limit; it defaulted to 100 films (scan cap 300, up to 3 rounds) | A refresh scans about the five films the manifest needs instead of a hundred | A film behind that window leaves the queue when a later start reaches it; every film that would block the manifest is still settled in the same start (up to 3 rounds, as before) |
| The freshness check of a start reads each film's fingerprint and **current** prediction, not the replaced versions (`currentOnly` through `loadJSON` to `routeRead`) | No lineage query and no R2 body per replaced version | The start never looked at replaced versions (freshness uses the current record, the manifest holds the stored fingerprint); other readers keep the full read |
| The start's read-only passes share the authority marker read through the AIR-441 request scope; the scope is dropped before the idle outcome, the settlement of the previous run, the queue refresh, the lease acquire and the post-lease preflight | About 40 of the roughly 50 marker batches of a start disappear | Every write and the post-lease revalidation read the marker afresh; a marker or queue change between the two preflights still ends as `queue_changed`; the object scope is not used |
| Stage-level telemetry in the `batch_start` line: `stages`, `preflights`, `refreshRounds`, `scannedFilms`, `settledFilms`, `leaseRefused` (early check or a competing start that won the acquire; `leaseRefusedAtAcquire` marks the second), `liveLeaseAgeMs` (only when the holder's expiry is known; a lost compare-and-swap carries none), and named R2 classes for what was `r2:other` | Where the time and calls go per start; a repeated start is correlated with the live lease | Counters and closed names only; no storage call is added; a failure of the timing code changes nothing |

Not done on purpose: no early `already_running` before the preflight (it would change the precedence of the 409 answers for a missing profile, a missing snapshot and a held catalog while a lease is live, for a refusal that is not on the owner's path); no idempotent start and no adoption of a run; no change of `manifestHash`, response fields, byte limit, dry run or pin.

## Differential check against main (`scripts/prediction-batch-start-diff.mjs`)

The same 13 scenarios (`tests/prediction-batch-start-parity-lib.mjs`) are run in a temporary worktree of the baseline commit `f314b339` and in this tree; each result is normalized (ids, timestamps and run ids removed) and holds the selected film ids and order, lane, plan, a digest of each film's metadata and stored fingerprint, profile and contract digests, `manifestHash`, response fields, the queue after the start, the run, lease and diagnostics state after it, and the dry-run/pin and refusal answers (`manifest_too_large`, invalid size, pin over size, `already_running`). The baseline result is committed (`tests/fixtures/prediction-batch-start-parity-baseline.json`) and `tests/prediction-batch-start-parity.mjs` compares the tree with it in CI. Offline `wall ms` is local sqlite and in-memory time: it shows the proportion of work removed and does **not** predict Cloudflare p95.

| scenario | result vs f314b339 | R2 calls | D1 calls | R2 bytes | offline wall ms |
| --- | --- | --- | --- | --- | --- |
| clean5 | identical | 48 -> 48 | 131 -> 82 | 16241 -> 16241 | 79 -> 76 |
| already_running | identical | 9 -> 9 | 41 -> 21 | 676 -> 676 | 25 -> 21 |
| dry_run | identical | 7 -> 7 | 35 -> 18 | 128 -> 128 | 20 -> 14 |
| dry_run_pin | identical | 7 -> 7 | 35 -> 18 | 128 -> 128 | 14 -> 13 |
| dry_run_pin_too_many | identical | 0 -> 0 | 0 -> 0 | 0 -> 0 | 1 -> 1 |
| invalid_size | identical | 0 -> 0 | 0 -> 0 | 0 -> 0 | 0 -> 1 |
| size100 | identical | 48 -> 48 | 1083 -> 464 | 65198 -> 65198 | 184 -> 74 |
| hot_cold | identical | 48 -> 48 | 181 -> 102 | 18794 -> 18794 | 64 -> 41 |
| stale_profile | identical | 59 -> 59 | 664 -> 118 | 44680 -> 44680 | 120 -> 43 |
| missing_admission_in_window | identical | 56 -> 56 | 1156 -> 143 | 43835 -> 43835 | 161 -> 34 |
| missing_admission_far | DIFFERENT | 56 -> 56 | 1166 -> 143 | 44135 -> 44402 | 141 -> 31 |
| manifest_too_large | identical | 7 -> 7 | 513 -> 210 | 128 -> 128 | 77 -> 41 |
| prediction_only | identical | 92 -> 92 | 287 -> 145 | 56906 -> 56906 | 70 -> 51 |

**One deliberate difference** (`missing_admission_far`): when a film without admission sits inside the manifest window (which starts the refresh) and another far behind it, main's refresh looked at a default 100 films and settled both; now it settles the one the manifest meets and the far one stays queued until a later start reaches it. The films, their order, `manifestHash` and the run, lease and diagnostics state are identical; only `queueSettled` (2 -> 1) and the queue-count fields of the answer (`eligible`, `pendingCount`, `hotRemaining`, one higher) differ, and the test pins exactly that. Every other scenario is identical.

Scenario budgets (ceilings asserted in `tests/prediction-batch-start-budget.mjs`, which also asserts fewer D1 calls and no more R2 calls than the baseline):

| Scenario | R2 calls main -> now | D1 calls main -> now | D1 statements main -> now |
| --- | --- | --- | --- |
| Current queue (40 films) | 48 -> 48 | 131 -> 82 | 245 -> 118 |
| Second start while the lease is live (`already_running`) | 9 -> 9 | 41 -> 21 | 73 -> 23 |
| Stale queue (profile moved), 100 films | 59 -> 59 | 664 -> 118 | 1197 -> 161 |
| Three films without admission at the head, 100 films | 56 -> 56 | 1156 -> 143 | 2077 -> 186 |
| `manifestSize` 100, 130 films | 48 -> 48 | 1083 -> 464 | 1957 -> 500 |

The R2 count does not move offline because the stand-in has no replaced prediction versions with R2 bodies; the saving on films that have them (one body per replaced version per pass) is shown only as the absence of lineage queries and is **not** quantified here.

Where the remaining 82 D1 calls of a current-queue start go (stage line): two preflights of about 17 each (two reads per selected film, the discovery admission authority checks, the profile, the queue), the lease and settlement checks, and 36 in `persist` (run, lease and queue bookkeeping that the start owns). The per-film reads and the post-lease preflight are the revalidation of selected inputs that ADR 0122 and this card keep; the discovery authority reads (four per admission lookup) belong to another module and are not scoped here. Getting under 60 would need batching the per-film reads or scoping the discovery authority read, both larger changes than this card, so the target is **escalated to the owner**, not bypassed.

## Behaviour checked (same test file)

- `stages` names are closed, sequential and their counts add up; the line holds no film id, key or statement.
- A refused start carries `leaseRefused: 1` and `liveLeaseAgeMs`, names the live holder and creates no run; the same holds for a competing start that wins the lease between the early check and the acquire (deterministic interleaving: live holder seen at the acquire, and a lost compare-and-swap, where no age is invented).
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
node tests/prediction-batch-start-parity.mjs
node scripts/prediction-batch-start-diff.mjs   # differential against f314b339, prints the table above
node tests/prediction-batch-start.mjs
node tests/prediction-manifest-size.mjs
node tests/prediction-step-timing.mjs
```
