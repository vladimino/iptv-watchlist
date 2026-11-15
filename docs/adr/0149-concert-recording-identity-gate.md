# ADR 0149: A concert telecast is not a Film without independent EPG broadcast evidence

**Status:** Proposed  
**Original decision date:** 2026-11-15  
**Recorded at:** 2026-11-15  
**Approval source:** [AIR-496](https://trello.com/c/4NxERbZW) (bug scope); independent review of PR #664 HEAD `0f3a2e2e` required a narrower predicate. Owner acceptance of this revised boundary is still required.  
**Related work:** [AIR-94](https://trello.com/c/bWYwLgqo) title screen, [AIR-480](https://trello.com/c/ZS0Xdrlq) / [ADR 0142](0142-epg-owned-generation-addressed-discovery-slots.md)  
**Supersedes:** None. Qualifies [ADR 0010](0010-scored-detail-verification.md) by adding one detail-gate refusal. Does not change the title screen of [non-film screening](../reference/domain/nonfilm-screening.md).  
**Superseded by:** None

## Context

The scored identity gate treated an exact TMDB Movies title with compatible year and runtime as enough for `detail_verified`. TMDB lists concert recordings as movies, so an EPG concert telecast with the same title became a catalog Film. Title words `Live` / `Concert` must not screen candidates (AIR-94). Genre labels alone also fail: `TV Movie` is a made-for-television feature, and `Music` alone is a legitimate theatrical concert film.

The production examples of 15 November 2026 (`tmdb_1326142`, `tmdb_238858`) are in [AIR-496 evidence](../evidence/discovery/air-496-concert-broadcast-film-2026-11-15.md). Live XMLTV category and TMDB genre ids of those slots were not read.

## Decision

After title, year and runtime on the fetched TMDB movie card succeed, `acceptScoredIdentity` withholds `detail_verified` only when **all** of the following hold:

1. The observation carries XMLTV `<category>` values that name a concert or music broadcast (`концерт`, `concert`, `live`, `музыка`, `music`) and do **not** also name a film (`фильм`, `кино`, `телефильм`, `movie`, `film`, and the corresponding Ukrainian tokens). Category tokens are matched as an exact normalized whitelist after whitespace split; JavaScript `\\b` is not used, because it does not treat Cyrillic letters as word characters.
2. The TMDB card has Music, identified by genre id `10402` (preferred) or the known Music display names as a fallback when the id is absent.
3. The card has no Documentary (`99`) and no other feature genre besides Music and TV Movie (`10770`).

The stored outcome is `candidate_decision` / `no_confident_match` with reason `concert_recording`. No Film or prediction-queue member is written. TV Movie, with or without a concert category, is never concert evidence by itself. A Music-only TMDB card without a concert EPG category verifies (theatrical concert films). Owner confirmation of that observation still verifies. Title words are not a screen. Categories are stored on the candidate for this gate; they do not screen at EPG scan.

**False-negative policy:** a concert telecast whose XMLTV category is missing or is `фильм` may still verify as Film if TMDB Music matches. That is accepted so genuine concert films are not lost. Catching those slots needs the provider category or a later owner identity correction, not a genre-only veto.

Not decided: automatic un-verification of already stored Films; a TMDB TV search; treating `video: true` as sufficient evidence.

## Alternatives considered

- **Title-screen `Live` / `Concert`:** rejected in AIR-94.
- **Every Music-only or TV Movie-only TMDB card is non-film:** rejected by independent review of PR #664; TV Movie is not concert evidence; Music-only theatrical concert films must remain Films.
- **Require XMLTV category `фильм` before any concert title verifies:** rejected while missing category would stall real films.

## Consequences

New observations with a concert EPG category and a Music-only TMDB card stay unresolved through the ordinary attempt cap. Existing false verified rows stay until an owner-approved identity correction. Category-less Music matches may still admit.

## Recovery and migration boundary

Code rollback restores the previous gate and does not delete stored Films. Correcting the two already admitted identities needs a separate owner-approved `discovery_identity_correct` reject (ADR 0080). Rejecting an identity does not move the EPG generation (ADR 0142). This ADR authorizes no production write.

## Evidence

- **Original decision:** [AIR-496](https://trello.com/c/4NxERbZW)
- **Implementation:** this delivery
- **Dated verification:** [AIR-496 evidence](../evidence/discovery/air-496-concert-broadcast-film-2026-11-15.md)
- **Uncertainty:** live XMLTV category and TMDB genre ids of the two production titles were not read; synthetic fixtures supply those labels

## Follow-ups

Owner identity correction of the two stored Films, if still verified after deploy, as a separate card.
