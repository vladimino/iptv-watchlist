# ADR 0178: Revoking one saved Identity correction is its own append-only intent kind

**Status:** Proposed  
**Original decision date:** unknown (awaiting owner decision)  
**Recorded at:** 2026-11-19  
**Approval source:** not documented (owner gate required before implementation, [AIR-132](https://trello.com/c/3AXbSoHe))  
**Related work:** [AIR-132](https://trello.com/c/3AXbSoHe), [AIR-65](https://trello.com/c/MKb4JMXi), [AIR-528](https://trello.com/c/bj4JSgB9), [AIR-131](https://trello.com/c/0WtLPRnH)  
**Supersedes:** None  
**Superseded by:** None

## Context

Audit of `main` at a888290 (read-only; no production access):

- `ownerDecision` (`src/discovery-authority.js`) writes one decision per idempotency key: it appends a `discovery_decision_history` row, updates `discovery_decision` under `decision_hash` CAS and the lease fence, deletes the dependent assigned rows through `assignedRowsDelete`, and stores a receipt on the `discovery_intent` row.
- `discovery_intent.kind` is `CHECK (kind IN ('reconsider','identity_assign','identity_reject'))` on a STRICT table (`migrations/0011_discovery_authority.sql`). `ownerDecision` accepts only the effects `assign` and `reject`.
- The saved correction is traceable: `discovery_intent` is keyed by `requestId`, and the decision payload carries `ownerIdentity {effect, tmdbId, basis, requestId}`. `discovery_decision_history` keeps `writer` and the payload per revision but has no `requestId` column; the original is found by intent key, then by `observation_key` history.
- Nothing can express "withdraw this earlier assertion". A new `reject` would block the id (a different meaning), and an `assign` of another id is a replacement, not a withdrawal.
- AIR-65 produced no confirmed production correction, so the number of historical actions is unknown.

## Decision (proposed)

Add the effect `revoke` as a first-class append-only intent, referencing the original `requestId`:

1. A new migration `0026` rebuilds `discovery_intent` with `kind` extended by `identity_revoke`. No column is removed and no history row is rewritten. `supersede` needs no new kind: it is `identity_assign` or `identity_reject` with `command.supersedes = <original requestId>`.
2. Preview is read-only and bounded: one intent by primary key, the history of that one observation, the current decision, and its assigned rows. No scan, no TMDB.
3. Execute re-checks D1 authority and generation, the exact `decision_hash`, that `ownerIdentity.requestId` still equals the original, the lease fence and a fresh idempotency key. If a newer evidence or owner action changed the decision, the answer is a refusal (`old_action_not_effective`), never a restore of the old before-image.
4. The write clears only the effect of that assertion and dependent assigned rows. It records the revoked `tmdbId` as not to be re-applied without new independent evidence, appends history and writes a receipt. It starts no Discovery chunk; the UI states "waits for the ordinary chunk".
5. No R2 authority or fallback.

Not decided here: applying migration `0026` to production (separate owner GO), merging, any production POST.

## Alternatives considered

- **A. Extend `kind` with a migration (proposed).** Honest audit trail, explicit state, small rebuild of a table that holds only owner actions. Costs a schema-26 migration and a separate apply gate.
- **B. No migration: store a revoke under `identity_reject` with `effect: revoke` in `command_json`.** No schema change, but the stored kind lies about the action, the CHECK no longer documents the contract, and readers filtering by kind misclassify it. Not recommended.
- **C. Revoke by writing an `assign`/`reject` replacement only.** No new contract, but it cannot withdraw without asserting something new, which the card rules out.

## Consequences

A: one migration and one apply gate; code is tested offline with a v26 fixture. Rollback of code leaves intent rows with the new kind; the old code must ignore unknown kinds (to be tested). B: faster but weakens the contract permanently.

## Recovery and migration boundary

Revoke is itself append-only; undoing it is a new owner action. Code rollback does not revert D1 rows. Migration `0026` follows the ordinary migration-apply procedure with its own evidence; this ADR authorizes no operation.

## Evidence

- **Original decision:** not recorded
- **Implementation:** none yet
- **Dated verification:** not recorded
- **Uncertainty:** whether any real production correction exists; `ownerDecision` expiry semantics for a revoke issuance (to confirm in implementation).

## Follow-ups

Implementation of [AIR-132](https://trello.com/c/3AXbSoHe) after owner decision; [AIR-131](https://trello.com/c/0WtLPRnH) follows.
