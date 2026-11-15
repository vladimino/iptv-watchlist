# ADR 0149: TMDB concert recordings do not verify as Film without independent confirmation

**Status:** Proposed  
**Original decision date:** 2026-11-15  
**Recorded at:** 2026-11-15  
**Approval source:** [AIR-496](https://trello.com/c/4NxERbZW) (bug scope; owner ADR acceptance is still required)  
**Related work:** [AIR-94](https://trello.com/c/bWYwLgqo) title screen, [AIR-480](https://trello.com/c/ZS0Xdrlq) / [ADR 0142](0142-epg-owned-generation-addressed-discovery-slots.md)  
**Supersedes:** None. Qualifies [ADR 0010](0010-scored-detail-verification.md) by adding one detail-gate refusal. Does not change the title screen of [non-film screening](../reference/domain/nonfilm-screening.md).  
**Superseded by:** None

## Context

The scored identity gate treats an exact TMDB Movies title with compatible year and runtime as enough for `detail_verified`. TMDB lists concert and music-festival recordings as movies. An EPG concert telecast with the same title therefore becomes a catalog Film and enters the prediction queue, even when the slot is a broadcast, not a feature. [AIR-94](https://trello.com/c/bWYwLgqo) correctly leaves `Live` / `Concert` / `концерт` titles as candidates so theatrical concert films are not lost. Title screening is the wrong layer for this bug.

The production examples of 15 November 2026 (`tmdb_1326142`, `tmdb_238858`) are recorded in [AIR-496 evidence](../evidence/discovery/air-496-concert-broadcast-film-2026-11-15.md). The raw XMLTV feed was not in this session; the reconstructed chain is title → TMDB Movies search → accepted score → detail_verified.

## Decision

After title, year and runtime on the fetched TMDB movie card succeed, `acceptScoredIdentity` withholds `detail_verified` when every named genre on that card is Music or TV Movie (including the Russian and Ukrainian labels the Worker already stores) and at least one of those labels is present. The stored outcome is `candidate_decision` / `no_confident_match` with reason `concert_recording`. No Film, programme slot or prediction-queue member is written. A Documentary, Drama or any other feature genre on the same card still verifies (concert films such as *Stop Making Sense*). Owner confirmation of that observation still verifies. Words in the EPG title are not a screen. XMLTV `<category>` is stored on the discovery candidate for evidence; it does not by itself admit or exclude.

Not decided: automatic un-verification of already stored Films; a TMDB TV search; a global concert-genre ban.

## Alternatives considered

- **Title-screen `Live` / `Concert`:** rejected in AIR-94 because it drops real concert films.
- **Treat every Music-genre movie as non-film:** rejected; musicals and concert documentaries remain Films.
- **Require XMLTV category `фильм` before any concert title verifies:** rejected while provider category usage is unmeasured; missing category would stall real films.

## Consequences

New concert telecasts that only match a Music/TV Movie TMDB card stay unresolved through the ordinary attempt cap. Theatrical concert films that TMDB also tags Documentary (or another feature genre) continue to admit. Existing false verified rows stay until an owner-approved identity correction; this ADR authorizes no production write.

## Recovery and migration boundary

Code rollback restores the previous gate and does not delete stored Films or queue rows. Correcting the two already admitted identities needs a separate owner-approved `discovery_identity_correct` reject (ADR 0080) and is not this delivery. Rejecting an identity does not move the EPG generation (ADR 0142).

## Evidence

- **Original decision:** [AIR-496](https://trello.com/c/4NxERbZW)
- **Implementation:** this delivery
- **Dated verification:** [AIR-496 evidence](../evidence/discovery/air-496-concert-broadcast-film-2026-11-15.md) (offline fixtures; no production write)
- **Uncertainty:** live XMLTV category and TMDB `video` flags of the two production titles were not read in this session; genre labels on the Worker language (`ru-RU`) are the gate input

## Follow-ups

Owner identity correction of the two stored Films, if still verified after deploy, as a separate card.
