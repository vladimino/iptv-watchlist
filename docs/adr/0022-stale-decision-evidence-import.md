# ADR 0022: A discovery decision taken against earlier airings is imported with its own evidence key

**Status:** Accepted (design decision only; it authorizes no production token, export, D1 database, write or Task change)  
**Original decision date:** 2026-10-27 (owner decision after the AIR-74 SQLite dry-run)  
**Recorded at:** 2026-10-27  
**Approval source:** owner instruction in the AIR-74 delivery session, recorded on [AIR-74](https://trello.com/c/5AdAmKPe): import such decisions "with the stored key and provenance `stale_evidence`, as the runtime does"  
**Related work:** [AIR-74](https://trello.com/c/5AdAmKPe), [dry-run evidence](../evidence/d1-migration/air-74-sqlite-dry-run-2026-10-26.md), [ADR-0019](0019-live-d1-backfill-boundaries.md), [ADR-0007](0007-persistent-discovery-evidence.md)  
**Supersedes:** [ADR-0019](0019-live-d1-backfill-boundaries.md) item 5, last sentence, and the matching example in item 8, **for discovery decisions only**  
**Superseded by:** None

## Context

ADR-0019 item 5 made a stored decision whose evidence key disagrees with the key derived from its candidate "a conflict, not a repair", and item 8 listed it among class C exceptions. The importer implemented it as a pre-write refusal of the whole baseline (`evidence_mismatch`), which the acknowledged class C list cannot clear.

The first dry-run on a real production baseline (AIR-175 snapshot, `finishedAt` 2026-10-26T22:19:31.757Z) stopped there: 79 of the 144 decisions that carry a stored key (of 8,984 decisions) differ from the derived key. In all 79 the difference is the airing slots (in 2 also the runtime; never the title or year); every stored slot had already aired, and 21 films are no longer in the published generation. The evidence key is title, year, runtimes and exact airing slots (`candidateEvidence()` in `src/discovery.js`), and every published generation moves the EPG window, so a decision taken against an earlier generation always names past airings. This is drift, not corruption, and any production baseline taken while generations advance contains it.

The runtime already handles it: `resolutionActionability()` keeps a `verified` or `excluded_nonfilm` decision final whatever the evidence, and makes any other decision whose evidence changed actionable again, without rewriting its stored key.

## Decision

1. A stored decision whose evidence key differs from the key derived from its candidate in the published generation is **imported**, with **its own stored key** in `candidate_decision.evidence_key` and `importEvidence: "stale_evidence"` in `provenance_json`. The derived key is not substituted.
2. The candidate fence is unchanged in force: the decision is written only if its candidate is in the published generation, now checked against the candidate's **current** key (`fenceEvidenceKey` in `recordDecision`). A decision without a candidate stays unresolved (`decision_without_candidate`, class C).
3. Parity expects the stored key for such a decision, and the run report counts them under `provenance.evidence.stale_evidence`.
4. Unchanged: a discovery **item** (candidate) whose stored key disagrees with its derived key still stops the import with `evidence_mismatch`; the class C rules of ADR-0019 for identity exceptions are unchanged.

After a cutover the D1 runtime sees the same state the R2 runtime sees: the decision's key differs from the candidate's, so a final decision stays final and any other one is re-checked.

## Alternatives considered

- **Class C ledger record, owner-acknowledged** (offered to the owner with this option): keeps the decision out of D1 until acknowledged. Rejected: it would leave ordinary drift gating the read cutover and lose decisions the runtime keeps.
- **Replace the stored key with the derived key:** would mark a decision as taken against airings it never saw, and for a non-final decision would suppress the retry the runtime would make. Rejected.
- **Take a new snapshot instead:** the EPG window moves with every generation, so no snapshot reliably avoids drifted decisions.

## Consequences

The real baseline no longer refuses on drift, and decisions keep their true history. The repository gains one optional input (`fenceEvidenceKey`); runtime callers do not pass it and keep the old fence. The count of `stale_evidence` decisions becomes a reported figure, not a blocker.

## Recovery and migration boundary

Code-only change to the importer and the unapplied D1 repository; reverting it restores the refusal. It authorizes no dry-run beyond local SQLite, no D1 database, schema or write, and no change to R2 or Scheduled Tasks; each stays under the approvals of ADR-0019 and the [backfill runbook](../runbooks/d1-backfill.md).

## Evidence

- **Original decision:** owner instruction recorded on [AIR-74](https://trello.com/c/5AdAmKPe), 2026-10-27
- **Implementation:** the PR that adds this ADR (`src/offline-importer.js`, `src/epg-repository.js`, `tests/offline-importer.mjs`)
- **Dated verification:** [SQLite dry-run, 26 October 2026](../evidence/d1-migration/air-74-sqlite-dry-run-2026-10-26.md) (the refusal); the repeat dry-run after this change is recorded separately
- **Uncertainty:** the 79 count belongs to one snapshot; later baselines will carry their own

## Follow-ups

Repeat the AIR-74 SQLite dry-run (plain and staged) on the same snapshot, with two reruns that must apply nothing.
