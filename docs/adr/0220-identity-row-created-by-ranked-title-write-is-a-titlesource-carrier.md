# ADR 0220: The identity row created by a ranked title write is a `titleSource` carrier with the neutral status `unresolved`, not an identity verdict

**Status:** Proposed  
**Original decision date:** 2026-11-25, selected as C1-1 by the Product Owner in chat and [relayed by the Coordinator](https://github.com/vladimino/iptv-watchlist/pull/1008#issuecomment-7168990950). That relay is a transcription; the durable owner-authored approval link is **not yet recorded** and is required before this ADR can be Accepted or merged (ADR merge gate).  
**Recorded at:** 2026-11-25, against `main` `7d8d4b3` and PR #1008 HEAD `286d422`  
**Approval source:** Pending: owner-authored direct approval link, to be added here and in the registry at disposition. Interim record: the relayed selection above.  
**Related work:** [AIR-662](https://trello.com/c/P8cCPv1V), [PR #1008](https://github.com/vladimino/iptv-watchlist/pull/1008) (independent review finding P1-3). Narrows Accepted [ADR 0218](0218-film-lifecycle-dimensions-revision.md) decision 5; coordinated with [AIR-660](https://trello.com/c/daGePESx) (parity classification) and [AIR-661](https://trello.com/c/1Rv634jd) (guarded import and retirement, merged as `5e61ab3`).  
**Supersedes:** In part, one sentence of [ADR 0218](0218-film-lifecycle-dimensions-revision.md) decision 5 ("That row has the current verdict as `status`"). It amends nothing else.  
**Superseded by:** None

## Context

[ADR 0218](0218-film-lifecycle-dimensions-revision.md) decision 5 (option C1, selected) keeps the `identity` row of `film_dimension` as the carrier of `titleSource` and of owner/reviewed protection. On a ranked title write where no identity row exists, the Film writer creates a minimal one in the same batch and under the same revision CAS, so `no_identity_row` no longer drops a rank. The decision text also says the row "has the current verdict as `status`", and that every status other than `reviewed` is informational and never read for a decision.

Implementing the status as the current verdict (AIR-662, PR #1008) exposed a conflict between two accepted designs:

- The only verdict semantics that covers `tmdb_tv` claims and the owner retirement ledger is the ADR 0216 resolver (`src/film-aggregate-resolver.js`). It is deliberately dormant: a test forbids any Worker source from importing it, it imports `node:crypto` (not bundled), and its own header forbids activating it before migration 0040 (the retirement ledger index by movie id, AIR-667) is applied in production.
- A second, hand-written verdict in the writer is a second identity rule. The first implementation checked only `tmdb`/`letterboxd` claims and omitted `tmdb_tv` and the retirement ledger, so it could disagree with the resolver in both directions (an unsettled TV claim `found` here and `conflict` there; a retired conflicting movie claim the reverse). ADR 0218 forbids new precedence or identity rules.

The independent review (finding P1-3) asked for either the existing verdict semantics bound to the title-write CAS, or an explicit owner disposition of a different informational contract.

## Decision

The Product Owner selected **C1-1**. The identity row that a ranked title write creates is a **`titleSource` carrier**:

1. **Status.** `unresolved`, an existing value of the AIR-42 identity status vocabulary (`DIMENSION_STATUSES.identity`, `KNOWN_STATUSES.identity` of the parity classifier). In this row it means only "this row asserts no identity verdict". It does not say the identity is unresolved, and no code may read it as an identity fact.
2. **Content.** `provenance_json` is `{"titleSource":{"source":...,"at":...}}` and nothing else; `authority`, `value`, `source`, `source_version` and every processing field are empty. Creation is `INSERT ... ON CONFLICT DO NOTHING`, in the same batch and under the same revision CAS as the title write.
3. **No verdict is computed, duplicated or persisted** by a ranked title write. The authoritative identity verdict remains solely the ADR 0216 read-side resolver. The writer reads no claim, redirect or retirement row to create the carrier, so it adds no read, no read-set and no dependency on migration 0040.
4. **Protection is unchanged.** `status='reviewed'` and `authority='owner'` stay the only control inputs of `strong()`. An existing identity row of any status is never replaced by this creation. A row without `titleSource` is untouched.

Everything else in ADR 0218 decision 5 stands, including the atomic `titleSource` binding, the CAS, the creation on a ranked title write only and the rule that every other status is informational and never read for a decision. This ADR changes no other decision, no ADR 0216 rule and no schema.

**Not decided here:** any change to the ADR 0216 resolver, its activation or migration 0040; any identity-row backfill or repair of existing rows; any production operation.

### Compatibility

- **AIR-660 parity classifier.** `unresolved` is a known identity status. A carrier row classifies as `control` (reason `title_source`) whatever the derived verdict is (`found`, `conflict`, `unavailable`); it is never `stale_copy` and never `unknown_legacy`. Fixtures: `tests/film-localization-projection.mjs`.
- **AIR-661 guarded import and retirement (merged, `5e61ab3`).** Its replaceable-identity and protected-row predicates key off `titleSource` in `provenance_json` and the known identity status list, which contains `unresolved`; a carrier row is therefore kept (control) by the importer and the retirement fence. No change of its predicates is required by this decision; a test over `replaceableIdentity` and `DIMENSION_STATUSES.identity` at `5e61ab3` confirms a carrier row (status `unresolved`, `titleSource` only) is not replaceable and the status is known.
- **Readers and fixtures.** No D1 reader or route reads the identity status for a decision (ADR 0218 inventory); the offline lifecycle reader reads `unresolved` as "not resolved", which is true of a Film whose identity the row does not assert. The dictionary producer no longer names `no_identity_row` and hands the title to the writer.

## Alternatives considered

- **C1-2: reuse the verdict.** Extract the pure `evaluate()` of the ADR 0216 resolver into a bundle-safe module shared with the writer, read claims, claim pairs and the retirement ledger by movie id in the writer and bind that read-set to the title-write batch. Honors "current verdict" literally with one semantics, but edits the delivered AIR-646 resolver, reads the ledger before migration 0040 is confirmed applied, relaxes the "no Worker source imports the resolver" invariant and adds a read budget to a hot writer. Not selected.
- **C1-3: defer identity-row creation.** Restore the `no_identity_row` refusal and deliver the carrier after the aggregate is activated. Leaves ranked titles unranked and moves a writer change into a read-route activation card (AIR-648 is read-only). Not selected.
- **C1-1 with another neutral value.** `unresolved` is preferred because it already exists in the status vocabulary of every consumer (parity classifier, importer fence, domain enum), so no consumer changes.

## Consequences

- The created row can never disagree with the resolver, because it asserts no verdict; the resolver is the only place identity is decided.
- A reader that wrongly treats `identity.status` as a fact would read `unresolved`; ADR 0218 already forbids that, and the classifier does not.
- Rows already created by earlier code of PR #1008's first revision do not exist in production (nothing was deployed), so no existing row has a verdict status from this writer.
- A code rollback leaves valid carrier rows: they use the same columns and a status the previous code and every reader already know.

## Recovery and migration boundary

Code-only and reversible by deploy; rows it wrote stay valid. No flag, schema apply, backfill, Scheduled Task or cutover is authorized by this ADR.

## Evidence

- **Original decision:** [relayed selection C1-1](https://github.com/vladimino/iptv-watchlist/pull/1008#issuecomment-7168990950); [options put to the owner](https://github.com/vladimino/iptv-watchlist/pull/1008#issuecomment-7168814532) (executor response, P1-3); [review of `9c716b4`](https://github.com/vladimino/iptv-watchlist/pull/1008#issuecomment-7168269692) and [re-review of `286d422`](https://github.com/vladimino/iptv-watchlist/pull/1008#issuecomment-7168938794).
- **Implementation:** PR #1008 (`IDENTITY_CARRIER_STATUS` in `src/canonical-film-writers.js`).
- **Dated verification:** 2026-11-25, local fixtures on SQLite (no production reads): the carrier status is identical for a clean Film, a competing claim, an unsettled `tmdb_tv` claim and a retired movie claim; the carrier insert issues no claim read; the carrier classifies as `control` for every derived verdict.
- **Uncertainty:** the AIR-661 predicates were read at the merged `5e61ab3`; a later change of them would need to keep keying off `titleSource` and the known status list.

## Follow-ups

- Owner-authored approval link for this ADR and its registry row, before merge.
- AIR-661: confirm that its fixtures include a carrier row with status `unresolved` once this ADR is Accepted.
