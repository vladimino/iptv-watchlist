# ADR 0120: Canonical Film writers: identity overwrite, metadata and membership rules

> Numbering: main already holds ADR 0118 (Discovery report failure notice) and the open receipts PR #530 uses 0119, so this ADR takes 0120.

**Status:** Accepted for the offline code and for rules R3 and R5 (sync clocks) as recorded below; Proposed for the rules marked STILL DRAFT. No production operation, schema migration, live writer, flag, Task or marker move is approved by this ADR.  
**Original decision date:** 2026-11-11  
**Recorded at:** 2026-11-11  
**Approval source:** Owner approval in the comment of 11 Nov 2026 on [PR #529](https://github.com/vladimino/iptv-watchlist/pull/529) (comment 6800009753), card [AIR-374](https://trello.com/c/ha7ais3w); earlier owner decisions 1 to 5 in [ADR 0117](0117-film-person-d1-handoff-owner-decisions.md) and [ADR 0116](0116-projector-marker-and-generation-fence-on-every-batch.md)  
**Related work:** [AIR-374](https://trello.com/c/ha7ais3w) (P2a), [ADR 0099](0099-canonical-film-person-d1-authority.md), [ADR 0117](0117-film-person-d1-handoff-owner-decisions.md), [ADR 0119](0119-durable-canonical-write-receipts.md) (proposed receipts, PR #530)  
**Supersedes:** None  
**Superseded by:** None

## Context

While the marker is `prepared` the projector is the only canonical writer. After `open` the producers must write through fenced mutations, and `GAPS` in `src/canonical-producers.js` lists the projector writes no fenced mutation covered. The film side of those gaps is: the overwrite of `canonical_identity` and `original_title` (the fenced write only fills), `film_metadata`, `film_sync_state`, `watchlist_film` membership, and the `film_dimension` rows (identity, metadata and the effective localization). The projector writes them in `writeFilm`, `releaseFilm` and `projectFilmSyncState` (`src/canonical-repository.js`) without any precedence rule: the last R2-derived value wins.

## Decision

1. **One fenced film-side writer, dormant.** `src/canonical-film-writers.js` adds `writeFilmFacts`, one batch per Film built on `fenced.commit` of `src/canonical-mutations.js`: it proves the marker (`d1`/`open` at the read generation), the expected Film revision and the absence of a redirect in the batch itself, bumps the revision, and is refused by `assertWritable` before any other database access at `r2`, `prepared`, `held`, legacy and unreadable markers. It is not bundled and only the producer adapters module imports it. The projector stays the only canonical writer at `prepared`; the producer entry `planFilmWrite` and the `writeFilmFacts` entries of `CALLS` and `RECONCILE` change no routing (`dispatch` still returns `projector_is_writer` below `open`).
2. **Same rows as the projector.** `planFilmFacts(snapshot,input)` is a pure planner over the stored rows of one Film. For the same inputs on an empty Film it writes the same rows as the projector in `film`, `film_metadata`, `film_sync_state`, `watchlist_film` and `film_dimension` (identity, metadata, localization); the P6 differential harness runs both on one fixture. It writes no external id, alias, credit, person, fingerprint or prediction.
3. **Effective localization in the same batch as the source write.** A write of automatic localization sources upserts `film_localization_source` and, in the same batch, materialises the resolved effective value (`resolveLocalization`: owner, then reviewed dictionary, then automatic) as the `film_dimension` localization row when the effective tier is automatic. The SQL of `src/catalog-d1.js` reads that row and is never left with a source and no effective value. An owner or reviewed value is never replaced.
4. **Idempotency, and what it is not.** Every call carries a stable `requestId` and the caller's `expectedRevision`. Replay by CONTENT (no batch when D1 already holds the planned rows), the revision check (`film_person_revision_conflict`) and `readback` (`content_present` / `not_applied`) are what this change offers. They are **not a substitute for durable per-request receipts**, which stay an existing prerequisite before any producer wiring (ADR 0117 decision 5); [ADR 0119](0119-durable-canonical-write-receipts.md) (PR #530, migration 0019) is the proposed implementation. This change adds no migration, does not authorize applying one and does not authorize a live writer.
5. **GAPS are not removed here.** The entries stay until the P6 differential harness proves equivalence on real fixtures and computes `handoffReadiness`.

## Rules and their status

The owner's wording of 11 Nov 2026 (PR #529 comment) approved: (a) the title order for `original_title` only; (b) a distinct `titleSource` key in the identity provenance instead of overloading `identity.source`, no new column; (c) a missing or null clock in a partial sync update leaves the stored clock, clearing needs an explicit clear or release, recorded as a named P6 differential exception. Mapping to this ADR's rules:

| Rule | Status | Owner wording it maps to |
| --- | --- | --- |
| R3 title order `owner > dictionary > tmdb > letterboxd > watchlist > epg > discovery`, for the selection and overwrite of `original_title` only, not a ranking of any other field | **ACCEPTED** | (a) |
| R3b provenance of the title: `film_dimension.identity.provenance_json.titleSource`, no new column, `identity.source` untouched | **ACCEPTED** | (b) |
| R5 (sync part): a missing, null or blank clock in a partial update keeps the stored clock; clearing is `sync.clear: [names]` or `sync: null` (release the row) | **ACCEPTED** | (c) |
| R1 blank values never overwrite (title, `canonical_identity`, metadata fields, localization) and the sync-clock part of R1 above | sync clocks ACCEPTED; the rest STILL DRAFT | (c) covers clocks only |
| R2 reviewed or owner rows never yield to an automatic write | STILL DRAFT (protection is kept in code) | not covered |
| R4 `canonical_identity` is `tmdb:<n>` of a trusted tmdb id of the Film, fills when empty, a change needs `evidence.verified === true`, never over a reviewed or owner identity row | STILL DRAFT (kept in code) | not covered |
| R5 (metadata part): `film_metadata` is a field-wise merge keeping stored values for blank fields | STILL DRAFT | not covered |
| R6 a redirected Film is refused (`film_person_redirect`); the projector skips silently | STILL DRAFT | not covered |

### `titleSource` shape

`identity.provenance_json` is a JSON object. The writer adds or updates exactly one key, `"titleSource": {"source": "<one of the ranked sources>", "at": "<ISO instant of the write>"}`, and only in the same batch that fills the title, overwrites it, or restates the same title from a higher-ranked source. Every other key (for example `tmdbId`, `letterboxdId`, `authority`) is preserved on every write (a caller's provenance is merged over the stored one, the update is a SQL `json_set`). A row without `titleSource` reads as unranked: any ranked source may overwrite its title, an unranked source may only fill an empty one. `owner` ranks only with `authority: owner`. A title refused on precedence leaves the provenance unchanged. Without an identity row there is nowhere to record it, and the writer says `titleSource: no_identity_row`.

### Named P6 differential exceptions

`P6_DIFFERENTIAL_EXCEPTIONS` in `src/canonical-film-writers.js` is the machine-readable list the P6 harness must import and report, never as parity: `sync_null_clock_keeps_stored` (accepted: the projector writes a missing clock as null), `identity_provenance_title_source` (accepted: the extra key), and the draft differences `blank_never_overwrites`, `reviewed_owner_rows_protected`, `redirected_film_refused`.

### Open owner questions

1. Rules marked STILL DRAFT above: accept, change or reject R1 (blank, outside sync clocks), R2, R4, R5 (metadata merge) and R6.
2. Receipts: ADR 0119 / PR #530 must be accepted and applied (separate owner GO) before any producer wiring.

## Alternatives considered

Not documented beyond this ADR. A merge of the projector's last-write-wins semantics into the canonical writer was not chosen because decision 1 of ADR 0117 and the existing localization contract (owner > reviewed > automatic) already refuse a lower tier over a higher one.

## Consequences

The film-side producers have fenced writers with one revision bump per Film. A second batch per Film is needed for a Film that must also gain external ids, aliases or credits (`mutateFilm` first, as ids must exist for `canonical_identity`). Localization conflicts that the projector records when a reviewed value holds an incoming one (`localization_conflict`, alias of the held value) are not written by this module; the gap stays in `GAPS`.

## Recovery and migration boundary

Nothing is activated, no flag, marker, schema or production data changes. After `open` a code revert does not undo D1 writes (ADR 0117 decision 2). An ADR never authorizes an operation.

## Evidence

- **Original decision:** [AIR-374 owner comments of 11 Nov 2026](https://trello.com/c/ha7ais3w) (decisions 1 to 5 only)
- **Implementation:** [PR #529](https://github.com/vladimino/iptv-watchlist/pull/529) (`tests/canonical-film-writers.mjs`, `tests/canonical-film-writers-mutation.mjs`)
- **Dated verification:** [offline evidence of 11 Nov 2026](../evidence/d1-migration/air-374-canonical-film-writers-2026-11-11.md)
- **Uncertainty:** equivalence with the projector is shown on fixtures, not on production data; unknown outcomes are simulated on the sqlite stand-in.

## Follow-ups

P2b (person side), P3a to P3d (producer wiring), P6 (differential harness and computed readiness), the receipt table.
