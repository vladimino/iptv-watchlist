# Authorization and escalation policy

This is the central delivery authorization policy for IPTV Watchlist. It supplements [agent workflow](agent-workflow.md), [Trello conventions](trello-card-conventions.md) and maintained [runbooks](../runbooks/README.md). **Documentation does not confer credentials, runtime permissions or new production writer capabilities.** Accepted ADRs, contracts and existing technical guards remain effective until specifically superseded.

## Decision ownership

| Category | Who decides | Delegated execution |
| --- | --- | --- |
| Product intent, priorities, changed acceptance, final product UX | Product Owner | Planner may propose; cannot silently change intent |
| Material architecture, data authority, security and irreversible trade-offs | Product Owner, advised by Planner and Reviewer | Decision brief before implementation: alternatives, blast radius, rollback |
| Breakdown, approved backlog ordering, ordinary technical choices | Planner / Coordinator | Only approved, unblocked work with verified dependencies and no concurrent conflicts |
| Code, tests, docs and PR fixes | Executor | Any authorized Codex, Cursor, Claude Code or other agent |
| Correctness, evidence and safety review | Independent Reviewer | Real diff and exact PR HEAD, independent of implementation context |
| CI, PR merge, deploy tracking, approved checks and task bookkeeping | Delivery Controller | Verified scope and connected capabilities only |

Roles are portable and not bound to ChatGPT. A chat cannot by itself poll an arbitrary agent forever, consume webhooks or invoke a disconnected executor. Record missing runtime capabilities in the work item rather than treating owner relay as automatic.

## Authorization levels

Classify by **effect and reversibility**, not API method, record count, apparent task size or tool name.

| Level | Typical actions | Decision and controls |
| --- | --- | --- |
| **L0: Observe** | Trello/GitHub reads, CI review, Cloudflare telemetry, proven side-effect-free MCP probes and status | Standing authorization. Verify that a route truly has no writes; least privilege, no sensitive data disclosure. |
| **L1: Routine** | Approved implementation and docs, independent review/fixes, normal PR merge, GitHub Actions deploy, scoped safe smoke | Approved task scope covers execution. Exact-head CI and review still mandatory. Merge never authorizes an unrelated data writer. |
| **L2: Bounded Remediation** | Explicitly permitted idempotent retries, known-checkpoint recovery, scoped repairs | Only after a **specific, reviewed and approved standing remediation contract** with tool, target, limits, preconditions, fencing/CAS, receipts, verification and stop conditions. **This policy enables no new autonomous L2 writer.** |
| **L3: High Impact** | Bulk migrations/backfill, storage authority cutover, destructive cleanup, identity corrections with material effects, Access/secrets/trust changes, flag/schedule edits, out-of-plan data/model producers | Product Owner approves a concrete plan and holdpoints. One plan can authorize bounded checks, commands and readbacks without per-call reapproval, but cannot waive holdpoints. |

Some GET endpoints write: in D1 authority `GET /api/programme`, `GET /api/watchlist`, `GET /api/catalog/available` and the `GET /api/admin/*` reads may run `repairMirrors`, and `GET /api/events`, `/api/enrichment/status` and `/api/enrichment/runs` may settle runs or deliver stop events (the baseline in [read side effects](../reference/api/read-side-effects.md) is the exact list); they are not L0. An authorized scheduled production task may run on its existing schedule; its authorization does not permit a new manual run. Underlying Access/JWT, D1/R2 authority fencing, CAS/leases, idempotency and identity safeguards remain in force.

## ChatGPT Scheduled Task authorization

**Owner approval is mandatory for every mutation or manual execution of ChatGPT Scheduled Tasks**, including creating an ephemeral or one-time task, enabling/disabling one, editing its prompt or schedule, and invoking an immediate run. Authorization must explicitly identify the proposed operation and the intended task or purpose; a previously approved operation does not authorize additional or replacement tasks. Generic requests to complete delivery, wait for CI, monitor a PR, follow up later or reduce owner interruptions are **not** consent to create an automation. Neither L0/L1 routine delivery nor any generic L2 standing authorization overrides this owner gate. Treat schedule/task changes as L3 owner-controlled actions unless a narrowly scoped, explicit owner-approved plan covers the exact operation.

When a CI/deploy job is slow, agents should use in-session observation or record the remaining status and next check in the existing PR/Trello card. Do not create a Scheduled Task as a workaround for the inability to keep a chat alive. Registry reads alone are not task mutations, subject to the normal L0 side-effect verification. An accidental unauthorized task creation must be reported immediately and its status handled transparently; **do not silently change or delete tasks to hide it**.

## Standing authorizations

Every operation-specific L2 authorization must state: exact actor/capability and production domain; input identity and allowed side effects; maximum duration, batch count, attempts and spend; generation/lease/authority preconditions; concurrent-writer protection; idempotency key and outcome reconciliation; evidence/readback; escalation/stop triggers; authorizing scope and revocation mechanism. The actual runtime/tool must enforce or reliably check those conditions.

If the outcome is unknown, **read the authoritative receipt/state before retrying**, using the same idempotency identity when the contract allows retry. Never infer that a timed-out call did nothing. Missing credentials, ambiguous write result without reconciliation, changed generation, conflicting lease, authority/identity uncertainty, exceeded budget or violated invariant means stop the affected action. Do not broaden permissions to make an automation work.

L3 may use **one approval for a staged execution plan**, subject to its explicit holdpoints and verified drain/recovery conditions. A documented plan is not itself owner approval.

## Exception-based management

1. Observe with proven L0 diagnostics. Differentiate transient delay, normal backoff, isolated data-quality issue, unknown state and real incident.
2. Apply only already-authorized L1 continuation or L2 remediation within contractual budget; preserve readbacks and evidence. Repeatable does not mean safe to repeat blindly.
3. If implementation fails agreed acceptance, return precise findings to the Executor for fixes and independent re-review. Isolate a record only when the agreed acceptance and integrity contract permit partial progress.
4. Defer nonblocking issues in a linked atomic task; do not insert false prerequisites or silently enlarge the active task's Definition of Done.
5. Escalate **decisions, not normal errors**: changed product intent, unapproved material architecture, uncovered L3 action, unresolved data authority/identity/integrity risk, exhausted remediation. Include concrete evidence, alternatives, affected outcomes and recommendation.
6. Continue unrelated approved work. Never silently waive a gate or declare an unverified production effect successful.

## Delivery and final acceptance

A Controller can move an **approved, ready** task through implementation, review, approved merge, terminal CI/deployment, scoped verification and `Delivered / Awaiting Owner Acceptance`. Technical supporting cards may close on delegated technical acceptance only if that delegation is part of the approved scope. Product outcomes need explicit owner acceptance or rework; the Controller then closes Trello (list **and** complete state) and unblocks successors.

Newly decided material architecture needs owner approval *before* implementation and an ADR with approval provenance. An ADR documenting an already approved choice can be finalized without asking twice. Mermaid changes require actual rendered visual plus independent semantic review, not a routine owner sign-off. A named exceptional visual or architectural gate still applies. UI product acceptance remains as scoped.

This documentation-only policy changes collaboration rules, not production topology, deployed tools, Cloudflare Access, Scheduled Tasks, flags, migrations, R2/D1 data or runtime entitlements. Revert the documentation PR to roll back these process changes; any future autonomous production action requires its own verified capability and authorization.
