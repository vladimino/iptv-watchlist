# ADR 0125: EPG producer layer for canonical Film facts (P3a, planning and apply, dormant)

**Status:** Accepted as DESIGN for offline, dormant code only, within the owner decisions E2, E4, E5 and E6 of 12 Nov 2026 (source: [AIR-374](https://trello.com/c/ha7ais3w), [decision pack](../runbooks/film-person-holdpoint-decision-pack.md)). This is not merge approval and not a production GO. Nothing here is wired: `epgSync` is unchanged, the module is not bundled, no marker moves and no production operation is authorized.  
**Original decision date:** 2026-11-12  
**Recorded at:** 2026-11-12  
**Approval source:** Owner decisions of 12 Nov 2026 on the [AIR-374 card](https://trello.com/c/ha7ais3w); the unit shape is the reviewer-level decision the P3 plan assigned to P3a  
**Related work:** [AIR-374](https://trello.com/c/ha7ais3w), [ADR 0123](0123-producer-receipt-adapter-film-facts.md), [ADR 0119](0119-durable-canonical-write-receipts.md), [ADR 0120](0120-canonical-film-writers-identity-metadata-membership.md), [ADR 0117](0117-film-person-d1-handoff-owner-decisions.md), [offline evidence](../evidence/d1-migration/air-374-p3a-epg-producer-layer-offline-2026-11-12.md)  
**Supersedes:** None  
**Superseded by:** None

## Context

P3-0b gave a producer the `film_facts` adapter (one receipted, atomic `writeFilmFacts` call per Film). The EPG commit is the first producer that needs it: after `open` a run must turn what it observed into canonical Film facts, bounded and resumable, while publication never depends on that. The full P3a also needs the dictionary store abstraction in `epgSync`, Person and credit kinds and a measured per-run budget (E6, a production read that is not authorized). This ADR records the smallest unambiguous subset that can be built and tested offline.

## Decision

1. **Scope: the pure planning and apply layer for `film_facts`, inputs injected.** `src/canonical-epg-producer.js` reads no R2, no EPG and no dictionary store, and changes nothing in `worker.js`. The `epgSync` call site, the dictionary store, Person, credit and localization-conflict kinds stay for the next PRs.
2. **Units.** `planEpgUnits` turns a run into one unit per observed Film (its facts) and one release-only unit per departed member (`watchlist:false`), in a deterministic order by id; an observed member is never also released; duplicates and malformed input are refused. The run id is the source event (`epg:<run id>`), so request ids follow ADR 0123 decision 4: the same run and content is the same request, a new run or other content another one (A to B to A is three requests).
3. **A release never creates or rewrites a Film.** A release-only unit is `{id, at, release:true, watchlist:false}` and carries no Film facts. At apply time it is resolved against the STORED `film` row (the existence test is that row, not a planned change): no row is `absent`, skipped with no receipt and never created; an existing Film (any contract version) is written back with its own stored `contract_version` and `updated_at` and no identity or title, so the Film row is unchanged byte for byte and only the membership and the revision change, in the same atomic receipted batch as ever. A departed non-member is a no-op. The digest of a release is its intent (`release`, `watchlist:false`) alone, independent of the stored Film, so a replay is stable; a replay resolves the release against the store again and has no re-plan when the Film is absent.
4. **Bounded, resumable pass.** `applyEpgUnits` visits at most a caller-injected number of units per call, clamped to a hard ceiling of 50, and returns a cursor for the run state to persist. The ceiling is PROVISIONAL: it keeps a pass under the repository's 800-query run budget at about 10 round trips per changed Film; the real per-run size is the E6 measurement. One unit's refusal is counted with its code and never blocks the others; `film_person_held` and `film_person_unavailable` stop the pass on the unit that met them (cursor kept). Per unit, ADR 0123 applies unchanged: no-op before any receipt (E5), one atomic fenced batch with the applied receipt, an uncertain race ends `unknown` and is settled by readback and reconcile, never by a silent second batch.
5. **Dormancy.** Both entry points read the marker once through the adapter's route helper; at `legacy`, `r2` and `prepared` they return `skipped` after that read (the projector stays the only canonical writer, E4: no flag is touched); `held` and an unreadable marker throw.
6. **Reconcile (E2).** `reconcileEpg` is the adapter's bounded inline reconcile for the origin `epg` only, with the re-plan taken from the units of the run. A receipt is re-planned only for the run that wrote it: the producer recomputes the request id from this plan's event, the receipt's target and its content digest and requires it to equal the receipt's request id (a content digest alone does not encode the event, so a receipt of run A would otherwise replay from run B that observed the same facts). Any other receipt has no re-plan and takes the receipts module's conservative path (counted retry and backoff, abandoned by attempts or expiry, or `stale_revision_needs_repair` when the revision moved); a new run never abandons it merely by being another run. No cron, no tick call, no global pass.
7. **Readiness stays truthful.** No operation is registered in `PRODUCER_OPERATIONS` and `PRODUCER_WIRING.epg_commit.requires` is unchanged, because the producer is not wired and still needs the person kinds; `producer_not_wired:epg_commit` remains a blocker. The 7 draft differential exceptions of the registry and the 3 of the writers are not accepted or edited by this change: each stays a draft, individually reviewable, and a blocker.

Not decided: the `epgSync` wiring and its durable attempt marker, the dictionary store, Person kinds, the per-run ceiling (E6), any exception acceptance, any production step.

## Alternatives considered

- **Wire `epgSync` now:** rejected: the E6 budget is not measured and the Person kinds have no adapter, so a wired producer could not be proven bounded.
- **Treat a missing Film on release as a create:** rejected: a departed member would resurrect a Film the canonical store never held.
- **A per-call cap without a ceiling:** rejected: the caller could exceed the query budget.

## Consequences

- A pass at `prepared` costs one marker read. At `open` a changed Film costs about two batches plus the planner reads; an unchanged Film costs the reads only and creates no receipt.
- The cursor and any attempt marker are the caller's responsibility until the call site exists. The `cursor` is only an index into a plan held in memory: before any runtime wiring a durable cursor with a plan fingerprint (so a resumed pass can refuse a different plan) and a retry policy for failed units must be specified, together with the E6 measurement of the ceiling.
- The layer proves nothing about the 10 draft exceptions: the differential scenarios for the EPG natural path (`epg_commit_natural`) are not added here.

## Recovery and migration boundary

Code only; nothing calls it and it writes nothing. No migration, flag, Task, cron, marker move or production read is involved. Reverting the change removes the module and its tests; no data depends on it.

## Evidence

- **Original decision:** [AIR-374](https://trello.com/c/ha7ais3w), owner decisions of 12 Nov 2026.
- **Implementation:** the P3a pull request of the same card.
- **Dated verification:** [offline evidence](../evidence/d1-migration/air-374-p3a-epg-producer-layer-offline-2026-11-12.md), counts only.
- **Uncertainty:** E6 not measured; the `epgSync` wiring, Person kinds and the differential scenario are not built.

## Follow-ups

The `epgSync` wiring with a durable attempt marker, the dictionary store, Person and credit adapters and the `epg_commit_natural` differential scenario, after the E6 measurement is authorized.
