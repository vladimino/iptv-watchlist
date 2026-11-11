# R2 round trips of next and submit, 11 November 2026

[AIR-442](https://trello.com/c/j564oeLD). Offline evidence only: the Worker in a Node `vm` on an in-memory R2 that counts every call by the class of the key (`tests/prediction-r2-roundtrips.mjs`), compared with `main` at `09d6113` in a separate worktree. No production read or write, no model, no run, no lease, flag or schedule.

## Starting point

The production figures of the card come from [AIR-438](https://trello.com/c/vs2H6LQK) (`prediction_step_timing`, two natural runs): R2 busy about 10.9 s over 52 calls per `next` and 15.9 s over 38 calls per `submit`, with repeats of the run, lease, view-index and film objects. This report does not re-measure production; it measures the call graph of the code.

## Call graph (before)

- Every `savePredictionRun` wrote the run, `latest-run.json` and the diagnostics row, and the diagnostics row read itself, the queue and the lease each time (`next` saves twice, `submit` once per item); `safeAppendStep` read the run and the row for each of its two appends.
- `submit` wrote the fingerprint (which updated the whole view index and the mood facet) and then the prediction (which updated the whole index and the facet again).
- The queue was read by the diagnostics, by `currentPredictionQueue` and by the mutation that follows it.

## Result (steady state, one film per step, twelve selected films)

| Class | next before -> after | submit before -> after |
| --- | --- | --- |
| Total R2 calls | 55 -> 43 | 41 -> 31 |
| GET run record | 3 -> 1 | 3 -> 1 |
| GET diagnostics row | 4 -> 1 | 3 -> 1 |
| GET queue | 3 -> 1 | 3 -> 1 |
| GET runner lease | 3 -> 1 | 3 -> 2 |
| GET view index | 1 -> 1 | 2 -> 1 |
| PUT view index / mood facet | 0 / 0 | 2 -> 1 / 2 -> 1 |
| PUT run / latest-run / diagnostics row | 2 / 2 / 4 -> 1 / 1 / 3 | 1 / 1 / 3 -> 1 / 1 / 3 |
| Film state GET, writer and runner lease PUT | unchanged | unchanged |

With a view index of 8704 entries (the production size) the bytes moved per `submit` fall from 4.84 MB to 2.43 MB; `next` stays at about 1.2 MB (one read of the index).

## Equivalence

The same deterministic flow (five `next`/`submit` pairs, one of them with a prediction the schema rejects after its fingerprint was stored, one replayed submit, then `complete`) ran on both versions. The answers of every step are identical, and the stored result is identical over all 42 keys (run records, queue, film files, immutable bodies, view index, mood facets, diagnostics rows, events), after the volatile fields (times, ids, content hashes that include a time) are normalized. The one difference is the order of keys inside the view-index entries, not their content.

## What the test pins

Per-class budgets of `next` and `submit`; one fingerprint body, one generation record and one prediction version per film, none written twice; the mood-facet file equal to the index entry's; a replayed submit is `already_current` and writes nothing new; a rejected prediction leaves the fingerprint indexed exactly as before, records the retry and stores no prediction; a queue conflict between the step's read and its write retries from a fresh read and keeps the other writer's record; an external change to the run record between two requests is read by the next one and the shared environment carries no scope; a busy writer and a changed profile write nothing mutable; an index write that fails after the prediction was stored stops the run as before, the version exists once, and the next run repairs the index entry. Mutants (no scoped read, no identical-write skip, no head seed, scope on the shared environment, no index flush) fail.

## Candidate not implemented

`next` reads the fingerprint and prediction state of every selected film each time (24 reads of 43 with twelve selected, one film submitted per step). Films whose result this run already recorded need that read only to re-derive what `run.results` says. Skipping it would roughly halve the film-state reads, but it replaces a re-verification with the run record and, in the unsupported case of an external invalidation within a run, offers the film again differently. It is neither a reuse within one request nor a batching of compatible operations, so it is left for a decision.

## Not proven

Production counts, R2 busy time and p50/p95 of `next` and `submit` after deploy. That needs two natural runs read through `prediction_step_timing`, grouped by Worker version.
