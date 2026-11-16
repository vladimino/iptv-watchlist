# ADR 0150: A shared EPG title is a known Film only when one trusted identity remains

**Status:** **Accepted** (2026-11-16; the Product Owner accepted this record, including the contradiction band `max(45 minutes, 40% of known runtime)`, the yearless near band `max(8 minutes, 12%)`, the ±1 title-year allowance, and the per-slot confirmation rule, at [PR #674](https://github.com/vladimino/iptv-watchlist/pull/674#issuecomment-6911666774) against HEAD `2332450bd7851fddc0a51858c55e03483cab6536`. Not permission to rerun EPG, Discovery or TMDB, or to correct stored identities.)  
**Original decision date:** 2026-11-16  
**Recorded at:** 2026-11-16  
**Approval source:** Owner comment on [PR #674](https://github.com/vladimino/iptv-watchlist/pull/674#issuecomment-6911666774), 16 November 2026 (Europe/Madrid)  
**Related work:** [AIR-480](https://trello.com/c/ZS0Xdrlq) / [ADR 0142](0142-epg-owned-generation-addressed-discovery-slots.md); [AIR-503](https://trello.com/c/t9fZCHLQ) remains a separate duration audit  
**Supersedes:** None. Replaces the `scanEPG` branch that accepted a watchlist film on year alone or, when the title had no year, on runtime alone.  
**Superseded by:** None

## Context

`scanEPG` indexed the watchlist plus catalog-only films by normalized alias. If the EPG title contained a year, every film within one year was valid. If it did not, every film whose runtime was within `max(8 minutes, 12%)` was valid. One remaining film was attached at once. `showMatchBasis` could mark that showing as a warning. It did not refuse it. Two films with one localized title and runtimes three minutes apart (Four Brothers, 2005, TMDB 8292, 109 minutes; Transfusion, 2023, TMDB 842544, 106 minutes) both fall inside that band, so a yearless slot attached whichever one was alone in the index. Tightening the band does not separate them. The scored resolver never reopened a film the scan had already attached. The production XMLTV row for the reported showing was not retained, so this record does not claim that row's cause.

## Decision

A slot becomes a watchlist Film only when the prebuilt alias index leaves one trusted identity. Identity is the TMDB id, or the film id when there is no TMDB id. Copies of the same id count once; a non-catalog row wins over `catalogOnly`.

1. **Year present.** Keep identities whose year is within one. Drop an identity whose runtime is known, at least 55 minutes, and further than `max(45 minutes, 40% of runtime)` from the slot. One identity left is the match, including when its runtime is missing or only in the middle band. Two identities left are `identity_collision`. A year match whose runtime is in that far band is `contradictory_runtime` and is not a match. No year match is `insufficient_year_or_duration`.
2. **Year absent.** An identity supports the slot only when its runtime is within `max(8 minutes, 12%)`. It is assigned only when it is the only identity inside the contradiction band above. Another identity in the near or middle band, or with no usable runtime, is `identity_collision`. A single indexed film with a near runtime still matches.
3. **Outcome.** A collision or a contradiction does not attach a showing and does not delete a film. Inside the hot window the slot is the existing discovery observation. The uncertain diagnostic carries the reason. `stats.identityCollision` counts those hot-window slots and stores no titles. A `catalogOnly` match confirms that TMDB id on **that slot** (`confirmedSlots`). The observation's `confirmedTmdbId` is set only when every retained slot confirms the same id, so one slot cannot make the cheap pass verify the whole observation as `known_epg_alias`. Assignment then reads `confirmedSlots`: `scan_confirmed` applies only to a slot whose own id equals the decision. An observation stored before this list still uses the observation id for every slot. Days 2–7 still retain only a unique non-catalog watchlist match; a collision there is omitted, not assigned. Slot ownership stays one owner per `(channel, start)` ([ADR 0142](0142-epg-owned-generation-addressed-discovery-slots.md)). There is no per-slot TMDB request and no new publisher.

The owner accepted the contradiction band with that trade-off. At 109 minutes, `max(45, 40%)` is 45 minutes, so a title year of 2005 still matches a 150-minute airing of a 109-minute film.

Films absent from the watchlist and from the catalog passed into the scan are not visible. The scan does not invent them.

## Alternatives considered

- **Keep the warning and still attach the nearer runtime.** Rejected: the reported failure was an attached showing, and three minutes does not identify the film.
- **Require a year on every known-film match.** Rejected: a title that only one indexed film uses, with a fitting runtime, would lose its showing.
- **Query TMDB, or scan the whole catalog pairwise, on every slot.** Rejected: the index is built once from the films the caller already holds.

## Consequences

A homonym that previously rode a close runtime becomes an ordinary discovery observation until a year or a later verified decision distinguishes it. Recall of yearless unique titles is unchanged. Recall of yearless titles shared with a catalog homonym goes down on purpose. No stored showing is rewritten by this change; the next natural EPG publication applies it. Rollback is a code revert and does not restore the previous generation.

## Verification

`tests/epg-title-collision.mjs` and the updated `tests/match-hint.mjs` scan fixture XML. No production feed was replayed: the repository has no current XMLTV fixture that contains this pair, and this change does not authorize a production read or a forced EPG run. `docs/evidence/discovery/air-488-title-collision-2026-11-16.md` records that limit.
