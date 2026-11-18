# ADR 0170: A short owner-reviewed id list lets the policy-exclusion writer reach cards the synopsis rule cannot

**Status:** Proposed (2026-11-18; the owner approved this path in the AIR-501 project chat and asked for the six films to be verified against TMDB. Acceptance is requested on the pull request. This records writer eligibility, not permission to exclude any Film or to run Discovery, EPG, TMDB, predictions, Tasks, or a storage write)  
**Original decision date:** 2026-11-18  
**Recorded at:** 2026-11-18  
**Approval source:** not yet documented as a GitHub approval; the owner's chat instruction «да, этот путь, и проверь заодно три non-fiction»  
**Related work:** [AIR-501](https://trello.com/c/ShipZn0N), [ADR 0169](0169-writer-only-catalog-cleanup-classification.md), [ADR 0153](0153-catalog-policy-exclusion.md), [TMDB verification](../evidence/discovery/air-501-tmdb-verification-2026-11-18.md)  
**Supersedes:** None. It qualifies [ADR 0169](0169-writer-only-catalog-cleanup-classification.md) rule 3: a card the synopsis words do not reach can still be reached when it is on the owner-reviewed list.  
**Superseded by:** None

## Context

ADR 0169 keeps the writer away from a card whose stored synopsis is empty, a placeholder, or names neither a performance nor a documentary. Six admitted cards stayed out of reach: three concert films with an empty Russian overview and three non-fiction films with no such word. The owner approved a bounded list for them, and the six were read against the TMDB card ([evidence](../evidence/discovery/air-501-tmdb-verification-2026-11-18.md)): three recordings of a real concert and three documentaries.

## Decision

1. `OWNER_REVIEWED_POLICY_EXCLUSIONS` in `src/domain/resolution-acceptance.js` maps a TMDB id to a kind (`concert` or `documentary`) and the reviewed title, year and runtime. It holds exactly the six ids: `450202`, `1126350`, `1603159` (`concert`) and `1623086`, `569928`, `1603299` (`documentary`).
2. `catalogCleanupPolicy` returns the listed kind only when the stored card has no feature genre (Music alone, TV Movie alone, or no genre), and its normalized title, year and runtime equal the reviewed ones exactly. A different id, title, year or runtime, or any feature genre, leaves the earlier result.
3. The list is read only by `catalogPolicyKind`, that is by the writer's preview and execute. `admissionPolicy`, the detail gate, `policyExcludedPresentedFilm` and the programme overlay do not read it.
4. Being on the list is eligibility, not an exclusion. Each film still needs a preview, an owner `GO` and an Access session per ADR 0153.
5. A film is added to or removed from the list only by a reviewed change to that constant, with a dated evidence record.

Not decided: any other film; a listed film's removal from the catalog (that is the writer's execute under a GO).

## Alternatives considered

- **More words in the synopsis rule.** Rejected: the three non-fiction synopses carry no reliable word, and a broader rule would reach fiction.
- **A body field carrying the evidence on the POST.** Rejected for now: it widens the owner-only write contract; a reviewed constant keeps the evidence in the repository.
- **A manual D1 `UPDATE`.** Rejected in ADR 0153.

## Consequences

A short constant that must be maintained by hand; its guard on title, year and runtime keeps it from reaching a different film that reuses an id after a catalog change.

## Recovery and migration boundary

Code rollback restores ADR 0169 eligibility and does not undo a film already excluded. This ADR authorizes no operation.
