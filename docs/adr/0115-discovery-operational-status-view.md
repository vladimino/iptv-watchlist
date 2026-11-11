# ADR 0115: Discovery has a light operational status view beside the detailed status

**Status:** Proposed  
**Original decision date:** 2026-11-11  
**Recorded at:** 2026-11-11  
**Approval source:** scope of [AIR-430](https://trello.com/c/z3Rr6odf); the card asks for an ADR (proposed → approved) for the new API shape  
**Related work:** [AIR-430](https://trello.com/c/z3Rr6odf), [AIR-344](https://trello.com/c/8TV5soDb), [AIR-428](https://trello.com/c/8U3uMYCJ), [ADR 0085](0085-d1-authoritative-discovery.md), [ADR 0083](0083-inert-discovery-workflow.md)  
**Supersedes:** None  
**Superseded by:** None

## Context

`discoveryPipelineStatus` walks every active observation with its shows and decisions, reads the catalog, and compares the Discovery authority generation before and after (`discovery_fence`). Every Discovery commit moves that generation, so while the Workflow runs, the status often fails closed. The refusal is correct for a ledger-wide statistic and wrong as an operational health read: it was taken for a sign of a failing Workflow, although AIR-428 verified the Workflow's recovery from its own logs.

## Decision

1. **Two semantic levels on the same read-only paths.** `GET /api/enrichment/pipeline/status` (and its alias `discovery/status`, and MCP `epg_pipeline_status`) take an optional `view`. No `view` and `view=detailed` are the unchanged full status with its snapshot fence. `view=operational` is the new light status. An unknown `view` is `400` before any read. Existing clients are not changed.
2. **The operational view reads only small authoritative records**: the authority row, transfer state, status, continuation, workflow, lease and projector window, in one D1 `batch` of at most 7 single-row SELECTs (`DiscoveryAuthority.readOperationalSnapshot`). One batch is one snapshot, so no generation compare is needed and a Discovery commit cannot refuse it. Outside D1 authority the same records are small R2 objects read independently. It never reads an observation, show, decision, admission or segment, never calls TMDB and never writes.
3. **Honest, never invented.** The backlog is two stored facts, the continuation's chunk budget and the last chunk's ledger counts, each with the time of the record that stored it, its programme generation and `known | stale | foreign | unknown` (a fact of another programme than the published one is `foreign` and its values are withheld); the freshness of one is never taken from the other, and no exact figure is computed. The executor facts are derived from the Workflow record of the same snapshot; only the platform liveness of that instance is observed anew and is labeled as a separate, non-atomic observation. A record that cannot be read is named in `unavailable` and not replaced from another source; a held cutover is `authority.state: "held"`; an unavailable authority is a typed `200` with `authority.state: "unavailable"` and no records.
4. **Writers and fences are untouched.** No writer, Cron, Scheduled Task, flag or schema changes; the generation fence of every Discovery write stays.

**Not decided here.** No production run, retry, reset or data write is authorized. Delivered in code; not deployed or production-verified until a post-merge deploy and a read of the new view during natural Discovery activity.

## Alternatives considered

- **A separate endpoint or MCP tool.** Not chosen: the `view` parameter keeps one documented path per status and the existing GET audit and MCP schema; the default body is unchanged.
- **Make the detailed status lighter or retry the fence.** Rejected: a ledger-wide statistic under continuous writes cannot be both exact and fence-free; AIR-344 already lowered its memory.
- **Compute the backlog exactly in the light view.** Rejected: it needs the ledger scan the view exists to avoid.

## Consequences

- An operator or monitor gets a bounded, always-readable status during commits; the cost does not follow the ledger.
- Two views to keep consistent; the operational one carries fewer fields and its own `schemaVersion`.
- The platform liveness of the Workflow instance is the one observation outside the snapshot; it is labeled `livenessObserved` with `atomicWithSnapshot: false`.

## Recovery and migration boundary

Code and API only, additive. Rollback is the previous Worker commit; it changes no D1 or R2 data, authority marker, schedule or secret.

## Evidence

- **Original decision:** [AIR-430](https://trello.com/c/z3Rr6odf)
- **Implementation:** the AIR-430 pull request
- **Dated verification:** [AIR-430 evidence](../evidence/discovery/air-430-operational-status-2026-11-11.md) (offline, local stand-ins)
- **Uncertainty:** production latency and the behaviour against real Discovery traffic are not observed.

## Follow-ups

Production read-only verification on natural Discovery activity.
