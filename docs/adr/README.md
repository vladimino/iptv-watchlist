# Architecture Decision Records

Architectural Decision Records (ADRs) preserve the **reasoning and durable constraints** behind material design choices. They are not feature lists, migration execution approvals, or production observations. Read [documentation governance](../README.md) and use the [ADR template](template.md).

## Accepted records

| ADR | Status | Scope and evidence |
| --- | --- | --- |
| [0001 — D1 schema v1 is unapplied](0001-d1-schema-v1.md) | Accepted (existing historical record, unchanged) | Immutable schema v1 and local-only D1 adapters with R2 still authoritative; [AIR-49](https://trello.com/c/YNaLFwtW), [PR #51](https://github.com/vladimino/iptv-watchlist/pull/51) |

Retrospective ADR reconstruction is **planned, not yet recorded**: [AIR-116 platform](https://trello.com/c/6MHbRFZR), [AIR-117 domain/resolution](https://trello.com/c/ORglHnul), [AIR-118 prediction/data](https://trello.com/c/5qf3Zn3p). Do not reserve numbers by publishing invented decisions; add each documented decision to this register only after verification.

## Decision lifecycle

- **Proposed:** under review, not yet agreed.
- **Accepted:** documented owner/architecture acceptance for an explicit scope. Include both original date (if known) and date documented.
- **Superseded:** replaced by an explicitly linked later ADR; leave the old adopted decision intact and add the successor in the index.
- **Rejected:** evaluated but never accepted; do not claim implemented status.

A new ADR is expected for authoritative source ownership, persistent identity/schema, module or trust/security boundary, orchestration model, publication/recovery strategy, migration/cutover contract, or fundamental domain invariant. A routine bug fix, UI styling, or non-architectural refactor does not itself require ADR.

An Accepted ADR must link Trello/PR/commit and appropriate dated evidence; when historically recovering one, note *unknown* motivations and alternatives honestly. ADRs capture design decisions; **current implementation** is described in reference docs and actual deployed runtime is established by safe production checks. Rolling back a code commit does not automatically roll back R2 data, settings, or schedules.
