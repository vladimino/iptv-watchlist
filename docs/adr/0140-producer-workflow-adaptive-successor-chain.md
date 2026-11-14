# ADR 0140: A separate Producer Workflow completes the full EPG producer pass as repeated bounded invocations of one run, in an adaptive chain of instances

**Status:** **Accepted as DESIGN** (2026-11-14, owner-approved architectural direction; implementation and production remain separately gated)
**Original decision date:** 2026-11-14 (architectural direction approved by owner; accepted as design)
**Recorded at:** 2026-11-14
**Approval source:** Owner decision of 14 November 2026 (Europe/Madrid) on [AIR-374](https://trello.com/c/ha7ais3w), comment "Owner decision | AIR-374 / S-A + W3 direction after AIR-465": S-A + W3 with adaptive successors approved. The owner explicitly confirmed acceptance of ADR 0140 as design and authorized a status-only direct-main correction in the project conversation on 14 November 2026. This does NOT authorize code, Cloudflare configuration or production activation.
**Related work:** [AIR-374](https://trello.com/c/ha7ais3w), [AIR-465](https://trello.com/c/OMe41E89), [ADR 0128](0128-epg-canonical-producer-durable-execution.md), [ADR 0137](0137-left-plan-settlement-from-sealed-newer-input.md), [ADR 0098](0098-discovery-workflow-step-failure-recovery.md) (the successor-ownership precedent), [ADR 0100](0100-epg-cloudflare-workflow-executor.md), [ADR 0135](0135-epg-priority-discovery-pause.md), [M1 evidence](../evidence/d1-migration/air-374-m1-workflow-limits-2026-11-14.md), [synthetic measurement](../evidence/d1-migration/air-465-m2b-synthetic-scale-2026-11-14.md), [reader inventory](../evidence/d1-migration/air-374-canonical-freshness-readers-2026-11-14.md), [D-C decision pack](../runbooks/film-person-d-c-decision-pack.md), [S5-1 gate evidence](../evidence/d1-migration/air-374-s5-1-nextaction-gate-2026-11-13.md)
**Supersedes:** None. It qualifies, and does not rewrite, one sentence of [ADR 0128](0128-epg-canonical-producer-durable-execution.md) decision 8 (the cadence line "never driven by a cron, tick or Task"): recovery of an interrupted chain may use the existing hourly reconciliation (below), and no new schedule is added
**Superseded by:** None

## Context

[ADR 0128](0128-epg-canonical-producer-durable-execution.md) designed the durable pass: a plan identity, a durable cursor, failed-unit results, a bounded retry and a generation-aware freshness. [S4-4](../reference/data/producer-driver.md) delivered it, dormant: `sliceSize`, `maxSlicesPerRun` and the slice deadline are required parameters that bound ONE INVOCATION, the run row resumes the cursor when the recomputed fingerprint equals the stored one, and a changed fingerprint within the same run replays from the start with a higher `pass_no`. A new EPG run opens a new run row and supersedes an unfinished pass.

What the delivered code does not contain is a caller that invokes the pass more than once. The [D-C pack](../runbooks/film-person-d-c-decision-pack.md) separates two wirings: (A) one invocation per EPG generation, where the modelled plan of 7,240 units (397 `film_facts`, 6,452 `person_mutation`, 391 `film_credits`; [AIR-465](../evidence/d1-migration/air-465-m2b-synthetic-scale-2026-11-14.md)) cannot finish at a ceiling of 1,000 units and a generation can stay `lagging` run after run, and (B) repeated invocations of the same run. At a ceiling of 1,000 units the full plan needs at least 8 invocations, whatever the unit cost.

The [S5-1 gate evidence](../evidence/d1-migration/air-374-s5-1-nextaction-gate-2026-11-13.md) showed that the continuation branch named by the staged plan is not on the Cloudflare executor's path, and compared the candidate wiring points W1 to W4. The [M1 evidence](../evidence/d1-migration/air-374-m1-workflow-limits-2026-11-14.md) records the documented platform limits: a Workflow instance has a default budget of 10,000 subrequests (D1 and R2 calls count), `limits.subrequests` is a top-level setting that is not raised in `wrangler.jsonc`, a step has no wall-time limit but is bound by the CPU limit (120,000 ms configured), and memory is 128 MB per isolate. Whether a pass fits one instance budget depends on the actual D1, batch and R2 request counts, which are **not measured**; the planner statement counts of the synthetic run are an unbatched stand-in scenario, not a bound in either direction.

## Decision

This accepted DESIGN records the architectural direction the owner agreed. Each point is a boundary or an invariant; none selects a numerical value or authorizes implementation.

1. **S-A is the basis for completing the full pass.** The pass is completed by repeated bounded invocations of the SAME EPG run: the durable cursor resumes while the recomputed fingerprint is equal, a fingerprint change inside the run replays safely from the start, and every write stays generation-fenced. Permanent `lagging` is not accepted as the steady state. The meaning of the full plan and the semantics of `canonicalFreshness` are not changed.
2. **The pass runs in a separate Producer Workflow, started only after the EPG publication has committed.** Its failures are fully isolated from the publication stage and from the failure budget of the EPG executor ([ADR 0128](0128-epg-canonical-producer-durable-execution.md) guardrail G6). A producer error is recorded in the producer store and the read model and is never reported to the EPG executor as a step failure.
3. **The Producer Workflow is an ADAPTIVE chain of instances, not a mandatory new instance after every batch of 1,000 units.** One instance may run several bounded producer invocations or steps while that is safe within the real limits for subrequests, CPU, wall time and memory. A successor is created only when the instance approaches a confirmed budget or another justified instance boundary. The fixed ceiling of units per invocation and the budget of an instance are different boundaries and are chosen and tracked separately.
4. **`limits.subrequests` keeps its documented default of 10,000 per instance.** The top-level limit is not raised globally: it would change every Workflow, and no measurement justifies it. Any change of that limit needs its own measured case and approval.
5. **The chain is single-owner, duplicate-safe and recoverable.** Required invariants for the design:
   - deterministic successor ids, derived from the EPG run and a sequence, so a repeated create names the same instance;
   - a compare-and-set so that exactly one instance owns the run at a time (the run row already carries a revision; whether it needs an owner field is part of the design);
   - a duplicate-safe create: a second create of the same id changes nothing, and a lost or uncertain create is distinguishable from a refused one; an ambiguous `create()` never proves that the instance is absent;
   - recovery from an uncertain create and from a death before the hand-off through the EXISTING hourly reconciliation, which finds a published generation with no complete pass and no live owner and re-creates the deterministic instance. This is recovery of the chain; it is distinct from scheduling the unit retry pass of ADR 0128 decision 8, which stays unscheduled. No new schedule is added;
   - the chain is pinned to one sealed, published EPG generation, and it stops when a newer generation supersedes it;
   - **the fences that exist today do not provide this.** The S4-4 store compare-and-sets the revision of the SAME producer run row and fences the canonical D1 authority marker (`d1`/`open` and its generation). Neither shows that the pinned generation is still the LATEST published one, and a run-row revision compare-and-set does not give exclusive, expiring instance ownership: an older chain could keep advancing its own run after a newer generation superseded it while the marker stays open. S5-1 therefore must add, and its acceptance must verify, an independent latest-published-generation fence or admission at the hand-off and at every mutation boundary, and an expiring ownership claim. The exact protocol is a separate reviewed owner gate; the existing driver is not claimed to prove either invariant, and a bounded hand-off and recovery with its lease and fencing semantics is defined before implementation.
6. **Every invocation is bounded and reported.** Bounded time, units and the actual D1 and R2 calls; each invocation produces a report of counts (no ids or content), so the real consumption against the budgets becomes measurable.
7. **EPG and Discovery keep priority.** The producer yields to the daily EPG publication and to Discovery ([ADR 0135](0135-epg-priority-discovery-pause.md)), and backs off against the single-threaded D1 database; the mechanism and the tolerated level of D1 contention are not decided here.
8. **Observability is its own.** The producer chain has its own telemetry and read-model state, separate from the EPG executor's.
9. **The conflicting D1 and Workers query limits are resolved carefully.** The D1 limits page lists 1,000 queries per invocation (Workers Paid) with a pointer to the subrequest limits, and the Workers and Workflows pages give 10,000. The design must not rely on the larger value until the discrepancy is settled by a primary-source reading or a bounded measurement.
10. **Tests required by the design:** a crash and a retry at every hand-off point, replay and a fingerprint change inside a run, a duplicate create, an uncertain create, a death before the hand-off, supersession by a newer generation, and the bounded-invocation reports.

**What this ADR does not decide:**
- the D-C numerical values (`sliceSize`, `maxSlicesPerRun`, the slice deadline, the per-instance boundary, the lag SLA);
- the concrete mechanism of the hand-off between instances;
- the tolerated level of D1 contention and the backoff rule;
- S-C: the [reader inventory](../evidence/d1-migration/air-374-canonical-freshness-readers-2026-11-14.md) is an input; splitting the pass or adding a narrower completion claim is not approved, and the title readers keep their mode for the wiring PR to assign, and the inventory's title conclusion is limited to eligible provisional localization;
- S-B: a delta plan is deferred until the real steady-state cost is measured; plan identity, `left_plan` ([ADR 0137](0137-left-plan-settlement-from-sealed-newer-input.md)) and the schema are not changed for a hypothetical optimisation.

## Alternatives considered

| Alternative | Why it is not the direction |
| --- | --- |
| W1: a producer step inside the EPG instance after `finished` | Shares the instance, retries and failure surface with the publication, and shares its subrequest budget; documented in the S5-1 gate evidence |
| W2: in the commit request itself | Adds CPU and wall time to a step that already reaches 146 s, and a throw would reach the executor's failure budget |
| W4: the continuation branch of the staged plan | Not on the Cloudflare executor's path in the production mode |
| One invocation per generation (scenario A) | Cannot complete the modelled plan at a ceiling of 1,000 units; leaves a generation `lagging` run after run; the owner rejected permanent `lagging` |
| A new instance after every 1,000 units | Rejected by the owner: the unit ceiling per invocation and the instance budget are different boundaries |
| Raise `limits.subrequests` globally | Rejected by the owner: it changes every Workflow, with no measured justification |
| Split the pass or add a narrower claim (S-C) | Deferred: inventory first, no approval |
| A delta plan (S-B) | Deferred until the steady-state cost is measured |

## Consequences

- The full plan can complete across several invocations without a new run identity, so `current` stays reachable and means what [ADR 0128](0128-epg-canonical-producer-durable-execution.md) says it means.
- New complexity: a second Workflow, a successor protocol with its own ownership and recovery, and a reconciliation step; the design must show it adds no failure path to the publication.
- The architectural use of the existing hourly reconciliation for chain recovery (not the unit retry pass) is accepted by the owner. It is not a new schedule; the exact reconciliation and recovery implementation remains subject to S5-1 review and separate rollout gates.
- A large amount of what the design needs is unmeasured (round trips, batching, instance consumption, D1 contention). The reports of decision 6 are how it becomes measurable, and the D-C numbers wait for them.
- An ELIGIBLE provisional title of a Film that is new to a generation can reach the title readers only after its Film-facts unit has been applied, not at publication. Whether a given Film gets one is not guaranteed: reviewed and owner localization rows are preserved, there may be no eligible source, and presentation also needs a matching trusted TMDB claim. Assigning those readers a mode stays with the wiring PR.

## Recovery and migration boundary

This record authorizes nothing: no code, no Workflow, no `wrangler.jsonc` change, no cron or flag, no `limits.subrequests` change, no migration, no producer run, no production D1 or R2 operation, no H2 and no authority change. Implementation, any schema change the design needs, the Cloudflare configuration and rollout are separate owner gates. A code rollback would not remove Workflow instances that already exist; the design must include the stop and fencing behaviour that makes an orphaned chain harmless.

## Evidence

- **Original decision:** owner direction of 14 Nov 2026 on [AIR-374](https://trello.com/c/ha7ais3w) (a Trello comment; no direct comment URL is recorded here).
- **Implementation:** none. The dormant S4-4 driver is [PR #601](https://github.com/vladimino/iptv-watchlist/pull/601); the limits and arithmetic corrections are [PR #608](https://github.com/vladimino/iptv-watchlist/pull/608).
- **Dated verification:** [M1 evidence](../evidence/d1-migration/air-374-m1-workflow-limits-2026-11-14.md), [synthetic measurement](../evidence/d1-migration/air-465-m2b-synthetic-scale-2026-11-14.md), [reader inventory](../evidence/d1-migration/air-374-canonical-freshness-readers-2026-11-14.md), all of 14 Nov 2026.
- **Uncertainty:** real D1 and R2 request counts per unit, batching, instance consumption, round-trip time, `changedShare`, Person applied cost, D1 contention, whether a create from a step and a create with an existing id behave as the design needs, and the 1,000-versus-10,000 limit discrepancy.

## Follow-ups

The D-C parameters, the hand-off mechanism, the S5-1 wiring PR with its reader modes, and the later implementation and rollout gates are separate owner decisions. Current state belongs to Trello and GitHub.
