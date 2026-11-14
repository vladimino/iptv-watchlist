# ADR 0138: The M2b volume measurement uses a synthetic catalog at the E6 aggregate scale

**Status:** Accepted
**Original decision date:** 2026-11-14
**Recorded at:** 2026-11-14
**Approval source:** Owner decision of 14 November 2026 (Europe/Madrid) on [AIR-465](https://trello.com/c/OMe41E89): the mandatory production full-table M2b copy is replaced by a local synthetic-at-scale experiment; a small real sample needs its own later GO
**Related work:** [AIR-465](https://trello.com/c/OMe41E89), [AIR-374](https://trello.com/c/ha7ais3w), [ADR 0128](0128-epg-canonical-producer-durable-execution.md), [E6 measurement](../evidence/d1-migration/air-374-e6-production-measurement-2026-11-12.md), [synthetic measurement](../evidence/d1-migration/air-465-m2b-synthetic-scale-2026-11-14.md)
**Supersedes:** The measurement-input clause of ADR 0128 gate M2b (a fresh production snapshot as the required input for unit volume and local planning cost). ADR 0128's producer design is unchanged
**Superseded by:** None

## Context

ADR 0128 gate M2b is the offline harness run on a verified copy of the canonical rows, and it names a fresh production snapshot, under its own read-only GO, as the way to obtain one. The full-table reader for that copy was delivered and then blocked: one connector result cannot carry the captured rows ([runbook](../runbooks/film-person-m2b-dry-run-copy.md)). The owner had earlier selected full tables as the copy scope. On 14 November 2026 the owner replaced that requirement with a local synthetic catalog at the published E6 aggregate volumes, and left any real sample to a separate GO.

## Decision

1. **Measurement input.** The M2b measurement of unit volume, statements prepared, and local planning and fingerprint cost uses a deterministic sqlite catalog generated from the repository migrations. The catalog's Film, Person, credit and dimension totals, and the watchlist cohort's credit and Person totals, are the sanitized E6 aggregates. The placement of those rows is a model. It is not a production sample and not production parity.
2. **What one run closes.** It reports units by kind for `film_facts`, `person_mutation` and `film_credits`, including departed Films and the absence and return of that departed set, on the ordinary generation-shaped cohort and on a heavier modelled cohort. It reports local timings and statement counts only.
3. **What one run does not close.** It does not measure production `changedShare` (a no-op on this catalog means the fixture matched itself), `person_state` (the harness does not build that unit), Worker-to-D1 round-trip time, D1 CPU or write cost, or Workflow platform limits. It does not set `sliceSize`, `maxSlicesPerRun`, the slice deadline, the per-run ceiling or the lag SLA. Those stay an owner decision after a real natural pass.
4. **Production copy.** The full-table reader stays blocked and is not the default path. Choosing among its historical delivery options is not a prerequisite for this measurement or for considering a provisional D-C decision. A later small production sample, if one is justified, is a separate operation-specific GO and must include departed Films and the Persons and credits of the sampled Films.
5. **Out of scope.** No production read or write, no wiring of the producer, no migration, flag, Task or marker change. The runtime data flow is unchanged, so this record adds no diagram.

## Alternatives considered

- **Keep the full-table production copy as the required input.** Rejected by the owner on 14 November 2026: the single-result delivery cannot return the capture, and the volume question can be asked on a synthetic catalog first.
- **Treat the synthetic `changedShare` of 0 as the production share.** Rejected: the harness reads back rows the fixture just wrote, so every stored unit is a no-op by construction.
- **Choose D-C numbers from the local timings.** Rejected: local plan and fingerprint time do not price a D1 round trip or an applied write.

## Consequences

- A provisional D-C discussion can use the synthetic unit counts and the local statement counts, labelled as modelled, alongside the E6 aggregates and the M3 timings.
- A deadline, a ceiling that covers the whole plan, and an L1 completion promise still need a natural pass. The synthetic steady plan is 7,240 units before `person_state`; none of the pack's ceilings covers that count in one generation.
- The blocked full-table reader and its digests remain in the runbook as history.

## Recovery and migration boundary

This ADR authorizes no production operation. Rollback of the generator and the documents is reverting the pull request. The local sqlite file is not a stored authority and is not committed.

## Evidence

- **Original decision:** [AIR-465](https://trello.com/c/OMe41E89), 14 November 2026
- **Implementation:** the generator `scripts/epg-producer-m2b-synthetic.mjs` and `tests/epg-producer-m2b-synthetic.mjs` in the delivery pull request
- **Dated verification:** [synthetic measurement](../evidence/d1-migration/air-465-m2b-synthetic-scale-2026-11-14.md), 2026-11-14 00:18 UTC, counts only
- **Uncertainty:** production `changedShare`, `person_state`, Worker-to-D1 round trip, D1 write cost, Workflow limits

## Follow-ups

A natural EPG pass (S5-2, or D1 timings on a natural step under a separate GO) is the measurement that can calibrate the deadline and the lag SLA. An optional production sample is a separate card. Current state belongs to Trello and GitHub.
