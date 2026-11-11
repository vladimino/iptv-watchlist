# Discovery operational status, 11 November 2026

[AIR-430](https://trello.com/c/z3Rr6odf). Offline evidence only: the Worker in a Node `vm` on an in-memory R2 and a real Discovery authority on a local sqlite D1 stand-in (`tests/discovery-operational-status.mjs`, migrations to 0018). No production read or write, no Discovery chunk, no TMDB call. Design: [ADR 0115](../../adr/0115-discovery-operational-status-view.md).

## Cause

`discoveryPipelineStatus` walks all active observations with their shows and decisions and compares the authority generation before and after; every Discovery commit moves it, so during chunks the read is refused with `discovery_fence`. A refusal that is correct for a ledger-wide statistic had become the operational readback.

## Method

A ledger of 3 and of 1500 observations is ingested through `ingestLedger`; the stand-in records every statement and the Worker answers `GET /api/enrichment/pipeline/status?view=operational` and the detailed status. A "storm" flag moves `discovery_authority.generation` on every statement against a ledger, decision, admission, segment, score or intent table.

## Results (one local run, indicative; sqlite CLI latency, not D1)

| Read | 3 observations | 1500 observations |
| --- | --- | --- |
| Operational: statements | 16 (9 single reads of the authority gate and the executor record, plus one batch of 7 single-row SELECTs) | 16 |
| Operational: statements against ledger, decisions, catalog, segments | 0 | 0 |
| Operational: writes | 0 | 0 |
| Detailed (quiet): statements | 74 | 81 |
| Detailed under the storm | refused (not 200) | refused (not 200) |
| Operational under the storm, 8 concurrent reads | 200 each, identical `discovery` block | 200 each |

The operational cost is the same for both ledger sizes; the detailed cost grows with the ledger.

States covered in the same file: held cutover (`authority.state: held`, `unavailable: [records]`), loading transfer, unavailable D1 (typed answer, `source: none`), no checkpoint (`unknown`, nulls, no zero), checkpoint older than 3 hours (`stale`, own `observedAt`), empty backlog (`known`, 0, `nextAction: stop`), stopped Workflow at `step_cap` with a backlog, held and expired projector window, generation handoff (`generationConflict`), an unparseable record (named, not replaced), R2 mode with one object failing, invalid `view` (400 before any read), the alias path and the MCP argument. The GET/HEAD audit (60 read routes) covers both views as samples.

## Not proven

Production latency, SQL and page counts on the real ledger, and the behaviour against live Discovery traffic. That needs a read of the new view during natural Discovery activity after deploy.
