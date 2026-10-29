# ADR 0046: Every accepted fingerprint is written as an immutable body and generation record, and FINGERPRINT_VERSION_OBJECTS is retired

**Status:** Proposed (owner flag disposition given; ADR acceptance pending; no production configuration authorization)  
**Original decision date:** 2026-10-29  
**Recorded at:** 2026-10-29  
**Approval source:** owner flag disposition `retire now`, keeping the behaviour of the current value, recorded on AIR-266 on 2026-10-29 after a read-only preflight; acceptance of this record is pending; separate approval is required to delete the production binding  
**Related work:** [AIR-266](https://trello.com/c/QsP4wGQ8); prerequisites [AIR-208](https://trello.com/c/54RDVHNj) (writer) and [AIR-210](https://trello.com/c/DM1Rrnrz) (activation); [ADR-0035](0035-selective-fingerprint-transition-compatibility.md) section 2; [ADR-0039](0039-allowlisted-feature-flag-readout.md); [AIR-265](https://trello.com/c/x7esHy4V) (the separate `PREDICTION_FINGERPRINT_COMPATIBILITY` card)  
**Supersedes:** None. ADR-0035 decides the storage (section 2) but no switch for it; the switch was the rollout gate of the AIR-208 implementation, and this record retires that gate only. Every ADR-0035 decision stays, including the separate mode switch of section 7  
**Superseded by:** None

## Context

ADR-0035 section 2 made immutable fingerprint versions the precondition of every non-identity transition: one create-only content body per `fingerprintHash`, one create-only generation record per `(fingerprintHash, fingerprintSchemaVersion, fingerprintPromptVersion)`, and `fingerprint.json` as the pointer that moves last. AIR-208 implemented it behind `FINGERPRINT_VERSION_OBJECTS`, enabled only by the exact string `on`, because turning it on changes what every fingerprint submit writes to R2. AIR-210 set it on 28 October 2026. Its production check found three naturally submitted fingerprints written in the writer's order (body, record, pointer) with hash parity and consistent index and diagnostics. The `partial` and `restored` paths and the storage conflicts are proven by tests, not in production. The owner-only `feature_flags` read of 2026-10-29 09:49 UTC showed `FINGERPRINT_VERSION_OBJECTS` set to `on` and valid, and `PREDICTION_FINGERPRINT_COMPATIBILITY` set to `selective`.

Switching the writer off is not a safe rollback any more. A pointer restore under `selective` can only use stored generation records, and ADR-0035 section 7 puts the code rollback floor at the release with immutable versions: a fingerprint accepted with the writer off has no record to restore.

## Decision

1. **The submit always writes the immutable objects.** Every accepted fingerprint (`generated`, `partial` or `restored`) writes its content body create-only, then its generation record create-only, then `fingerprint.json` and the view index, which is the behaviour of the production value `FINGERPRINT_VERSION_OBJECTS=on`. Keys, hashing, serialization, the acceptance check of an existing body (same bytes) and record (same film, hash and versions, valid provenance, stored body), and the `storage_error` before the pointer or the index moves are unchanged. Repeating the same content is idempotent.
2. **`FINGERPRINT_VERSION_OBJECTS` is retired.** The Worker never reads it, and a binding of any value is inert; `off` no longer stops the writer. It stays in the `feature_flags` registry as retired, so the leftover binding is visible.
3. **Unchanged:** `produced` and `previous`, the `partial` and `restored` rules, the schema and prompt versions, run binding, the evaluator, the queue, readers, the profile, the D1 projection, the paged generation scan with its 1,000-record limit, and `PREDICTION_FINGERPRINT_COMPATIBILITY`, which stays a separate active switch (AIR-265).
4. **Stopping the writer is a code revert, never a flag.** Objects already written are never deleted.
5. **The binding is removed as the last step of the retirement.** After the code is merged and deployed and the read-only checks pass, the owner removes the exact `FINGERPRINT_VERSION_OBJECTS` binding from Worker `iptv` under a separate, action-specific authorization, and its absence is read back (`feature_flags`: `state: absent`). That removal and readback are the final acceptance of AIR-266: the card stays open until the binding is gone. `keep_vars: true` means no deployment removes it.

Not decided here: any change to the storage layout, the compatibility rule, the transition registry or the D1 import. Neither the acceptance of this record nor the approval of its PR authorizes a settings change, a submit, a model run or an R2 write; the binding removal in decision 5 needs its own owner authorization.

## Alternatives considered

- **Retain as a permanent operational gate.** Considered and not chosen by the owner. Its only use would be to stop the writer, and a fingerprint accepted then has no generation record, so a later rollback cannot restore it without a model run. A storage failure of the writer already fails the film with `storage_error` and leaves the pointer and the index unchanged.
- **Retire after stabilization.** Not chosen. The writer has run in production since 28 October with verified writes, and no further rollout step depends on the switch.

## Consequences

- One write path for every accepted fingerprint. The `off` branch, its parsing tests and its documentation go away.
- The writer can no longer be switched off at runtime. A conflicting body or record stops the film exactly as before.
- Films whose fingerprints predate the writer still have no generation records; they stay readable through `fingerprint.json` and regenerate when a restore would need one.
- Until the owner removes it as the last step of AIR-266, the leftover `FINGERPRINT_VERSION_OBJECTS` binding stays and changes nothing.

## Recovery and migration boundary

Reversible by a code revert. Before the binding is removed, the switch comes back and the leftover binding `on` keeps the writer on. After the binding is removed, a revert to code that reads the switch also needs `FINGERPRINT_VERSION_OBJECTS=on` restored on Worker `iptv` (owner authorization) before that code is deployed, or new fingerprints get no immutable objects. Objects already written stay in R2 in every case; the Worker never deletes. This record authorizes no flag, binding, R2 or D1 change.

## Evidence

- **Original decision:** owner disposition recorded on AIR-266 on 2026-10-29.
- **Implementation:** `src/enrichment.js`, `src/feature-flags.js`, `tests/fingerprint-migration-queue.mjs`, `tests/fingerprint-readers.mjs`, `tests/feature-flags.mjs`.
- **Dated verification:** [AIR-210 immutable fingerprint storage](../evidence/prediction/air-210-immutable-fingerprint-storage-2026-10-28.md) (three natural submits: body, record and pointer in order, hash parity); `feature_flags` read 2026-10-29 09:49 UTC: `FINGERPRINT_VERSION_OBJECTS` `state: set`, `raw: on`, `valid: true`. After deployment, a `feature_flags` read showing the switch as retired and a read-only check of existing objects and diagnostics are the acceptance steps; no submit is forced for them.
- **Uncertainty:** the `partial` and `restored` paths and the conflict handling are proven by tests only. The read shows the binding, not when it was last changed.

## Follow-ups

None outside AIR-266: the binding removal and its readback (decision 5) close that card.
