# ADR 0162: D1 is the only authority; retire the R2 rollback and cutover toolchain

**Status:** Proposed  
**Original decision date:** 2026-11-17  
**Recorded at:** 2026-11-17  
**Approval source:** owner decision of 2026-11-17 in the AIR-79 executor session ("D1 stays, no rollback to R2 is planned, no insurance for that case, clean everything"; the single rule, the residual risk and the marker read were each confirmed), to be recorded on [AIR-79](https://trello.com/c/485tlGLA) and accepted by the owner on this ADR  
**Related work:** [AIR-79](https://trello.com/c/485tlGLA); decision brief in [AIR-79 D-2 inventory, closeout ledger and D-1 preparation](../evidence/d1-migration/air-79-d2-closeout-and-d1-preparation-2026-11-17.md)  
**Supersedes:** in part [ADR 0073](0073-metadata-cache-d1-authority.md), [ADR 0078](0078-d1-authoritative-prediction-domain.md), [ADR 0079](0079-d1-authoritative-published-epg.md), [ADR 0081](0081-d1-authoritative-owner-reviews.md), [ADR 0084](0084-d1-authoritative-ratings.md) and [ADR 0085](0085-d1-authoritative-discovery.md): their import, hold, activate, seal, release and revert procedures only. Their schema, fence and per-domain authority decisions stay.  
**Superseded by:** None

## Context

Six storage domains moved from R2 to D1 one at a time, each behind an authority marker and an operator toolchain that could import, hold, activate, seal, release and revert. Film/Person moved later behind its own marker and has no revert. The owner decided on 17 November 2026 that D1 stays the authority, that a return to R2 is not planned, and that the code should not keep insurance for that case.

A read-only `SELECT` of the production markers on 17 November 2026 at 21:45 UTC (no row written) returned `mode` `d1` in all seven domains: ratings `d1`/`open`, mutable predictions `d1` (with `writes` `held`, see below), owner reviews `d1` (`writes` `open`), metadata cache `d1`, published EPG `d1`/`open`, Discovery `d1`/`open`, Film/Person `d1`/`open`; `schema_contract` version 23. See the [dated evidence](../evidence/d1-migration/air-79-d2-closeout-and-d1-preparation-2026-11-17.md#production-markers-read-on-17-november).

The Worker never calls any import, activate, seal, release or revert function; only operator scripts and tests do. The `r2`, `prepared`, `legacy` and `held` arms that remain in the Worker serve states that the production markers have left.

## Decision

1. **One rule for every domain:** the Worker serves a domain only when its marker says D1 is the authority (`mode` `d1`, and `cutover` `open` where the domain has a cutover column). For mutable predictions the `writes` column is the import fence of the `r2` mode and is not part of this rule: `activatePredictionDomain` moves `mode` to `d1` and leaves `writes` `held`, which is the normal state after activation. Any other marker value, a missing database binding, a missing `schema_contract` or missing domain tables is an explicit refusal. Nothing falls back to R2 as an authority.
2. **Retire the whole toolchain:** the import, hold, activate, seal, release, revert and reset commands of the six migrated domains, their operator scripts and their tests, and the Worker arms that exist only for the `r2`, `prepared`, `legacy` and cutover-`held` states. Film/Person follows the same rule: its `legacy`, `r2` and `prepared` arms go once the tests that load the Worker without the reader have a shared loader.
3. **Local development and the harness** keep explicit, opt-in stand-ins (such as `PUBLISHED_EPG_DB_OPTIONAL=standin`, `OWNER_REVIEW_DB_OPTIONAL=standin`); an implicit `legacy` answer for a missing binding is not kept. Production asserts the stand-ins are absent.
4. **Kept, because they are not rollback:** CAS and fenced batches, generation fences, `*_DB_REQUIRED`, the R2 compatibility mirrors and their writers, immutable prediction and fingerprint bodies, raw inputs and archives, receipts and immutable Discovery segments, the Discovery `projector_window` fence, and the schema CHECK constraints that still allow the value `r2` (changing them is a migration with no benefit).
5. **Order:** one domain per change, smallest coupling first: owner reviews, metadata cache (which also gains the missing-binding refusal it lacks today), ratings documents, mutable predictions, published EPG, Discovery, then Film/Person after the shared test loader.

Not decided here: [AIR-515](https://trello.com/c/FMWcvvWI) (poster hydration through `epg/discovered-films.json`) and [AIR-516](https://trello.com/c/03h5WhiT) (frozen metadata) stay separate.

## Alternatives considered

- **Keep the revert commands only as insurance.** Rejected by the owner: no return to R2 is planned.
- **Keep the forward import, hold, activate and seal chain as recovery tooling (Option B of the decision brief).** Rejected by the owner: it keeps code and tests for a scenario the project does not plan for. A partial chain would not be executable, so the choice was all or nothing.
- **Keep the published EPG `held` reader contract.** Not kept: after the toolchain is gone `held` is reachable only by a restore or a manual SQL write, and the single rule refuses it.

## Consequences

- Less code and fewer tests in six domains, one rule to review instead of several per-domain arms.
- A Worker deployed without its D1 binding refuses instead of reading R2; for the metadata cache this is a behavior change, because it returns `r2` silently today.
- A fresh local or test database no longer reaches `d1` through import and activate; tests set the marker directly through a harness helper.
- **Accepted residual risk:** if the D1 database is ever restored with Time Travel to a point before a domain's activation, that domain's marker is no longer `d1` and the Worker refuses it. There is no tool to bring it back; recovery is a manual, owner-approved operation. The exposure lasts only while the restore window still reaches back before that domain's activation.

## Recovery and migration boundary

Recovery after this decision is a forward-fix through the fenced adapters, or an owner-approved whole-database D1 Time Travel restore followed by a read-back of every marker. R2 mirrors and immutable bodies are not a D1 source. Code rollback restores no marker and no deleted tooling. This ADR authorizes no production operation; each code slice is an ordinary pull request.

## Evidence

- **Original decision:** owner, AIR-79 executor session, 2026-11-17; to be recorded on [AIR-79](https://trello.com/c/485tlGLA).
- **Implementation:** not started; one pull request per domain as listed above.
- **Dated verification:** [production markers read on 17 November](../evidence/d1-migration/air-79-d2-closeout-and-d1-preparation-2026-11-17.md#production-markers-read-on-17-november).
- **Uncertainty:** the length of the D1 Time Travel window on the account plan, the live `*_DB_REQUIRED` bindings, and the content of ADRs 0017, 0051, 0076, 0108, 0141 and 0142 were not read; each code slice checks the documents it touches.

## Follow-ups

The per-domain code slices of AIR-79; the shared Worker test loader that the Film/Person slice depends on.
