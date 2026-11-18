# ADR 0168: A TMDB card with no genre is unclassified and is not verified on identity alone

**Status:** Accepted (2026-11-18; explicit Product Owner approval on [PR #748](https://github.com/vladimino/iptv-watchlist/pull/748#issuecomment-6975701431). This admission refinement authorizes no production operation or retroactive data write)  
**Original decision date:** 2026-11-18  
**Recorded at:** 2026-11-18  
**Approval source:** [Product Owner accepted ADR 0168 in the AIR-501 conversation, recorded in PR #748](https://github.com/vladimino/iptv-watchlist/pull/748#issuecomment-6975701431) on 2026-11-18, following [independent technical review](https://github.com/vladimino/iptv-watchlist/pull/748#pullrequestreview-5954609967)  
**Related work:** [AIR-501](https://trello.com/c/ShipZn0N) (including separately gated cleanup of newly identified old admissions), [ADR 0150](0150-documentary-and-concert-film-exclusion.md), [AIR-504](https://trello.com/c/jUaNE1Rs) (previously accepted cleanup cohort)  
**Supersedes:** None. It refines [ADR 0150](0150-documentary-and-concert-film-exclusion.md) rule 4 (`No Music, TV Movie, Documentary or feature genre`) and the Music-only bare-word hold; ADR 0150 stays as accepted history.  
**Superseded by:** None

## Context

On 17 November 2026 the natural Discovery run verified `Пикник: Традиционный весенний концерт` (TMDB 761960): TMDB returned `genres=[]`, so no Documentary or Music genre existed to trigger ADR 0150, and the title and overview used the bare word `концерт` rather than an exact performance phrase. Title, year and runtime matched, so the card became `detail_verified`. A read-only inventory found nine more current admissions of the same shape (real concerts and non-fiction cards with an empty genre list), 16 current admissions in all that carry an empty `genres` list out of 10 367 current movie admissions.

## Decision

After title, year and runtime succeed, `admissionPolicy` additionally treats these cards as not verifiable on identity alone:

1. **Unclassified.** A TMDB card whose genre list is present and empty (no id and no name), and that is not already `concert_recording` by the independent title-and-overview rule, returns `needs_verification` with reason `genre_evidence_missing`. No `detail_verified`, Film, show binding, or prediction queue entry is created. An owner confirmation of the identity may admit it, because the missing genre is not a proven excluded type.
2. **Music-only, concert word in the overview.** A Music card with no feature genre whose overview contains `concert` or a word starting `концерт` is held as `concert_recording_ambiguous` (it was already held for such a word in the title). An owner confirmation may admit it. A bare `live` in an overview is still ordinary narrative and holds nothing.
3. A card with at least one feature genre is unchanged: fiction such as `Концерт` (2009) and a musical biography still verify. The pure gate leaves a movie object with no genre list at all unchanged, but the Worker's `tmdbDetailFromMovie` always builds `genres: []`, so on the resolver path a TMDB payload that omits genres is held exactly like an empty list (fail closed, tested).

Not decided by this ADR: the per-film disposition or production write set for previously verified Films (the owner retained remediation within AIR-501, with a separate, explicit approval gate for execution; see AIR-504 for the existing exclusion contract); a Music-only card with no concert word anywhere; any external catalog or LLM classifier.

## Alternatives considered

Not documented beyond the RCA. A blanket ban on the word `концерт` in a title was rejected in the RCA because it removes fiction.

## Consequences

Roughly 0.15% of current movie admissions have an empty genre list, so the held volume is small; each held card waits for the existing owner review. The catalog policy cleanup (`catalog_policy_exclude`) reads the same function but only acts on `documentary`, `concert` and `ambiguous`; the new `unclassified` value is deliberately not acted on there. AIR-501 now includes a separately gated read-only inventory and remediation of confirmed past policy violations, but an empty genre list alone does not authorize exclusion.

## Recovery and migration boundary

Code rollback restores the ADR 0150 gate and does not undo any decision already written. This ADR acceptance does not authorize existing-Film cleanup, manual Discovery/EPG/TMDB/prediction execution, Scheduled Tasks, D1/R2 writes or migrations; an exact write set and separate Product Owner GO are required for production remediation.
