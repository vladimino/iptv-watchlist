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

Add the effect `revoke` as a first-class append-only intent (`identity_revoke`), bound to one original `requestId`. Review of this PR (technical review on HEAD e51cce5) shaped the invariants below.

### 1. Binding: the original action must still be the effective one

`ownerMarkerCarry` (`src/discovery.js`) copies `ownerIdentity` and `rejectedTmdbIds` into later resolver decisions even when evidence, status or `tmdbId` change. A matching `ownerIdentity.requestId` therefore proves only that the marker was carried, not that the owner action still governs the decision. Preview and confirm bind, and the fenced D1 commit re-checks, all of:

- the original intent row (key = `requestId`, `state='receipt'`, same `observation_key`, its `kind` and `command`);
- the current `decision_hash` and the original issuance's `evidenceKey` and target `tmdbId`;
- for `assign`: `status='verified'`, `identitySource='owner'`, `tmdbId` equal to the original target, and `filmId` equal to `tmdb_<id>`;
- for `reject`: the id is still in `rejectedTmdbIds` and `ownerIdentity` still names this `requestId`;
- no later owner action or independent verified decision on this observation: the history rows after the original revision are read, and any revision whose writer is not a carry of this marker refuses;
- the dependent assigned rows are the ones `assignedRowsDelete` would remove for this decision, nothing else.

Any mismatch refuses with `old_action_not_effective` (or `record_changed` for a plain hash race). `before_json` is never replayed: the next decision is computed from the current decision by removing only this marker's effect.

### 2. `revoke` of `assign` and of `reject` have different semantics

- **Revoke an assign:** remove `ownerIdentity`, `identitySource='owner'`, the verified `tmdbId`/`filmId`/`canonicalIdentity` and the dependent assigned rows; set `status='needs_verification'`. The revoked id is recorded as `revokedOwnerAssign {tmdbId, requestId, evidenceKey}`. Discovery must not re-confirm that id on the same `evidenceKey`; it may on a different `evidenceKey` (new evidence means a changed candidate evidence key, never a new owner click or a re-score on unchanged evidence).
- **Revoke a reject:** remove only this owner's entry from `rejectedTmdbIds` and `ownerIdentity`. It writes no negative marker and no `revokedOwnerAssign`. An exclusion that is independently justified (another owner action, another request id, or a resolver-level rule) stays. The id becomes eligible for the next ordinary chunk.
- `revokedOwnerAssign` is a new decision field. It must be added to `ownerMarkerCarry`, to the observation-index view, and to the resolver consumer check next to `ownerRejected`. A later owner `assign` of the same id clears it. `rejectedTmdbIds` is not used to hold it.

### 3. `supersede` is enforced, not descriptive

`supersede` is `identity_assign` or `identity_reject` with `command.supersedes = {requestId, decisionHash}`. `DiscoveryAuthority.ownerDecision` today checks only the assign/reject specifics. This ADR requires a typed validation branch for `revoke` and for `supersedes`: preview and confirm bind the original same-observation action and the exact current target and hash, and the D1 writer enforces that binding in the same fence or refuses. A `revoke` is never passed through the existing assign/reject-only checks.

### 4. Execution boundary

Preview is read-only and bounded: one intent by primary key, the history of that one observation, the current decision and its assigned rows. No scan, no TMDB. Execute re-checks D1 authority and generation, the lease fence, a fresh idempotency key and sections 1 to 3, appends history, writes a receipt, and starts no Discovery chunk (the UI says "waits for the ordinary chunk"). No R2 authority or fallback. The STRICT-table rebuild of `discovery_intent` must be tested offline for row and constraint preservation and for old-code behavior with the new kind.

Not decided here: applying the new migration to production (separate owner GO), merging, any production POST.

## Alternatives considered

- **A. Extend `kind` with a migration (proposed).** Honest audit trail, explicit state, small rebuild of a table that holds only owner actions. Costs a schema-26 migration and a separate apply gate.
- **B. No migration: store a revoke under `identity_reject` with `effect: revoke` in `command_json`.** No schema change, but the stored kind lies about the action, the CHECK no longer documents the contract, and readers filtering by kind misclassify it. Not recommended.
- **C. Revoke by writing an `assign`/`reject` replacement only.** No new contract, but it cannot withdraw without asserting something new, which the card rules out.

## Consequences

A: one migration and one apply gate; code is tested offline with a v26 fixture. Rollback of code leaves intent rows with the new kind; the old code must ignore unknown kinds (to be tested). B: faster but weakens the contract permanently.

## Recovery and migration boundary

Revoke is itself append-only; undoing it is a new owner action. Code rollback does not revert D1 rows. Migration the new migration follows the ordinary migration-apply procedure with its own evidence; this ADR authorizes no operation.

## Evidence

- **Original decision:** not recorded
- **Implementation:** none yet
- **Dated verification:** not recorded
- **Uncertainty:** whether any real production correction exists; `ownerDecision` expiry semantics for a revoke issuance (to confirm in implementation).

## Follow-ups

Implementation of [AIR-132](https://trello.com/c/3AXbSoHe) after owner decision; [AIR-131](https://trello.com/c/0WtLPRnH) follows.
