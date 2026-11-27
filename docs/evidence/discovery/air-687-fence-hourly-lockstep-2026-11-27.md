# AIR-687: hourly lockstep of an unguarded `discovery_fence` (27 November 2026)

Scope: source reading of `main` at `e9e91be` and the offline real sqlite D1 stand-in of the AIR-534 fixture with a recording TMDB stub (card: [AIR-687](https://trello.com/c/jrP0z56f), related [AIR-534](https://trello.com/c/90dyx0Ai), [AIR-492](https://trello.com/c/09ys5uPy), [AIR-682](https://trello.com/c/UWYTPEDB)). No production access, no Cloudflare API, no real TMDB.

## Confirmed causal chain (code)

1. The hourly cron writes `discovery_authority.generation`; a chunk write whose `CHECK` on the generation fails throws `discovery_fence` (`failureKind: fence`).
2. Only the guarded batches (`guarded()` in `resolvePagedDiscoveryChunk`, AIR-534) retry and then defer with `retryAt` about 30 s. Other writes (final status, checkpoint, assignment) rethrow the typed error.
3. `advanceDiscovery` turned any typed throw into `stage: error` and `continuationAfterChunk` set `nextCatchUpAt` to the next hour boundary with `retryAt: null`.
4. `workflowPlan` → `continuationDecision` waits until that boundary. The wake-up at `:00` meets the hourly cron again, so the same collision repeats for every hour. This matches the seven consecutive `chunk-N-1` failures (`checked=0`, `discovery_fence`, sleep almost one hour) on the card.
5. `progress=true` at `stage=error` only meant `saved === true` (the checkpoint was written); it did not mean queue movement.

## Reproduced mechanism (offline, real sqlite D1 stand-in)

`tests/discovery-fence-collision.mjs` (sections F to I, extending the AIR-534 fixture): a competing writer bumps `discovery_authority.generation` inside the real D1 batch hook immediately before the first status batch of the real `advanceDiscovery` (the cheap-pass status write, outside any named phase). The real batch fence fails with `CHECK constraint failed`, `discovery_fence` is thrown outside `guarded`, and on `main` the checkpoint is `stage: error`, `reason: discovery_fence`, `nextCatchUpAt` = the next hour. With the change it is a 30 s `backoff`, the second real chunk (clock moved past the deferral) completes, the counter is cleared, and the single stored decision is intact and not duplicated. The hourly writer itself and the Cloudflare Workflow sleep are modelled by the bump and by `workflowPlan` (wake at the retry, not at the hour), not executed.

## Not proven

- The exact write that failed in each of the seven production hours: the historical step outputs were not re-read (HTTP 429 on the instance step output API), so the failing phase (`failedAt`) is a code hypothesis, consistent with the card, not a production fact.
- Why work resumed at 06:00 inside the same instance: consistent with the hourly collision not occurring that hour, not proven.

## Change

- `retryableFenceCollision` positively proves a counter-only collision before any retry: the refusal is a D1 batch `CHECK` failure that carries the generation its own fence statement expected (`fenceGeneration`, recorded by `commit`), the authority counter has moved past it, the published pointer names this run as `published` (missing or non-published is rejected), the authority is ready, not held, not loading and bound to the run, and the hop's lease renews. Each condition has a negative on the real fixture (section I of `tests/discovery-fence-collision.mjs`: unchanged counter, no fence statement, no cause, not a CHECK, another code, no lease, another run, loading transfer, authority moved to another run) and end-to-end (section H: lease replaced, lease expired, authority held, pointer not published, pointer missing, each with a persisted fail-closed checkpoint or the authority's own refusal).
- A proven collision becomes `paused`/`backoff` with `retryAt` +30 s and `fenceCollisions`, bounded to 6 consecutive collisions; the cap is an engineering bound (three minutes against a seconds-long competing write) whose fallback is the pre-existing `error` record and recovery contract. Fences, lease and idempotency are unchanged.
- `chunkSummary` carries `generationCollision`, `fenceCollisions`, `failureKind: fence` and a bounded `failedAt`; the AIR-534 in-chunk collision result keeps its real `checked`/`touched` work.
- `chunkUsefulProgress` is read from the real summary shape (`checked`, `touched`, `added`, `assignment.assigned`, `assignment.replayed`, `revalidation.revalidated`). The Workflow stall counter keeps using the saved checkpoint. `workflowProgressPatch` persists `lastUsefulProgressAt` and `usefulProgressTrackedSince`; the rollover swap and a same-generation successor carry them, another programme run does not. `discoveryQueueState` exposes both, and `evaluateDiscovery` judges a tracked series by them (three-hour existing threshold, no new alert): a fresh zero-work error or collision checkpoint does not recover an open incident.

## Tests

- `tests/discovery-fence-collision.mjs` (core), on the real sqlite D1 fixture with an undecided candidate: the first status batch is refused by an injected generation bump and nothing is persisted (decisions 0, slots 0); the real `runWorkflowChunk` saves a collision checkpoint with `usefulProgress: false`; after the 30 s deferral the real recovery chunk settles the candidate and assigns its slots (decisions 1, slots 2, no duplicate slot), `usefulProgress: true`. The Workflow state, the queue classification and `evaluateDiscovery` are the real ones: with a tracked series idle for five hours a fresh collision checkpoint keeps the incident open, genuine persisted work recovers it (`queue_empty`, the queue is drained). The series cap is six real consecutive retries.
- `tests/monitor-policy.mjs`: saved error, collision and no-useful-work checkpoints with fresh times and a future gate keep and raise the incident; real work and a freshly started tracking recover it; the empty queue and the EPG pause are unaffected; legacy records keep the old clocks.
- `tests/discovery-workflow-rollover.mjs`: the clock survives the swap. They fail on `main` without the change. Related Discovery, workflow, diagnostics and events tests pass.

## Open

Natural production acceptance (queue advances across an hour boundary after a collision) is pending; absence of the conflict is not proof of recovery.
