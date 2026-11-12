# EPG diagnostic canary: operating, retention, cleanup and rollback

Contract: [orchestration reliability](../reference/orchestration-reliability.md#epg-diagnostic-canary-the-run-and-its-receipt-air-455-adr-0124). Decisions: [ADR 0121](../adr/0121-epg-diagnostic-rehearsal-design.md), [ADR 0124](../adr/0124-epg-diagnostic-canary-run-contract.md). This page authorizes nothing: provisioning, applying the diagnostic migrations, copying a dataset, activating the diagnostic markers and every launch, stop and cleanup each need an operation-specific owner GO. A passing canary is not AIR-444 acceptance and is not permission to set `DISCOVERY_LEDGER_MODE=bounded`.

## State machine of a run

`preflight` (read) -> `launch` (reservation, instance created, receipt `created`) -> the Workflow: `begin` (receipt `running`), `seal` (baseline written, step lease, the real seal, report), `finish` (receipt `complete` only when the report's `outcome.ok`, otherwise `failed`) -> `result` (read). `stop` marks the receipt `stopping`, terminates the instance and releases the lease; repeat it until it answers `200 stopped` (`202` until the instance ended and the lease was quiet for 60 s). The slot (one active canary) is held through `stopping` and free in every end state. Authorization is Cloudflare Access at the edge; before the first launch the owner confirms that the edge policy really protects `/api/epg/diagnostic/*` (AIR-456 preflight).

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

## Provisioning operator (AIR-456 H1)

`scripts/epg-diagnostic-provision.mjs` is the only tool that writes the schema and the identity of the diagnostic domain; it is an operator script, not part of the Worker bundle, and it creates no Cloudflare resource (the owner creates the D1 database `iptv-epg-diagnostic` and the bucket `iptv-epg-diagnostic` under a separate GO). It refuses the production database (by id) and the production bucket, and the database read back must carry the diagnostic name. Configuration comes from the environment only (`EPG_DIAGNOSTIC_ACCOUNT_ID`, `EPG_DIAGNOSTIC_D1_DATABASE_ID`, `EPG_DIAGNOSTIC_D1_API_TOKEN`, `EPG_DIAGNOSTIC_R2_ACCESS_KEY_ID`, `EPG_DIAGNOSTIC_R2_SECRET_ACCESS_KEY`, `EPG_DIAGNOSTIC_RESOURCE_ID`; credentials scoped to the diagnostic resources only, see the [credentials skill](../../.claude/skills/iptv-credentials/SKILL.md)); values are never printed.

| Command | Effect |
|---|---|
| `check` | read only: target, table count, bucket object count and the judgement `provision` would make |
| `schema` | dry run: the files that would be applied (`migrations/NNNN_*.sql` in order, then `diagnostic-migrations/NNNN_*.sql`) with their sizes and digests |
| `schema --apply --confirm APPLY_EPG_DIAGNOSTIC_SCHEMA` | applies them, one request per file, only to a database with no tables; stops at the first failure without a retry (delete and recreate an empty diagnostic database to start over); then judges the domain |
| `identity` | dry run: the Worker's own `EpgDiagnostic.assess` (seed rows exactly canonical, no other rows, empty bucket, no identity) |
| `identity --apply --confirm PROVISION_EPG_DIAGNOSTIC_IDENTITY` | the Worker's own `EpgDiagnostic.provision`: writes `diagnostic/identity.json` and the identity row once, then reads both back |

The confirmation strings are guards against accident; every `--apply` needs the owner's operation-specific GO. The script never deletes, and the bucket handle it gives `provision` can write only the identity object.

Safety properties and recovery:

- The credentials are sent only to the canonical Cloudflare API endpoint (or a loopback test server): an arbitrary host in `EPG_DIAGNOSTIC_API_ENDPOINT` or `EPG_DIAGNOSTIC_R2_ENDPOINT` is refused before any request, as is a URL with credentials, a query or a fragment.
- Unknown is never empty: a read answer that is not exactly one successful statement result with a `results` array stops the run (`malformed_read`) before any write, so `schema --apply` cannot proceed on a database whose contents were not proven empty.
- A failed or uncertain migration write stops the run at that file; nothing is retried. A half-applied diagnostic database is deleted and created again by the owner (it holds nothing else).
- The identity is two writes: `diagnostic/identity.json` in R2 first, then the D1 row. If the run is interrupted between them (`identity: interrupted` with `sides`), the bucket is no longer empty and `assess` refuses a retry by design. Do not retry and do not insert by hand: verify both sides with `check`, then either the owner deletes and recreates the diagnostic bucket and database (nothing else lives there before H2) or a separately reviewed repair plan is approved.

## Retention and cleanup

Receipts are kept (they are the record of what was run); the report is inside the receipt. The baseline objects a run materializes (`epg/…`, `sync.json`, `diagnostic/runs/materialized.json`) are removed by `cleanup`, which refuses while a canary is active and never touches `diagnostic/identity.json`, `diagnostic/replay/*` or the receipts. Rows of the diagnostic D1 other than the receipts (the Discovery ledger the run loaded, the step lease document, the published markers) are reset by the provisioning procedure of AIR-456, not by `cleanup`. A dataset holds ledger payloads: keep it out of the repository and out of logs.

## Rollback

A code revert removes the routes and the Workflow class; it does not delete provisioned diagnostic resources, receipts or a running instance. Order: (1) `stop` an active canary; (2) revert; (3) clean the diagnostic domain and, if the owner decides, delete the diagnostic bucket and database (an owner operation). The production EPG schedule, the Cloudflare mode and `DISCOVERY_LEDGER_MODE` are never touched by this feature.
