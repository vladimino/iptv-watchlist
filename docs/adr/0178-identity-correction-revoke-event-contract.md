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

`ownerMarkerCarry` (`src/discovery.js`) copies `ownerIdentity` and `rejectedTmdbIds` into later resolver decisions even when evidence, status or `tmdbId` change. A matching `ownerIdentity.requestId` therefore proves only that the marker was carried. Preview and confirm bind, and the fenced D1 commit re-checks, all of:

- the original intent row (key = `requestId`, `state='receipt'`, same `observation_key`, its `kind` and `command`);
- the current `decision_hash`;
- for `assign`: `status='verified'`, `identitySource='owner'`, `tmdbId` equal to the original target, `filmId` equal to `tmdb_<id>`;
- for `reject`: the id is still in `rejectedTmdbIds`, `ownerIdentity` still names this `requestId`, and the introduction proof of section 1b holds;
- no later owner action or independent verified decision on this observation: history rows after the original revision are read, and any revision whose writer is not a carry of this marker refuses;
- the dependent assigned rows are the ones `assignedRowsDelete` would remove for this decision, nothing else.

The binding deliberately does **not** compare the resolver's `evidenceKey`. `candidateEvidence()` (`src/discovery.js:61`) hashes title, year, durations and `channelId:start` of every airing, so a harmless new airing changes it. That is a scheduling and attempt fingerprint, not identity evidence. A drifted `evidenceKey` must neither block revoking a still-effective assertion nor clear a revocation.

Any mismatch refuses with `old_action_not_effective` (or `record_changed` for a plain hash race). `before_json` is never replayed: the next decision is computed from the current decision by removing only this marker's effect.

### 1a. Identity evidence is a separate, stable basis

Define `identityBasis` as a digest of the observation's identity inputs only: normalized title, year and `confirmedTmdbId` (from the index record). Airings, durations, channels and the scoring result are excluded. It is computed from the *current* record at preview and at execute. New code records it in `ownerIdentity.identityBasis` for every later assign, reject and revoke. "Genuinely new independent identity evidence" means exactly: the current `identityBasis` differs from the one stored in the revocation. A new airing, a rescore or a changed `evidenceKey` does not qualify. An explicit fresh owner `assign` of the same id is a deliberate override and clears the revocation. Ordinary Discovery processing of other candidates is unchanged; the fence is checked only for this observation and this id.

### 1b. Existing corrections: authoritative derivation, fail closed

`diConfirm` does not persist `evidenceKey` in `issued`, and `rejectedTmdbIds` has no per-entry provenance. For corrections made before this change the contract derives provenance from stored D1 rows, read-only:

- the **introducing revision** is the first `discovery_decision_history` revision of the observation whose payload has `ownerIdentity.requestId` equal to the original key and whose `writer` is `discovery_identity_correct`; the **prior revision** is the one before it;
- for `assign`: the introducing revision must be `verified` with the original `tmdbId`; the revoke then sets `identityBasis` from the current record (no historical `evidenceKey` is needed);
- for `reject`: the id must be in the introducing revision's `rejectedTmdbIds` and **absent** from the prior revision's. If it was already present (an independent or earlier exclusion), provenance is ambiguous and the revoke refuses with `provenance_ambiguous`, preserving the exclusion;
- if the intent, either revision or the writer cannot be found or does not match, the revoke refuses with `provenance_unproven`. An old correction is therefore revocable only when its introduction is provable, never by assumption.

`before_json` may be read to cross-check the prior revision. It is never written back.

### 2. `revoke` of `assign` and of `reject` have different semantics

- **Revoke an assign:** remove `ownerIdentity`, `identitySource='owner'`, the verified `tmdbId`/`filmId`/`canonicalIdentity` and the dependent assigned rows; set `status='needs_verification'`. Record `revokedOwnerAssign {tmdbId, requestId, identityBasis}`. Discovery must not re-confirm that id while the current `identityBasis` equals the recorded one (section 1a).
- **Revoke a reject:** remove only the entry proven in section 1b and this owner's `ownerIdentity`. It writes no negative marker and no `revokedOwnerAssign`. Any independently justified exclusion stays. The id becomes eligible for the next ordinary chunk.
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

Revoke is itself append-only; undoing it is a new owner action. Code rollback does not revert D1 rows. The new migration follows the ordinary migration-apply procedure with its own evidence; this ADR authorizes no operation.

## Evidence

- **Original decision:** not recorded
- **Implementation:** none yet
- **Dated verification:** not recorded
- **Uncertainty:** whether any real production correction exists; whether the index record always carries `confirmedTmdbId` and year for `identityBasis`; `ownerDecision` expiry semantics for a revoke issuance (to confirm in implementation).

## Follow-ups

Implementation of [AIR-132](https://trello.com/c/3AXbSoHe) after owner decision; [AIR-131](https://trello.com/c/0WtLPRnH) follows.
