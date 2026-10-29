# ADR 0044: The taste-profile compatibility rule is always selective, and PREDICTION_PROFILE_COMPATIBILITY is retired

**Status:** Proposed  
**Original decision date:** 2026-10-29  
**Recorded at:** 2026-10-29  
**Approval source:** owner flag disposition `retire now`, keeping the behaviour of the current value, given in the AIR-231 session on 2026-10-29; acceptance of this record is pending  
**Related work:** [AIR-231](https://trello.com/c/hrOVxD7v); prerequisite [AIR-206](https://trello.com/c/87mg3VNi) (activation); [ADR-0031](0031-selective-prediction-profile-compatibility.md); [ADR-0035](0035-selective-fingerprint-transition-compatibility.md); [ADR-0039](0039-allowlisted-feature-flag-readout.md)  
**Supersedes:** [ADR-0031](0031-selective-prediction-profile-compatibility.md) in part: the mode switch and the feature rollback of section 6; the evaluation rule, the publication validation, the trust model and the one-rule-for-every-consumer requirement stay  
**Superseded by:** None

## Context

ADR-0031 introduced one shared rule for deciding whether a stored prediction survives a taste-profile change, behind a switch: `strict` (default, exact version and hash equality) or `selective` (the shared evaluator keeps a prediction that no published, owner-approved change impact reaches). AIR-206 activated `selective` in production on 28 October 2026 after a shadow stage and an owner-approved profile publication. The owner-only `feature_flags` read of 2026-10-29 07:05 UTC showed the binding `selective` and valid.

The queue's counters showed what strict would do: on 28 October about 2,054 kept predictions would be requeued at once, a large model workload with no taste change behind it. Under selective, an unknown, unapproved or global change already fails closed (stale), so strict adds no safety that selective lacks for an unrecognised change.

## Decision

1. Every consumer of ADR-0031 section 5 decides with the selective rule: the queue, the view, coverage, the catalog and Finds, the runner steps, diagnostics and the MCP readers. No variable selects it, and `profileMode` in responses is always `selective`.
2. `PREDICTION_PROFILE_COMPATIBILITY` is retired. The Worker never reads it, and a binding of any value is inert. It stays in the `feature_flags` registry as retired, so the leftover binding is visible.
3. Unchanged:
   - the pure evaluator, which still accepts `strict` for the consumers that stay strict by contract (the isolated benchmark and the D1 projection);
   - the publication validation and approval digests;
   - fail-closed outcomes for unknown, unapproved or global changes;
   - the queue's diagnostic block, which keeps counting the strict outcome beside the decision (`strict`, `wouldKeep`, `wouldRequeue`, `strictDisagreements`);
   - the fingerprint transition rule of ADR-0035 and its own switch.
4. **The binding is removed as the last step of the retirement.** After the code is merged and deployed and the read-only checks pass, the owner removes the exact `PREDICTION_PROFILE_COMPATIBILITY` binding from Worker `iptv` under a separate, action-specific authorization, and its absence is read back (`feature_flags`: `state: absent`). That removal and readback are the final acceptance of AIR-231: the card stays open until the binding is gone. `keep_vars: true` means no deployment removes it.

Not decided here: any change to the evaluator, the selectors, the approval model or the fingerprint rule. Neither the acceptance of this record nor the approval of its PR authorizes a settings change; the binding removal in decision 4 needs its own owner authorization.

## Alternatives considered

- **Retain `strict` as a permanent emergency gate.** Considered and not chosen by the owner. Switching to strict requeues every non-exact prediction at once, which is itself an operational event; a defect in the selective evaluator is better handled by a code fix or revert, under review.
- **Retire after stabilization.** Not chosen. Selective has decided in production since 28 October with consistent queue and reader counters, and no further rollout step depends on the switch.

## Consequences

- One rule in every consumer; the strict fallbacks that read the variable go away, and the readers always read the genres the evaluator needs.
- There is no runtime switch back to strict equality. Returning to it is a code revert to a version that reads the switch, with the binding unset or `strict`, and it requeues every non-exact prediction.
- Until the owner removes it as the last step of AIR-231, the leftover binding stays and changes nothing.

## Recovery and migration boundary

Reversible by a code revert, which touches no record: a kept prediction keeps its own profile version and hash. Before the binding is removed, the revert keeps today's behaviour because the binding still holds `selective`. After the removal, a revert that should keep today's behaviour needs `PREDICTION_PROFILE_COMPATIBILITY=selective` restored on Worker `iptv` (owner authorization); without it, the reverted code falls back to strict and requeues the non-exact predictions. This record authorizes no flag, binding, R2 or D1 change.

## Evidence

- **Original decision:** owner disposition in the AIR-231 session on 2026-10-29.
- **Implementation:** `src/enrichment.js`, `src/feature-flags.js`, `tests/queue-compatibility.mjs`, `tests/fingerprint-readers.mjs`, `tests/feature-flags.mjs`, and the test loaders that now include the compatibility domain modules the bundle always carries.
- **Dated verification:** `feature_flags` read 2026-10-29 07:05 UTC: `PREDICTION_PROFILE_COMPATIBILITY` `state: set`, `raw: selective`, `valid: true`, `effective: selective`. After deployment, a read-only queue status (`compatibility.mode: selective`) and a `feature_flags` read showing the switch as retired are the acceptance reads.
- **Uncertainty:** none on behaviour. The read shows the binding, not when it was last changed.

## Follow-ups

None outside AIR-231: the binding removal and its readback (decision 4) close that card.
