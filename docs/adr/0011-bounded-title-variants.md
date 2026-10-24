# ADR 0011: Constrain title variants and preserve ambiguity gates

**Status:** Accepted  
**Original decision date:** unknown (retrospective)  
**Recorded at:** 2026-10-24 (retrospective, [AIR-117](https://trello.com/c/ORglHnul))  
**Approval source:** [AIR-80](https://trello.com/c/hQPjVTXv), [AIR-95](https://trello.com/c/kD8xjvVu), [AIR-96](https://trello.com/c/prY7T5iE)  
**Supersedes:** None documented  
**Superseded by:** None documented

## Context

EPG titles can differ from TMDB through numbered sequels, written numerals, `е`/`э` spelling, or neighbouring release years. Broad fuzzy matching can conflate remakes and unrelated films.

## Decision

Generate bounded candidate-search variants; treat only reversible supported structural forms with exact recomputation as title evidence. Require independent year/runtime and detail checks; aliases remain proposals, not scorer authority. Preserve competing-edition and short-title safeguards. Optional search is independently gated by `CANDIDATE_DISCOVERY` rather than silently enabled alongside scored resolution.

## Alternatives considered

Not documented as a verified comparison. Implementation does not establish which other approaches were explicitly considered.

## Consequences

Improves recall on predictable transformations while retaining explicit uncertainty; capped requests and generation-aware retries limit workload. A variant hit is not an identity decision.

## Recovery and migration boundary

Historical NO-GO or INSUFFICIENT experiments are not approval to enable the optional search. Activating the flag requires independent owner authorization.

## Evidence

- [AIR-80](https://trello.com/c/hQPjVTXv), [AIR-95](https://trello.com/c/kD8xjvVu), [AIR-96](https://trello.com/c/prY7T5iE)
- [Candidate-discovery contract](../reference/domain/candidate-discovery.md)
- [Historical replay and verdict registry](../evidence/scored-resolver/replay-cutover-register.md)

**Uncertainty:** The original approval timestamp is not inferred from a later implementation or observation. Historical measurements are scoped to their recorded generation and cannot grant new operational approval.

## Follow-ups

[AIR-117](https://trello.com/c/ORglHnul); any subsequent change to this architectural invariant needs a new decision and independently approved rollout.
