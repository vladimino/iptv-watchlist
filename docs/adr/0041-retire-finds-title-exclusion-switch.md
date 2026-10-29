# ADR 0041: The Finds display-only title exclusion runs without a switch, and FINDS_TITLE_EXCLUSION is retired

**Status:** Accepted 2026-10-29 (explicit owner approval; documentation decision, no production configuration authorization)  
**Original decision date:** 2026-10-29  
**Recorded at:** 2026-10-29  
**Approval source:** owner flag disposition `retire now`, with one behaviour branch equal to the current value, given in the AIR-229 session on 2026-10-29; ADR-0041 explicitly Accepted and Mermaid visually approved by owner in AIR-229 PR #219 conversation on 2026-10-29  
**Related work:** [AIR-229](https://trello.com/c/ubOHtAgi); prerequisites [AIR-198](https://trello.com/c/9xpmq2fc) (rollout) and [AIR-218](https://trello.com/c/lmToHh5p) (v2 list); [ADR-0028](0028-finds-display-only-watched-exclusion.md); [ADR-0033](0033-finds-exclusion-namesake-relaxation.md); [ADR-0039](0039-allowlisted-feature-flag-readout.md)  
**Supersedes:** [ADR-0028](0028-finds-display-only-watched-exclusion.md) in part: the switch of decision 5 and the switch-based rollback; the fail-open rule of decision 5 stays  
**Superseded by:** None

## Context

ADR-0028 put the display-only title exclusion behind a Worker variable, `FINDS_TITLE_EXCLUSION`, enabled only by the exact string `on`. The switch was a rollout gate: the list had to be placed and checked before Finds hid anything. AIR-198 placed the list and set the switch on 27 October 2026; AIR-218 replaced the list with a `strict_original_exact_year_v2` list on 28 October and kept the switch on. The owner-only `feature_flags` read of 2026-10-29 05:47 UTC showed the binding `on` and valid, effective `on`.

With the switch on, whether Finds hide anything already depends only on the list object: a missing, oversized or invalid list hides nothing (`unavailable`). The switch adds a second, redundant way to disable the rule and one more branch (`off`, list not read) to maintain.

## Decision

1. `GET /api/catalog/available` reads `letterboxd/display-exclusion.json` and applies it on every request, exactly as it did with `FINDS_TITLE_EXCLUSION=on`. No variable selects the rule.
2. `FINDS_TITLE_EXCLUSION` is retired. The Worker never reads it; a binding of any value is inert. It stays in the `feature_flags` registry as retired, so the leftover binding is visible.
3. Unchanged: the strict original-title and exact-year match, uniqueness in the export and the catalog, identity winning, the rule tags and guards of ADR-0028 and ADR-0033, the size and validity checks, fail-open on a missing or invalid list, and a response that carries only `state` and a count. The only change in the response is that `displayExclusion.state` is no longer `off`: it is `applied` or `unavailable`.
4. Disabling the rule is a change to the list object (removal or replacement) under the owner's approval, or a code revert.

Not decided here: removing the Cloudflare binding, which is a separate owner-approved settings change; any change to the list, the matching rule or its guards.

## Alternatives considered

- **Retire after stabilization.** Rejected by the owner: the rule has run in production since 27 October with the v2 list since 28 October, and no further rollout step depends on the switch.
- **Retain as a permanent operational gate.** Rejected: the rule writes nothing and starts nothing, so it is not a sensitive one-off write that needs a durable gate; the list object already is the operational control.

## Consequences

- One code path; the off branch, its tests and its documentation go away.
- Showing every film again now needs an R2 change to the list object instead of a variable change. Both are owner operations; neither writes facts or ratings.
- A leftover `FINDS_TITLE_EXCLUSION` binding stays until the owner removes it; it changes nothing.

## Recovery and migration boundary

Reversible by a code revert: the switch comes back, and the leftover binding `on` keeps the rule running. No data is written by this change or by the rule. This record authorizes no flag, binding, R2 or D1 change.

## Evidence

- **Original decision:** owner disposition in the AIR-229 session on 2026-10-29.
- **Implementation:** `src/worker.js`, `src/feature-flags.js`, `tests/finds-title-exclusion.mjs`, `tests/feature-flags.mjs`.
- **Dated verification:** `feature_flags` read 2026-10-29 05:47 UTC: `FINDS_TITLE_EXCLUSION` `state: set`, `raw: on`, `valid: true`, `effective: on`. The production read of `GET /api/catalog/available` after deployment is the acceptance step.
- **Uncertainty:** none on behaviour; the read shows the binding, not when it was last changed.

## Follow-ups

Removal of the leftover Worker binding, as a separate owner-approved settings change.
