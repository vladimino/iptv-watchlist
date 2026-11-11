# AIR-374 handoff and recovery design, offline evidence (11 Nov 2026)

**Scope:** code reading of `origin/main` at `07d3893` and migration `0013`; no production read, no execution. Authorizes nothing.

| Reference | Finding |
| --- | --- |
| `transitionAuthority`, `FILM_PERSON_TRANSITIONS` (`src/film-person-authority.js`) | Guarded one-generation marker `UPDATE` plus a CAS upsert; `prepared` to `open` allowed; no lease, window or baseline assertion in it |
| migration 0013 triggers | `film_person_authority_transition` allows only listed moves (no `d1` to `r2`); `film_person_authority_needs_baseline` checks the baseline only when leaving `r2`; `film_person_baseline_reopen_needs_r2` blocks reopening a verified baseline at `prepared`/`d1` |
| `writerRoute`, `projectorFence` (`src/canonical-producers.js`) | One writer per state; projector fence asserts mode `r2`/`prepared`, cutover `open`, generation |
| `assertWritable`, `readSource` | `held` refuses writers, readers never get R2 |
| `GAPS` / `handoffReadiness` | Never ready while `GAPS` is non-empty (P6 makes it computed) |
| `projector_window` / projection lease (`src/d1-enrichment.js`) | Window fence exists in the projector write path (ADR 0103) |

Not verified: production state; table-by-table absence of marker triggers on migrations 0015/0016 (taken from the AIR-374 plan); `bulk.expectedMarker` guard conditions beyond the plan; text of the decision-1 ADR.

Decisions: [ADR 0117](../../adr/0117-film-person-d1-handoff-owner-decisions.md). Runbook: [open handoff](../../runbooks/film-person-open-handoff.md).
