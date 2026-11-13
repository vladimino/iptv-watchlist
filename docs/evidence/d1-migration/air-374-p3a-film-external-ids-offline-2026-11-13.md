# AIR-374 P3a: the `film_external_ids` unit, offline verification (13 Nov 2026)

**Capture:** 13 Nov 2026, offline. Code and tests on the sqlite3-CLI D1 stand-in over the real migration chain `0001` to `0021`; no production, R2, D1, Access, flag, Scheduled Task or connector access. Counts only.

## What was delivered

The dormant Film external-id producer unit of [ADR 0133](../../adr/0133-film-external-ids-producer-unit.md): `src/canonical-film-external-ids-producer.js` (`planFilmExternalIds`, `applyFilmExternalIds`, `filmExternalIdsOperation`, `filmExternalIdsContent`, `filmExternalIdsDigest`) and the new closed kind `film_external_ids` in `OPERATION_KINDS`. It is the fix the owner mandated on 13 Nov 2026 for the differential exception `external_ids_not_pruned_by_the_planner` ([decision](air-374-differential-exceptions-decision-2026-11-13.md)): it adds the ids the source lists and removes the stored ids the source dropped, only inside the schemes the source owns, never an id the identity stands on, one fenced `mutateFilm` batch with the applied receipt. Nothing imports it, it is not bundled, `PRODUCER_OPERATIONS` is still empty and `PRODUCER_WIRING` is unchanged, so no readiness blocker moves: the exception stays `draft` until a producer is wired to call the unit.

## Verification

- `tests/canonical-film-external-ids-producer.mjs` (13 sections on the stand-in): content and digest (a set, sorted, bound to the target and the owned schemes, bounded, malformed refused); dormant below `open` and `held` throws; add and prune in one batch with the receipt, an id of another scheme untouched, a second real pass at a non-zero revision, no-op without a receipt and the request id per event; an empty source set removing the owned schemes only; stored ids never rewritten; the ids the identity stands on (canonical identity, rated admission) refused `film_person_identity_conflict` with no batch and no receipt; other-Film trusted owner, two trusted values, redirect, absent Film, plan over the bound; interleavings (a Film that vanishes is never recreated, a stale revision rolls back whole); the atomic receipt; E5; replay bound to the digest; end-to-end own-origin reconcile (replay prunes, another origin untouched, a moved source abandoned); transient read failures; parity of the owned schemes with the projector's replacement; static dormancy.
- `tests/canonical-film-external-ids-producer-mutation.mjs`: **45 mutants killed** (each removes or inverts one rule in the unit, the kind list or the two `mutateFilm` options it relies on). The first run of the runner left six survivors (an empty and a duplicate scheme list, a pre-plan revision of zero, a vanished Film written, a readback that never finds the facts, a receipt planned at revision zero); each was a blind spot of the test, closed by a new case, and all 42 are killed.
- Existing static allowlists extended for the new importer in `tests/canonical-receipts.mjs`, `tests/canonical-producer-adapters.mjs` and `tests/canonical-epg-person-producer.mjs`.

## Review correction (13 Nov 2026)

The Controller review of the first revision found a blocking safety defect: `externalIds` omitted or undefined was read as an empty source set, so a partial producer input would have planned the removal of every id of the owned schemes (the first revision even asserted that behaviour). Fixed: `externalIds` must be an own array property (`[]` stays the intentional empty set); an omitted, undefined, null, non-array or inherited value is refused `film_person_invalid` before any receipt or batch. Tests: the positive case was replaced by negatives, a new open-marker section proves that stored ids, the Film, the revision, the receipts and the batch calls stay unchanged for six malformed inputs, a re-plan without the field is a typed abandon, and the explicit `[]` still prunes; three mutants cover the rule.

## ADR acceptance

The Controller review required the owner's explicit acceptance of the design choices of ADR 0133 (the first revision marked it Proposed). The owner accepted it on the pull request on 13 Nov 2026 as design approval for the dormant unit; the status is now Accepted. It authorizes no producer wiring, production mutation or H2 marker flip.

## Not done, not verified

- No producer calls the unit: the call site and the source of the owned schemes and ids in `epgSync` are not decided; that is the EPG producer wiring.
- The unit does not update the trust of an id that is already stored and still listed, and does not split a Film with more than 40 ids.
- No production measurement of Film external-id volume or of how often a source drops an id exists; the bound (40) is provisional until E6.
- Whether the `film_external_id` rows of production already contain stale ids was not read.
