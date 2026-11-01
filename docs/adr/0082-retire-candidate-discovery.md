# ADR 0082: Retire the optional candidate-discovery search

**Status:** Proposed
**Original decision date:** 2026-11-01
**Recorded at:** 2026-11-01
**Approval source:** owner GO on [AIR-91](https://trello.com/c/ob6zOaAK) to delete the experimental path and keep the absent-flag behaviour; formal Accepted or Declined is a separate owner gate and is not implied by that GO
**Related work:** [AIR-91](https://trello.com/c/ob6zOaAK); prerequisites [AIR-86](https://trello.com/c/INQy9Hca) and [AIR-69](https://trello.com/c/FlcWZX7W); [ADR 0011](0011-bounded-title-variants.md); [ADR 0036](0036-scored-resolution-only.md)
**Supersedes:** [ADR 0011](0011-bounded-title-variants.md) in part (the sentence that optional search is independently gated by `CANDIDATE_DISCOVERY`); [ADR 0036](0036-scored-resolution-only.md) in part (the bullet that `CANDIDATE_DISCOVERY` keeps its role as the only optional switch). The structural-form and ambiguity rules of ADR 0011, and the scored-only resolver of ADR 0036, stay
**Superseded by:** None

## Context

ADR 0011 allowed bounded title, spelling, numeral and neighbouring-year searches, and said that optional search is independently gated by `CANDIDATE_DISCOVERY`. ADR 0036 then made the scored gate the only resolver and left that variable as the only optional switch: the exact string `on` planned the extra searches.

The switch was never approved on. [AIR-81](https://trello.com/c/ywuOtfo0) recorded NO-GO, [AIR-84](https://trello.com/c/E7wlg7uV) recorded INSUFFICIENT DATA, and [AIR-86](https://trello.com/c/INQy9Hca) replayed 38 stored rows and verified 2. [AIR-68](https://trello.com/c/qbLDc6Ql) turned scored resolution on and left `CANDIDATE_DISCOVERY` unset. The owner-only `feature_flags` read at 2026-11-01T22:24:21.589Z reported `CANDIDATE_DISCOVERY` `state: absent`, `raw: null`, `valid: true`, `effective: off`, side effects none. The owner confirmed that Cloudflare Worker `iptv` has no such binding.

The `on` branch was still in `src/discovery.js`. A leftover binding set to `on` would have planned variant searches again. The absent binding already selects the off path: no variant TMDB requests, zero variant counters, no proposals and no extra catalog rows.

## Decision

1. The scored resolver does not plan or send title, year, spelling or numeral variant searches. There is no replacement switch.
2. `CANDIDATE_DISCOVERY` is not read and is not in the `feature_flags` registry. A leftover value, including `on`, does not change a chunk. The preflight above found the binding absent. The owner confirmed Worker `iptv` has no such binding. This record does not delete a Cloudflare binding, and absence of the name from the new registry is not evidence that a binding was deleted.
3. The public discovery status keeps `variantCalls`, `variantErrors`, `variantThrottled` and `variantSkipped`. Each is 0. There is no variant-only hold, and the path does not add `proposedCandidates`. Stored historical previews and the AIR-86 evidence files stay as written.
4. The AIR-86 replay still plans the old queries from `scripts/air-86-variant-generator.js`. The Worker does not load that file. Scoring and the detail gate in the replay stay on the current Worker source.
5. Unchanged: the ordinary exact-title search, the scorer, movie-detail verification, known aliases, year and runtime checks, chunk limits, retry and backoff, compare-and-swap, the resolver lease, generation fencing, queue semantics, and the outcomes `no_confident_match`, `needs_verification` and `ambiguous`.

Not decided here: enabling or re-evaluating variant search, any scorer or identity change, a Cloudflare settings edit, and any production discovery, EPG, ratings, prediction, R2 or D1 operation.

## Alternatives considered

- **Keep the flag readable with `retired: true`, as `SCORED_RESOLUTION` is kept.** Rejected: AIR-91 requires the variable to be neither active nor readable. A registry row would still report a binding the owner has confirmed is absent, and the card forbids a replacement switch.
- **Leave the `on` branch in place behind the absent default.** Rejected: a stale `on` would execute the experimental search. The owner asked to delete that path while preserving today's absent behaviour.

## Consequences

- One discovery search path. The historical NO-GO and INSUFFICIENT conclusions stay in their original sense and are not a plan to turn the search back on.
- Diagnostics clients that read the four variant counters still parse them. They no longer rise above 0.
- `candidateDiscoveryMode`, named as an example consumer in ADR 0039, is gone. The readout no longer computes an effective mode for this name.
- The discovery diagram no longer draws an optional variant node. That drawing needs the owner's visual approval before merge. This Proposed record needs the owner's Accepted or Declined decision before merge. Neither gate is this implementation.

## Recovery and migration boundary

Reverting the code restores the optional branch. It does not create a Cloudflare binding. Today's absent binding, and the previous Worker, both treat a missing `CANDIDATE_DISCOVERY` as off and keep the same standard path. R2 and D1 are not written and are not rolled back. This record authorizes no flag, binding, Scheduled Task, Access, R2 or D1 change.

## Evidence

- **Original decision:** owner GO on [AIR-91](https://trello.com/c/ob6zOaAK), 2026-11-01, to retire the path and keep absent behaviour.
- **Implementation:** `src/discovery.js`, `src/feature-flags.js`, `scripts/air-86-variant-generator.js`, `tests/candidate-discovery.mjs`.
- **Dated verification:** owner-only `feature_flags` at 2026-11-01T22:24:21.589Z, `CANDIDATE_DISCOVERY` absent, effective off, side effects none. Production behaviour after deploy is a later read-only check, not this record.
- **Uncertainty:** the read shows the binding absent at that time. It does not by itself prove a later settings change. The owner's confirmation that Worker `iptv` has no such binding is the other half of that evidence.

## Follow-ups

Formal owner acceptance or decline of this Proposed record, and owner visual approval of the discovery diagram. A production read of discovery status after deploy is observational and is not a new search.
