# ADR 0082: Discovery continuation may run as an inert Cloudflare Workflow

**Status:** Proposed  
**Original decision date:** 2026-11-02  
**Recorded at:** 2026-11-02  
**Approval source:** not an owner acceptance. Card approval of [AIR-323](https://trello.com/c/SrWM43h0) authorizes the implementation and an ordinary deploy, not acceptance of this record and not a production cutover  
**Related work:** [AIR-323](https://trello.com/c/SrWM43h0); switch successor [AIR-324](https://trello.com/c/kNtaEbm8)  
**Supersedes:** [ADR 0005](0005-external-chatgpt-tasks.md) and [ADR 0006](0006-one-chunk-discovery.md) in part, only while `DISCOVERY_EXECUTOR=workflow`  
**Superseded by:** None

## Context

Discovery continuation is an external ChatGPT Scheduled Task ([ADR 0005](0005-external-chatgpt-tasks.md)). Each explicit request runs one chunk ([ADR 0006](0006-one-chunk-discovery.md)). The series budget is 12 chunks; a spent series waits until the next UTC hour even when TMDB would allow more work. The owner wants a deployed executor that can keep going from the saved queue, one bounded step at a time, without ChatGPT and without that hour cap. Production must not start using it because of this change.

The scored resolver, checkpoints, leases, the published generation and the TMDB budgets stay as they are. The continuation record may stay in R2 for this decision. D1 ownership of discovery is a later decision (AIR-320) and is not taken here. EPG publication, ratings and prediction generation stay on the external tasks.

## Decision

1. **The flag.** `DISCOVERY_EXECUTOR` is `external` when absent, null or `''`. The exact string `workflow` selects the Workflow executor. Any other string, including case or whitespace differences, is `invalid`. Invalid does not trim and does not run a chunk: a continuation or resolve answers `503 discovery_executor_invalid`. An EPG commit still publishes and may queue its intent. The variable is not in `wrangler.jsonc` `vars`. `keep_vars: true` means a deploy does not set or clear it. Removing the variable is a later card after [AIR-324](https://trello.com/c/kNtaEbm8) has switched it and been accepted. This record does not create that card.
2. **External mode is today's contract.** `continuationDecision` is unchanged. A future `chunk_budget`, backoff, `retryAt` or error still waits. The hourly task still opens at most one series of 12 chunks and then waits for the hour. Scheduled Task prompts and their enabled state are not edited.
3. **Workflow mode does not run a chunk in the request.** The EPG commit and the scan still queue the same fenced intent. `epg_sync_step` on a completed run, and `POST /api/enrichment/discovery/resolve`, do not call `advanceDiscovery`. If the stored contract is already `stop`, the response says so and `delegated` is false. Otherwise the response is `nextAction: wait`, `reason: delegated`, `delegated: true`. `delegated` is not written into the continuation record. The commit-tail resume path still copies the generation and queues discovery; it does not start a chunk, and it is not blocked by the executor.
4. **One chunk per durable step.** The Workflow calls the existing `advanceDiscovery` inside one `step.do`. It does not loop inside a Worker isolate, does not chain `waitUntil`, does not fetch itself, and does not bypass Access. A step that may have committed does not throw, because the platform would retry it and run another chunk. An unsaved checkpoint is not reported as progress.
5. **The series renews without the hour.** After a confirmed chunk, the plan is `continue`, `wait`, or `stop`. `wait` sleeps until the real `retryAt`, `nextCatchUpAt`, lease expiry or backoff. A future `chunk_budget` is renewed immediately, by a compare-and-swap back to the series budget, only when the saved discovery status for that generation has `remaining > 0`. Unknown remaining waits for the stored gate. Remaining `0` stops. There is no extra 1–2 chunks per hour cap and no fixed pause when work is allowed. TMDB throttling, retry and the resolver lease still apply. An instance runs at most 20 chunks and then starts a successor instance; 20 is this product's cap so that state stays bounded, not a claim about the platform's step quota ([Workflow limits](https://developers.cloudflare.com/workflows/reference/limits/)).
6. **One writer.** The instance id is `discovery_<programmeRunId>_<series>`. A duplicate create attaches to that id. An uncertain create does not mint a new id. A changed published generation stops the pinned instance and does not apply the old generation. Two callers share the existing resolver lease and continuation compare-and-swap. `reconcileDiscoveryWorkflow` retries the same id, or a successor when the instance is finished and work remains. It is implemented and tested. It is not called from cron, from a request, or from a Workflow schedule.
7. **The binding is inert.** `wrangler.jsonc` exports `DiscoveryWorkflow` on `DISCOVERY_WORKFLOW` with no `schedules`. A schedule would create instances on deploy; this config has none. The cron stays `37 * * * *` and still runs only the enrichment projector. Nothing calls `create()` unless the mode is `workflow`. The executor record is `epg/discovery-workflow.json` in the current R2 bucket. That key is the orchestrator's record of the instance, not a new authority for discovery decisions, and AIR-320 may move it later.
8. **Read-only status.** `GET /api/enrichment/pipeline/status` adds `discoveryExecutor` only when the mode is not `external`. The GET does not create a Workflow. External diagnostics are otherwise unchanged. Workflow mode must not report discovery complete while the backlog remains.

What this decision does **not** do: it does not set the production flag, add a schedule, run discovery, call TMDB, change cron, edit a Scheduled Task, move EPG, ratings or predictions, or make D1 authoritative for discovery.

## Alternatives considered

Keeping the hourly ChatGPT loop and raising its chunk cap was rejected: the cap is the external contract, and the owner asked for a server executor instead of a larger ChatGPT loop. Changing `continuationDecision` so the external task also ignores the hour was rejected: that would change today's Scheduled Task without a separate decision. A Workflow `schedules` entry was rejected: Cloudflare creates an instance for each schedule match on deploy, which this card forbids. Running the whole backlog inside one Worker invocation was rejected: that is the failure [ADR 0006](0006-one-chunk-discovery.md) already closed.

## Consequences

With the flag absent, operators see the same Daily EPG and hourly Stage A as before. The Worker script exports a Workflow class that does not run. When the flag is later set to `workflow`, the external client receives `delegated` and stops driving chunks, and the Workflow continues the same resolver. A code rollback with the variable absent returns to external mode. Instances and R2 objects already written are not deleted by that rollback. The flag is temporary. [AIR-324](https://trello.com/c/kNtaEbm8) is the switch. A removal card comes after that switch is accepted, not instead of this record.

## Recovery and migration boundary

Accepting this record would approve the architecture only. It does not authorize `DISCOVERY_EXECUTOR=workflow`, a Workflow schedule, a live trigger, a manual EPG or discovery run, a TMDB call, a cron change, a Task edit, a D1 migration, or an R2 write. The reconciler stays unscheduled until AIR-324. If a crash lands between the queued intent and a successful `create()`, or between a committed chunk and the executor record, the series waits for that reconciler; the implementation is tested and is not activated here. Do not roll back R2 or D1 as part of a code rollback.

## Evidence

- **Original decision:** [AIR-323](https://trello.com/c/SrWM43h0), including the owner GO on that card. That GO is for the build, not for this record's acceptance.
- **Implementation:** this PR. The ADR stays Proposed until the owner accepts or declines it after an independent technical PASS and green exact-head CI.
- **Dated verification:** [local tests only](../evidence/discovery-workflow-air-323-2026-11-02.md). No production read or write.
- **Uncertainty:** Platform step and state quotas are not copied into this record. The instance cap of 20 chunks is a product bound. Whether a finished instance id can be created again is handled by reading instance status in the reconciler and opening a successor; that path is not activated.

## Follow-ups

[AIR-324](https://trello.com/c/kNtaEbm8) is the production switch. It is not authorized by this record. Discovery checkpoint ownership moving to D1 is AIR-320 and stays ahead of that switch. Flag removal is a card after AIR-324, not a card created here.
