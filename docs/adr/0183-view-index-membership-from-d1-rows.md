# ADR 0183: The view index key set comes from D1 rows, not from the mutable R2 object

**Status:** Accepted (target design; production not activated)  
**Original decision date:** 2026-11-20  
**Recorded at:** 2026-11-20  
**Approval source:** [Owner decision recorded on AIR-552](https://trello.com/c/Hk2dJf2U#comment-6b005e464d8174c52aca7148), following the [decision brief](https://trello.com/c/Hk2dJf2U). The owner chose A, authorized one bounded read-only parity comparison and selected the temporary read selector. Activation and acceptance of observed differences remain separate gates.  
**Related work:** [AIR-552](https://trello.com/c/Hk2dJf2U); [AIR-546](https://trello.com/c/1dRSJEbp); [AIR-275](https://trello.com/c/4x7hH0gI); [AIR-547](https://trello.com/c/99faXisC); [field-level contract](../reference/domain/view-index-read-model.md); [offline analysis](../evidence/d1-migration/air-552-membership-options-offline-2026-11-20.md)  
**Supersedes:** None  
**Superseded by:** None

## Context

`enrichment/view-index.json` is a mutable R2 object (11.3 MB on 17 November 2026, [footer RCA](../evidence/footer-status-oom-rca-2026-11-17.md)) that every prediction submit rewrites under a compare-and-swap. At production authority every field of every entry is replaced at read from D1 (`prediction_pointer`, `prediction_fingerprint`, `ratings_view`), so the object contributes one thing: **which ids are keys** (membership), before an in-memory compiled-seed layer some readers add. The [contract](../reference/domain/view-index-read-model.md) fixes this field by field.

Key existence matters to few readers. Programme, Finds, footer counts, queue freshness, Admin health dimensions, limbo, diagnostics and Letterboxd matching derive state from entry **fields** (`prediction`, `fingerprintHash`, `watched`, `actualRating`, `watchlist`), so an absent entry reads as an empty one. The readers that use the key set itself are the identity bridge candidate list (`catalogBridgeIds`), the `entries` count of the Admin health card, and the operator Letterboxd scripts, which read the object from a snapshot file and register every lid-shaped key as a match target.

The object costs memory and writes: the footer has a streaming reader because the 128 MB isolate overran memory on the whole object, and each film's prediction submit reads and rewrites it once.

## Decision

**Accepted target: option A.** The key set of the view index is the union of the film ids of `prediction_pointer`, `prediction_fingerprint` and `ratings_view`, read in bounded keyset pages by the same overlay readers that exist today. The compiled ratings seed stays a separate in-memory layer applied afterwards with today's rule: an own `actualRating` (an explicit `null` included) wins, otherwise the seed fills it, and a seed-only id adds a key. The raw object is no longer read, and `updateViewIndex`, `ensureInitialRatings` and the mood and fingerprint backfills stop writing it. No new table, no migration, no second mutable authority. Field values, `moodFacet` recomputation, the fail-closed refusals (`ratings_domain_not_authoritative`, `overlay_rows`) and the no-write rule of GET are unchanged.

The owner chose a temporary `r2` (default) / `d1` read selector for the implementation, with the R2 writers continuing until a controlled switch and later cleanup. This decision accepts the **architecture**, not a particular production data diff. A single scoped read-only comparison of the existing R2 key set with the three D1 tables and the compiled seed is separately approved in the decision record. Actual field/key differences, activation thresholds, selector creation or modification in production, cutover and decommission remain unapproved until their own evidence and owner decisions.

## Alternatives considered

**A. Union of D1 rows (accepted target).** Differences from today, each reported by id by the offline classifier and typed by which D1 table holds the row (the prediction overlay supplies different fields per table):

- **Removed key.** A raw key with no D1 row of any of the three kinds and no seed id disappears. It carries no fact, so every field-based reader is unchanged; it leaves the bridge candidate list, the health `entries` count and the operator scripts' lid targets.
- **Forecast gain** (an id with a `prediction_pointer` row that is not a raw key). `item.prediction` appears, with a mood facet derived from it. Today such an id shows no forecast. Visible effects: the full view, the footer prediction coverage, queue freshness (the film reads as predicted) and Finds eligibility.
- **Feature gain** (an id with a `prediction_fingerprint` row that is not a raw key). `fingerprint`, `fingerprintHash`, `impactFeatures` and the mood facet appear, **without a forecast**. This is a different visible change: mood and mechanics filtering and the compatibility evaluator see the film's features. It does not change prediction coverage or queue freshness by itself.
- An id with both rows gains both; an id that is already a key today through a ratings alias or a seed id gains the fields but not the key. One possible cause of any gain is a submit that committed D1 and then failed before the index write, which the parity run cannot prove.

Cost per request: the keyset reads the overlays already do, minus one 11.3 MB object read; no per-submit object rewrite.

**B. Explicit D1 membership table.** A table of ids written in the same D1 batch as each prediction and ratings write, with a migration, a marker or fence, a backfill from the raw object and a repair path. It preserves today's membership exactly, including keys that no reader needs. Cost: a new mutable authority that must be kept consistent with the two domains it mirrors, a migration number (schema 0028 is already allocated by the merged Filter presets migration; verify the next free number before use), an owner-approved read of the raw object for the backfill, and retirement of the table if A is later chosen.

**C. Keep the raw object as a read-only mirror.** Rejected for AIR-552: production still reads an 11.3 MB mutable object, so the dependency the card removes stays.

## Consequences

A removes the dependency, the per-submit object rewrite and the whole-object read, and creates nothing to repair. Its risk is the removed keys and two distinct typed field gains above; these must be measured by the parity run, not assumed harmless. B better preserves legacy membership at the price of new state; reconsider B only with a further owner decision if a raw-only key is essential and cannot be recovered through an authoritative identity source. Either option must keep the seed layer and the Letterboxd reader path (ratings overlay only; it needs the ratings and seed ids, not the prediction ids).

## Approved parity investigation and gated rollout

1. **Owner-authorized single read-only parity comparison.** This one permission covers a bounded export of the *key set* of `enrichment/view-index.json`, the film ids of `prediction_pointer`, `prediction_fingerprint` and `ratings_view` in the production `iptv` D1 database, and the compiled ratings seed. Use proven side-effect-free read tooling only, verify the production D1 binding and authority markers first, and do not publish raw private records. The offline `compareMembership` classifier (`scripts/view-index-membership-parity.mjs`) reports `removedKeys`, `newKeys`, `forecastOnly`, `featuresOnly`, `forecastAndFeatures`, seed categories and overlap through existing ratings/seed keys. For each removed key determine whether it is the only identity bridge to a film; for forecast gains assess Finds eligibility, footer coverage and queue freshness; for feature gains assess mood/mechanics. An unexpected marker, source error or budget overrun is a stop, not a reason to repair or fall back.
2. **Operator tooling contract.** The snapshot export (`r2-snapshot-export`) and the four Letterboxd scripts must use an explicitly defined D1-derived key-set source (or no view-index source) after cutover. This belongs to the implementation, not the read-only audit.
3. **Owner review of real parity evidence.** Before implementing or activating the replacement, independently verify that removed keys carry no needed field facts and are bridge-redundant (or are explicitly handled by a new owner decision), and separately inspect forecast and feature gains and any effect on user-facing counts and eligibility. Preserve seed precedence including an own `actualRating: null`. Measure the row-count and CPU margin against the existing 20,000-row overlay caps. **A is approved as the target, but no specific production difference is approved yet.** If the audit exposes essential legacy-only ids or an unacceptable effect, stop and ask the owner to choose targeted preservation or reconsider B.
4. **Implementation PR, after the parity review.** Target fresh `main`; implement D1-derived membership across `loadJSON`, `readViewIndex`, Finds/programme, footer streaming, Admin health/limbo, queue, diagnostics/recovery, `LetterboxdFacts.readJSON` and operator scripts. Add a temporary read selector with `r2` as default and `d1` as an option, plus a defined retirement follow-up and feature-flag contract. Keep the R2 writers running until the approved switch so that read rollback remains possible. Read-only GET must never write. Retain the existing authoritative-domain fail-closed guards and bounded keyset paging.
5. **Controlled switch, requiring a distinct owner-approved L3 plan.** The owner must approve the actual parity differences and activation holdpoints, including before/after footer and Finds readbacks, measured resource budgets and bounded stabilization. Creating or changing any production selector/flag is not authorized by the architectural decision or the audit permission.
6. **Cleanup, separately gated.** After verified acceptance, remove raw R2 writers/readers and the temporary selector in a reviewed PR. Retire the object only under a separate owner-approved R2 operation, not in this ADR approval PR.

Rollback until cleanup: return the selector to `r2` while the raw index is still being maintained. A code rollback is not a data rollback. After cleanup, rebuilding an R2 view index from D1 would require a separate owner-approved offline export.

## Recorded owner decisions and unresolved acceptance

- **Selected:** A rather than a new mutable D1 membership table (B) or a permanent raw R2 mirror (C).
- **Approved observation:** one bounded read-only production parity comparison of the specified R2 key set, D1 film ids and compiled seed. No other production operation is included.
- **Selected rollout shape:** temporary `r2` / `d1` selector with `r2` as default, removed after stabilization. The selector is not yet deployed or set in production.
- **Conditionally acceptable in principle, not yet accepted in production:** previously committed forecast gains and fingerprint/feature gains, with their actual effects presented after parity.
- **Still gated:** any essential removed key, real user-facing behavioral differences, implementation release acceptance, production flag change, cutover, R2 cleanup and AIR-552 final acceptance.

## Recovery and migration boundary

Architecture and documentation only. The single narrowly scoped, read-only production parity comparison described above is owner-authorized; this ADR does not authorize any production mutation, additional read/repair, migration, flag change, Task, R2 deletion or authority cutover. Each such action needs separate owner approval. A code rollback never reverts R2 or D1 data.

## Evidence

- **Original decision:** [owner-approved target A, bounded parity permission and selector choice](https://trello.com/c/Hk2dJf2U#comment-6b005e464d8174c52aca7148), 20 November 2026.
- **Implementation:** no read-model replacement yet; [PR #812](https://github.com/vladimino/iptv-watchlist/pull/812) delivered the earlier Proposed ADR and offline classifier only.
- **Dated verification:** [offline analysis, 20 November 2026](../evidence/d1-migration/air-552-membership-options-offline-2026-11-20.md), synthetic fixtures only.
- **Uncertainty:** the production raw object's real key set against the D1 rows, the number and effect of removed keys and typed gains, and whether any legacy-only identifier needs preservation. No production parity readback has yet been recorded.

## Follow-ups

The implementation and temporary-selector retirement follow-ups remain to be scoped after the approved parity investigation, with explicit owner gates for production action. Coordinate documentation with [AIR-547](https://trello.com/c/99faXisC). AIR-552 remains open and continues to block AIR-275 until actual acceptance.
