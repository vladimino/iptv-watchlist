# AIR-573: deferred batch start, offline measurements and checks

**Capture:** 21 November 2026 (UTC), offline. The real Worker bundle over a sqlite D1 stand-in and an in-memory R2; the Workflow binding is a stand-in that only records the created instance, so the preparation is run (or not run) by the test. Six films, `manifestSize=5`. No production read or write, no Scheduled Task, no model, no Workflow instance.  
**Scope:** [ADR 0191](../../adr/0191-deferred-batch-start-with-server-issued-key.md) on top of [PR #854](https://github.com/vladimino/iptv-watchlist/pull/854) (ADR 0188). Tests: `tests/prediction-batch-start-deferred.mjs`, `tests/prediction-batch-start-keyed.mjs`, `tests/prediction-orphan-start-signal.mjs`.  
**Verdict:** Offline PASS of the protocol and its safety properties. **Production latency, Workflow instance start delay and concurrency limits are not measured**; the natural runs after the Tasks are moved are the proof.

## Phase cost (D1 round trips, R2 operations, stand-in wall time)

| Phase | D1 round trips | R2 operations | Stand-in wall time | Notes |
| --- | --- | --- | --- | --- |
| `prediction_batch_key` (bootstrap) | 0 | 0 | about 1 ms | stateless; a lost answer leaves no lease, run or storage row |
| `prediction_batch_start({deferred:true})` (accept) | 4 | 1 | about 8 ms | claim plus instance creation; receipt 373 bytes |
| Preparation in the Workflow step | about 150 | about 40 | about 100 ms | the keyed start of ADR 0188 with its claim, gate and guard overhead |
| `prediction_batch_manifest` envelope (readback) | 4 | 1 | about 2 ms | 1,013 bytes; parts are the existing reads |
| Repeat of the keyed deferred start (`ready`) | 4 | 1 | about 4 ms | same receipt, no second preparation |
| Synchronous unkeyed start (for comparison) | 82 | n/a | about 50 ms | the path that took 75–90 s in production |

The stand-in wall times only order the phases; production latency is dominated by the per-call D1 and R2 round trips (the AIR-468 traces: about 0.24 s per D1 call), which these counts are the input of. The preparation is heavier than the unkeyed synchronous start (about 150 against 82 D1 round trips) because of the claim renewals, the gate and the commit guard; that cost now sits **off the caller's critical path**, and a test proves that a slow preparation does not delay the receipt: the receipt is answered while the instance has not run at all.

## Checks (all offline, all in the core suite)

- Bootstrap: shape `dk1.<32 hex>`, a different key on every call, no D1 or R2 write, no arguments accepted.
- Receipt: compact, no manifest, the key reaches neither the instance payload nor any row or record; a lease `claim` with key and argument hashes; no run, source or manifest; `manifest_pending` readback.
- Repeat before, during and after the preparation: the same receipt (`preparing`, then `ready`), one instance, one epoch; another key, other arguments (`key_args_mismatch`), a keyless start and four competing Tasks (one accepted, three `already_running`, no adoption).
- Preparation: stored manifest, `ready` outcome, a lease of at most 180 s until the first heartbeat (mutation check: without the cut-back the lease is 15 minutes and the test fails), the first heartbeat renews to the full TTL and keeps the correlation fields; a replayed instance finds no claim and writes nothing; the create-only outcome is never overwritten (mutation check).
- Caller disappears after the receipt: the short lease expires and the next start recovers the run as `recovered_stale_lease` (epoch advances, no reset).
- Refused and failed preparations: `refused` outcome for no capacity, `failed`/`start_claim_lost` for a stale instance; the claim is released or the foreign holder untouched; readback is `start_refused` / `start_failed`, never pending or `unknown_run`.
- Workflow binding absent or `create` throws: `503 deferred_start_unavailable`, claim released, nothing accepted.
- Argument rules: a deferred start needs the issued key shape and is never a dry run or a pin; the synchronous keyed start and a keyless start are unchanged.
- ADR 0188 properties (PR #854) are unchanged and re-run: fenced persist at every boundary, exceptional exits, join interleavings.
- Repeated orphan starts: the incident of 21 Nov 2026 (one abandoned owned run and three turned-away starts after 40 minutes without progress) is `no_progress` with `repeated_orphan_starts` at 40 minutes instead of waiting for the 60-minute rule; two attempts, progress five minutes ago, a running run, under 20 minutes, no eligible work, an old chain outside the two-hour window and attempts before the last progress are not.

## Not measured, not claimed

Production latency of the receipt, of the Workflow instance start and of the preparation; Workflow concurrency limits; whether a Task keeps its key in its context across a long execution; the cause of the Task ending after a receipt (AIR-573 traces); the natural runs of the moved Tasks. No production operation was performed.
