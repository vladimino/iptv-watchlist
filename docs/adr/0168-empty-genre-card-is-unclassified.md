# ADR 0168: A TMDB card with no genre is unclassified and is not verified on identity alone

**Status:** Proposed (2026-11-18; owner acceptance is requested on the pull request. This records an admission refinement, not permission to clean already verified Films or to run Discovery, EPG, TMDB, predictions, Tasks, or a storage write)  
**Original decision date:** 2026-11-18  
**Recorded at:** 2026-11-18  
**Approval source:** not yet documented; the owner asked to continue [AIR-501](https://trello.com/c/ShipZn0N) from its 18 November RCA comment  
**Related work:** [AIR-501](https://trello.com/c/ShipZn0N), [ADR 0150](0150-documentary-and-concert-film-exclusion.md), [AIR-498](https://trello.com/c/3dPOigK9)  
**Supersedes:** None. It refines [ADR 0150](0150-documentary-and-concert-film-exclusion.md) rule 4 (`No Music, TV Movie, Documentary or feature genre`) and the Music-only bare-word hold; ADR 0150 stays as accepted history.  
**Superseded by:** None

## Context

On 17 November 2026 the natural Discovery run verified `Пикник: Традиционный весенний концерт` (TMDB 761960): TMDB returned `genres=[]`, so no Documentary or Music genre existed to trigger ADR 0150, and the title and overview used the bare word `концерт` rather than an exact performance phrase. Title, year and runtime matched, so the card became `detail_verified`. A read-only inventory found nine more current admissions of the same shape (real concerts and non-fiction cards with an empty genre list), 16 current admissions in all that carry an empty `genres` list out of 10 367 current movie admissions.

## Decision

After title, year and runtime succeed, `admissionPolicy` additionally treats these cards as not verifiable on identity alone:

1. **Unclassified.** A TMDB card whose genre list is present and empty (no id and no name), and that is not already `concert_recording` by the independent title-and-overview rule, returns `needs_verification` with reason `genre_evidence_missing`. No `detail_verified`, Film, show binding, or prediction queue entry is created. An owner confirmation of the identity may admit it, because the missing genre is not a proven excluded type.
2. **Music-only, concert word in the overview.** A Music card with no feature genre whose overview contains `concert` or a word starting `концерт` is held as `concert_recording_ambiguous` (it was already held for such a word in the title). An owner confirmation may admit it. A bare `live` in an overview is still ordinary narrative and holds nothing.
3. A card with at least one feature genre is unchanged: fiction such as `Концерт` (2009) and a musical biography still verify. A card whose genre list is absent from the payload (not the same as empty) is unchanged.

Not decided: the disposition of Films already verified (see AIR-498 and its cleanup contract); a Music-only card with no concert word anywhere; any external catalog or LLM classifier.

## Alternatives considered

Not documented beyond the RCA. A blanket ban on the word `концерт` in a title was rejected in the RCA because it removes fiction.

## Consequences

Roughly 0.15% of current movie admissions have an empty genre list, so the held volume is small; each held card waits for the existing owner review. The catalog policy cleanup (`catalog_policy_exclude`) reads the same function but only acts on `documentary`, `concert` and `ambiguous`; the new `unclassified` value is deliberately not acted on there, so cleanup of existing Films needs its own approved classification.

## Recovery and migration boundary

Code rollback restores the ADR 0150 gate and does not undo any decision already written. This ADR authorizes no operation.
