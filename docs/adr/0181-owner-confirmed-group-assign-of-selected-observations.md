# ADR 0181: Owner-confirmed group assign of up to ten explicitly selected EPG observations to one movie

**Status:** Proposed  
**Original decision date:** unknown (awaiting owner decision)  
**Recorded at:** 2026-11-20  
**Approval source:** not documented (owner gate required before implementation, [AIR-131](https://trello.com/c/0WtLPRnH))  
**Related work:** [AIR-131](https://trello.com/c/0WtLPRnH), [AIR-65](https://trello.com/c/MKb4JMXi), [AIR-132](https://trello.com/c/3AXbSoHe), [ADR 0080](0080-discovery-identity-correction.md), [ADR 0170](0170-unified-identity-work-inventory.md), [ADR 0178](0178-identity-correction-revoke-event-contract.md)  
**Supersedes:** None  
**Superseded by:** None

## Context

Audit of `main` at 648800c2 (read-only; no production access):

- The only owner identity write is `discovery_identity_correct@1`: one observation key, one `discovery_intent` row, one fenced `DiscoveryAuthority.ownerDecision` batch (decision-hash CAS, lease, history row, receipt). `GET /api/admin/identity-work` and `/admin/identity` are read-only and prove no correlation between observations (ADR 0170).
- `discovery_observation` has the primary key `(source_key, observation_key)` and one other index `(residence, observation_key)`. `observation_key` is `normalizedTitle|year`. Plans checked with `EXPLAIN QUERY PLAN` on the schema through migration 0027: a key **prefix range** (`observation_key >= ? AND observation_key < ?` with `source_key = ?`) is an index `SEARCH` and can carry a `LIMIT`; `normalized_title = ?` and `confirmed_tmdb_id = ?` lead only with `source_key = ?`, so they scan every active row and are not bounded without a new index (a migration).
- Decisions are read by primary key (`discovery_decision.observation_key`) and shows by `(source_key, observation_key)`, so evidence for a known key list is a constant number of queries.
- The existing observation index is a bounded projection (cap 3000, scope `current_unresolved_with_decision`) and is partial by construction.
- `AdminActions` already supports a confirmation over many records: `ids`, a per-record `version`, a budget `maxRecords` (contract ceiling 50) and a receipt with one outcome per record. No new framework is needed.
- The single-key gate (`identityCommand` with `catalogueFilmTrust`) refuses television, unreadable catalogue, conflicting identity and a year more than one apart unless the id is the observation's confirmed id. It has no runtime check. A revoked owner assign leaves a targeted fence for `(observation, tmdbId)` ([ADR 0178](0178-identity-correction-revoke-event-contract.md)).
- The only owner correction stored in production is the AIR-498 reject; no group has ever been confirmed.

## Decision (proposed)

A group is a **convenience over single-key owner writes, not a new authority**: each selected key is written by the existing fenced writer and keeps its own intent, history row and receipt.

1. **Anchor.** A group starts from one canonical movie `tmdb:<digits>` that exists in the D1 catalog as a movie (never television), under the published programme run. There is no title-only start and no wildcard over future observations.
2. **Candidate discovery, migration-free.** Up to four anchor strings (normalized primary, original and alternative titles of the catalogue Film, deduplicated) each run one primary-key prefix range with `LIMIT 26`; candidates merge to at most 50. Evidence is then read for the known keys in constant queries (decision by key, observation row by key, shows by key), never per candidate. The response always states `coverage: partial`, the anchors used, whether any anchor hit its limit, and the counts checked and dropped. It never calls the list "all observations" and never finds translations or other spellings; that gap is stated, not hidden.
3. **Per-candidate assessment, fail closed** (pure, tested). Selectable only when the single-key gate passes for `assign`, the current decision is not an owner assignment of another id, the scorer's accepted id is not a different id, no revoked-assign fence names this id, and, new for groups, a known observation duration is within the larger of 10 minutes and 15% of the Film's runtime (unknown runtime is shown, not blocked). Each row shows year and runtime differences, the conflicts, the current decision, its hash, the shows and the exact before and after.
4. **Selection and cap.** Explicit keys only, 1 to 10 per confirmation. The server re-derives the candidate set at confirm and refuses keys it does not show; more than 10 is refused (`group_too_large`), never truncated.
5. **Confirmation.** One new versioned capability `discovery_identity_group_assign@1` (subject kind `observation`, budget `maxRecords: 10`), per-record version `decisionHash:assign:tmdbId`, one issuance whose scope fingerprint covers exactly the selected keys and versions. Confirm stores one `discovery_intent` row per key, kind `identity_assign` (an existing kind, so **no migration**), child key `<groupKey>-NN`, with `command.group {id, size, index, anchorTmdbId}` and the usual expected hash.
6. **Execute.** Sequential in one request under one lease, every key through the existing `ownerDecision` (CAS on its own hash). Per-key outcome: `applied`, `conflict`, `refused`, `skipped` or `unknown`. There is no all-or-nothing promise. A conflict or refusal of one key does not stop the others. An `unknown` outcome or a lost lease stops the run; the remaining keys are reported `not_attempted` and nothing is retried blindly. A replay finishes only keys still `approved`, never rewrites a receipt. Refused keys can be re-evaluated only through a new preview and a new confirmation.
7. **Reads and writes.** The group preview is a GET: no write, no TMDB or model call, bounded. POST only for confirm and execute, with the same Access, same-origin and action-header guards as the identity writes. No Discovery chunk, EPG or TMDB run is started; the published view updates on the ordinary next chunk and the UI says so.
8. **UI.** A separate owner page `/admin/identity/group?tmdbId=` with its own bundle, reached by a link from a Film row of `/admin/identity` and from the Limbo observation detail. The queue and its GET stay read-only (the link is an anchor, not a form).

Not decided here: an index on `confirmed_tmdb_id` or `normalized_title` (a migration, which would widen discovery and needs its own owner GO), group reject or group revoke, any automatic or future-observation promotion, and every production write.

## Alternatives considered

- **Loop the single-key flow in the browser.** Rejected by the card: it hides N confirmations behind one click and gives no exact group scope.
- **All-or-nothing in one transaction.** Rejected: the owner writer is fenced per key with its own CAS and a statement cap of 40, and one stale key would block the rest; the card also forbids promising it.
- **New group table or intent kind.** Needs a migration and adds no authority; per-key intents already hold the receipts, and the group result is derived by reading its children.
- **Add an index first (migration 0028) for confirmed-id candidates.** More complete discovery, but a schema change before the need is shown; left as an explicit follow-up.
- **Candidates from the existing bounded observation index only.** Reuses code, but depends on its scope and cannot find an observation the index omits.

## Consequences

Coverage is partial and says so: an observation whose title does not share a prefix with any anchor is not offered. Each key costs one fenced D1 batch, so a run of ten is ten batches under one lease (the lease TTL is 90 seconds; a live Discovery chunk makes the run refuse with `lease_held`, as the single-key route does). The group result after a reload is reconstructed from the per-key intents. Selecting keys that gain a conflicting decision between preview and execute makes those keys `conflict`, not silent writes.

## Recovery and migration boundary

Every key is an ordinary owner assignment: undoing one is the ADR 0178 revoke or supersede of that key, never a group undo. Code rollback does not revert D1 rows. No migration is proposed. This ADR authorizes no production write; the real group confirmation is the owner's own action in the UI.

## Evidence

- **Original decision:** not recorded
- **Implementation:** none yet
- **Dated verification:** query plans checked offline on the stand-in schema, 20 November 2026; nothing read from production
- **Uncertainty:** how often a real wrong-match observation shares a title prefix with the correct Film (affects how useful partial coverage is); the runtime tolerance (10 minutes or 15%) is a proposal to confirm with the owner

## Follow-ups

Implementation of [AIR-131](https://trello.com/c/0WtLPRnH) after the owner decision; optional index migration for confirmed-id discovery; group revoke is out of scope and would be its own card.
