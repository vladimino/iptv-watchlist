# EPG diagnostic canary: operating, retention, cleanup and rollback

Contract: [orchestration reliability](../reference/orchestration-reliability.md#epg-diagnostic-canary-the-run-and-its-receipt-air-455-adr-0124). Decisions: [ADR 0121](../adr/0121-epg-diagnostic-rehearsal-design.md), [ADR 0124](../adr/0124-epg-diagnostic-canary-run-contract.md). This page authorizes nothing: provisioning, applying the diagnostic migrations, copying a dataset, activating the diagnostic markers and every launch, stop and cleanup each need an operation-specific owner GO. A passing canary is not AIR-444 acceptance and is not permission to set `DISCOVERY_LEDGER_MODE=bounded`.

## State machine of a run

`preflight` (read) -> `launch` (reservation, instance created, receipt `created`) -> the Workflow: `begin` (receipt `running`), `seal` (baseline written, step lease, the real seal, report), `finish` (receipt `complete` only when the report's `outcome.ok`, otherwise `failed`) -> `result` (read). `stop` marks the receipt `stopping`, terminates the instance and releases the lease; repeat it until it answers `200 stopped` (`202` until the instance ended and the lease was quiet for 60 s). The slot (one active canary) is held through `stopping` and free in every end state. Every route needs the owner's signed Access assertion for the diagnostic Access application (`EPG_DIAGNOSTIC_ACCESS_AUD`, `EPG_DIAGNOSTIC_OWNER_EMAIL`).

## Reading a result

`status` shows the receipt and the live instance; `result` returns the report once the receipt is final. Compare `expectedVsActual` (departures and rewritten segments of the plan against what the real seal archived), the `seal_stage_*` phases (`fences`, `fencesSkipped`, `fenceMs`, `readMs`, `putMs`), `storage` (per-resource reads and writes), `lease.renewals`, and the invariants (measured `published:false`, `productionWrites:0`, `deniedAccesses:0`, `refusedWrites:0`) and `outcome` (`ok:true`, no `violations`); a run with a violation is `failed` with the whole report. The report says `canary-measured`: diagnostic D1 and bucket latency, not production latency.

| Receipt failure | Meaning and next step |
|---|---|
| `domain_not_prepared` | the diagnostic published generation does not name the dataset's generation: the preparation of AIR-456 is missing |
| `domain_not_clean` | a stray object, another dataset's baseline or a consumed baseline: run `cleanup` (owner GO), then launch again |
| `dataset_missing`, `dataset_invalid` | the dataset is not at `diagnostic/replay/<digest>.json` or does not verify |
| `step_lease_expired`, `epoch_mismatch`, `step_lease_held` | the diagnostic step lease ran out, was lost or is held: no retry; read the report, then `cleanup` |
| other typed codes | the class of the thrown error (`EpgOrchestration.classifyThrown`); the message is never stored |

An unknown create outcome (`202`, receipt `reserved`) is resolved by repeating the SAME launch (same key, same parameters) after `status` shows what exists, or by `stop`; never by a new key.

## Retention and cleanup

Receipts are kept (they are the record of what was run); the report is inside the receipt. The baseline objects a run materializes (`epg/…`, `sync.json`, `diagnostic/runs/materialized.json`) are removed by `cleanup`, which refuses while a canary is active and never touches `diagnostic/identity.json`, `diagnostic/replay/*` or the receipts. Rows of the diagnostic D1 other than the receipts (the Discovery ledger the run loaded, the step lease document, the published markers) are reset by the provisioning procedure of AIR-456, not by `cleanup`. A dataset holds ledger payloads: keep it out of the repository and out of logs.

## Rollback

A code revert removes the routes and the Workflow class; it does not delete provisioned diagnostic resources, receipts or a running instance. Order: (1) `stop` an active canary; (2) revert; (3) clean the diagnostic domain and, if the owner decides, delete the diagnostic bucket and database (an owner operation). The production EPG schedule, the Cloudflare mode and `DISCOVERY_LEDGER_MODE` are never touched by this feature.
