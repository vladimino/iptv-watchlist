# ADR 0169: The owner policy-exclusion writer reads concert and documentary words on a card with no feature genre

**Status:** Accepted (2026-11-18; explicit Product Owner acceptance of ADR 0169 following the [independent technical PASS](https://github.com/vladimino/iptv-watchlist/pull/750#pullrequestreview-5956582740), [recorded in PR #750](https://github.com/vladimino/iptv-watchlist/pull/750#issuecomment-6979013313). The approval covers the writer-only classifier and routine merge/deploy, not Film exclusion or other production operations)  
**Original decision date:** 2026-11-18  
**Recorded at:** 2026-11-18  
**Approval source:** [Product Owner's explicit approval in the AIR-501 project chat, recorded on PR #750](https://github.com/vladimino/iptv-watchlist/pull/750#issuecomment-6979013313) after the [technical PASS at HEAD `6884382`](https://github.com/vladimino/iptv-watchlist/pull/750#pullrequestreview-5956582740)  
**Related work:** [AIR-501](https://trello.com/c/ShipZn0N), [ADR 0153](0153-catalog-policy-exclusion.md), [ADR 0150](0150-documentary-and-concert-film-exclusion.md), [ADR 0168](0168-empty-genre-card-is-unclassified.md), [AIR-498](https://trello.com/c/3dPOigK9)  
**Supersedes:** None. It qualifies the eligibility sentence of [ADR 0153](0153-catalog-policy-exclusion.md) (rule 1): the writer no longer uses `admissionPolicy` alone.  
**Superseded by:** None

## Context

After ADR 0168, the 18 November inventory ([evidence](../evidence/discovery/air-501-empty-genre-inventory-2026-11-18.md)) found nine admitted cards that stored metadata shows to be a concert recording or a documentary, but that `admissionPolicy` classifies `unclassified` (no genre at all) or `null` (Music alone, no performance phrase). A preview of `catalog_policy_exclude@1` answered `not_policy_excluded` for all of them. `admissionPolicy` also feeds the detail gate and the programme overlay, and widening it there would withhold or hold cards without an owner decision per film.

## Decision

1. A second pure function `catalogCleanupPolicy(movie, observation)` is used **only** by `catalogPolicyKind`, that is by the writer's preview and execute. `admissionPolicy`, the detail gate, `policyExcludedPresentedFilm` and the programme overlay are unchanged.
2. It returns the `admissionPolicy` result when that is `documentary`, `concert` or `ambiguous`. A card with a feature genre is returned unchanged.
3. For a card with **no feature genre** (Music alone, TV Movie alone, or an empty genre list), the normalized **stored synopsis** is read. A word in the title or an alias alone is not evidence: `документальн` or `documentary` gives `documentary`; `концерт`, `koncert`, `concert`, `выступлен…`, `выступил…`, `performance`, `performed`, `filmed live`, `live at/in/from`, `турне`, `tour`, `festival`, `фестивал…` gives `concert`. No such word in the synopsis, an empty synopsis, or a placeholder such as `Описание отсутствует` gives the `admissionPolicy` result, so the writer still refuses it and the card stays in the external-verification tier.
4. Eligibility is not an exclusion. Each film still needs an owner `GO` and an Access session per ADR 0153, with the preview read first.

Measured on the 267 current admissions with an empty or Music genre list: the rule reaches six of the nine unreachable cards and none of the 12 ordinary feature films with no genre list or of the Music-only fiction in that set. It does not reach a card with an empty or placeholder synopsis (`Britney Spears: Apple Music Festival`, whose only word is `Festival` in the title, `DJ BoBo`, `TesseracT`), or a non-fiction card whose synopsis names neither a performance nor a documentary.

Not decided: how to retire a card the words do not reach (three non-fiction cards and three with an empty or placeholder synopsis on the 18 November list); any wording change to the detail gate.

## Alternatives considered

- **Widen `admissionPolicy`.** Rejected: it would change the detail gate and the programme overlay for every card, with no owner review per film.
- **A fixed owner-approved id list in the writer.** Kept open for the cards the words do not reach.
- **A manual D1 `UPDATE`.** Rejected in ADR 0153.

## Consequences

The writer reaches more cards, so a wrong match is possible: a Music-only or genre-less card whose synopsis uses `выступление` for a fictional performance would preview as `concert`. The per-film owner `GO` after reading the preview is the control.

## Recovery and migration boundary

Code rollback restores the ADR 0153 eligibility and does not undo a film already excluded. This ADR authorizes no operation.
