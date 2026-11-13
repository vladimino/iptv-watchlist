# ADR 0137: A unit absent from a complete, committed, sealed newer input settles its older failed result as left_plan

**Status:** Accepted
**Original decision date:** 2026-11-13
**Recorded at:** 2026-11-13
**Approval source:** Owner decision of 13 November 2026 (option C), recorded in the [AIR-374 Trello comment 6af791c3ce1593d6890b1351](https://trello.com/c/ha7ais3w) and in the [owner decision record on PR #601](https://github.com/vladimino/iptv-watchlist/pull/601#issuecomment-6866712541); the owner's words: if the Film did not enter the Discovery cycle, let it disappear; the cycle repeats and the Film gets another attempt when it appears in the programme again
**Related work:** [AIR-374](https://trello.com/c/ha7ais3w), [ADR 0128](0128-epg-canonical-producer-durable-execution.md), PR #601 (S4-4)
**Supersedes:** None. It extends ADR 0128 decision 8 (the `left_plan` supersession of a result whose unit is absent from the current plan, which ADR 0128 placed in the retry pass and which a permanent refusal never reaches) and leaves every other ADR 0128 decision unchanged
**Superseded by:** None

## Context

ADR 0128 supersedes a live result as `left_plan` only when the retry pass touches it, and the retry pass takes only due results of owner `unit`. A `refused_permanent` result has no schedule, so a failing Film that never returns to the plan would keep `canonicalFreshness` away from `current` for ever, and the retry pass could not clear it. ADR 0128 also did not say what evidence shows that a unit is truly absent: a single Discovery chunk, a partial scan or a pending generation would wrongly look like absence.

## Decision

1. **When a unit is absent.** Once the COMPLETE, COMMITTED, SEALED candidate input of a newer EPG and Discovery cycle (the published EPG generation and its sealed scan or discovery input) is the input of a producer pass that has given every unit of its plan a durable outcome, a unit that has an older live result and is not in that plan is absent. The pass settles that result terminally as `superseded` / `left_plan`. The historical row, its code and its provenance stay. No per-film release event is required, and the completion of the later bounded Discovery resolver chunks is not.
2. **Evidence, strictly pinned.** The caller states the provenance explicitly: `complete`, `committed` and `sealed` each exactly `true`, and the published generation equal to the generation the run was planned for. One Discovery chunk, a partial or unsealed scan, a failed input build or an uncommitted or pending generation is not provenance. Without it nothing is settled (fail closed); the result stays live and the generation stays `partial`.
3. **Only an older run.** A result is settled only when its run is PROVEN earlier than the settling run by the caller's authoritative, monotonic ordering of published generations. A run key, a creation time or a string comparison is not that ordering. A later run's result (a delayed older pass) is never touched, and an order that cannot be proven settles nothing.
4. **Bounded and resumable.** The settlement is one compare-and-set per row, behind the marker fence, within the step deadline, resumable by the next step and idempotent (a terminal row is never offered again).
5. **Return is a new attempt.** If the Film appears in a later published programme it re-enters normal planning, and a failure there is a new result row of the new run. An obsolete terminal result is never reopened as the new attempt.
6. **Scope.** Producer and Discovery result freshness only. Canonical Film identity, watched state, ratings and catalog or history records are never deleted or changed.

## Alternatives considered

- **Keep the older failure as a permanent blocker.** Rejected by the owner: it makes freshness unreachable for a Film that left the programme.
- **A per-film release event.** Rejected by the owner: the sealed full input is the proof of absence.
- **Wait for every Discovery chunk.** Rejected by the owner: the sealed, published input is enough.
- **Settle on any newer run key.** Rejected: a delayed older pass could then settle a newer result.

## Consequences

- A corrected or shrunk later generation can become `current` while the failure stays as history.
- The wiring (S5-1) must supply the provenance from the sealed input and the authoritative generation ordering; until then the driver settles nothing for an absent unit.
- No numeric D-C value, no production access and no flag is involved.

## Recovery and migration boundary

Nothing is deployed or migrated: the driver is dormant and unbundled, and the settlement writes only the producer result table that migration 0020 created. A code revert leaves any settled row as it is; the rows are history.

## Evidence

- Owner decision: the [Trello comment](https://trello.com/c/ha7ais3w) and the [PR #601 decision record](https://github.com/vladimino/iptv-watchlist/pull/601#issuecomment-6866712541).
- Implementation and tests: [producer driver reference](../reference/data/producer-driver.md), [offline evidence](../evidence/d1-migration/air-374-s4-4-producer-driver-offline-2026-11-13.md).

## Follow-ups

S5-1 supplies the provenance and the generation ordering; each production step keeps its own owner GO.
