# ADR 0047: The fingerprint transition rule always decides, and PREDICTION_FINGERPRINT_COMPATIBILITY is retired

**Status:** Proposed (owner flag disposition given; ADR acceptance pending; no production configuration authorization)  
**Original decision date:** 2026-10-29  
**Recorded at:** 2026-10-29  
**Approval source:** owner flag disposition `retire now`, keeping the behaviour of the current value, given in the AIR-265 session on 2026-10-29 after a read-only preflight; acceptance of this record is pending; separate approval is required to delete the production binding  
**Related work:** [AIR-265](https://trello.com/c/x7esHy4V); prerequisite [AIR-210](https://trello.com/c/DM1Rrnrz) (activation and stage B parity); [AIR-208](https://trello.com/c/54RDVHNj), [AIR-209](https://trello.com/c/kDbOGZuj); [ADR-0035](0035-selective-fingerprint-transition-compatibility.md); [ADR 0044](0044-retire-profile-compatibility-switch.md); [ADR-0039](0039-allowlisted-feature-flag-readout.md)  
**Supersedes:** [ADR-0035](0035-selective-fingerprint-transition-compatibility.md) in part: the mode switch and the feature rollback of section 7. The transition rule, the registry and its approvals, immutable storage, migration scheduling, the code rollback floor and the schema or prompt rollback stay  
**Superseded by:** None

## Context

ADR-0035 introduced the fingerprint transition rule behind a separate switch with default `strict`: exact schema and prompt version equality unless `PREDICTION_FINGERPRINT_COMPATIBILITY=selective`. AIR-208 and AIR-209 implemented the queue, the runner and every reader behind it, and AIR-210 activated `selective` in production on 28 October 2026 after a stage B parity check that passed. The owner-only `feature_flags` read of 2026-10-29 15:44 UTC showed the switch set to `selective` and valid. The queue overview at the same time showed 2,366 films unchanged, `strictDisagreements: 0`, `wouldRequeue: 0` and coverage at 100 %.

The transition registry is still empty, so today the rule decides exactly as strict equality does. It differs only after a declared schema or prompt transition, or after a code rollback that leaves a fingerprint ahead of the code; in both cases `selective` keeps or restores fingerprints that `strict` would regenerate. ADR 0044 already made the profile rule always selective.

## Decision

1. **The fingerprint transition rule always decides.** The queue, the runner (`start`, `next`, `submit`, `complete`) and every reader (view, coverage, catalog and Finds, queue status, status, queue overview, film diagnostics) use one combined verdict for the fingerprint, the prediction prompt and the profile, which is the behaviour of the production value `selective`. The runner's `next` always restores a fingerprint ahead of the code from a stored generation record that is exact for the code.
2. **`PREDICTION_FINGERPRINT_COMPATIBILITY` is retired.** The Worker never reads it, and a binding of any value is inert; `strict` no longer brings back exact equality. It stays in the `feature_flags` registry as retired, so the leftover binding is visible. The readouts report `fingerprintMode: selective`.
3. **Unchanged:** the evaluator, which still accepts `strict` for the consumers that are strict by contract (the D1 projection, the benchmark, the fingerprint-view backfill); the registry and its owner approvals; the fail-closed outcomes for unknown or unapproved transitions and for an index entry without its impact facet; the queue's strict shadow counters (`strict`, `wouldKeep`, `wouldRequeue`); migration scheduling and the batch share; run binding; immutable storage.
4. **Returning to exact equality is a code revert, never a flag.**
5. **The binding is removed as the last step of the retirement.** After the code is merged and deployed and the read-only checks pass, the owner removes the exact `PREDICTION_FINGERPRINT_COMPATIBILITY` binding from Worker `iptv` under a separate, action-specific authorization, and its absence is read back (`feature_flags`: `state: absent`). That removal and readback are the final acceptance of AIR-265: the card stays open until the binding is gone. `keep_vars: true` means no deployment removes it.

Not decided here: any transition declaration, registry change or change to the evaluator. Neither the acceptance of this record nor the approval of its PR authorizes a settings change, a queue rebuild, a model run or an R2 write; the binding removal in decision 5 needs its own owner authorization.

## Alternatives considered

- **Retain as a permanent operational gate.** Considered and not chosen by the owner. Its only use would be to switch every consumer back to exact equality, which after a non-identity transition requeues the whole catalogue for a full re-fingerprint; ADR-0035 already called that the costly last resort. Transitions take effect only through declarations that need owner approval, so the rule has no unapproved effect to switch off.
- **Retire after stabilization.** Not chosen. Waiting for the first real transition would keep a second code path for a decision already taken, and the readers, the queue and the runner already agree film by film under `selective` in production.

## Consequences

- One rule for every consumer; the strict branches of the queue decision, the readers and the runner's restore step go away. Test fixtures now carry the impact facet that every production index entry has, because the rule cannot judge an entry without it.
- An index entry without its impact facet fails closed and is queued; the runner's `next` repairs the facet from the stored fingerprint without a model run. Production has none (`unindexed: 0`).
- Until the owner removes it as the last step of AIR-265, the leftover `PREDICTION_FINGERPRINT_COMPATIBILITY` binding stays and changes nothing.

## Recovery and migration boundary

Reversible by a code revert. Before the binding is removed, the switch comes back and the leftover binding `selective` keeps today's behaviour. After the binding is removed, a revert to code that reads the switch also needs `PREDICTION_FINGERPRINT_COMPATIBILITY=selective` restored on Worker `iptv` (owner authorization), or every consumer falls back to exact equality. No fingerprint, prediction or index record is rewritten by this change. This record authorizes no flag, binding, R2 or D1 change.

## Evidence

- **Original decision:** owner disposition in the AIR-265 session on 2026-10-29.
- **Implementation:** `src/enrichment.js`, `src/feature-flags.js`, `scripts/local-fixtures.mjs`, `tests/fingerprint-migration-queue.mjs`, `tests/fingerprint-readers.mjs`, `tests/queue-compatibility.mjs`, `tests/feature-flags.mjs` and the reader tests whose fixtures gained the impact facet.
- **Dated verification:** [AIR-210 stage B parity](../evidence/prediction/air-210-immutable-fingerprint-storage-2026-10-28.md); `feature_flags` read 2026-10-29 15:44 UTC: `PREDICTION_FINGERPRINT_COMPATIBILITY` `state: set`, `raw: selective`, `valid: true`, `effective: selective`; `prediction_queue_overview` at the same time: mode `selective`, 2,366 films unchanged, `unindexed: 0`, `strictDisagreements: 0`, `wouldRequeue: 0`, coverage 100 %. After deployment, a `feature_flags` read showing the switch as retired and a read-only queue overview are the acceptance steps; no run is started for them.
- **Uncertainty:** with an empty registry the production rule has not yet decided a real transition; that path is proven by tests only. The read shows the binding, not when it was last changed.

## Follow-ups

None outside AIR-265: the binding removal and its readback (decision 5) close that card.
