# AIR-484 EPG seal successor Workflow: implementation readiness and verification matrix

**Recorded:** 2026-11-14 (UTC)
**Status:** Pre-implementation baseline. This document records the approved design and the evidence still to collect; it is **not** evidence of implemented code, a natural run, lower memory usage, or production acceptance.
**Canonical work item:** [AIR-484](https://trello.com/c/CDvqIdUn)
**Design:** [ADR 0144](../../adr/0144-epg-seal-successor-workflow-instance.md), accepted as DESIGN and merged in [PR #631](https://github.com/vladimino/iptv-watchlist/pull/631), commit `684edd0f042dd9056beb0e7baeb71269a07321cc`.
**Implementation PR:** this draft, to be completed and independently reviewed.

## Boundary to implement

The existing one-instance `epg_commit → seal` control flow remains in place until the implementation PR is delivered. After the durable `sync.json stage:seal` checkpoint, claim a successor using D1 `control` CAS, create the deterministic next-series instance, and finish the producing instance normally without another step lease. Preserve the existing single R2 `epg/seal/<runId>/payload.json` and its readers. The staged payload optimization is excluded under [AIR-485](https://trello.com/c/qulgP9a8).

## Pre-change risks that must be verified in code

- **Cross-midnight:** `src/epg-orchestration.js` currently stops `act()` at `day_rolled` before `drive()`. An admitted successor must continue only if its `handoff.sealRunId` matches the unfinished sealed run. Publishing a previous day's seal must never certify today's run.
- **Mixed versions / rollback:** pre-ADR `readControl()` accepts additional fields at schema version 1 and `admit()` does not check `handoff`. A code rollback is safe only after a verified drain with no unfinished successor claim and no live successor. A fail-closed new schema would require a separately delivered earlier compatibility release and is not assumed.
- **Ambiguous `create()`:** an existing terminal Workflow id cannot be reused. Recovery must recheck platform status and control ownership before attach or new-series create, preserving existing failure budget and cooldown.
- **Exactly once:** generation/epoch/lease fences and `seal.units` idempotency must prevent duplicate pointer switches, published intents or events.

## Required implementation evidence (not collected yet)

- [ ] Durable handoff and crash coverage before/after checkpoint, CAS and `create()`; no budget spent by normal handoff.
- [ ] Successor admission and recovered seal on actual `act()` across Madrid midnight, without today's false `done`.
- [ ] Every observed instance-status path; uncertain create, missing/terminal/complete, repeated error, cooldown and quarantine.
- [ ] Mixed-version tests against the actual pre-change executor plus deploy/rollback drain holdpoint.
- [ ] Generation, mode/epoch and lease fences; replayed `seal.units`, no duplicated publication or Discovery intent.
- [ ] Offline memory/CPU evidence (no claim that a successor guarantees an isolated V8 heap).
- [ ] Reference, operations runbook and architecture/Mermaid updated and actual render checked.
- [ ] `npm test`, `npm run build`, PR three-shard CI with each `Run tests` <=240 seconds, independent review, post-merge CI/deploy.
- [ ] Natural EPG runs prove production memory/publication effect before moving AIR-484 from verification to Done.

**Safety:** this preparation authorizes no manual production EPG/Discovery/TMDB execution, lease reset, Task/flag/Access change, migration, R2/D1 intervention or cutover.
