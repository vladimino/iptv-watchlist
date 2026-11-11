# ADR 0116: Every projector write batch asserts the Film/Person authority marker and generation

**Status:** Accepted 2026-11-11 (owner decision 1 of the AIR-374 decision set; offline code only, no activation)  
**Original decision date:** 2026-11-11  
**Recorded at:** 2026-11-11  
**Approval source:** owner decision 1 recorded on [AIR-374](https://trello.com/c/ha7ais3w) (cited by title from PR #522)  
**Related work:** [AIR-374](https://trello.com/c/ha7ais3w), [ADR 0099](0099-canonical-film-person-d1-authority.md), [ADR 0103](0103-projector-exclusive-window.md), [ADR 0106](0106-bulk-projector-write-path.md), [ADR 0056](0056-d1-enrichment-write-through.md)  
**Supersedes:** None. It strengthens the fences of ADR 0056, ADR 0103 and ADR 0106 and removes the "projector revision bumps" gap from `src/canonical-producers.js`.  
**Superseded by:** None

## Context

ADR 0099 makes the `film_person_authority` marker the single router between the R2-sourced projector (`r2`, `prepared`) and the canonical D1 writer (`open`). Before this change the projector asserted the marker only in the grouped path (ADR 0106) and only when a bulk expectation was passed; the per-entity path and the legacy path could write a batch after the marker had moved to `d1`, `held` or another generation.

## Decision

1. Every `D1_ENRICHMENT_WRITE=on` run reads the marker before its diff, whatever the flags. Marker `d1`, `held`, unknown, malformed or unreadable defers the run as `authority_unavailable`.
2. Every write batch, per entity and grouped, contains one guard statement asserting `mode=? AND cutover='open' AND generation=?` against the marker read at the start. A move fails the whole batch (nothing committed) and the run reports `authority_moved`; a lost lease is told apart by re-reading.
3. A database without the marker table (legacy) keeps its legacy guard, which holds only while `film_person_authority` is absent from `sqlite_master`.
4. The guard SQL lives only in `src/film-person-authority.js` (`PROJECTOR_MARKER_GUARD`, `projectorGuard`, `projectorHolds`). The projector and the dormant `projectorFence` of `src/canonical-producers.js` consume it; there is no second copy.

The guard is a statement inside the existing atomic batch: no extra round trip. The marker read adds one query per `on` run. No production constant (budget, window, group size) changes.

**Not decided:** activation of canonical D1 authority, any marker move, flag, schema change or production write. Code delivered offline only.

## Alternatives considered

Guarding only the grouped path (the previous state): rejected, the per-entity path is the fallback of the grouped one and the default when `D1_ENRICHMENT_BULK` is off.

## Consequences

A marker move can no longer be overtaken by an in-flight projector batch. The cost is one statement per batch and one read per run. The fence test and a 17-mutant mutation test (`tests/projector-marker-fence*.mjs`) keep the guard from being dropped silently.

## Recovery and migration boundary

Reversible by code rollback; no data, marker or flag is touched. A rollback does not change any marker.
