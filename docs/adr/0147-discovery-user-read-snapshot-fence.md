# ADR 0147: User catalog reads fence authority, programme and transfer epoch, not the global Discovery generation

**Status:** Proposed  
**Original decision date:** 2026-11-15  
**Recorded at:** 2026-11-15  
**Approval source:** [AIR-493](https://trello.com/c/AKoSOprC) incident card plus owner numbering (AIR-492 keeps ADR 0146). The material snapshot-fence trade-off is **not** Accepted until independent review PASS and explicit owner merge approval.  
**Related work:** [AIR-493](https://trello.com/c/AKoSOprC)  
**Supersedes:** None  
**Superseded by:** None

## Context

`DiscoveryAuthority.routeRead` compared `discovery_authority.generation` before and after every owned key. Every Discovery writer (chunk admission, decision, continuation, status, Workflow record) increments that generation. User `GET /api/catalog/available` and `GET /api/enrichment/view` load the catalog through `routeRead`. While the Cloudflare Discovery Workflow is live, those GETs raced the generation bump, threw `discovery_fence`, and the Worker catch turned the throw into HTTP 502. The UI then showed «нет данных» as if the collection and predictions were empty. Production evidence (Worker `route_error` with `code=discovery_fence` on both paths, 15 November 2026 Europe/Madrid) is in the [dated RCA](../evidence/discovery/air-493-user-read-fence-2026-11-15.md).

The generation compare is the right torn-page guard for multi-statement walks (the whole decisions document, the whole ledger, `streamActiveLedger`). It is the wrong guard for a single `SELECT` of current admissions or a single payload row: SQLite already returns one statement snapshot, and a continuation write does not mix catalog rows.

A transfer-state-only close (`closed.transfer !== 'loading'`) is not enough: `replaceCatalog` can move `committed → loading` (current admissions become `pending`) → `committed` between the authority reads. The SELECT can observe the empty intermediate catalog while both transfer checks still see `committed`. Existing `discovery_transfer.batches` already increments on every catalog (and other) transfer load start and finish.

## Decision

1. **Generation-fenced keys** stay generation-fenced: `epg/discovery-resolution.json`, `epg/discovery-latest.json` (including a generation copy of the ledger) and `epg/discovery-score-preview.json`. A mid-read generation, programme or transfer change is `discovery_fence`. Mixed pages are never returned.
2. **Snapshot keys** (catalog `discovered-films.json` and its generation copy, status, continuation, lease, Workflow, and `readFilmAdmission`) close the read on D1 still ready, the same `programmeRunId`, transfer not becoming `loading` (except a ledger-seal read), and the same `discovery_transfer.batches`. A continuation or status write that only bumps generation does not fail the catalog. A catalog-replace ABA that returns to `committed` with a moved batches epoch does.
3. **Fail closed** for held cutover, a loading transfer that is not a ledger seal, a programme-run (EPG pin) change, a lost D1 authority, a torn paged decision/ledger read, an unreadable payload, and a held D1 catalog when serving `GET /api/enrichment/view`. No R2 fallback for a D1-owned or held catalog. No invented empty list.
4. User `GET /api/catalog/available` and `GET /api/enrichment/view` map those Discovery codes to **HTTP 503** with `code` and `Retry-After: 1`, never the unhandled 502 catch. The UI retries that GET at most once and distinguishes «недоступен» from an empty collection.

Not decided: a new schema, authority marker, feature flag, production writer, or removing writer-side generation increments.

## Alternatives considered

- **Remove the read fence entirely.** Rejected: paged decision and ledger reads would mix pages under a live Workflow.
- **Retry `routeRead` until generation is stable.** Rejected as unbounded while Discovery writes every few hundred milliseconds; a single 503 with one Retry-After is the bound.
- **A second catalog-generation column.** Rejected for this incident: extra schema without owner approval; `discovery_transfer.batches` already names catalog-load epochs.

## Consequences

User Finds and prediction view stay available during ordinary Discovery chunks. The Prediction queue rebuild (`loadCatalogForQueue`) uses the same catalog snapshot, so a generation-only Discovery storm no longer 503s a reconcile or a programme-change `next`; a real pin change, held cutover, non-seal load or catalog-replace ABA still does. Projector and detailed pipeline status still defer on `discovery_fence` when they walk decisions or the ledger.

## Recovery and migration boundary

Code rollback restores the previous global generation compare. It does not change D1 rows. No flag, Task, Access, migration or production write is authorized by this ADR.

## Evidence

- **Original decision:** [AIR-493](https://trello.com/c/AKoSOprC); ADR number 0147 by owner comment on PR #659 (AIR-492 keeps 0146).
- **Implementation:** the delivery PR of AIR-493
- **Dated verification:** [offline RCA and tests](../evidence/discovery/air-493-user-read-fence-2026-11-15.md). Natural production 502 disappearance waits on post-merge deploy and the next Discovery Workflow, recorded on the card.
- **Uncertainty:** production interleaving of a specific continuation write with a specific GET was correlated from logs, not captured as a distributed trace.

## Follow-ups

[AIR-492](https://trello.com/c/09ys5uPy) (Discovery throughput) is independent and must merge first. Owner product acceptance of the live UI remains on AIR-493.
