# AIR-687: hourly lockstep of an unguarded `discovery_fence` (27 November 2026)

Scope: source reading of `main` at `e9e91be` and an offline in-memory stand-in. No production access, no Cloudflare API, no TMDB.

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

- `retryableFenceCollision` positively proves a counter-only collision before any retry: the refusal is the D1 batch `CHECK` failure (it has a cause; direct evidence/invariant throws do not), the published pointer names this run as `published` (missing or non-published is rejected), the authority is ready, not held, not loading and bound to the run, and the hop's lease renews. Negatives run on the real fixture: lease replaced, lease expired, authority held, pointer not published, pointer missing, and a fence with no batch cause.
- A proven collision becomes `paused`/`backoff` with `retryAt` +30 s and `fenceCollisions`, bounded to 6 consecutive collisions; the cap is an engineering bound (three minutes against a seconds-long competing write) whose fallback is the pre-existing `error` record and recovery contract. Fences, lease and idempotency are unchanged.
- `chunkSummary` carries `generationCollision`, `fenceCollisions`, `failureKind: fence` and a bounded `failedAt`; the AIR-534 in-chunk collision result keeps its real `checked`/`touched` work.
- `chunkUsefulProgress` is read from the real summary shape (`checked`, `touched`, `added`, `assignment.assigned`, `assignment.replayed`, `revalidation.revalidated`). The stall counter keeps using the saved checkpoint; `usefulProgress` is persisted in `lastProgress` and `lastUsefulProgressAt` and shown by the Discovery status view.

## Tests

Sections F to I of `tests/discovery-fence-collision.mjs` (core), including the series cap exercised by consecutive real retries and the `workflowPlan` wake. They fail on `main` without the change. Related Discovery, workflow, rollover, diagnostics and events tests pass.

## Open

Natural production acceptance (queue advances across an hour boundary after a collision) is pending; absence of the conflict is not proof of recovery.
