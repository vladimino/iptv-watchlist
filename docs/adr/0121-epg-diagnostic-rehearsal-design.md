# ADR 0121: Owner-only EPG diagnostic canary on an isolated Cloudflare Workflow (design for owner decision)

**Status:** Accepted (architecture only; nothing is implemented, provisioned, deployed or activated by this ADR)  
**Original decision date:** 2026-11-12 (explicit owner acceptance following independent review of PR #540)  
**Recorded at:** 2026-11-12  
**Approval source:** Explicit Product Owner instruction on 2026-11-12 in the AIR-445 project conversation to mark ADR 0121 Accepted and merge PR #540, after independent [review of PR #540 HEAD `200866e`](https://github.com/vladimino/iptv-watchlist/pull/540#pullrequestreview-5871329798). Earlier [design feedback](https://github.com/vladimino/iptv-watchlist/pull/540#issuecomment-6818501618) provides the selected options. Architecture approval only; no provisioning, migration or diagnostic run authorized  
**Related work:** [AIR-445](https://trello.com/c/ssRI21B6), [AIR-444](https://trello.com/c/lSSrrJdE), [PR #538](https://github.com/vladimino/iptv-watchlist/pull/538), [ADR 0100](0100-epg-cloudflare-workflow-executor.md), [ADR 0108](0108-epg-mirror-reconciliation-writer.md)  
**Supersedes:** None  
**Superseded by:** None

## Context

The EPG publication is one Cloudflare Workflow instance per Madrid day (`runKey`), driven by `EpgOrchestration.act` under a durable step lease. The 300 s lease (`LEASE_MS`) is **our application-level lease**, checked and renewed by `assertStep` at every mutation boundary; it is not a Cloudflare Workflow wall-clock limit and this ADR claims no such limit. AIR-444 bounded the ledger `seal_stage` (segment fences every 8 writes or 20 s, lease renewal at each fence) after a 348 s step outlived that lease. The **uncertainty is preserved**: the observed step was 348 s ([AIR-444 report](../evidence/discovery/air-444-bounded-seal-stage-rca-2026-11-11.md)); the model that the fix brings it to about 195 s is a model, not a production fact. The owner wants to exercise the mechanism without waiting for the next 17:00 Madrid run and without a second publication.

What the code does (read on `main` at `dfd1a51`):

1. `seal_stage` is not a function of stored state alone. `planDiscoveryLedger` takes `latest`, the discovery scan produced by the `epg` step of the same run from the live provider feed, and derives `departures` (keys that left the scan) from it.
2. The archive commit writes create-only segment objects under a fresh `writeId` (`writeLedgerSegment`), a manifest, then swaps `LEDGER_ARCHIVE_POINTER` by compare-and-swap. The swap is the Discovery archive's commit point and is a production write when run against production storage.
3. Every fence reads the Discovery lease (`renewDiscoveryLease`, which renews it), the published-EPG generation and the pointer ETag; `epgStepGuard` reads and renews the EPG step lease row. A rehearsal that holds the production lease blocks the real run; one that does not hold it does not exercise the fence.
4. The production run needs `sync.json` in stage `epg` for the same `runId`.
5. Persisted input exists read-only: each published generation keeps `epg/generations/<programmeRunId>/discovery-latest.json` (the scan result of that publication, streamable) and the ledger archive pointer, manifest and segments. Whether this is a faithful substitute for the live scan (it is the merged result, not the raw feed) is **not yet verified** and is the first read-only step of implementation, see decision 4.

## Decision

The following architecture was explicitly accepted by the owner on 2026-11-12:

1. **Option B: a real, on-demand, isolated Cloudflare Workflow canary.** It runs in the **existing `iptv` Worker service** with its own Workflow binding (for example `EPG_DIAGNOSTIC_WORKFLOW`, own class and instance namespace). No second Worker service and no Worker request with in-memory write overlays.
2. **Isolation is an application-enforced routing and capability boundary, not platform privilege isolation.** The canary has its own R2 bucket, D1 database, lease and authority documents, receipt state, run ids and Workflow binding. Diagnostic mutations never touch the production EPG publication, Discovery authority and ledger, compatibility mirrors, events, ratings, predictions, `sync.json` or any operational lease. The diagnostic pointer and manifest CAS operate only inside the diagnostic bucket. Because the same Worker is bound to both sets of resources, the production bindings remain reachable by the Worker's code. **Residual risk, stated plainly:** a routing defect in this code could address a production binding. The mitigations are structural and tested, not absolute (decision 6).
3. **Durable receipts and results live in the diagnostic D1**, never in production `epg_orchestration_document`. The idempotency key is reserved by an atomic compare-and-set (unique constraint) **before** the Workflow is created, bound to the immutable parameters and to a deterministic instance id. A repeated call with identical parameters resolves to the same run; different parameters fail. An unknown creation or step outcome is reconciled from the receipt and the Workflow status, never retried blind. Transitions are idempotent and fenced.
4. **Input is a versioned, immutable recorded scan plus a consistent ledger baseline,** with deterministic, seeded, bounded departures and mutations. The report records the source generation, provenance, digest and replay parameters. Before any implementation, a read-only check establishes whether the persisted generation scan and archive baseline are a faithful snapshot; nothing is scanned, published, discovered or resolved to obtain input. If the source state is incomplete the canary reports reduced fidelity explicitly or fails closed. The snapshot is copied into the diagnostic bucket by an operation that needs its own owner GO; no sensitive production fixture or payload goes to GitHub.
5. **Delivery is one scope:** the real canary with offline and fault-injection tests, delivered **inert** (no binding resources provisioned, no route enabled by default). Implementation approval, Cloudflare resource provisioning (bucket, D1, Workflow binding, migration) and the first live invocation are three separate operation-specific owner GOs. The facility stays inert until all that it needs are given.
6. **Engineering requirements for the implementation:**
   - Reuse, without a second algorithm and without simulated R2 or D1 writes: `planDiscoveryLedger`, `seal_stage`, `writeLedgerSegment`, manifest and pointer CAS, `epgStepGuard`/`assertStep`, lease renewal, fence cadence, checkpointing and error classification.
   - Build a **strict allowlisted diagnostic execution context** (only the diagnostic `DB`, `BUCKET`, Workflow binding and explicit constants), not `{...env}` with `DB`/`BUCKET` swapped. Audit nested paths for implicit production access: `postSync`, `PublishedEpg`, Discovery authority and fences, the R2 helpers and any global that reads `env`. Negative and mutation tests must catch misrouting and must reject a missing or contradictory context **before any mutation**.
   - Owner-only initiate, status and result through the existing Access and JWT checks. The read-only preflight writes nothing (asserted by a write-counting test). One active canary at a time, bounded inputs, time and resource budgets, no extra Cron, no ChatGPT Scheduled Task, no automatic interference with production leases or schedules. Shared account-level resources (Workflow concurrency, R2 and D1 account limits, Worker CPU and memory) are checked separately and reported as contention risk.
   - A durable report: exact code revision, fixture digest and seed, departures and segment counts, wall, CPU and memory when available, per-phase R2 and D1 reads and writes, latency, fence count and timing, lease renewals, retries, failures, and the publication and isolation invariants. Evidence is labelled **`canary-measured`**, never `production-measured`.
   - **A passing canary is not AIR-444 production acceptance and is not permission to set `DISCOVERY_LEDGER_MODE=bounded`.** Production acceptance still needs a natural run observed read-only.
   - Retention, cleanup and rollback: diagnostic bucket objects, D1 rows and Workflow instances carry a stated retention and a documented cleanup procedure; rolling back the code does not delete diagnostic state and does not stop an active instance, so disabling the surface and terminating an instance are separate, documented steps.

## Alternatives considered

| | Reuses real code and fences | Production R2/D1 timing | Production writes | Verdict |
|---|---|---|---|---|
| A1 Offline replay (Node, `MemoryBucket`) | yes, with test doubles | no, simulated | none | Kept as the offline test layer of B, not as the deliverable |
| A2 In-Worker replay with a write-diverting overlay on production bindings | yes, behind an overlay | production reads, simulated writes | none by design; a defect is a production write | Not selected: simulated writes contradict the goal and the overlay is a new boundary on production bindings |
| **B Isolated canary Workflow in the existing Worker (accepted)** | yes, real writes into the diagnostic domain | diagnostic-resource timing, not production's | none by design; shared Worker keeps production capabilities | Accepted architecture |
| B' Isolated canary in a separate Worker service | yes | diagnostic | none; production bindings not given to that Worker (platform-level separation) | Stronger isolation, not selected: the owner chose the existing Worker; a second service remains the fallback if the residual risk is not accepted |
| C Second production commit | n/a | yes | yes | Rejected: the daily `runKey` allows one successful publication and is never bypassed |

## Consequences

Selecting B in the shared Worker gives faithful mechanics (real code, real writes, real CAS and lease renewal) at the price of new durable state (diagnostic bucket, D1, Workflow class, receipts), a new owner-only surface, and an isolation that rests on code and tests, not on the platform. Its latency numbers describe the diagnostic resources and the Worker's own CPU and memory; production R2 and D1 latency under production contention remains unmeasured by it. Provisioning and cleanup add operational work. The honest labels (`canary-measured`) must stay in every report.

## Recovery and migration boundary

This ADR adds documentation only. Implementation, when separately approved, ships inert; Cloudflare resource creation, the diagnostic D1 migration, the snapshot copy and the first invocation each need their own operation-specific owner GO. Code rollback does not delete diagnostic D1 or R2 state or stop a running instance; those need the cleanup procedure. Nothing here changes the production EPG schedule, mode, `DISCOVERY_LEDGER_MODE`, Discovery authority or leases.

## Evidence

- **Original decision:** explicit owner architecture acceptance on 2026-11-12, following independent review on PR #540; prior design direction recorded in the owner's PR comment.
- **Implementation:** none.
- **Dated verification:** not recorded; the 348 s observation is in the AIR-444 report linked above.
- **Uncertainty:** the 348 s versus modeled 195 s step; the fidelity of the persisted generation scan as a replay input; the real behaviour of shared account-level limits; the residual routing risk of one Worker holding both binding sets.

## Documentation affected by the future implementation PR (not by this one)

`docs/architecture/scheduling-and-orchestration.md`, `docs/architecture/runtime-topology.md` and `docs/architecture/authentication-and-mcp.md` (Mermaid, with rendered QA), `docs/reference/api/mcp.md`, `docs/reference/orchestration-reliability.md`, `docs/reference/data/d1-schema.md` (diagnostic database), `docs/runbooks/discovery-ledger.md`, `docs/runbooks/deployment.md`, a new runbook for provisioning and cleanup, `docs/reference/feature-flags.md` if a flag is added, and dated `docs/evidence/orchestration/` reports.

## Follow-ups

An implementation card after this architecture acceptance, and separate operation GO cards for provisioning and the first invocation; created by the Planner.
