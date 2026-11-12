# ADR 0127: Dictionary-store producer for canonical Film title and identity facts (P3a, planning and apply, dormant)

**Status:** Accepted as DESIGN for offline, dormant code only, within the owner decisions E2, E4, E5 and E6 of 12 Nov 2026 and the title order of [ADR 0117](0117-film-person-d1-handoff-owner-decisions.md) / [ADR 0120](0120-canonical-film-writers-identity-metadata-membership.md) (source: [AIR-374](https://trello.com/c/ha7ais3w)). This is not merge approval and not a production GO. Nothing here is wired: `epgSync` is unchanged, the module is not bundled, no marker moves and no production operation is authorized. The number 0127 is provisional (a parallel change takes the number after the highest on `main`); it is renumbered on merge if a collision appears.  
**Original decision date:** 2026-11-12  
**Recorded at:** 2026-11-12  
**Approval source:** Owner decision of 12 Nov 2026 (step 3 of the offline EPG producer: separate deliveries; this one is the dictionary-store semantics); the unit shape and the named outcomes are the reviewer-level decisions the P3 plan assigned to P3a  
**Related work:** [AIR-374](https://trello.com/c/ha7ais3w), [ADR 0125](0125-epg-producer-layer-film-facts.md), [ADR 0123](0123-producer-receipt-adapter-film-facts.md), [ADR 0120](0120-canonical-film-writers-identity-metadata-membership.md), [ADR 0119](0119-durable-canonical-write-receipts.md), [ADR 0117](0117-film-person-d1-handoff-owner-decisions.md), [offline evidence](../evidence/d1-migration/air-374-p3a-dictionary-store-producer-offline-2026-11-12.md)  
**Supersedes:** None  
**Superseded by:** None

## Context

The curated title and alias dictionary (`data/film-titles.json`, reviewed entries baked into the Worker) is, today, applied to the in-memory watchlist by `epgSync` and the readers, and the provisional `titles.json` cache lives in R2 ([ADR 0117](0117-film-person-d1-handoff-owner-decisions.md) decision 3 freezes it at `open`). After `open` the dictionary must reach the canonical Film (`original_title`, its `titleSource`, the TMDB identity and the effective Russian localization) without a second writer: the owner decision is ONE source of truth for ownership, so the dictionary feeds the canonical rows only through the existing fenced writer (`writeFilmFacts`), reached through the receipt adapter of ADR 0123. ADR 0125 left "the dictionary store" as a later PR; this ADR records its smallest unambiguous subset, buildable offline.

## Decision

1. **Scope: a pure planning and apply layer in its own module, inputs injected.** `src/canonical-dictionary-producer.js` reads no R2, no dictionary file and no EPG, has no SQL, no second write path and no competing writer, and changes nothing in `worker.js`, `epg-producer` or the shared writers. The caller supplies the curated entries (each naming the canonical Film it describes, `filmId`); resolving a dictionary id to a Film is not done here.
2. **What a unit is.** One unit per dictionary entry, keyed by the canonical Film id, sorted by it; an entry that is not `verified`, has no Film, repeats a Film or an entry id, or carries no title and no original is refused, never skipped silently. A unit hands the writer only the facts the dictionary owns: `original_title` (the entry's `original`, source `dictionary`), the effective Russian localization (reviewed, source `dictionary`, a constant source version so a dictionary version bump does not rewrite an unchanged row) and the TMDB identity. It never carries membership, metadata or sync clocks, and it carries the STORED contract version and `updated_at` so the Film row changes only where the dictionary changes it. Aliases are part of the snapshot digest (they are dictionary content) but no canonical table holds them, so no unit writes them.
3. **The snapshot is part of the request id.** `dictionarySnapshot` is the caller's version label plus a digest of EVERY entry (order fixed, aliases and sources included). The pair is the source event `dictionary:<version>:<digest>` of every request id (ADR 0123 decision 4), so a replay is bound to the dictionary version it was planned from, and an A to B to A dictionary edit is three requests, not a flip back to a stale `applied` receipt. The request id also binds the PLANNED content (what is handed to the writer, ADR 0123): a stored-state change that changes it (for example an identity that is now stored) makes another request, so a replay never applies stale content; this is safe and bounded, and is stated because it differs from the EPG layer, whose content is the observation alone.
4. **One source of truth: precedence is the writer's.** Per unit the builder reads the stored rows of the Film and decides, then `applyFilmFacts` runs ADR 0123 unchanged: a no-op pre-plan BEFORE any receipt (E5; a new snapshot of identical content writes nothing), ONE atomic fenced batch of the mutation and the applied receipt, an uncertain race ends `unknown` and is settled by readback and reconcile, never by a second batch. The title order `owner > dictionary > tmdb > letterboxd > watchlist > epg > discovery` (`original_title` only) with `titleSource` in the identity provenance, and the localization tiers owner > reviewed dictionary > automatic, are applied by the writer again under its fence. An owner-owned value is never overwritten.
5. **Named outcomes, never a silent overwrite.** The pure `buildDictionaryInput` returns one of `absent` (no stored `film` row: a dictionary entry NEVER creates a Film), `redirected`, `identity_mismatch` (a trusted TMDB id or the stored identity names another film: nothing of the entry applies), `kept` (nothing to hand the writer) or `proceed`, and a list of named conflicts. Kept (nothing written for the field): `owner_kept`, `reviewed_kept`, `unranked_kept` (a stored title that differs and has no `titleSource`: its provenance is unknown, so it is not overwritten), `no_identity_row` (a title is written only where the identity row exists to carry `titleSource`), `needs_trusted_tmdb_id` (the identity is filled only when empty and the id is a trusted external id of that Film), `identity_mismatch`. Replaced (written over a different, lower-ranked value): `replaced_lower` (the stored source is named), `replaced_reviewed`, `replaced_automatic`. The pass reports them per unit (in memory) and the evidence records counts only.
6. **Bounded and resumable, dormant, own-origin reconcile.** `applyDictionaryUnits` visits at most a caller-injected number of units per call, clamped to a hard ceiling of 50 (PROVISIONAL: E6 is not measured), with a cursor for the caller; one unit's refusal is counted with its code and never blocks the others; `film_person_held` and `film_person_unavailable` stop the pass on the unit that met them. Below `open` both entry points read the marker once and return `skipped` (the projector stays the only canonical writer, E4: no flag). `reconcileDictionary` is the adapter's bounded inline reconcile for the origin `dictionary` ONLY (E2): a receipt is re-planned only for the snapshot that wrote it and against the CURRENT stored rows; a Film that is gone, redirected or mismatched has no re-plan. No cron, no tick, no global reconcile, no second batch (E5).
7. **Readiness stays truthful.** No operation is registered in `PRODUCER_OPERATIONS`, `PRODUCER_WIRING` is unchanged and `producer_not_wired:epg_commit` remains a blocker. The title-source and clock exceptions of the differential registry (`identity_provenance_title_source`, `sync_null_clock_keeps_stored` of the writers, and the registry drafts) are related to this layer because it writes `titleSource`, but none is accepted, edited or discharged by this change.

Not decided: the call site (where in `epgSync` or the metadata sync a snapshot is planned), the resolution of a dictionary id to a canonical Film, the durable per-unit failure result and the durable cursor with a plan fingerprint, the per-run ceiling (E6), any exception acceptance, any production step.

## Alternatives considered

- **Write the title and localization with a dictionary-specific SQL path:** rejected: a second writer would compete with `writeFilmFacts` for the same rows and rules.
- **Overwrite a stored title that has no `titleSource`:** rejected here: its provenance is unknown and could be owner-written. The writer's own planner would overwrite it (unranked ranks below every source); this layer keeps it and names `unranked_kept`. Open owner question below.
- **A content-only or version-only request id:** rejected: a content-only id flips back to a stale receipt on A to B to A; the snapshot event prevents it.
- **Create the Film when the dictionary names it:** rejected: the dictionary describes Films, it does not admit them.

## Consequences

- A pass at `prepared` costs one marker read. At `open` a changed Film costs one read by the builder, the adapter's pre-plan read, two batches and the writer's own read; an unchanged Film costs the reads only and creates no receipt, also under a new dictionary version.
- A dictionary edit of one entry is a new snapshot event for every unit, so any Film whose handed facts differ from the stored rows gets a new request; a Film already holding the facts is a no-op with no receipt.
- Compatible with the later durable results: the plan carries `event`, the snapshot digest and a deterministic unit order, so the durable cursor can store `{event, digest, index}` and refuse to resume a different snapshot, and a per-unit failure result can be keyed by `(event, filmId)`; both are the caller's persistence, not built here (as in ADR 0125).

## Recovery and migration boundary

Code only; nothing calls it and it writes nothing. No migration, flag, Task, cron, marker move, R2 write or production read is involved. Reverting the change removes the module and its tests; no data depends on it.

## Evidence

- **Original decision:** [AIR-374](https://trello.com/c/ha7ais3w), owner decisions of 12 Nov 2026.
- **Implementation:** the P3a dictionary-store pull request of the same card.
- **Dated verification:** [offline evidence](../evidence/d1-migration/air-374-p3a-dictionary-store-producer-offline-2026-11-12.md), counts only.
- **Uncertainty:** E6 not measured; the call site, the dictionary-id to Film resolution and the durable results are not built.

## Follow-ups

The call site with a durable attempt marker and cursor, the resolution of dictionary ids to canonical Films, the Person-name dictionary kinds, and the `epg_commit_natural` differential scenario, after the E6 measurement is authorized.
