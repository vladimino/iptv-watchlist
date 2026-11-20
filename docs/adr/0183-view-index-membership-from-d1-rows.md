# ADR 0183: The view index key set comes from D1 rows, not from the mutable R2 object

**Status:** Proposed  
**Original decision date:** not decided; the owner has not chosen between the options below  
**Recorded at:** 2026-11-20  
**Approval source:** not documented. This record asks for the owner decision; it is not Accepted and authorizes nothing.  
**Related work:** [AIR-552](https://trello.com/c/Hk2dJf2U); [AIR-546](https://trello.com/c/1dRSJEbp); [AIR-275](https://trello.com/c/4x7hH0gI); [AIR-547](https://trello.com/c/99faXisC); [field-level contract](../reference/domain/view-index-read-model.md); [offline analysis](../evidence/d1-migration/air-552-membership-options-offline-2026-11-20.md)  
**Supersedes:** None  
**Superseded by:** None

## Context

`enrichment/view-index.json` is a mutable R2 object (11.3 MB on 17 November 2026, [footer RCA](../evidence/footer-status-oom-rca-2026-11-17.md)) that every prediction submit rewrites under a compare-and-swap. At production authority every field of every entry is replaced at read from D1 (`prediction_pointer`, `prediction_fingerprint`, `ratings_view`), so the object contributes one thing: **which ids are keys** (membership), before an in-memory compiled-seed layer some readers add. The [contract](../reference/domain/view-index-read-model.md) fixes this field by field.

Key existence matters to few readers. Programme, Finds, footer counts, queue freshness, Admin health dimensions, limbo, diagnostics and Letterboxd matching derive state from entry **fields** (`prediction`, `fingerprintHash`, `watched`, `actualRating`, `watchlist`), so an absent entry reads as an empty one. The readers that use the key set itself are the identity bridge candidate list (`catalogBridgeIds`), the `entries` count of the Admin health card, and the operator Letterboxd scripts, which read the object from a snapshot file and register every lid-shaped key as a match target.

The object costs memory and writes: the footer has a streaming reader because the 128 MB isolate overran memory on the whole object, and each film's prediction submit reads and rewrites it once.

## Decision

**Proposed (recommended): option A.** The key set of the view index is the union of the film ids of `prediction_pointer`, `prediction_fingerprint` and `ratings_view`, read in bounded keyset pages by the same overlay readers that exist today. The compiled ratings seed stays a separate in-memory layer applied afterwards with today's rule: an own `actualRating` (an explicit `null` included) wins, otherwise the seed fills it, and a seed-only id adds a key. The raw object is no longer read, and `updateViewIndex`, `ensureInitialRatings` and the mood and fingerprint backfills stop writing it. No new table, no migration, no second mutable authority. Field values, `moodFacet` recomputation, the fail-closed refusals (`ratings_domain_not_authoritative`, `overlay_rows`) and the no-write rule of GET are unchanged.

Not decided here: whether the switch is an owner-set flag or a deploy, the parity thresholds the owner accepts, and every production read or write.

## Alternatives considered

**A. Union of D1 rows (above).** Two key-set differences from today, both reported by id by the offline classifier: a raw key with no D1 row and no seed id **disappears** (an entry with no fact left; inert for every field-based reader, but it leaves the bridge candidate list, the health `entries` count and the operator scripts' lid targets), and a prediction or fingerprint id that is not a raw key **gains its forecast** (today it shows none; one possible cause is a submit that committed D1 and then failed before the index write, which the parity run cannot prove). The second is visible: the full view, the footer prediction coverage, queue freshness and Finds eligibility treat that film as predicted. Cost per request: the keyset reads the overlays already do, minus one 11.3 MB object read; no per-submit object rewrite.

**B. Explicit D1 membership table.** A table of ids written in the same D1 batch as each prediction and ratings write, with a migration, a marker or fence, a backfill from the raw object and a repair path. It preserves today's membership exactly, including keys that no reader needs. Cost: a new mutable authority that must be kept consistent with the two domains it mirrors, a migration number (0028 is taken by an open change; verify before use), an owner-approved read of the raw object for the backfill, and retirement of the table if A is later chosen.

**C. Keep the raw object as a read-only mirror.** Rejected for AIR-552: production still reads an 11.3 MB mutable object, so the dependency the card removes stays.

## Consequences

A removes the dependency, the per-submit object rewrite and the whole-object read, and creates nothing to repair. Its risk is the two differences above; they are bounded by the parity run, not argued away. B keeps behavior identical at the price of new state; it is the safer choice only if the parity run shows a raw-only key that a reader needs. Either option must keep the seed layer and the Letterboxd reader path (ratings overlay only; it needs the ratings and seed ids, not the prediction ids).

## Parity criteria and rollout (for owner approval; none is authorized now)

1. **Owner GO for one read-only export** of `enrichment/view-index.json` and the film ids of the three D1 tables, using the existing read-only snapshot tooling. `compareMembership` (`scripts/view-index-membership-parity.mjs`) classifies it. Report: counts of `disappears`, `gainsForecast`, `addedKeys`, seed categories; for each `disappears` id whether it is the only bridge to a film; for each `gainsForecast` id the effect on Finds eligibility and footer counts.
1b. **Operator tooling.** Under A the snapshot export (`r2-snapshot-export`) and the four Letterboxd scripts need a defined view-index source (a D1-derived key set, or none); that change belongs to the implementation PR.
2. **Acceptance of A** needs: `disappears` entries inert for every field reader and bridge-redundant (or explicitly accepted by the owner), `gainsForecast` reviewed by the owner, no seed-category change, keyset reads within the existing 20,000-row caps with a measured margin.
3. **Implementation PR** after the decision, against fresh `main`, reading from D1 for every consumer (`loadJSON`, `readViewIndex`, Finds and programme, footer streaming, Admin health and limbo, queue, diagnostics and recovery, `LetterboxdFacts.readJSON`) behind a temporary selector (`r2` default, `d1`) with its removal card created first and the flag-lifecycle entry in the same PR; raw writers retained so the object stays current and the switch stays reversible by setting the selector back.
4. **Controlled switch** under an owner-approved L3 plan with holdpoints: before and after readback of the footer counts and the Finds count on permitted read-only routes, stabilization, owner acceptance.
5. **Cleanup PR**: remove the raw writers and reads and the selector; the object itself is retired by a separate owner-approved R2 operation (no delete here).

Rollback until step 5: set the selector back; the raw object was never stopped being written. After step 5 the raw object can be rebuilt only from D1 rows by an owner-approved offline export, so step 5 needs its own gate.

## Questions for the owner

1. Choose A (recommended) or B.
2. May one read-only export for the parity run be performed (the single R2 object and the film ids of the three tables)? Without it neither option can be accepted.
3. If A: temporary selector (`r2`/`d1`, instant rollback, owner-set binding) or a code-only switch by deploy (simpler, rollback is a revert deploy)? Recommended: selector.
4. If A: is a forecast appearing for a film that has a D1 prediction but no raw key acceptable, subject to review of the parity list?

## Recovery and migration boundary

Documentation and an offline classifier only. No production read or write, migration, flag, Task, R2 delete or cutover is authorized by this record; each needs its own owner GO. A code rollback never reverts R2 or D1 data.

## Evidence

- **Original decision:** not recorded (Proposed).
- **Implementation:** none.
- **Dated verification:** [offline analysis, 20 November 2026](../evidence/d1-migration/air-552-membership-options-offline-2026-11-20.md), synthetic fixtures only.
- **Uncertainty:** the production raw object's real key set against the D1 rows, and the number of `disappears` and `gainsForecast` ids.

## Follow-ups

The implementation card and the temporary-flag removal card are created only after the owner decision. Coordinate documentation with [AIR-547](https://trello.com/c/99faXisC).
