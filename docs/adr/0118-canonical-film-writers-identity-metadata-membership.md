# ADR 0118: Canonical Film writers: identity overwrite, metadata and membership rules

**Status:** Proposed (code is offline and dormant; the rules in "Rules for owner review" are DRAFT-FOR-OWNER-REVIEW and become policy only after the owner accepts them)  
**Original decision date:** 2026-11-11  
**Recorded at:** 2026-11-11  
**Approval source:** Owner decisions 1 to 5 of 11 Nov 2026 on the [AIR-374 card](https://trello.com/c/ha7ais3w), recorded in [ADR 0117](0117-film-person-d1-handoff-owner-decisions.md) and [ADR 0116](0116-projector-marker-and-generation-fence-on-every-batch.md). The rules below are NOT covered by them.  
**Related work:** [AIR-374](https://trello.com/c/ha7ais3w) (P2a), [ADR 0099](0099-canonical-film-person-d1-authority.md), [ADR 0117](0117-film-person-d1-handoff-owner-decisions.md)  
**Supersedes:** None  
**Superseded by:** None

## Context

While the marker is `prepared` the projector is the only canonical writer. After `open` the producers must write through fenced mutations, and `GAPS` in `src/canonical-producers.js` lists the projector writes no fenced mutation covered. The film side of those gaps is: the overwrite of `canonical_identity` and `original_title` (the fenced write only fills), `film_metadata`, `film_sync_state`, `watchlist_film` membership, and the `film_dimension` rows (identity, metadata and the effective localization). The projector writes them in `writeFilm`, `releaseFilm` and `projectFilmSyncState` (`src/canonical-repository.js`) without any precedence rule: the last R2-derived value wins.

## Decision

1. **One fenced film-side writer, dormant.** `src/canonical-film-writers.js` adds `writeFilmFacts`, one batch per Film built on `fenced.commit` of `src/canonical-mutations.js`: it proves the marker (`d1`/`open` at the read generation), the expected Film revision and the absence of a redirect in the batch itself, bumps the revision, and is refused by `assertWritable` before any other database access at `r2`, `prepared`, `held`, legacy and unreadable markers. It is not bundled and only the producer adapters module imports it. The projector stays the only canonical writer at `prepared`; the producer entry `planFilmWrite` and the `writeFilmFacts` entries of `CALLS` and `RECONCILE` change no routing (`dispatch` still returns `projector_is_writer` below `open`).
2. **Same rows as the projector.** `planFilmFacts(snapshot,input)` is a pure planner over the stored rows of one Film. For the same inputs on an empty Film it writes the same rows as the projector in `film`, `film_metadata`, `film_sync_state`, `watchlist_film` and `film_dimension` (identity, metadata, localization); the P6 differential harness runs both on one fixture. It writes no external id, alias, credit, person, fingerprint or prediction.
3. **Effective localization in the same batch as the source write.** A write of automatic localization sources upserts `film_localization_source` and, in the same batch, materialises the resolved effective value (`resolveLocalization`: owner, then reviewed dictionary, then automatic) as the `film_dimension` localization row when the effective tier is automatic. The SQL of `src/catalog-d1.js` reads that row and is never left with a source and no effective value. An owner or reviewed value is never replaced.
4. **Idempotency without a new table.** Every call carries a stable `requestId` and the caller's `expectedRevision`. There is no per-request receipt for these writes: a call whose rows are all stored already (updated_at aside) opens no batch (a replay, or a settled unknown outcome), a stale revision with different content is `film_person_revision_conflict`, and an unknown outcome (`film_person_unavailable`) is settled by `readback`: `content_present` or `not_applied`. A DURABLE receipt per request (owner decision 5: receipts in the existing D1) needs a table beyond the existing ones, for example `canonical_write_receipt (request_id, producer, entity, content_sha256, applied_revision, at)`. It is **not** added here (no migration in this change) and is listed as a follow-up.
5. **GAPS are not removed here.** The entries stay until the P6 differential harness proves equivalence on real fixtures and computes `handoffReadiness`.

## Rules for owner review

These rules are policy that no accepted decision states. Each is a draft the owner accepts, changes or rejects.

- R1. A blank value (null, empty or whitespace, empty genres or payload) never overwrites a stored value, for the title, `canonical_identity`, metadata fields, localization and sync clocks. Removing a row is an explicit `metadata: null`, `sync: null` or `watchlist: false`.
- R2. A reviewed or owner row never yields to an automatic write: a reviewed or owner identity row keeps `original_title` and `canonical_identity`; a reviewed or owner localization row keeps its value; a reviewed or owner lifecycle row keeps its state. A reviewed row yields only to a reviewed dictionary or owner write, an owner row only to an owner write (the projector's localization guard).
- R3. `original_title` precedence, trusted sources highest first: `owner`, `dictionary`, `tmdb`, `letterboxd`, `watchlist`, `epg`, `discovery`. The recorded source of the stored title is the `source` of the stored identity dimension row. A value fills an empty field from any source; it overwrites a stored value only from a trusted source of equal or higher rank; an unlisted source never overwrites. A call whose title lost on precedence does not lower the recorded source of the identity row.
- R4. `canonical_identity` is only `tmdb:<n>` for a trusted, non-conflicting `tmdb` external id of the same Film; it fills when empty; changing a stored value needs `evidence.verified === true` (the rule of merging Films with different trusted ids, ADR 0009) and is never allowed over a reviewed or owner identity row.
- R5. `film_metadata` is a field-wise merge: a field the call leaves blank keeps its stored value. `film_sync_state` is a field-wise merge as well; a null clock in the call does not clear a stored clock. The projector writes a missing clock as null (`projectFilmSyncState`); the canonical writer does not, so the equivalence holds for complete inputs only.
- R6. A Film that is a redirect is refused (`film_person_redirect`); the projector's `releaseFilm` skips it silently.

### Open owner questions

1. Accept R3 as the title precedence, or name another order (in particular where `epg` and `watchlist` sit)?
2. R5: should a canonical sync clock go back to null when the source says it is missing (projector semantics), through an explicit release only, or never?
3. Is `identity.source` the right place for the recorded provenance of the title, or should a later schema add a column?
4. Add the receipt table of decision 4 (a migration, owner GO) before the first producer wiring PR, or accept content idempotency for these writes?

## Alternatives considered

Not documented beyond this ADR. A merge of the projector's last-write-wins semantics into the canonical writer was not chosen because decision 1 of ADR 0117 and the existing localization contract (owner > reviewed > automatic) already refuse a lower tier over a higher one.

## Consequences

The film-side producers have fenced writers with one revision bump per Film. A second batch per Film is needed for a Film that must also gain external ids, aliases or credits (`mutateFilm` first, as ids must exist for `canonical_identity`). Localization conflicts that the projector records when a reviewed value holds an incoming one (`localization_conflict`, alias of the held value) are not written by this module; the gap stays in `GAPS`.

## Recovery and migration boundary

Nothing is activated, no flag, marker, schema or production data changes. After `open` a code revert does not undo D1 writes (ADR 0117 decision 2). An ADR never authorizes an operation.

## Evidence

- **Original decision:** [AIR-374 owner comments of 11 Nov 2026](https://trello.com/c/ha7ais3w) (decisions 1 to 5 only)
- **Implementation:** the AIR-374 P2a pull request (`tests/canonical-film-writers.mjs`, `tests/canonical-film-writers-mutation.mjs`)
- **Dated verification:** [offline evidence of 11 Nov 2026](../evidence/d1-migration/air-374-canonical-film-writers-2026-11-11.md)
- **Uncertainty:** equivalence with the projector is shown on fixtures, not on production data; unknown outcomes are simulated on the sqlite stand-in.

## Follow-ups

P2b (person side), P3a to P3d (producer wiring), P6 (differential harness and computed readiness), the receipt table.
