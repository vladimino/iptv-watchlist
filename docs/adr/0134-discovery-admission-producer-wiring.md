# ADR 0134: The Discovery admission producer is wired inside `upsertAdmissions` (P3c, `film_mutation`, bounded, never throws, sweep)

**Status:** Accepted 2026-11-13 as DESIGN. The owner explicitly accepted the FINAL corrected design in PR #590 review on 13 Nov 2026, including inline Discovery admission, the propagated canonical time budget, bounded recurring catch-up sweep and cached projector-route skip. This is design approval only; below the Film/Person marker `open` the writer remains dormant, and acceptance does not authorize production natural writes, the H2 marker flip, a flag or any other production mutation.  
**Original decision date:** 2026-11-13  
**Recorded at:** 2026-11-13  
**Approval source:** Owner initially chose placement variant A on 13 Nov 2026; after independent Controller review of PR #590 and correction of the missing real-path time budget and recurring catch-up trigger (HEAD `9fbbc701`), the owner explicitly accepted ADR 0134 and authorized the Controller to update the document and merge PR #590 on 13 Nov 2026.  
**Related work:** [AIR-374](https://trello.com/c/ha7ais3w), [ADR 0126](0126-epg-producer-layer-person-credits.md) (decision 2: the kind `film_mutation` belongs to the Discovery admission), [ADR 0119](0119-durable-canonical-write-receipts.md), [ADR 0123](0123-producer-receipt-adapter-film-facts.md), [ADR 0133](0133-film-external-ids-producer-unit.md)  
**Supersedes:** None  
**Superseded by:** None

## Context

`PRODUCER_WIRING` names four producers that must write canonical Film state once the marker is `open`. The Discovery admission (`discovery_admission`) needs only the kind `film_mutation`: a verified movie (`tmdb_<n>`) becomes the Film that carries the trusted `tmdb` external id. Its natural call site is `upsertAdmissions` (`src/discovery-authority.js`), which the paged chunk (`src/discovery.js`) and the catalog step (`src/worker.js`) call under tight, tuned budgets (`persistLimit`, `writeEstimate`, deadlines, the D1 statement totals of ADR 0094). A canonical write that is skipped for lack of budget leaves an admission with no receipt, which the receipts reconcile cannot find.

## Decision

1. **One call site, inside `upsertAdmissions`.** After the batches are committed the function calls `CanonicalDiscoveryAdmission.admitDiscoveryFilms` for the keys it wrote (a call that wrote nothing still reaches it, so the bounded reconcile and sweep run), behind a `typeof` guard (offline imports of the file have no such scope). The call never throws and never changes the function's result. Its time budget is the caller's `canonicalDeadline`, else `deadline`, else none: both production call sites in the paged Discovery chunk (`src/discovery.js`) pass `canonicalLimit()`, the persist limit minus the cost of three writes, so a unit never starts when it could not finish before the checkpoint reserve; `canonicalDeadline` is separate from `deadline`, which stops the admission batches themselves. The catalog step (`src/worker.js`) passes its step deadline.
2. **Dormant below `open`.** The first statement is the marker route read. A `projector` route is remembered per database binding for 60 s (`ROUTE_SKIP_MS`), so the long `prepared` wait costs no marker read per batch; a `held` or unreadable marker is reported, never thrown. Only the skip is cached: every canonical write re-reads and fences the marker inside its own batch, and a stale skip can only delay admission, which the sweep repairs.
3. **Bounded at `open`.** At most 10 written films per call (`ADMIT_PER_CALL`), none after the caller's `deadline`; the rest is deferred.
4. **Completeness by a sweep, not by hope.** A call that has the marker `open` also settles the origin's own due receipts (the existing inline reconcile, limit 10) and sweeps at most 5 current movie admissions that have no trusted canonical Film (`ORDER BY random()`, so an admission that is permanently refused cannot starve the others). A deferred, late or failed admission is therefore found on a later call. **The recurring trigger** is the end of every completed paged Discovery chunk (`src/discovery.js`, after the TMDB loop and before the status and checkpoint writes), which runs the same call once with nothing written, inside the same budget and never throwing, whether or not the chunk admitted anything: the sweep does not depend on a later admission arriving. No cron, Task or background system is added. A chunk that returns early (programme changed, lease lost, no time left) skips it and the next hop runs it.
5. **The unit.** `film_mutation` (one atomic fenced `mutateFilm` batch with the applied receipt): the Film is the one that already holds the trusted `tmdb` id, else `film:tmdb:<n>`; the trusted `tmdb` id is added when missing; the title is written only when the stored one is blank; the stored contract version, identity and title are never overwritten. A `tmdb` id held untrusted or conflicting by another Film, a different trusted `tmdb` value on the Film, or a redirect source is a typed refusal before any receipt (`identity_collision`, `film_person_redirect`): the admission is held for the owner, never merged or remapped. A no-op writes nothing and has no receipt.
6. **The registry.** `PRODUCER_OPERATIONS` registers the atomic `film_mutation` spec. Its static re-plan is `null` (a receipt that reaches the generic registry is never replayed blind); the real settlement binds the same spec to the environment and re-plans from the current `discovery_admission` row, a moved source is a typed terminal abandon. `handoffReadiness` therefore no longer reports `receipts_protocol_unregistered` or `producer_not_wired:discovery_admission`; `epg_commit`, `metadata_sync` and `rated_admission_retention` stay unwired because their other kinds are not registered.
7. **Bundle shape.** The producer, route, receipts, mutations, film-writers, localization-sources and adapter modules enter the Worker bundle as named scopes (`scopedImports`), in dependency order. The readiness registry (`src/canonical-producers.js`) is not bundled; `writerRoute` moved to `src/canonical-writer-route.js` so no import cycle exists.

## Alternatives considered

- **A separate bounded step after the chunk (variant B):** less risk to the chunk budget, but a new workflow step and a new failure surface; not chosen by the owner.
- **Write inside the chunk without a sweep:** rejected: a skipped write has no receipt and would surface only as `unreceipted_changes` at the activation baseline.
- **Cache the marker route as a hard gate:** rejected: the cache only skips; the write path always re-reads and fences.

## Consequences

- At `prepared` (today) the production cost is zero statements on a cached skip and one marker read (about five statements) at most once a minute per isolate; no write, no receipt, no flag.
- At `open` a changed admission costs the planner reads, the pending-receipt batch and one atomic batch per film, plus the bounded reconcile and sweep reads per call. This is a new load on the chunk path whose real size is the E6 measurement, **not done and not authorized here**; the caps (10, 5, 10) and the deadline are provisional.
- Zero extra work is added when the chunk has no time left; the catch-up costs one cached marker read below `open`.
- A cached `projector` skip can delay canonical admission by up to 60 s after the marker moves to `open`.

## Recovery and migration boundary

Code only; deploying it does not move the marker, write a Film, create a receipt, change a flag, a Task or a schedule. Reverting the change removes the call, the registration and the scopes; no stored data depends on them. Receipts created at `open` stay as ADR 0119 describes.

## Evidence

- **Implementation:** the P3c pull request of AIR-374; offline evidence [air-374-p3c-discovery-admission-offline-2026-11-13.md](../evidence/d1-migration/air-374-p3c-discovery-admission-offline-2026-11-13.md) (counts only).
- **Uncertainty:** no production measurement of admission volume per chunk, of the Film rows that already exist for admitted ids, or of the added statements per chunk exists.

## Follow-ups

P3a/P3b/P3d wiring (EPG, metadata and localization, rated admission and retention), the E6 budget measurement for the combined producers, and the readers. The H2 marker flip and any production operation need their own explicit owner GO.
