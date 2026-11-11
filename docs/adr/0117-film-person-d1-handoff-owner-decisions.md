# ADR 0117: Canonical Film/Person D1 handoff: decisions of 11 Nov 2026

**Status:** Accepted (as recorded OWNER DECISIONS; design only, no production operation authorized)  
**Original decision date:** 2026-11-11  
**Recorded at:** 2026-11-11  
**Approval source:** Owner approval comment of 11 Nov 2026, 12:03 Madrid, on the [AIR-374 card](https://trello.com/c/ha7ais3w)  
**Related work:** [AIR-374](https://trello.com/c/ha7ais3w), [ADR 0099](0099-canonical-film-person-d1-authority.md), [ADR 0103](0103-projector-exclusive-window.md), [ADR 0110](0110-film-person-operator-copy-and-accepted-discrepancies.md), [runbook](../runbooks/film-person-open-handoff.md), the ADR titled "Projector marker and generation fence" (decision 1, written in a parallel PR)  
**Supersedes:** None. It refines [ADR 0099](0099-canonical-film-person-d1-authority.md) section 6 (recovery paragraph) only within the approved change below; ADR 0099 carries a dated note.  
**Superseded by:** None

> Numbering note: this number was picked as the next free one at the branch point while the parallel decision-1 ADR was in flight. If the register clashes at review, the Controller renumbers; this number is referenced only in this file, the ADR index row, the dated note in ADR 0099 and the links in the runbook, evidence record and the two architecture/reference pages.

## Context

The production marker is `prepared`, `open`, generation 1, baseline `verified` ([AIR-373 evidence](../evidence/d1-migration/air-373-baseline-prepared-2026-11-11.md)). The projector is the only canonical writer; the fenced producers (`src/canonical-producers.js` and the fenced writers) are dormant. The owner answered the open questions of AIR-374 on 11 Nov 2026. This ADR records decisions 2 to 5; decision 1 (the projector checks marker and generation in every real batch, unconditionally, independent of `D1_ENRICHMENT_BULK` and any other flag; the missing historic `canonical_revision` bump does not block readiness, initial revision 0) is recorded in the parallel ADR titled "Projector marker and generation fence". Facts below are read from the repository at `origin/main` 07d3893.

## Decision

1. **Empty classes loaded while `prepared` (owner decision 2).** The three classes that are empty in D1 (rated admission 708, retention 401, retirement decisions 4; 1,113 in all) are loaded while the marker is still `prepared` through a separately verified, bounded, idempotent loader with a dry run, receipts and readback. The tables `film_rated_admission`, `film_retention` and `tmdb_retirement_decision` (migrations 0015 and 0016) carry no marker trigger and the projector does not write them (from the AIR-374 plan; not re-verified table by table here). The trigger `film_person_baseline_reopen_needs_r2` in migration 0013 blocks reopening a verified baseline at `prepared`/`d1`, so this is a separate loader, not a baseline reload. A live run of that loader needs its own owner GO.
2. **Recovery after `open` (owner decision 3; refines ADR 0099 section 6).** The primary recovery is `open` to `held` (readers fail closed with 503, writers refuse; never R2), then a **forward fix**: a plan `held` to `open` that has been proven on a SAFE COPY. A full reverse reconciler (rebuild R2 documents from D1, then `r2`) is **deferred**, not cancelled. Once any D1-only canonical write exists, setting `mode=r2` or a git revert is NOT a rollback. Held, rollback and any repair each need a separate owner GO. This refines ADR 0099 section 6 only in that the reverse reconciliation is no longer the recovery path of record; the prohibition of `r2` after D1-only writes is unchanged.
3. **Frozen mirrors (owner decision 4; refines ADR 0099 section 6 mirror policy).** At `open` the canonical R2 `titles.json`, `people.json` and the other former mutable canonical mirrors are frozen; every consumer moves to D1. Not frozen without an exact classification: the independent programme and watchlist EPG mirrors ([ADR 0108](0108-epg-mirror-reconciliation-writer.md)), immutable sources and receipts, permitted input artifacts, and the view-index prediction retention flag. The classification of each object is a precondition of the activation GO and is not decided here.
4. **Cross-domain operations (owner decision 5).** Operations from EPG, Discovery, metadata and ratings into canonical Film/Person get durable receipts stored in the existing D1 (no new event platform), stable idempotency and request ids, bounded safe retries, and a separate reconciliation of pending or failed operations. A periodic reconcile is only a safety net; the absence of a record without a receipt is never evidence of safety. No new cron or Scheduled Task without a separate GO.

## The generation-fenced single-writer handoff (design)

Verified references (code at 07d3893):

- `transitionAuthority` (`src/film-person-authority.js`) reads the marker, then issues one batch: a guarded `UPDATE film_person_authority SET mode,cutover,generation=generation+1 WHERE id=1 AND mode=? AND cutover=? AND generation=?` and a CAS upsert into `film_person_cas` whose CHECK fails unless one row changed. It does **not** assert the lease, the window or the baseline.
- `FILM_PERSON_TRANSITIONS` allows `prepared` to `open` (marker `d1`/`open`).
- Migration 0013 trigger `film_person_authority_transition` allows only the listed moves, each by one generation; there is no move from `d1` back to `r2` or `prepared`. Trigger `film_person_authority_needs_baseline` checks the verified baseline only when leaving `r2`, so a `prepared` to `d1` move is **not** checked by it: the handoff batch must assert the baseline itself.
- `writerRoute` and `projectorFence` (`src/canonical-producers.js`): projector for `r2`/`prepared`, adapters for `open`, `held` and unreadable throw. `projectorFence` asserts `mode IN ('r2','prepared') AND cutover='open' AND generation=?`; the fenced writers assert `mode='d1' AND cutover='open' AND generation=?` (`FENCE` in `src/canonical-mutations.js`).

The batch below is therefore new reviewed code, to be delivered offline first (follow-up).

Sequence, every step behind an owner GO (see the runbook):

1. **Pre-flight (read-only).** Marker `prepared`/`open`/G; fence row ok; baseline `verified` with the recorded reference; schema version at least 16; `handoffReadiness` ready (computed readiness, P6; today it is never ready while `GAPS` is non-empty); no live projector lease; empty-class loader receipts and the frozen-mirror classification present; producers still dormant.
2. **Lease and exclusive window ([ADR 0103](0103-projector-exclusive-window.md)).** Acquire the projector lease and the held `projector_window`, so Discovery and every lease-fenced writer yield.
3. **Final projector pass with an empty plan** (with the decision-1 fence): D1 equals the R2-derived plan at G.
4. **ONE batch:** assert the lease is held and unexpired (and the window held by the same owner); assert the marker is `prepared`/`open`/G; assert the baseline is `verified` with the expected reference; guarded `UPDATE` to mode `d1`, cutover `open`, generation G+1; the CAS fence statement. A failed assertion rolls the whole batch back.
5. **Readback:** marker `d1`/`open`/G+1, route `canonical`, projector compare-only.
6. **One catch-up canonical reconcile** of what producers could not write while `prepared` (receipts, decision 4), then release the window and the lease.

**Why never two writers and never none.** A projector batch in flight carries the marker CHECK for G, so after step 4 it fails whole; adapters cannot pass their fence before the move; between steps 2 and 6 no other lease-fenced writer runs; the move is one atomic batch, so one fence can pass at any generation. The only no-writer interval is the batch itself and is closed by the catch-up reconcile and the receipts. Decision 1 (unconditional projector fence) is a **precondition**: today the projector asserts the marker only with `D1_ENRICHMENT_BULK=on` (`bulk.expectedMarker`, from the AIR-374 plan; not re-verified here).

## `open` to `held`

`held` is mode `d1`, cutover `held`: readers answer 503 (`film_person_held`), writers refuse (`assertWritable`), `readSource` never names R2. The forward fix `held` to `open` is an allowed trigger move; it must first be rehearsed on a SAFE COPY (a local sqlite copy with the migrations, never production) and meet the runbook acceptance criteria before a production `held` is ever requested.

## Alternatives considered

Reverse reconciler as the primary recovery: deferred by the owner. Setting `r2` after D1-only writes, or a git revert: rejected, it drops or orphans D1-only data.

## Consequences

Recovery is fail-closed and forward only; readers and writers are unavailable while `held`. Frozen mirrors go stale for old consumers, so every consumer must be on D1 before `open`. Receipts add D1 tables in a later PR.

## Recovery and migration boundary

This ADR and its runbook authorize nothing: no marker move, lease, window, held, loader run, flag, Task or cron. Each production step is a separate owner GO. A code revert reverts neither D1 nor the marker.

## Evidence

[Offline design evidence, 2026-11-11](../evidence/d1-migration/air-374-handoff-design-2026-11-11.md). Not verified: production state after the 11 Nov 10:57 UTC baseline record; the decision-1 ADR text; the exact set of mirror objects.

## Follow-ups

Offline tool `scripts/film-person-open-handoff.mjs` that emits (never executes) the preflight reads, the single batch and the readback, with sqlite tests and mutation checks; the held drill harness; the receipts schema; the mirror classification record.
