# ADR 0178: Revoking one saved Identity correction is its own append-only intent kind

**Status:** Accepted  
**Original decision date:** 2026-11-19  
**Recorded at:** 2026-11-19  
**Approval source:** [explicit Product Owner approval of Option A + A1 in AIR-132 on 2026-11-19](https://trello.com/c/3AXbSoHe#comment-6aff57b6f18bcafb9e0d7c1c), following [independent review of PR #792](https://github.com/vladimino/iptv-watchlist/pull/792#issuecomment-7020719335). Approval covers the architectural contract and routine delivery, not production D1 migration application or identity writes.  
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

## Decision

Add the effect `revoke` as a first-class append-only intent (`identity_revoke`), bound to one original `requestId`. The Product Owner selected alternative **A** and the strict revocation-release rule **A1**. The following invariants are part of the approved architecture.

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

### 1a. Identity basis is provenance, not a release condition

Define `identityBasis` as a digest of the observation's identity inputs only: normalized title, year and `confirmedTmdbId` (from the index record). Airings, durations, channels and the scoring result are excluded. It is computed from the *current* record at preview and at execute, and new code records it in `ownerIdentity.identityBasis` for every later assign, reject and revoke. It serves stable provenance and comparison only.

**Approved A1 rule (strict revocation):** a revoked owner assign is a targeted fence on `(observation, tmdbId)` and is **not** lifted by any drift of `identityBasis`. A title normalization fix or a year edit changes the digest but does not verify that the revoked id is right, and a duration (omitted from the basis) can matter between movie versions. The fence lifts only on:

- a fresh explicit owner-confirmed `assign` of the same id (deliberate override), or
- new, independently sourced, trusted id-specific proof with provenance that was not present at revoke time (for example a `confirmedTmdbId` that comes from a source recorded after the revocation). The exact proof contract is a separate, later decision; until it exists the only release is the owner `assign`.

There is no TTL and no global queue hold. A change of title or year alone lets ordinary Discovery evaluate **other** candidates for the observation, never the revoked id. A new airing, a rescore or a changed `evidenceKey` has no effect on the fence. Other observations are untouched.

The rejected **A2** alternative would lift the fence on any `identityBasis` change. Its risk is silently re-confirming the same erroneous id after a title or year correction; this is not authorized by ADR 0178.

### 1b. Existing corrections: authoritative derivation, fail closed

`diConfirm` does not persist `evidenceKey` in `issued`, and `rejectedTmdbIds` has no per-entry provenance. For corrections made before this change the contract derives provenance from stored D1 rows, read-only:

- the **introducing revision** is the first `discovery_decision_history` revision of the observation whose payload has `ownerIdentity.requestId` equal to the original key and whose `writer` is `discovery_identity_correct`; the **prior revision** is the one before it;
- for `assign`: the introducing revision must be `verified` with the original `tmdbId`; the revoke then sets `identityBasis` from the current record (no historical `evidenceKey` is needed);
- for `reject`: the id must be in the introducing revision's `rejectedTmdbIds` and **absent** from the prior revision's. If it was already present (an independent or earlier exclusion), provenance is ambiguous and the revoke refuses with `provenance_ambiguous`, preserving the exclusion;
- if the intent, either revision or the writer cannot be found or does not match, the revoke refuses with `provenance_unproven`. An old correction is therefore revocable only when its introduction is provable, never by assumption.

`before_json` may be read to cross-check the prior revision. It is never written back.

### 2. `revoke` of `assign` and of `reject` have different semantics

- **Revoke an assign:** remove `ownerIdentity`, `identitySource='owner'`, the verified `tmdbId`/`filmId`/`canonicalIdentity` and the dependent assigned rows; set `status='needs_verification'`. Record `revokedOwnerAssign {tmdbId, requestId, identityBasis}`. Discovery must not re-confirm that id for this observation except through the release conditions of section 1a; `identityBasis` is stored for provenance only.
- **Revoke a reject:** remove only the entry proven in section 1b and this owner's `ownerIdentity`. It writes no negative marker and no `revokedOwnerAssign`. Any independently justified exclusion stays. The id becomes eligible for the next ordinary chunk.
- `revokedOwnerAssign` is a new decision field. It must be added to `ownerMarkerCarry`, to the observation-index view, and to the resolver consumer check next to `ownerRejected`. A later owner `assign` of the same id clears it. `rejectedTmdbIds` is not used to hold it.

### 3. `supersede` is enforced, not descriptive

`supersede` is `identity_assign` or `identity_reject` with `command.supersedes = {requestId, decisionHash}`. `DiscoveryAuthority.ownerDecision` today checks only the assign/reject specifics. This ADR requires a typed validation branch for `revoke` and for `supersedes`: preview and confirm bind the original same-observation action and the exact current target and hash, and the D1 writer enforces that binding in the same fence or refuses. A `revoke` is never passed through the existing assign/reject-only checks.

### 4. Execution boundary

Preview is read-only and bounded: one intent by primary key, the history of that one observation, the current decision and its assigned rows. No scan, no TMDB. Execute re-checks D1 authority and generation, the lease fence, a fresh idempotency key and sections 1 to 3, appends history, writes a receipt, and starts no Discovery chunk (the UI says "waits for the ordinary chunk"). No R2 authority or fallback. The STRICT-table rebuild of `discovery_intent` must be tested offline for row and constraint preservation and for old-code behavior with the new kind.

**Not authorized by this decision:** applying a D1 migration to production or executing a real identity-correction POST. Both require a separate, operation-specific owner approval. Implementing and delivering the approved code and documentation follows the ordinary AIR-132 review and CI/CD gates.

## Alternatives considered

- **A. Extend `kind` with a migration (accepted).** Honest audit trail, explicit state, small rebuild of a table that holds only owner actions. Requires a versioned D1 migration at the next available version and a separate production apply gate.
- **B. No migration: store a revoke under `identity_reject` with `effect: revoke` in `command_json`.** No schema change, but the stored kind lies about the action, the CHECK no longer documents the contract, and readers filtering by kind misclassify it. Not recommended.
- **C. Revoke by writing an `assign`/`reject` replacement only.** No new contract, but it cannot withdraw without asserting something new, which the card rules out.

## Consequences

The targeted fence in section 1a can stay in place after a legitimate metadata correction until the owner re-assigns the id or trusted id-specific proof exists; that costs one owner click, and it is the intended trade for never re-verifying a revoked wrong id silently. If the owner instead lifts the fence on any `identityBasis` change, a title or year correction could silently re-confirm the same erroneous id.

A: one versioned migration and one operation-specific production apply gate; code is tested offline at the actual migration's schema version. Rolling back code does not remove rows with the new kind; the prior code must safely ignore unknown kinds (to be tested). B: faster but weakens the contract permanently.

## Recovery and migration boundary

Revoke is itself append-only; undoing it is a new owner action. Code rollback does not revert D1 rows. The new migration follows the ordinary migration-apply procedure with its own evidence; this ADR authorizes no operation.

## Evidence

- **Original decision:** [Product Owner approved A + A1 on 2026-11-19 in AIR-132](https://trello.com/c/3AXbSoHe#comment-6aff57b6f18bcafb9e0d7c1c)
- **Implementation:** [AIR-132](https://trello.com/c/3AXbSoHe) delivery PR: migration `0026_discovery_intent_identity_revoke.sql` (inert until its own owner GO), pure revoke rules in `src/domain/discovery-identity-review.js`, the typed `revoke` and `supersedes` branches of `DiscoveryAuthority.ownerDecision`, the carried `revokedOwnerAssign` fence in `src/discovery.js`, the routes and the page `/admin/identity/revoke`. Link to the merged PR is added when it merges.
- **Dated verification:** not recorded
- **Implementation checks:** verify whether any real production correction exists, the handling of absent `confirmedTmdbId` or year in `identityBasis`, and `ownerDecision` issuance-expiry semantics. Missing or ambiguous provenance must fail closed. These checks do not authorize an identity write.

## Follow-ups

Implement the approved design in [AIR-132](https://trello.com/c/3AXbSoHe), with separate approval before production migration application or identity writes; [AIR-131](https://trello.com/c/0WtLPRnH) follows.
