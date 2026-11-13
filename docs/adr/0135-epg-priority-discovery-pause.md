# ADR 0135: Discovery admission pauses for the daily EPG publication and stays paused until that publication is handed off

**Status:** Proposed
**Original decision date:** 2026-11-13
**Recorded at:** 2026-11-13
**Approval source:** owner decision on [AIR-458](https://trello.com/c/RrtTkNg1) (13 November 2026): EPG is the upstream supplier of candidates and has priority over downstream Discovery; Discovery waits for a successful EPG sync with no business TTL, including past two hours; step leases stay bounded; an in-flight chunk finishes or its lease expires, and no new chunk is admitted. This record is the mechanism for that decision. It is not yet Accepted and it authorizes no production operation.
**Related work:** [AIR-458](https://trello.com/c/RrtTkNg1); incident context [AIR-420](https://trello.com/c/J0dit94i) and [AIR-444](https://trello.com/c/lSSrrJdE); [ADR 0089](0089-shared-orchestration-reliability-contract.md); [ADR 0093](0093-discovery-workflow-cron-reconcile.md); [ADR 0098](0098-discovery-workflow-step-failure-recovery.md); [ADR 0100](0100-epg-cloudflare-workflow-executor.md); [ADR 0103](0103-projector-exclusive-window.md)
**Supersedes:** None yet. On acceptance it qualifies, and does not rewrite, one sentence of [ADR 0100](0100-epg-cloudflare-workflow-executor.md) decision 1 and the matching sentence of [ADR 0089](0089-shared-orchestration-reliability-contract.md): EPG still does not run Discovery, and it may soft-busy-wait for a live Discovery lease. It adds a refusal in front of the reconcile of [ADR 0093](0093-discovery-workflow-cron-reconcile.md) and the successor create of [ADR 0098](0098-discovery-workflow-step-failure-recovery.md). It does not change the 300 s deadline of [ADR 0103](0103-projector-exclusive-window.md).
**Superseded by:** None

## Context

On 13 November 2026 the natural EPG run published at 17:44:34 Europe/Madrid, 44 minutes after the 17:00 due time (the publication target is 15 minutes). About 22 minutes of that was cooldown after three EPG failures, two classified `resolver_busy` and one `unknown`, while Discovery chunks held the resolver lease. EPG also waited about 4.5 minutes on a `projector_window`. The memory failures in `seal_ledger` / `seal_publish` are a separate incident and are not decided here.

Those busy collisions are counted today. `publishD1Generation` and the other publication paths that cannot take `discovery_lease` throw `Resolver is writing the catalog`. The continuation diagnostic maps that text to `resolver_busy`, and `EpgOrchestration.classifyThrown` then maps an unrecognised throw to `step_failed`, a transient failure. The shared budget then sleeps (60 s, then 5 min, 15 min, 1 h) and can quarantine the run. A Discovery chunk is not a fault in the publication.

Discovery is downstream of the published generation. It has no candidates until EPG publishes, and a new chunk during the publication only competes for the same lease. The owner decided that Discovery waits. The wait is not the projector window: [ADR 0103](0103-projector-exclusive-window.md) is a mutual exclusion of at most 300 s with its own expiry, and this record does not move the projector or give EPG priority over it.

The pure decision this record specifies lives in `src/domain/epg-priority-pause.js` and is not imported by the Worker. With the table absent, admission stays as it is today.

## Decision

1. **Priority.** EPG publication is ahead of Discovery on the shared `discovery_lease`. The order covers the daily run, a rollover, cron `reconcileDiscoveryWorkflow`, a Workflow successor, and every manual or admin path that would take a new Discovery lease (a chunk, `discovery_reconsider`, an identity correction, poster maintenance, the interrupted-confirm path). An in-flight Discovery chunk is not killed. Its holder may `renewLease` until that chunk ends; a new `acquireLease` is refused. EPG's own `acquireLease` (`role: 'epg'`, including `sealStep`) is exempt, so the publication can take the lease once the holder drops it. A caller that omits `role` is Discovery, so a forgotten call site cannot slip through the pause. The projector window is unchanged and independent: while it is `requested` or `held`, Discovery is also refused for `projector_window`, and an EPG step that meets the window still soft-busies until that window's own deadline ([ADR 0103](0103-projector-exclusive-window.md) decision 5). The window's deadline never lifts this pause, and this pause never extends the window.

2. **When admission closes.** Five minutes before the EPG due instant, 16:55 Europe/Madrid while the due time stays 17:00. The lead is `EPG_PRIORITY_LEAD_MINUTES` before `EPG_SCHEDULE`, not a second hardcoded clock. Five minutes is enough for the overlap to be exceptional: a paged chunk's candidate budget is 40 s (`PAGED_CHUNK_BUDGET_MS`) and the Discovery lease TTL is 90 s (`LEASE_TTL_MS`), and 300 s covers both. It does not promise an empty lease at 17:00. A chunk that is still renewing at the due time is the soft-busy case in decision 5, not a reason to interrupt it or to close admission earlier. The Worker cron is `0 * * * *`. Madrid's offset is a whole hour in both CET and CEST, so a tick exists at 17:00 Madrid on every date; the pause does not add a cron. The arming instant and the due instant exist on both DST transition days, because the transition is at 02:00/03:00. Conversion uses the IANA zone (`madridDayKey`, `madridInstant`), never a fixed offset.

3. **How long it lasts.** Until the owed Madrid date is published and the Discovery handoff is durable: `published_epg_authority` names that date's generation and `published_programme_run_id` equals that `programmeRunId`. There is no `expires_at` and no other automatic lift. A failed, quarantined or stalled EPG run does not release it. A missing Workflow instance does not release it and does not create one; the existing EPG `ensure` remains the creator, and the existing `late` (15 min) and `stalled` (2 h) read model, plus the end-of-day alert, remain the escalation. The pause record names the owed date, so a pause that crosses midnight is the same pause, not a new silent one. Before the next day's arming instant the owed date is still yesterday while yesterday is unconfirmed. At the next 16:55 the owed date becomes that new day even if yesterday never published; a late publication of the older day after that instant does not lift the pause (the same rule as the reliability contract's "a missed date is not backfilled once the next date is due"). An owner override is a separate CAS that sets `override_day_key` to the owed date. It admits Discovery for that date only, it does not publish, and the next arming instant drops it. Removing it closes admission again.

4. **The gate is one D1 statement.** Proposed table `discovery_epg_priority`, one seeded row (`id` 1, `state` `clear` or `paused`, `owed_day_key`, `override_day_key`), no expiry column. The migration file is part of the implementation card and is not applied here. While the table is absent every path behaves as today. While it is present and the row is missing or malformed, Discovery admission fails closed (`evidence_unreadable`) and writes nothing. `acquireLease` for a Discovery caller, and the lease-free generation writers (`writeContinuation`, `writeWorkflow`, `importSegment`), carry the pause predicate in the same statement as the write: a prior SELECT is not the gate. The statement also refuses when the bound `now` is at or after the bound arming instant and the published generation is not the owed date, so a row that is still `clear` cannot admit during the window. The publication batch that commits the pointer and the matching Discovery pin is the only routine writer that sets the row `clear`, in that same batch. `ensure`, reconcile, rollover and `armStepFailureRecovery` treat a pause as a wait and do not create an instance. A restart or a lost Workflow reads the row and the pointer again; neither lives in one isolate.

5. **Soft-busy.** An expected collision is `nextAction: wait` with a closed `reason`: `epg_priority` (this pause; `nextCatchUpAt` is a 60 s poll, `DISCOVERY_EPG_PRIORITY_POLL_MS`, and the poll does not lift the pause), `projector_window` (the window deadline, unchanged), `lease_held` or `lost_race` (the live lease expiry). When the pause and the projector window both apply, the reported reason is `epg_priority`, so a caller cannot treat the window deadline as the end of the pause. None of these increments `consecutive` or `total`, sets `cooldownUntil`, or is classified `step_failed`, `unknown` or HTTP 502. Discovery health while the reason is `epg_priority` is `waiting`, not `stalled`. EPG health is unchanged: a publication that has not happened is still `late` and then `stalled`. A D1 failure stays `d1_unavailable` (transient, counted, no fallback store). `authority_held`, `authority_loading`, `evidence_unreadable`, `evidence_contradictory`, `stale_generation` and `generation_mismatch` stay fail-closed. The diagnostic fields are the reason, the owed date, the lease owner kind (`discovery`, `projector`, `epg`, `none`) and the hold expiry. No Film id, SQL, continuation body or other payload.

6. **After publication.** The old Discovery series does not take a lease and does not keep writing. A requested `programmeRunId` other than the published one is `stale_generation` (fail-closed, no retry loop) once the handoff matches. The intent that may run is the new `publishedProgrammeRunId`, through the existing generation fence and continuation. An interrupted older series stays fenced; recovery ([ADR 0088](0088-guarded-interrupted-discovery-recovery.md), [ADR 0098](0098-discovery-workflow-step-failure-recovery.md)) re-checks the pin and, during the pause, creates nothing.

7. **Crash and race matrix.** The implementation card's tests have to cover this table. `budget` `wait` means no failure count; `fail_closed` means the existing unsafe or transient class.

   | Situation | Result |
   | --- | --- |
   | Acquire before 16:55, yesterday published and pinned | admit |
   | Acquire at or after 16:55, today unconfirmed, row still `clear` | `epg_priority`, `wait`; the same statement arms `paused` |
   | In-flight chunk renews | renewal stands; no new lease |
   | CAS loses the lease to the holder | `lease_held` or `lost_race`, `wait`; EPG sleeps to the expiry and does not count it |
   | Lease expired, pause still open | the next acquire is refused; the pause is not released |
   | Worker or Workflow dies | the row and the pointer are still there; the next admission reads them |
   | EPG retry, rollover, quarantine, stall, or no instance created | pause stays; no TTL; EPG `late` / `stalled` / quarantine stay the escalation |
   | Pointer committed, Discovery pin not equal yet | pause stays |
   | Pointer and pin match for the owed day | row `clear` in that batch; only the new id may acquire; the old id is `stale_generation` |
   | Midnight, then the next 16:55, owed day still unconfirmed | pause stays; the owed date rolls at the next arming instant; an override for the previous date does not apply |
   | Projector window during the pause | Discovery waits as `epg_priority`; EPG soft-busies for the hold it actually met; neither hold lifts the other |
   | Owner override for the owed date | admission opens for that date only; clearing the override closes it; nothing is published |
   | D1 error, held or `loading` authority | fail-closed, as today; the pause does not swallow it |
   | Reconcile, rollover, successor or manual/admin acquire during the pause | no new instance and no new lease |

**Not decided here.** The migration number and the applied schema, any flag, the production arming of the row, and the natural-run acceptance. Nothing in this record is activated. The memory failures of the 13 November seal are out of scope.

## Alternatives considered

- **A fixed TTL, including the projector window's 300 s.** Rejected by the owner. A publication can run longer than any bound chosen in advance, and an expiry would resume Discovery under a live EPG run.
- **Close admission only from the 16:00 cron, with no predicate on the lease statement.** Rejected. The cron does not fire at 16:55, and a check in one round trip followed by a write in another admits a chunk that raced the publication.
- **Derived only from the clock and the pointer, with no row.** Rejected as the whole mechanism. The statement does use that predicate so a late arm still fails closed, but an owner override and a visible owed date need a durable row. A missing row on a present table fails closed rather than pretending the pause is clear.
- **Interrupt the in-flight chunk at 16:55.** Rejected by the owner. The chunk finishes or the existing 90 s lease expires under the fence it already has.
- **Give EPG priority over the projector in this record.** Rejected as scope. The 13 November run also waited on `projector_window`. That window keeps its own contract; changing its schedule is a separate decision.
- **Count `resolver_busy` as a cheaper transient.** Rejected. The collision is not a failure, so it does not enter the cooldown budget at any price.

## Consequences

Discovery does not start new work from 16:55 Madrid until the owed publication is handed off, which on a slow day is the whole publication and on a failed day is until an owner override or a later owed day's publication. That is the priority the owner asked for. EPG stops spending its failure budget on a live Discovery lease. The projector can still delay EPG by up to its own 300 s. A bug that omits the predicate on one generation writer would admit a chunk during the pause; the implementation card has to name every `acquireLease` and every lease-free generation writer. A bug that treats the 60 s poll as an expiry would lift the pause early; the row has no expiry column and the tests refuse one.

## Recovery and migration boundary

Reversible before activation: do not apply the migration. After a later, separately approved activation, code rollback does not delete the row or publish a generation. Clearing a stuck pause is the owner override, not a lease reset and not a TTL. This ADR authorizes no migration apply, flag, cron, Task, Workflow create, Discovery or EPG run, lease change or D1/R2 write.

## Evidence

- **Original decision:** [AIR-458](https://trello.com/c/RrtTkNg1), owner decision of 13 November 2026, recorded in the card
- **Implementation:** none in production. The dormant pure contract is `src/domain/epg-priority-pause.js`, covered by `tests/epg-priority-pause.mjs`. The Worker does not import it
- **Dated verification:** not recorded. The 13 November publication time is the incident context on the card, not a measurement of this mechanism
- **Uncertainty:** how often a chunk is still inside its own budget at 17:00 after a 16:55 close is not measured. The soft-busy path is the bound for that remainder. The interaction with a projector window that starts on the same 17:00 tick is unchanged and still not given a new priority

## Follow-ups

The dormant implementation (migration file not applied, predicate on the admission statements, soft-busy translation, no production arming) is [AIR-459](https://trello.com/c/8AryOCug) and is the only implementation this record unblocks. Applying the migration, enabling the gate and accepting a natural run are later owner-gated cards and are not opened here.
