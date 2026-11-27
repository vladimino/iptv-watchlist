# AIR-687: hourly lockstep of an unguarded `discovery_fence` (27 November 2026)

Scope: source reading of `main` at `e9e91be` and an offline in-memory stand-in. No production access, no Cloudflare API, no TMDB.

## Confirmed causal chain (code)

1. The hourly cron writes `discovery_authority.generation`; a chunk write whose `CHECK` on the generation fails throws `discovery_fence` (`failureKind: fence`).
2. Only the guarded batches (`guarded()` in `resolvePagedDiscoveryChunk`, AIR-534) retry and then defer with `retryAt` about 30 s. Other writes (final status, checkpoint, assignment) rethrow the typed error.
3. `advanceDiscovery` turned any typed throw into `stage: error` and `continuationAfterChunk` set `nextCatchUpAt` to the next hour boundary with `retryAt: null`.
4. `workflowPlan` → `continuationDecision` waits until that boundary. The wake-up at `:00` meets the hourly cron again, so the same collision repeats for every hour. This matches the seven consecutive `chunk-N-1` failures (`checked=0`, `discovery_fence`, sleep almost one hour) on the card.
5. `progress=true` at `stage=error` only meant `saved === true` (the checkpoint was written); it did not mean queue movement.

## Not proven

- The exact write that failed in each of the seven hours: the historical step outputs were not re-read (HTTP 429 on the instance step output API), so the failing phase (`failedAt`) is unproven; the chain above is reproduced on the offline fixture.
- Why work resumed at 06:00 inside the same instance: consistent with the hourly collision not occurring that hour, not proven.

## Change

A typed `discovery_fence` that is thrown, while the published run and the authority still name this run, becomes a `paused`/`backoff` checkpoint with `retryAt` +30 s and `fenceCollisions`, bounded to 6 consecutive collisions. A moved published run, a different authority run or exhausted retries keep the fail-closed `error` checkpoint. Fences, lease and idempotency are unchanged. `runWorkflowChunk` adds `usefulProgress` (checked, cheap-pass or replay work only).

## Tests

`tests/discovery-fence-hourly-lockstep.mjs` (core): short retry instead of the hour boundary, plan wake about 30 s, recovery moves the queue and clears the counter, bound, genuine switch fail-closed, `progress` vs `usefulProgress`. It fails on `main` without the change. `discovery-fence-collision`, `discovery-fast-recovery`, `discovery-workflow`, `discovery-workflow-rollover`, `continuation-diagnostics` and `discovery-events` pass.

## Open

Natural production acceptance (queue advances across an hour boundary after a collision) is pending; absence of the conflict is not proof of recovery.
