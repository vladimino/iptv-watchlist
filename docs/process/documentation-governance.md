# Documentation routing and acceptance

This policy applies to every technical delivery, irrespective of agent, session or PR size. Read the current [agent workflow](agent-workflow.md), [Trello conventions](trello-card-conventions.md) and [AGENTS.md](../../AGENTS.md) at task start. The matrix is **cumulative**: one change can require several destinations. Record the exact affected paths in the Trello card, implementation handoff and review. `Documentation impact: none` is permitted only with a concrete, reviewable explanation.

| Change | Required maintained documentation |
| --- | --- |
| New research, experiment, audit, parity or rollout verification with durable findings | Dated, reproducible report in [evidence](../evidence/README.md), or a clearly identifiable new section in existing thematic evidence. Include scope, method/source, result, limits, verdict and Trello/PR links. Do not fabricate production observations. Routine unit-test output does not need a separate report. |
| Feature flag definition, accepted values, default, gate, side effects or dependencies | Update [feature flag contract](../reference/feature-flags.md) in the same delivery, with source and tests. |
| Owner-authorized production feature-flag change | Append a timestamped observation and direct authorizing Trello link in [feature flag evidence ledger](../reference/feature-flags.md), including observed value, verification source and uncertainties. The operator must verify the actual binding. The card comment and any relevant operational evidence supplement, not replace, the register. Do not mistake historical observations for live configuration. |
| API, data model, domain behavior or external integration contract | Update the relevant page in [reference](../reference/README.md), with appropriate examples and compatibility notes. |
| Operational procedure, recovery, deploy, access, scheduling or data-source procedure | Update relevant [runbook](../runbooks/README.md); validate safety and rollback/side effects. |
| **Material architecture change**: component responsibilities, data authority, persistence or publication, security boundary, runtime topology, orchestration, cross-service flow or other architectural decision | **Mandatory new ADR** in [ADR register](../adr/README.md) with context, alternatives, rationale, consequences and superseded decision(s), plus updates to every affected [Mermaid architecture diagram](../architecture/README.md) and technical reference contracts. A comment or revised diagram alone is insufficient. Mermaid changes require the established rendered owner visual QA and approval before merge. |
| Changing an earlier architectural decision | Create a **new** ADR that supersedes the earlier one; link both and preserve the original ADR as historical evidence. Do not silently rewrite accepted decisions. |
| Navigation, relocation or deletion of docs | Update indexes and all tracked internal links; do not add placeholder redirect stubs. |

A pure internal refactor with unchanged architectural decisions, data flows, trust boundaries and public contracts does **not** need a new ADR. Record that classification and explain it when an architectural-looking code path changes. Documentation-only policy updates do not themselves require a new architecture ADR.

## Required delivery checkpoints

1. **Card:** declare `Documentation impact` with specific paths/sections and the matrix rationale, or explicitly `none` with justification. This is distinct from the native prerequisite checklist.
2. **Implementation handoff:** preserve the same obligations. Include documentation and evidence alongside code/tests in the same PR or expressly authorized direct-to-main delivery.
3. **Review:** independently compare changed code, configuration and operational scope to this matrix. Missing required ADR, diagram, reference, runbook, evidence or flag entry is a **blocking** issue, even if build/tests pass. In particular, architecture ADRs must contain a real decision, not a token empty file.
4. **Completion:** cite documentation paths and corresponding PR/commit, plus terminal CI/CD and separately authorized live verification where relevant. Never mark Done merely because documentation promises future operational work.

## Automated pull-request checks

[The AIR-149 checker](../../scripts/check-documentation-governance.mjs) runs in the PR **Test and build** job. Every PR body must contain standalone lines `Documentation impact: <paths or none - reason>`, `Architecture impact: changed|none - reason`, and `Research evidence: yes|no`. `changed` requires a new ADR path, a diagram page and a reference page in the diff; `yes` requires an evidence file. When source changes mention one of the registered feature flags, the flag reference must also change. The [test fixtures](../../tests/documentation-governance.mjs) cover positive and negative cases. The checker does not classify architectural changes by semantics, inspect evidence quality, authorize production operations or replace the independent review and Mermaid owner visual gate. On non-PR pushes no PR classification is enforced; the usual test/build/deployment sequence remains unchanged.

