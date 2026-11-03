# ADR 0084: D1 owns the discovery ledger only after its own marker is switched

**Status:** Proposed  
**Original decision date:** not yet accepted  
**Recorded at:** 2026-11-03  
**Approval source:** not documented. This record is proposed with the offline implementation. The 2 November 2026 card comment allows a separate code preparation and is not acceptance of this ADR and not a production GO.  
**Related work:** [AIR-320](https://trello.com/c/4cA5GlJn), [ADR 0079](0079-d1-authoritative-published-epg.md), [ADR 0080](0080-discovery-identity-correction.md), [ADR 0081](0081-d1-authoritative-owner-reviews.md), [ADR 0083](0083-inert-discovery-workflow.md), [ADR 0034](0034-bounded-discovery-ledger.md)  
**Supersedes:** None while this record is Proposed. On acceptance, and only while `discovery_authority.mode` is `d1` and `cutover` is `open`, it supersedes in part [ADR 0002](0002-cloudflare-worker-r2-authority.md) for the discovery ledger, the sentence in [ADR 0079](0079-d1-authoritative-published-epg.md) decision 5 that discovery candidate and decision objects stay R2, and the R2 shard index as the owner read in [ADR 0061](0061-discovery-observation-index-and-reconsider.md). The accepted text of those records stays until then.  
**Superseded by:** None

## Context

Live and archived candidate observations, the current-generation evidence, score and attempt state, retry and terminal decisions, their history, and verified catalog admission are R2 objects. The published EPG generation is already D1 ([ADR 0079](0079-d1-authoritative-published-epg.md), Accepted, marker `d1` / `open`). Discovery still fences on that generation and still stores the ledger in R2. Owner reconsideration and identity correction ([ADR 0061](0061-discovery-observation-index-and-reconsider.md), [ADR 0080](0080-discovery-identity-correction.md)) write that R2 map. When the published-EPG marker is `d1` and discovery is not, both actions report `supported: false` and write nothing.

Production D1 is schema v8. Migration `0009` (owner reviews, [ADR 0081](0081-d1-authoritative-owner-reviews.md)) is in the repository and is not applied. Schema versions are linear, so a discovery migration cannot become version 9. The external executor remains the only executor ([ADR 0083](0083-inert-discovery-workflow.md)). `DISCOVERY_EXECUTOR` is unchanged. There is no transaction that covers D1 and R2 together.

## Decision

1. **New tables, no Film foreign key.** Migration `migrations/0010_discovery_authority.sql` adds the discovery marker, fence, transfer, lease, continuation, status, checkpoint, workflow record, observations, shows, decisions, decision history, catalog admission, archive segments, scores and owner intents. `film_id` and `observation_key` are not foreign keys to `film`. The migration inserts no film, person, credit or owner-review row. `tmdb` and `tmdb_tv` stay distinct admission rows. A duplicate `(media_kind, tmdb_id)` or a canonical identity other than `tmdb:<id>` or `tmdb_tv:<id>` is `discovery_conflict` and writes nothing. Catalog admission is not a Film row.
2. **Version 10 follows a complete version 9.** The file refuses to create a table unless `schema_contract.version` is at least 9 and below 10, the 22 named prediction, published-EPG and owner-review tables are present, and the three authority rows exist. The production order is `0007`, then `0008`, then `0009`, then this file. Applying it before `0009` would make `0009` unapplicable. A trigger rejects a later downgrade. A deploy does not apply `0010` and does not apply `0009`.
3. **One marker, default `r2`.** The inserted row is `mode` `r2`, `cutover` `open`, generation 0, null programme. Readers and writers use D1 only when `mode` is `d1` and `cutover` is `open`. `cutover` `held` is not that authority: readers stay on R2 and writers throw `discovery_fence`. A missing binding, a missing `schema_contract`, or a version below 10 stays on R2, so today's production and the existing tests keep the R2 path. Version 10 without these tables, a marker other than `r2` or `d1`, or a read that throws is `discovery_unavailable`. That path does not serve the R2 ledger. `discovery_transfer.state` `loading` is `discovery_incomplete` for readers. A failed multi-batch replace leaves `loading`, so a torn ledger or catalog is not served.
4. **What moves when the marker is `d1` and open.** `loadJSON` / `saveJSON` route the live ledger, the generation ledger, the catalog, the decision map, status, the score preview, the continuation, the workflow record and the lease key. The lease key is not written as an R2 object. The continuation etag is `d1:<revision>`. The workflow etag is `d1:workflow:<revision>`. A ledger seal is fenced on the discovery lease. It does not require the published pointer to already name the new run: the lease holder moves `programme_run_id`, and a later acquire returns no lease when that programme and the live pointer differ. A decision write requires the lease programme to equal the marker programme and the observation's evidence key, when both sides have one. Departed active rows move to residence `archive` with `source_key` `archive:<programme>:<generation>:<key>`. They are not deleted. Each committed decision is appended to `discovery_decision_history` when its hash changes. Statement batches stay at or below 40. One observation's shows may span batches while the transfer is `loading`.
5. **Owner actions are real D1 writes when discovery is ready.** `discovery_reconsider` and `discovery_identity_correct` (assign and reject) store an intent (`approved`, then `running`, then `receipt`) and the decision in one fenced batch. A replay returns the receipt and does not write again. A `running` intent with no receipt answers `unknown` and does not write again. While discovery is not ready and the published EPG marker is `d1`, both actions stay `supported: false` and do not write R2. While discovery is held, the confirm is refused. The UI disable contract is unchanged: an action that cannot run is not offered as a write.
6. **What does not move.** Canonical Film and Person, credits, owner-reviewed titles and names, ratings, prediction state, and raw EPG XML. R2 keeps immutable observation segments, snapshots, raw TMDB bodies, and the owner-action receipts of the `r2` path. `importSegment` copies an archive segment into D1 only when the marker is already authoritative, the source key starts with `archive:`, the SHA-256 matches, and no lease is live. The operator script does not expose it. No automatic merge. No AIR-131 group apply and no AIR-132 versioned revoke. `ensureDiscoveryWorkflow` and `reconcileDiscoveryWorkflow` are not rewritten and are not started by this marker. The external executor remains the executor until [AIR-324](https://trello.com/c/kNtaEbm8). No new feature flag.

Not decided here, and not authorized by proposing this record: applying `0009`, applying `0010`, importing a ledger or an archive segment, holding or sealing the marker, setting `mode` to `d1`, any discovery or TMDB run, and any production R2 or D1 write.

## Alternatives considered

- **Reuse the v1 `candidate` tables and their Film foreign key.** Rejected on the card. A publish or a decision would insert a Film, and `tmdb` / `tmdb_tv` would collapse.
- **Fall back to the R2 ledger when D1 fails after the marker says `d1`.** Rejected on the card. The object can be the stale copy the failure just left behind.
- **Apply `0010` as version 9, beside owner reviews.** Rejected by the linear `schema_contract`. `0009` must occupy version 9 first, or it can never apply.
- **Start the Cloudflare Workflow from this marker.** Rejected. [ADR 0083](0083-inert-discovery-workflow.md) leaves that switch to AIR-324. This record only stores the workflow row when discovery is already authoritative.

## Consequences

Two chunks cannot hold the lease. A decision whose evidence key does not match the active observation fails the fence and leaves the stored decision. A catalog identity collision fails before the transfer goes `loading`. A killed multi-batch leaves `loading`, and every discovery read then fails closed until a later successful seal or an operator repair that this delivery does not provide. The owner page's index, when the marker is `d1` and open, is the D1 rows rather than the R2 shards. `saveObservationIndex` does not write those shards in that mode. While the marker is absent, `r2`, or the schema is below 10, the R2 shards remain the index.

The discovery, EPG and persistence Mermaid diagrams change in this delivery. They need the owner's visual approval. That approval is not a production GO.

## Recovery and migration boundary

A code rollback while the marker is `r2` leaves readers on R2, whether or not `0010` has been applied. Applying `0010` leaves `mode` at `r2` and copies nothing. Schema apply, archive import, a hold, a seal, and the marker change are separate owner GOs. This delivery's script, `scripts/discovery-authority.mjs`, prints the marker and `writes: false`. It refuses `--apply`, `--activate`, `--import` and `--load`. It refuses a database path that contains the production database id `3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb` or a path segment `iptv` before sqlite is opened. It does not call the network. There is no production entry. Returning a future `d1` marker to `r2` is not implemented here. A Time Travel restore of the whole database would be its own approval. Neither is authorized by this record.

## Evidence

- **Original decision:** not accepted. The preparation comment is on [AIR-320](https://trello.com/c/4cA5GlJn).
- **Implementation:** the pull request that introduces this record.
- **Dated verification:** [local sqlite note, 3 November 2026](../evidence/d1-migration/air-320-discovery-authority-2026-11-03.md). No production D1 or R2 read or write.
- **Uncertainty:** production D1 batch behavior for a real ledger was not measured. `0009` is not applied, so `0010` cannot be applied to production until that separate GO. HTTP admin routes, `GET /api/catalog/available`, and a full resolver chunk after a new EPG were not executed against this module. The local note lists those gaps.

## Follow-ups

Owner acceptance of this Proposed ADR, and visual approval of the changed Mermaid, are gates on the pull request. They do not apply a migration or flip the marker. The later operational GOs are schema `0009`, schema `0010`, import, hold, seal, and activation, each separate. AIR-324 remains the Workflow switch. AIR-131 and AIR-132 stay out of this record.
