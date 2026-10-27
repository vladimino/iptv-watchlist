# ADR 0029: A retired Film id's fingerprint or prediction bundle is superseded by the canonical Film's own newer payload

**Status:** Proposed (offline importer, executor and parity contract only; it authorizes no R2 or D1 write, flag, Task, snapshot, materialization or cutover)  
**Original decision date:** 2026-10-27  
**Recorded at:** 2026-10-27  
**Approval source:** owner choice of design A on [AIR-194](https://trello.com/c/WfATFVSP), 2026-10-27 (canonical payload authoritative; the old source stays in R2 as a narrow, auditable superseded exception); this record awaits review  
**Related work:** [AIR-194](https://trello.com/c/WfATFVSP), [AIR-74](https://trello.com/c/5AdAmKPe), [AIR-74 S1 executor dry-runs](../evidence/d1-migration/air-74-s1-executor-dry-run-2026-10-27.md), [ADR-0009](0009-canonical-film-person-identity.md), [ADR-0019](0019-live-d1-backfill-boundaries.md) items 4 and 8, [ADR-0026](0026-historical-prediction-version-materialization.md), [ADR-0027](0027-owner-rating-tmdb-identity.md), [D1 schema reference](../reference/data/d1-schema.md)  
**Supersedes:** None (it adds one ledger category beside classes A, B and C of ADR-0019 item 8; class A stays never acknowledgeable)  
**Superseded by:** None

## Context

The full offline executor on the AIR-175 snapshot stopped with `class_a_blocker` on `fingerprint_kept` after 20,068 applied units ([S1 evidence](../evidence/d1-migration/air-74-s1-executor-dry-run-2026-10-27.md)). The cause is a redirect collision. A fingerprint is stored under a retired Film id. That id's redirect maps it to a survivor Film, and the survivor holds its own, newer fingerprint. Both source objects resolve to the same `fingerprint_payload` row. The repository keeps the newer one, so the older unit reads back as "kept" and the run stops. The same retired id also has a prediction bundle, which collides with the survivor's bundle the same way.

Such a stop is correct for an unexplained collision. For this shape, however, the survivor's own payload is the current truth: the runtime reads the survivor's key, and the retired key is no longer written. The owner chose design A for this case:
- the canonical payload is authoritative;
- the old object stays in R2 untouched;
- the old object is reported as a narrow, auditable superseded record.

It is neither a silent pass nor a class C acknowledgement.

## Decision

1. **Scope.** The rule covers only `enrichment/films/<id>/fingerprint.json` (target `fingerprint_payload`) and `enrichment/films/<id>/predictions.json` (targets `prediction_current` and `prediction_history`). Ratings, decisions, generations and every other family are unchanged. No Film is created, no id is minted, and no source object is changed or deleted.

2. **When a payload is superseded.** All of the following must hold, per family:
   - **Redirect identity.** The stored id resolves through the shared resolver with `via: "redirect"` to Film T. The resolver has already proved this: exactly one survivor carries the redirect, the survivor exists, and no other Film or conflict record claims the id's TMDB id. A retired id that is also a stored Film, or one that two survivors claim, is an `identity_conflict` and never reaches this rule.
   - **One canonical payload.** Exactly one other object of the same family resolves to T with `via: "direct"`. This is the canonical payload.
   - **Both are portable.**
     - A fingerprint has its hash, a schema version and a valid `generatedAt`.
     - In a bundle, the current record and every history record pass the write path's version-pointer and field checks against the snapshot: a well-formed pointer, an object in the manifest, equal checksums and the required fields. The current record carries a valid `updatedAt`.
   - **Checksums.** Both objects carry a SHA-256 checksum from the manifest.
   - **Strictly newer.** The canonical time (`generatedAt`, or the current record's `updatedAt`) is later than the retired payload's time.

3. **Refusals keep today's path.** When the conditions fail, the unit stays what it was, and the reason is reported. The reasons are:
   - `canonical_missing`: there are only retired payloads;
   - `canonical_ambiguous`: there is more than one direct payload;
   - `canonical_unportable`;
   - `source_unportable`;
   - `checksum_missing`;
   - `canonical_not_newer`: this includes an equal time with a different hash.

   The fail-closed outcome is then unchanged. The collision is still a class A `fingerprint_kept` or `prediction_kept` that stops the run, and an unportable bundle is still a class A `prediction_family_unportable`.

   When the retired id is the only payload of T, there is no collision, and its payload is imported through the redirect as before.

4. **Missing version objects are never hidden.** A retired bundle whose records lack immutable version objects is not superseded. Its records stay unportable (`prediction_version_object_missing`), and the prediction family stays a class A blocker until an approved materialization ([ADR-0026](0026-historical-prediction-version-materialization.md)) and a new fenced snapshot. The same holds when the canonical bundle is the unportable one.

5. **Disposition `superseded_by_canonical`, category S.**
   - **No write, no receipt.** A superseded payload produces one ledger row with outcome `superseded` and class `S`. No row is written and no receipt is taken.
   - **Provenance in the row.** The row keeps:
     - the source key and checksum;
     - the resolution (`via: "redirect"`);
     - the source time;
     - `supersededBy`: `{key, sha256, at}` of the canonical payload;
     - for a bundle, the number of records it holds.
   - **Effect on the run.** The record does not stop the run. It is not a class A gap: `classes.A.open` and `classes.A.blockers` ignore it. It is not a class C record: it needs no acknowledgement-list entry and cannot be added to one. It is reported in `classes.S` with counts per family and the full records. `ledger.json` lists it under `superseded`.
   - **Parity claim.** `claimsFullParity` stays false while any S record exists, because a superseded source is not lossless parity.

6. **Same rule on both sides.** `supersededPayloads()` runs once per run over the snapshot's fingerprint and bundle objects. The one result goes to both:
   - the write list: `fingerprintUnit` and `predictionUnits`;
   - the independent source projection: `projectSource`.

   The projection marks the retired key `superseded` and expects only the canonical payload. The read-back therefore fails if the retired payload ever lands on T: the stored `r2_key` and `content_sha256` must be the canonical ones. The result does not depend on input order, and reruns repeat the same S rows with zero writes.

7. **Everything else stays fail-closed.** Every other class A outcome still stops the run. The rule never turns a conflict, an explained unit or an unportable record into a pass.

## Alternatives considered

- **Acknowledge the record as class C.** Rejected. It is a class A collision on a resolved identity, and ADR-0019 keeps class A never acknowledgeable. A blanket acknowledgement would also hide later, different collisions.
- **Let the newest payload win silently.** Rejected. The run would lose the audit trail of a source object that is not imported.
- **Import the retired payload into history.** Rejected. A fingerprint has no history table. Merging two bundles' histories would invent an order the runtime never had.
- **Rewrite or delete the retired R2 objects first.** Rejected. That would be a production R2 write, out of scope, and it would destroy the evidence the ledger points to.

## Consequences

On the AIR-175 snapshot, the redirected fingerprint that stopped S1 is superseded and the run continues. The retired id's bundle stays unportable, as do the bundles of every Film whose versions are not materialized. The next honest stop is therefore the prediction family's class A blocker ([evidence](../evidence/d1-migration/air-194-superseded-redirect-replay-2026-10-27.md)). After materialization and a new fenced snapshot, the same rule decides the retired bundle by its own merits. A later snapshot may show more or fewer such records, and each is listed. The Worker never reads this rule.

## Recovery and migration boundary

- **Code rollback.** It restores the class A stop; nothing else changes.
- **Rows already written.** A D1 database that already holds rows keeps them with their receipts until an approved re-import. Superseded payloads were never written, so no row has to be undone.
- **R2.** It stays authoritative, and the retired objects remain where they are.
- **Approvals.** Any D1 write, any R2 change and any decision to retire the old objects are separate owner approvals.

## Evidence

- [AIR-194 offline replay on the AIR-175 snapshot](../evidence/d1-migration/air-194-superseded-redirect-replay-2026-10-27.md)
