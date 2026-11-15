# ADR 0146: User catalog reads fence authority and programme, not the global Discovery generation

**Status:** Accepted  
**Original decision date:** 2026-11-15  
**Recorded at:** 2026-11-15  
**Approval source:** [AIR-493](https://trello.com/c/AKoSOprC) (owner instruction to implement the approved incident card)  
**Related work:** [AIR-493](https://trello.com/c/AKoSOprC)  
**Supersedes:** None  
**Superseded by:** None

## Context

`DiscoveryAuthority.routeRead` compared `discovery_authority.generation` before and after every owned key. Every Discovery writer (chunk admission, decision, continuation, status, Workflow record) increments that generation. User `GET /api/catalog/available` and `GET /api/enrichment/view` load the catalog through `routeRead`. While the Cloudflare Discovery Workflow is live, those GETs raced the generation bump, threw `discovery_fence`, and the Worker catch turned the throw into HTTP 502. The UI then showed «нет данных» as if the collection and predictions were empty. Production evidence (Worker `route_error` with `code=discovery_fence` on both paths, 15 November 2026 Europe/Madrid) is in the [dated RCA](../evidence/discovery/air-493-user-read-fence-2026-11-15.md).

The generation compare is the right torn-page guard for multi-statement walks (the whole decisions document, the whole ledger, `streamActiveLedger`). It is the wrong guard for a single `SELECT` of current admissions or a single payload row: SQLite already returns one statement snapshot, and a continuation write does not mix catalog rows.

## Decision

1. **Generation-fenced keys** stay generation-fenced: `epg/discovery-resolution.json`, `epg/discovery-latest.json` (including a generation copy of the ledger) and `epg/discovery-score-preview.json`. A mid-read generation, programme or transfer change is `discovery_fence`. Mixed pages are never returned.
2. **Snapshot keys** (catalog `discovered-films.json` and its generation copy, status, continuation, lease, Workflow) close the read on D1 still ready, the same `programmeRunId`, and transfer not becoming `loading` (except a ledger-seal read, which already ignores generation). A continuation or status write that only bumps generation does not fail the catalog.
3. **Fail closed** for held cutover, a loading transfer that is not a ledger seal, a programme-run (EPG pin) change, a lost D1 authority, a torn paged decision/ledger read, and an unreadable payload. No R2 fallback for a D1-owned catalog. No invented empty list.
4. User `GET /api/catalog/available` and `GET /api/enrichment/view` map those Discovery codes to **HTTP 503** with `code` and `Retry-After: 1`, never the unhandled 502 catch. The UI retries that GET at most once and distinguishes «недоступен» from an empty collection.

Not decided: a new schema, authority marker, feature flag, production writer, or removing writer-side generation increments.

## Alternatives considered

- **Remove the read fence entirely.** Rejected: paged decision and ledger reads would mix pages under a live Workflow.
- **Retry `routeRead` until generation is stable.** Rejected as unbounded while Discovery writes every few hundred milliseconds; a single 503 with one Retry-After is the bound.
- **A second catalog-generation column.** Rejected for this incident: extra schema without owner approval; the single-statement snapshot is enough for admissions.

## Consequences

User Finds and prediction view stay available during ordinary Discovery chunks. The Prediction queue rebuild (`loadCatalogForQueue`) uses the same catalog snapshot, so a generation-only Discovery storm no longer 503s a reconcile or a programme-change `next`; a real pin change, held cutover or non-seal load still does. Projector and detailed pipeline status still defer on `discovery_fence` when they walk decisions or the ledger.

## Recovery and migration boundary

Code rollback restores the previous global generation compare. It does not change D1 rows. No flag, Task, Access, migration or production write is authorized by this ADR.

## Evidence

- **Original decision:** [AIR-493](https://trello.com/c/AKoSOprC)
- **Implementation:** the delivery PR of AIR-493
- **Dated verification:** [offline RCA and tests](../evidence/discovery/air-493-user-read-fence-2026-11-15.md). Natural production 502 disappearance waits on post-merge deploy and the next Discovery Workflow, recorded on the card.
- **Uncertainty:** production interleaving of a specific continuation write with a specific GET was correlated from logs, not captured as a distributed trace.

## Follow-ups

[AIR-492](https://trello.com/c/09ys5uPy) (Discovery throughput) is independent. Owner product acceptance of the live UI remains on AIR-493.
