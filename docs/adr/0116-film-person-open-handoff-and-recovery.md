# ADR 0116: Film/Person activation uses fenced handoff, prepared admission load, held forward recovery, frozen canonical mirrors and durable receipts

**Status:** Accepted  
**Original decision date:** 2026-11-11  
**Recorded at:** 2026-11-11  
**Approval source:** The Product Owner's explicit five-point approval on [AIR-374](https://trello.com/c/ha7ais3w), captured in the card as "OWNER APPROVAL / AIR-374 / 11.11.2026". This authorizes architectural documentation and offline implementation only, **not** production operations.  
**Related work:** [AIR-374](https://trello.com/c/ha7ais3w), [AIR-373](https://trello.com/c/ugu3sQmp), [AIR-371](https://trello.com/c/gt1afd0C), [ADR 0099](0099-canonical-film-person-d1-authority.md), [ADR 0110](0110-film-person-operator-copy-and-accepted-discrepancies.md)  
**Supersedes:** ADR 0099 section 6 and "Recovery and migration boundary" **only to the extent of the post-open recovery choice below**; all other ADR 0099 invariants remain binding.

## Context

The Film/Person baseline is recorded and the production marker is `prepared/open`, generation 1, on the owner-accepted operator-attested evidence of [AIR-373](https://trello.com/c/ugu3sQmp). R2 remains canonical authority and the projector is the sole Film/Person writer until a separately approved handoff. The offline AIR-374 delivery plan identifies missing producer wiring and canonical read consumers. A bare marker flip would risk losing writes or creating two writers; it is prohibited.

## Decision

1. **Projector revision gap is not a cutover blocker by itself.** In `prepared`, an absent historical `canonical_revision` is interpreted as initial revision 0, not evidence that another writer owns the row. The projector must guard **every real canonical write batch** on the current marker and generation, independent of `D1_ENRICHMENT_BULK` or any other feature flag. In `r2` and `prepared` it remains the only writer. After the generation-fenced `prepared -> open` transition, stale projector batches must fail before writing; canonical mutations use per-entity revisions and CAS. A tested proof of no writer overlap and no writer gap remains mandatory.

2. **Load 1,113 missing facts while still `prepared`.** The accepted counts are `ratedAdmission=708`, `retention=401`, `retirement=4`. Build a bounded, idempotent, owner-run loader with an offline dry-run, provenance, receipts, restart/unknown-outcome handling, no accidental duplicate facts and readback. These producer facts are not concurrently written by the legacy projector; verify that premise in code and at preflight. The actual production import requires a separate action-specific owner GO. The handoff must not proceed until the required facts are loaded and verified.

3. **Post-open recovery is `held` plus validated forward-fix.** First move `open -> held` under a separate owner-approved, generation-fenced operation; fail closed for affected readers and writers and do not silently fall back to R2. Before activation, test a bounded, executable `held -> open` recovery drill on a safe copy, covering repair, parity, writer ownership, generation fencing and readback. A full D1-to-R2 reverse reconciler is **deferred**. After D1-only canonical writes start, neither `mode=r2` nor a code revert is a safe rollback; restoring R2 authority would require a separately designed and approved reverse reconciliation. This explicitly narrows the earlier ADR 0099 reverse-reconciler-before-activation expectation without removing mandatory recovery readiness.

4. **Freeze legacy mutable canonical R2 mirrors at activation.** After `open`, canonical `titles.json`, `people.json` and equivalent mutable canonical snapshots are archived and no longer updated as authoritative Film/Person copies; their consumers must use the D1 canonical read model. This does **not** freeze independent D1-published EPG programme/watchlist compatibility mirrors, immutable source documents, receipts, required admission inputs, or `enrichment/view-index.json` where it retains its separately owned prediction meaning. Classify each path by authority before disabling a writer or changing a reader. No silent R2 fallback once the marker is `open` or `held`.

5. **Durable cross-domain canonical delivery.** EPG, Discovery, metadata/localization and ratings producers must deliver canonical effects with stable idempotency/request identifiers and persisted receipts of pending/succeeded/failed or indeterminate outcomes. Use bounded retries and a reconciler that can discover unfinished receipts; a periodic (e.g. hourly) reconciliation is a safety net, **not** a substitute for durable intent. Preserve the existing domain authorities for programme, Discovery, ratings, metadata and owner reviews. Implement the minimal mechanism on existing D1 infrastructure; no new general event platform or scheduled task is approved by this ADR. Every writer must remain generation-fenced and recover unknown outcomes by verifying full effects or re-planning.

## Delivery and verification

- Existing [AIR-374](https://trello.com/c/ha7ais3w) plan stages P1–P7 remain the implementation framework. Critical path: P2a Film writers -> P3a EPG commit wiring -> P6 differential natural-path and computed readiness. P1 unconditional projector fence, P4 fail-closed canonical readers, P5 prepared-only loader and P7 activation/recovery tooling may be developed as independent offline PRs in parallel. P2b Person and P3b/P3c/P3d producer routes are required before readiness.
- Validate actual code call sites and feature flags read-only before making decisions; code with dormant/compare-only behavior under `prepared`. Ensure `handoffReadiness.ready` is computed from verified coverage, never hardcoded and never true while any required writer/reader gap remains.
- Tests must prove canonical identity, trusted IDs, aliases, redirects, Film–Person credits, rated-only and departed-watchlist preservation, effective owner localization, version conflicts, no double/missing writer, no stale projector writes, durable retry, `held`/unknown 503 and correct separation of R2 mirrors.
- All code and documents go through normal PR, independent exact-HEAD review, CI and post-merge delivery. No production activation is implied by merging.
- **Distinct owner holdpoints:** actual P5 production load; `prepared -> open` flip; any live producer write/probe beyond passive natural observation; `open -> held`, recovery or rollback; feature flags, leases and scheduled work. Each requires its own preflight, fenced bounds, readback and explicit GO.

## Trade-offs and limits

- The absence of pre-activation projector revision history is tolerated only because the projector is the sole writer in `prepared` and every batch is marker/generation fenced.
- The team explicitly accepts losing immediate R2 rollback after D1-only writes in exchange for reaching D1 authority sooner; `held` can cause read/write unavailability, and recovery drill evidence must exist **before** activation.
- Durable receipts add local state and reconcile work but protect against dropped cross-domain operations. A periodic scan alone could miss an event that was never durably recorded.
- This ADR specifies a design, not proof that production is ready. AIR-373's operator attestation does not prove atomicity between D1 and R2 or later production parity.

## Alternatives considered

- Historical projector revision bump as a hard prerequisite: rejected if generation fencing and post-flip revision CAS are proven.
- Load the 1,113 facts only after `open`: rejected because activation would expose incomplete canonical facts.
- Implement full reverse reconciliation before `open`: deferred; `held` plus proven forward recovery accepted instead.
- Keep updating legacy R2 canonical snapshots: rejected because they could become competing mutable truth.
- Idempotency IDs plus hourly reconciliation *without durable receipts*: rejected because missing intent can remain invisible.

## Follow-up

The Executor prepares bounded implementation PRs under AIR-374. The independent reviewer tests each branch on its exact HEAD. The Delivery Controller coordinates merge and post-merge CI/deploy. Activation and recovery remain owner-controlled production decisions.
