# ADR 0200: The auxiliary cutover may take its R2 cut over the Predictions auxiliary scope only, with a scope-specific consistency proof

**Status:** Accepted (2026-11-22; [explicit owner decision](https://trello.com/c/UrS1gflv#comment-6b034f80d61396dfb0e88069) after review of the ADR and the offline implementation in [PR #916](https://github.com/vladimino/iptv-watchlist/pull/916); no production action authorized)  
**Original decision date:** 2026-11-22  
**Recorded at:** 2026-11-22  
**Approval source:** [explicit ADR 0200 acceptance](https://trello.com/c/UrS1gflv#comment-6b034f80d61396dfb0e88069); earlier [offline implementation approval](https://trello.com/c/UrS1gflv) addressed NO-GO blocker B1 of the [readiness evidence](../evidence/prediction/air-554-cutover-readiness-readback-2026-11-22.md)  
**Related work:** [AIR-554](https://trello.com/c/UrS1gflv), [AIR-579](https://trello.com/c/OlcWhyM7) (the independent D1 load analysis)  
**Supersedes:** None  
**Amends:** [ADR 0194](0194-prediction-auxiliary-state-d1-checkpoint-and-outbox.md) and [ADR 0196](0196-prediction-aux-admission-closed-state.md) only in **how the two listings of the cutover are taken**; the marker, the closed gate, the import and the residual risk of ADR 0196 are unchanged  
**Superseded by:** None

## Context

The cutover needs two distinct consistent cuts of the legacy auxiliary R2 state, the second at most 15 minutes old, with an import and a verification between them. The exporter takes the whole bucket and calls a cut consistent only when **no object of the bucket** changed between its two listings and seven coordination objects kept their ETags. Freezing the four Predictions Tasks does not make the whole bucket quiet: the hourly Worker tick (monitor state), the Discovery cron every two minutes (immutable observation segments), the Letterboxd `:30` cron, the daily EPG run and ratings keep writing, so every whole-bucket cut risks `inventory_changed` for objects that are not part of the migrated cohort ([readiness evidence](../evidence/prediction/air-554-cutover-readiness-readback-2026-11-22.md), blocker B1). Filtering the listing alone would not remove it: the fence still named the EPG and Discovery coordination keys.

## Decision

1. **An explicit scoped mode, the whole-bucket mode unchanged.** `node scripts/r2-snapshot-export.mjs --scope prediction-aux` takes a cut of exactly the auxiliary scope defined once in `scripts/prediction-aux-scope.mjs`: the exact keys `enrichment/batch-stage.json` and `enrichment/event-outbox.json` and the complete prefixes `enrichment/sources/`, `enrichment/batch-manifest/`, `enrichment/stop-events/` and `enrichment/start-events/` (the set the importer consumes and the Worker's closed gate guards; a test ties the three together). A key under a scope prefix that the importer would not consume stays in the cut and is refused by the converter, never dropped. Without `--scope` nothing changes.
2. **The proof is a property of the scope.** Opening and closing inventories are the complete listing of each prefix plus a `HEAD` of each exact key; every object is read with a conditional `HEAD`, `GET` and `HEAD` and its SHA-256 recorded; any object added, removed or changed inside the scope is `inventory_changed` or `source_changed`. The fence is the scope's own coordination objects, the batch runner and writer leases (`enrichment/runner-lease.json`, `enrichment/writer-lease.json`), compared between the two moments. The EPG and Discovery coordination keys and every other object are outside the proof: they are not listed past their prefix, not read, not compared, and an unrelated writer cannot change the verdict.
3. **The scope travels with the capture and the operator checks it.** The manifest records the scope and the verification refuses a scope that is not exactly the current definition, an object outside it and fence keys that differ from it. The converter report records `{kind, digest}`. The operator accepts only two captures that carry the **same** proof (both scoped, or both the original whole-bucket cut; a capture without a scope field is the whole-bucket cut), refuses an unsupported digest, and the flip release binds the proof kind. A directory taken with one scope is never resumed with the other.
4. **What the scoped proof does and does not claim.** It proves that, at two moments, the objects of the scope were the listed versions and did not change in between, and that the scope's leases did not change. It does not claim atomicity with D1, does not prove anything about unrelated objects (they are not migrated data: immutable Discovery observation segments, Workflow receipts and the rest stay in R2), and does not see a PUT that lands after the closing inventory, which is the residual risk of ADR 0196 unchanged. The closed marker is verified by the operator at the flip, not by the exporter, which holds no D1 access; a legitimate write between the first cut and the close changes the second cut and refuses the flip.

## Consequences

- A scoped cut no longer depends on EPG, Discovery, Letterboxd or monitor activity; it still depends on the auxiliary writers being quiet inside the scope, which the closed gate and the drain procedure of the run sheet provide.
- The scope is one more contract to keep in step: a new auxiliary family must change `scripts/prediction-aux-scope.mjs`, the importer, the Worker gate and the coverage test together.
- Old whole-bucket snapshots and their converter output stay valid.
- Nothing here authorizes a production export, credential, `0034`, a Task freeze or a cutover; each keeps its own owner decision.

## Alternatives considered

- **Filter the listing only and keep the global fence keys.** Rejected: unrelated EPG and Discovery coordination writes keep forcing the original NO-GO.
- **A quiet interval for every writer of the bucket.** Not available without Access, flag or cron changes that no one approved, and not robust against the two-minute Discovery cron.
- **Prefix wildcard configured by the operator.** Rejected: the scope is reviewed code, not an arbitrary prefix.
