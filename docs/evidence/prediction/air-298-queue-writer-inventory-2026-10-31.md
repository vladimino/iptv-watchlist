# AIR-298: prediction queue writer inventory and offline race tests

**Captured:** 2026-10-31, code reading of `main` `dab57b9` and offline tests on the AIR-298 branch. No production read or write, no run, no reconcile.  
**Card:** [AIR-298](https://trello.com/c/VBVLAbuW). **Decision:** [ADR 0062](../../adr/0062-prediction-queue-conditional-writes.md) (Proposed). **Root finding:** [AIR-281 audit](air-281-targeted-recovery-no-go-2026-10-31.md).

## Hypothesis versus observation

The lost-update risk is a **code hypothesis**: it follows from writers that put the whole queue without an etag condition. No production incident was observed or searched for in logs. How often writers interleave in production was not measured. The offline tests below prove that the interleaving loses data in the code before the change and does not after it. They say nothing about production frequency.

## Writers of `enrichment/prediction-queue.json` at `dab57b9`

| Writer | Trigger or change | Lease held | Write before the change |
| --- | --- | --- | --- |
| `POST /api/enrichment/start` (queued) | rebuild `scheduled` / `manual` | runner lease (15 min, CAS) and prediction writer lease (90 s, not renewed) | blind put |
| start with nothing selectable | `lastCheckAt`, `lastBatch` on the rebuilt object | same | blind put of the object it rebuilt |
| `POST /api/enrichment/next` | rebuild `next_priority` | runner and writer leases | blind put |
| `POST /api/enrichment/submit` | per-film `retries[id]` | runner and writer leases | read, change, blind put |
| submit | rebuild `batch_progress` | same | blind put |
| `POST /api/enrichment/complete` | rebuild `completion_check`, rebuild `batch_complete` | runner and writer leases | blind put |
| complete | `retries`, `lastBatch`, `lastCheckAt`, `metrics.hotProcessedTotal` on the rebuilt object | same | blind put of the object it rebuilt |
| EPG commit tail (`finishSync`) | rebuild `programme_updated` | none | blind put |
| `POST /api/enrichment/discovery/scan` | rebuild `epg_scan` | none | blind put |
| `PUT /api/enrichment/profile` | rebuild `profile_updated` after the profile moved | none (the profile itself is CAS) | blind put |
| discovery resolver chunk | rebuild `resolver_checkpoint` | discovery lease, renewed by `beforeWrite` | blind put |
| `POST /api/enrichment/queue/reconcile` | rebuild `manual_reconcile` | none | blind put |

The prediction writer lease is not checked before the queue put and is not renewed. Neither lease fences the queue against the writers that hold none. Every rebuild copied `retries`, `lastBatch`, `lastCheckAt` and `metrics` from the queue it read at its start.

## R2 conditional writes

The [Workers API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#conditional-operations) states that `put` returns `null` when its `onlyIf` condition fails. The [consistency page](https://developers.cloudflare.com/r2/reference/consistency/#conditional-writes) states that the condition is evaluated atomically against the committed state and that competing conditional writes to one key are serialized. The repository already depends on this in `updateViewIndex`, `mergeStoredJSON`, the runner, writer and discovery leases, and the profile pointer.

## Offline race tests

`node tests/prediction-queue-cas.mjs` runs the Worker code in `vm` over an in-memory bucket that enforces `etagMatches` and `etagDoesNotMatch: '*'` like R2. A hook parks one writer between its read and its put, lets another writer commit, then releases it. Covered:

- **Retry write ↔ EPG commit rebuild**, both orders. The parked film is not handed out again by `next`.
- **Profile publication ↔ submit**, both orders.
- **Resolver checkpoint ↔ completion**, both orders. The fence renews once per attempt.
- **Reconcile ↔ each of the 11 rebuild triggers** and ↔ a retry write, both orders, plus the start's idle check.
- **Stale programme generation and stale profile:** with and without a conflict.
- **Failure modes:** a lost lease (no put), a put that throws (not repeated), a put whose outcome is unknown (not repeated; the next writer continues).
- **Exhaustion:** after 5 attempts, with a `409 prediction_queue_conflict` from the reconcile route.
- **Idempotency:** a repeated completion counts and records once; a systemic stop heals a lost retry.
- **Retry monotonicity:** merge rules, and 11 independent rebuilds that never lower an outstanding record.
- **Cost:** storage operations per rebuild are equal for 10 and 3,000 films; one conflict costs one more rebuild.
- **Static check:** no unconditional queue write is left in the source.
- **Failed retry writes, end to end through the real routes.** Each case is followed by the next `start` and `next`, which must leave the failed film deferred (`retryAt` about an hour ahead, `lastRunId` the stopped run):
  - five conflicts at `POST /api/enrichment/submit`, with the stop's own write conflicting too: the run stops `partial`, still marked, with its lease released. Three further starts each answer `503 prediction_retry_heal_pending` with reason `retry_heal_pending`. They leave unchanged `latest-run.json`, the lease and its etag, the run records, the selections, the stop records and the Events. Once the conflicts stop, the start writes the retry first.
  - five conflicts at submit only: the stop's write lands.
  - a `complete` with reason `quota` whose retry write keeps conflicting: the stop is recorded with `retryHeal: pending`, and the next start fails closed until the write lands.
  - a stop whose retry write has an unknown outcome: exactly one queue put. The next attempt re-reads, finds the record and does not double it.
  - a crashed runner, with the run still `running` and the lease expired: the recovering start writes the retry before selecting.

**Results on the branch:** `prediction-queue-cas.mjs` passed. After merging `main` `30186a5`, `npm test` passed all 183 test files.

**Counter-checks:**

- The first version of the test file, run against `src/enrichment.js` of `dab57b9`, fails at its first race: "the EPG refresh keeps the retry written while it was parked". The rebuild put back the `retries` it had read before the submit's write.
- The failed-write cases were also run against the branch's first conditional-write version, without the run mark and the start check, with only the mark assertions removed. They fail with "the next start finds the retry in the queue". The film whose submit write was exhausted had no retry record when the next run started. That is the gap the independent review found.
- With the start outcome routed through the generic stop handling again, the repeated-start case fails with "not turned into a storage_error stop". That is the second review finding: a fabricated `blocked-*` stop that overwrote `latest-run.json`.

## Not verified

- Production behaviour: no deploy, run or production read was part of this capture.
- How often a conflict occurs and whether exhaustion ever happens in production.
- The behaviour of the external Scheduled Tasks after the deploy; that is a separate acceptance gate.
