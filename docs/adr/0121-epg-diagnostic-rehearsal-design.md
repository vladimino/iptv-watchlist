# ADR 0121: Owner-only EPG Workflow diagnostic rehearsal (design for owner decision)

**Status:** Proposed (design only; nothing is implemented, deployed or activated by this ADR)  
**Original decision date:** not decided  
**Recorded at:** 2026-11-11  
**Approval source:** not yet given; the owner decisions listed below are required before any implementation  
**Related work:** [AIR-445](https://trello.com/c/ssRI21B6), [AIR-444](https://trello.com/c/lSSrrJdE), [PR #538](https://github.com/vladimino/iptv-watchlist/pull/538), [ADR 0100](0100-epg-cloudflare-workflow-executor.md), [ADR 0108](0108-epg-mirror-reconciliation-writer.md)  
**Supersedes:** None  
**Superseded by:** None

## Context

The EPG publication is one Cloudflare Workflow instance per Madrid day (`runKey`), driven by `EpgOrchestration.act` under a durable step lease (`LEASE_MS` 300 s, checked and renewed by `assertStep` at every mutation boundary). AIR-444 bounded the ledger `seal_stage` (segment fences every 8 writes or 20 s, lease renewal at every fence) after a 348 s step outlived the 300 s lease. Whether the fix brings the step to about 195 s is a model, not a production fact. The owner wants to exercise the mechanism without waiting for the next 17:00 Madrid run and without a second publication.

What the code does (read on `main` at `dfd1a51`):

1. `seal_stage` is not a function of stored state alone. `planDiscoveryLedger` takes `latest`, the discovery scan produced by the `epg` step of the same run from the live provider feed, and derives `departures` (keys that left the scan) from it. Without a recorded scan there is no archive work to measure.
2. The archive commit writes create-only segment objects under a fresh `writeId` (`writeLedgerSegment`, `etagDoesNotMatch:*`), then a manifest, then swaps `LEDGER_ARCHIVE_POINTER` by compare-and-swap. The pointer swap is the Discovery archive's commit point and is a production write. Segment and manifest objects are unreferenced until it, but they are real R2 writes (and orphans if abandoned).
3. Every fence reads the Discovery lease (`renewDiscoveryLease`, which renews it), the published-EPG generation and the pointer ETag, and `epgStepGuard` reads and renews the EPG step lease row. A rehearsal that holds the production lease would block the real run; one that does not hold it does not exercise the fence.
4. The production run needs `sync.json` in stage `epg` for the same `runId`; a rehearsal must not write that document.

## Options

| | Reuses real `planDiscoveryLedger`, fences, lease renewal | Production R2/D1 timing | Writes to production storage | New durable state |
|---|---|---|---|---|
| (a1) Offline replay (Node, `MemoryBucket`, fixtures) | yes, with test doubles | no (simulated) | none | none |
| (a2) In-Worker replay: real reads, writes diverted to an in-memory overlay (bucket, D1 lease row, pointer) | yes, with an overlay in front of real bindings | reads real; puts and lease writes simulated | none by design | request receipt only (see below) |
| (b) Canary: separate bucket prefix and D1 table namespace, real writes there | yes | writes real, in a separate namespace | yes, in the canary namespace | namespace, retention and cleanup contract |
| (c) Second production commit | n/a | yes | yes, production | rejected: the daily `runKey` allows one successful publication |

## Recommendation (for the owner to accept or change)

**Phase 1 (no owner decision needed beyond this ADR being accepted): (a1) a deterministic offline replay harness.** It runs the real `planDiscoveryLedger`, `writeLedgerSegment`, `epgStepGuard`/`assertStep` and `act` classification against `MemoryBucket` and the D1 stand-in, from a synthetic scan with N departures, with injectable put latency, lease expiry at 300 s, lost lease, pointer CAS conflict and memory ceilings. It reports phase wall, fences count and skipped, `fenceMs/readMs/putMs`, lease renewals, expected versus actual, labelled `simulated`. It proves mechanics and invariants, not production latency. AIR-444 already carries part of this; the new work is the lease-renewal timeline under injected latency and the report format.

**Phase 2 (requires explicit owner decisions D1 to D4): (a2) an owner-only in-Worker rehearsal**, because only it measures the real read path of the production bucket and D1. It would:

- run `planDiscoveryLedger` with `env.BUCKET` replaced by an overlay (reads pass through, `put` goes to a Worker-memory map, the pointer is a memory CAS) and `DB` replaced by an overlay for `epg_orchestration_document` only (a private lease row); the Discovery lease would be a no-op recorder, never `DiscoveryAuthority.renewLease`;
- take its scan from the live `epg/discovery-latest.json` with a bounded, deterministic set of N synthetic departures (the N oldest active keys, N capped), recorded in the report as `source: replay`;
- be created through one owner-only MCP tool and one Workflow-free request (the rehearsal is a single bounded Worker invocation, not a Workflow instance), with an idempotency key, and refuse while the EPG mode is `switching`, an EPG instance is alive, `sync.json` is in `seal`, the EPG step lease or the Discovery lease/projector window is live, or the day's publication is not complete (an incomplete day means the real run still needs the resources);
- return `published:false`, `productionWrites:0` (counted by the overlay, which fails the request if a pass-through write is ever attempted), and `latencyBasis:'simulated puts, production reads'`.

Its honest limit: the 273 s of fences and the segment puts in the 11 Nov step were production R2 and D1 latencies. An overlay measures production reads and CPU/memory of the same code, but put latency is simulated. That acceptance still needs a real natural run observed read-only. The rehearsal cannot replace it.

## Owner decisions required before Phase 2

- **D1. Overlay on production bindings is a new write-mode boundary.** A defect in the overlay is a production write. Accept it only with the guard `productionWrites` fail-closed and a mutation-tested negative suite, or choose (b) or Phase 1 only.
- **D2. Request receipt storage.** "Once, with a receipt, reconciled after an unknown outcome" needs a durable record. Options: a new D1 document `epg_rehearsal` in `epg_orchestration_document` (one row per idempotency key, append-only, retention stated), or no receipt and a read-only status that proves absence of effect. A receipt is a new D1 write path outside the daily publication.
- **D3. Source of departures.** Synthetic N oldest active keys (deterministic, exercises the archive path, differs from a real scan) or a recorded real scan (needs a stored snapshot of the feed, new storage, refused here).
- **D4. Canary (b).** Only if the owner needs real put latency: a separate namespace, a retention/cleanup contract and an operation-specific GO. Not recommended before Phase 1 shows the mechanics.

## What is not decided

No code, tool, route, flag, schedule, Cron or ChatGPT Scheduled Task is created. This ADR authorizes no production run. A second production publication for the same `runKey` is not an option and is never implemented by bypassing the daily key. The existing EPG schedule, the Cloudflare mode, `DISCOVERY_LEDGER_MODE` and the Discovery lease are untouched.

## Consequences

Phase 1 is cheap and fully offline but proves mechanics only. Phase 2 adds one owner-only surface and a receipt contract; it narrows, but does not remove, the gap to production latency. The honest pair of outputs (`simulated` and `production-measured`) stays separate in every report.

## Recovery and migration boundary

Phase 1 adds tests and docs only; reversible by revert. Phase 2, if approved, is removed by deleting the tool and route; receipts (if D2 chooses them) stay as inert history. No data migration. Code rollback does not undo any receipt.

## Evidence

- **Original decision:** not recorded.
- **Implementation:** none.
- **Dated verification:** not recorded; the 348 s observation is in [the AIR-444 report](../evidence/discovery/air-444-bounded-seal-stage-rca-2026-11-11.md).
- **Uncertainty:** the overlay's fidelity to production timing and the 195 s model are not established.

## Follow-ups

Phase 1 implementation card and, after owner decisions D1 to D4, a Phase 2 card; both created by the Planner.
