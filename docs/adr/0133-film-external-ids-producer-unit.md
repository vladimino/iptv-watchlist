# ADR 0133: `film_external_ids`, the Film external-id producer unit with explicit pruning (P3a, planning and apply, dormant)

**Status:** Accepted as DESIGN for offline, dormant code only, within the owner decision of 13 Nov 2026 on the ten differential exceptions (`external_ids_not_pruned_by_the_planner` is a mandatory FIX before the H2 marker flip; the owner approved the producer fix as bounded code work, not a production operation) and the Controller instruction to deliver it in the producer delivery that owns the change, with a test (source: [AIR-374](https://trello.com/c/ha7ais3w), card comments of 13 Nov 2026).  
**Original decision date:** 2026-11-13  
**Recorded at:** 2026-11-13  
**Approval source:** Owner decision and Controller handoff of 13 Nov 2026 (FIX #6); the unit semantics below (owned schemes, protected ids, refusals) are the reviewer-level decisions this delivery assigns  
**Related work:** [AIR-374](https://trello.com/c/ha7ais3w), [ADR 0130](0130-person-mutation-producer-unit.md), [ADR 0126](0126-epg-producer-layer-person-credits.md), [ADR 0123](0123-producer-receipt-adapter-film-facts.md), [ADR 0119](0119-durable-canonical-write-receipts.md), [ADR 0117](0117-film-person-d1-handoff-owner-decisions.md), [ADR 0099](0099-canonical-film-person-d1-authority.md), [evidence of the owner decision](../evidence/d1-migration/air-374-differential-exceptions-decision-2026-11-13.md), [offline evidence](../evidence/d1-migration/air-374-p3a-film-external-ids-offline-2026-11-13.md)  
**Supersedes:** None. It overrides ADR 0130's rejected alternative "prune external ids the source no longer lists" for FILM external ids only; Person external ids stay upsert-only  
**Superseded by:** None

## Context

The differential harness found that the projector replaces the whole external-id set of a Film from its source while the canonical planner only upserts, so an id the source dropped stays and keeps resolving the Film (`external_ids_not_pruned_by_the_planner`, kept `draft`). The owner decided on 13 Nov 2026 that this one difference must be fixed, not accepted, before the H2 marker flip: an outdated external identifier must not produce incorrect identity resolution. The review of the code showed that no production unit plans the external ids of a Film at all: the EPG layer (ADR 0126) writes facts, credits and membership, the dictionary producer (ADR 0127) writes title and identity, and `film_external_id` is written only by the projector. The "planner" of the exception is the harness's model of a call that no producer makes yet. The fix is therefore a missing unit, not a change to an existing one.

## Decision

1. **A new closed operation kind and a new module, no second write path.** `film_external_ids` is added to `OPERATION_KINDS` (no migration: the SQL column accepts any lowercase identifier, ADR 0119 decision 8). `film_mutation` is not reused: it is also the kind of the Discovery admission and ADR 0126 decision 2 keeps one registry spec per kind. `src/canonical-film-external-ids-producer.js` plans and applies the unit; its only canonical write is the existing fenced `mutateFilm` (`removeExternalIds`, then `externalIds`) with the P3-0a `receiptMark` tail and `requireExisting: true`, so the mutation and its applied receipt are ONE fenced batch. It has no SQL that changes a table, reads no R2, EPG or dictionary, and nothing imports it. Below `open` one marker read returns `skipped`; `held` and an unreadable marker throw (as `person_mutation`).
2. **The unit owns schemes, not the whole set.** The input names the schemes the source owns (`schemes`, non-empty, lowercase identifiers) and every source id must be in one of them. Inside those schemes the unit makes the stored set equal to the source set: it adds the ids that are missing and removes the stored ids the source dropped. An id of any other scheme (the Letterboxd id of a rated admission, an owner id) is never touched. An empty source set with a non-empty `schemes` removes every stored id of those schemes; that is explicit and is the only way an id leaves.
3. **What it never removes or writes, as typed refusals before any receipt.** (a) The ids the identity stands on: the trusted tmdb id of `film.canonical_identity` (`tmdb:<n>`) and the tmdb id of the Film's rated admission. A source that drops or replaces one is refused `film_person_identity_conflict`; the owner or the dictionary decides that, a producer does not (silent loss of a primary identity is the one outcome the owner excluded). (b) A trusted id owned by another Film (the partial unique index `film_external_id_one_trusted`) and a second trusted value of one scheme of the Film after the write: `identity_collision`. (c) A redirected Film: `film_person_redirect`. (d) An absent Film is `absent` and is never created (the Film row belongs to the facts unit). (e) An id that is already stored and still listed keeps its stored trust, conflict flag and provenance; changing the trust of a stored id is not this unit's job.
4. **Bounds and content.** The source set is bounded at 40 ids (`film_person_bounded`), and so is the plan (adds plus removals), the same cap as `person_mutation`. The digest binds the operation, the target id and the content (the owned schemes and the source ids, both sorted sets; the write clock is not content). The removals are derived from the stored rows at plan time and are not part of the digest.
5. **Idempotency, replay and receipts, as `person_mutation`.** The request id comes from the source event, the kind, the target and the digest. The pre-plan reads the stored rows and a no-op ends there with NO receipt (E5). A race that leaves nothing to write ends `unknown`, never a second marking batch. The registry spec (readback, replay, revalidate, `atomic: true`) re-plans from the producer's own source; a re-plan whose digest moved is a typed abandon, a content refusal is `stale`, a read failure propagates so the receipt stays due. A Film that vanishes between the fresh read and the batch fails the whole batch with `film_person_precondition` and is never recreated.
6. **Readiness stays truthful.** No operation is registered in `PRODUCER_OPERATIONS` and `PRODUCER_WIRING` is unchanged, so `producer_not_wired:epg_commit`, `receipts_protocol_unregistered` and the others stay blockers. The exception `external_ids_not_pruned_by_the_planner` stays `draft` and keeps blocking: the difference disappears only when a producer calls the unit, which is the wiring PR; that PR also re-derives `requires` and changes the status (a resolved difference, not an accepted one).

Not decided: which source supplies the owned schemes and ids in `epgSync` (the call site), whether a stored id whose trust the source changed should be updated, splitting a Film with more than 40 ids, and the E6 ceiling for the combined producer.

## Alternatives considered

- **Accept the difference like the other nine:** rejected by the owner (a stale id can corrupt identity resolution).
- **Make the existing planner or `mutateFilm` prune by itself:** rejected: the existing writer cannot know which schemes a source owns, and a blanket replace would delete ids other writers added (rated admission, owner ids).
- **Reuse `film_mutation`:** rejected for the reason in decision 1.
- **Refuse silently, or keep the protected id, when the source drops an identity id:** rejected: a silent skip hides a source disagreement, and the owner excluded silent loss of a primary identity.
- **Prune Person external ids too:** not requested; ADR 0130 keeps them upsert-only and no exception is registered for them.

## Consequences

- A pass at `prepared` costs one marker read. At `open` a changed Film costs the planner reads, the pending-receipt batch, the writer's fresh read and one atomic batch; an unchanged Film costs the reads only and no receipt.
- The wiring PR for the EPG producer has a unit that plans Film external ids, with pruning proven by tests and mutants, instead of the harness's model.
- `OPERATION_KINDS` gains one kind; `mutateFilm` is unchanged (it already supports `removeExternalIds` and `requireExisting`).

## Recovery and migration boundary

Code only; nothing calls it and it writes nothing. No migration, flag, Task, cron, marker move, R2 write or production read is involved. Reverting the change removes the module, its tests and the kind; no data depends on it.

## Evidence

- **Original decision:** [AIR-374](https://trello.com/c/ha7ais3w), owner decision of 13 Nov 2026 ([evidence](../evidence/d1-migration/air-374-differential-exceptions-decision-2026-11-13.md)).
- **Implementation:** the `film_external_ids` pull request of the same card.
- **Dated verification:** [offline evidence](../evidence/d1-migration/air-374-p3a-film-external-ids-offline-2026-11-13.md), counts only.
- **Uncertainty:** no production measurement of Film external-id volume or of the share of sources that drop ids exists; the unit size (40) is provisional until E6.

## Follow-ups

The call site and the source of the owned schemes and ids (the EPG producer wiring), re-deriving `PRODUCER_WIRING` and registering the operation, and the status change of the exception from `draft` to resolved when the wiring lands.
