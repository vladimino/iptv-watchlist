# ADR 0114: Film availability is one computed lifecycle: available, soon, unavailable

**Status:** Proposed (the product rules were approved by the owner on 2026-11-11 on the cards below; acceptance of this ADR, and of the one reading choice marked in Decision 6, is pending)  
**Original decision date:** 2026-11-11 (owner's product rules); technical contract recorded the same day  
**Recorded at:** 2026-11-11  
**Approval source:** the owner's approved rules on [AIR-433](https://trello.com/c/D3mlCSiC) and the umbrella [AIR-432](https://trello.com/c/r1uaF4c4) (11 Nov 2026, Madrid)  
**Related work:** [AIR-433](https://trello.com/c/D3mlCSiC) (this foundation), AIR-434 to AIR-436 (lists, Finds, film page: the consumers), [EPG horizons](../reference/domain/epg-horizons.md), [ADR 0008](0008-atomic-epg-publication.md), [film availability reference](../reference/domain/film-availability.md)  
**Supersedes:** None. It does not change the 168-hour retention, the 24-hour hot processing or the 72-hour catch-up of [AIR-188](../reference/domain/epg-horizons.md).  
**Superseded by:** None

## Context

IPTV is used to choose a film from the **archive** (catch-up), not to watch linear television. Four places computed availability on their own and in part disagreed:

- `public/app.js` (`shortlistAvailability`, `availabilityTime`, `findsAiring`, `inArchive`/`inFuture`): treats a show that has **started** as available (`catchup = start <= now`), even when it is still on air, and prefers `current` over `catchup`; the shortlist's «сегодня» mode adds a calendar-day future show.
- `GET /api/catalog/available` and the film page (`src/worker.js`): `availableNow` is true when some show has **started**; the per-show `status` is `archive` for any show that is not future and not on air, **including a show with no `end`** (`Number(undefined) > now` is false).
- `predictionPriority` (`src/enrichment.js`): `availableNow` is "a start in `[now-72h, now+24h)` has passed", and "today" is a Madrid calendar day.
- The stored per-film `availableUntil` (`src/sources.js`, `src/domain/film-person.js`): last start plus 72 hours.

So a film on air now was "available", a recording that does not exist yet was offered as archive, a future repeat could change a film's place, and a missing `end` produced a false archive. The owner set the product rules on 11 Nov 2026: an archive recording always outranks live and future; live is not a ready archive until the show ends; "Скоро" is only a film with no ready archive that has a show in the rolling next 24 hours or one on air; archive and "Скоро" exclude each other; a future repeat never turns a film with a ready archive into "Скоро".

## Decision

1. **Three film-level states, computed, never stored.** `available`: some show has ended and is inside the 72-hour catch-up. `soon`: no such show, and a show is on air now or starts inside the rolling next 24 hours. `unavailable`: neither. User-facing words: «Доступно», «Скоро», «Недоступно». No new persisted field, no new read, no writer.
2. **Archive wins.** If a ready recording exists the state is `available` whatever else is on air or ahead; a repeat and a show on air are additional information (`nextStart`, `onAir`) and never change the state or the priority. `available` and `soon` never hold together.
3. **The boundary is the END of a show.** A show on air is not an archive. For `soon` the film turns `available` at the **end** of the candidate show (for a future show too, not its start): `appearsAt` is the earliest known end among the candidates.
4. **Unknown is unknown.** A missing, unparseable or not-after-start `end` is never guessed. A show that has started without a usable end is **ignored** (neither a ready recording nor a promised one). A future show without a usable end still makes the film `soon`, with `appearsAt` taken from the candidates that do have an end, or `null`, and `appearsAtKnown: false` so no exact hour is promised. This fallback cannot create a false `available`.
5. **Windows are elapsed time.** The rolling 24 hours is `start < now + 24 h` and the catch-up is `start + 72 h > now`, in milliseconds: a 23-hour or 25-hour day (DST) and a call at 23:50 Madrid are not special cases and the helper has no time zone. It reads only the shows it is given: the 168-hour retention is storage, not a product horizon, and a show beyond 24 hours ahead is not read as `soon`.
6. **The catch-up is counted from the start of a show, as today** (`availableUntil` = last start + 72 h, `archiveUntil` in the helper). This keeps every existing consumer and the stored contract; counting 72 hours from the **end** would lengthen each recording by its duration and is not adopted here. **Owner reading to confirm:** "в пределах 72 ч" is read as the existing start-based window.
7. **One pure module, two consumers.** `src/domain/film-availability.js` (`filmAvailability(shows, now)`, `showPhase`) has no imports, storage, network, clock or time zone. `build.mjs` embeds it in the Worker bundle (`FilmAvailability`) and serves the same source to the browser as `/film-availability.js`, loaded before `app.js`.
8. **The JSON API is extended, not changed.** The catalog entries (`GET /api/catalog/available`, `GET /api/catalog/film/<id>`) gain an additive `availability` object. `availableNow`, `nextStart`, `availableUntil` and `shows[].status` keep their values and meaning. `shows[].status` is documented as the legacy per-show field: its `on_air` is not the film's `soon` (a film on air is `soon`, a film with an archive is `available`), and its `archive` for a show without an end is not a ready recording. Consumers that decide "can this be watched" use `availability`. Removing or reinterpreting the legacy fields needs its own migration design.
9. **Not decided here (follow-ups).** The UI: the filters «Доступно / Скоро» and «Все показы / Архив / Скоро», replacing «Сегодня» and «Следующие сутки» by «Скоро», the hourglass mark, Finds ordering and the film page «Показы» block are AIR-434 to AIR-436. Migrating the browser's own functions and `predictionPriority` to this helper is done by those cards and by a hot-processing card, not here: this PR adds the contract and the Worker field and changes no screen.

## Alternatives considered

- **Keep per-consumer logic and align it case by case.** Rejected: it is how the four disagreements arose.
- **Store a precomputed state on the film.** Rejected: it depends on `now`, would need a writer and would be stale between publications. A pure function of the shows already in hand has no storage and no staleness.
- **Treat a started show as available** (the current behavior). Rejected by the owner's rule: a recording does not exist until the show ends.
- **Guess an end from the programme length for a show without one.** Rejected: it would promise an hour the feed never gave.
- **Count the 72 hours from the end of the show.** Not adopted (Decision 6); available if the owner prefers it, as a change of the single constant use in the helper and of `availableUntil`.
- **Change `shows[].status` and `availableNow` in place.** Not adopted: it breaks existing clients and tests without a migration; the additive field avoids that.

## Consequences

- One definition, one table of tests, used by the browser and the Worker. A later UI card changes a consumer, not the rules.
- The Worker response grows by one small object per film; no extra read or write.
- Until AIR-434 to AIR-436 land, the screens still use their own functions: the new field and the browser module are available but unused by the UI. The disagreement between `app.js` and the helper therefore remains visible in the product until those cards are delivered; this PR makes it measurable, not fixed.
- A film with only started shows that have no `end` is `unavailable` in the new field while the legacy fields still call it available/archive. That is the intended correction and is why consumers must move to `availability`.

## Recovery and migration boundary

Code only: no data, flag, schedule, migration or authority marker. Reverting the PR removes the module, the asset and the additive field. No production operation is authorized or needed.

## Evidence

- **Original decision:** the owner's rules on [AIR-433](https://trello.com/c/D3mlCSiC) / [AIR-432](https://trello.com/c/r1uaF4c4), 2026-11-11.
- **Implementation:** the AIR-433 pull request (`src/domain/film-availability.js`, `tests/film-availability.mjs`, additive field in `src/worker.js`, asset in `build.mjs`).
- **Dated verification:** offline tests only: a table of transitions (future, on air, ended, archive, expired), archive plus repeat, the 24-hour edge, 23:50 Madrid, both DST nights, the 72-hour boundary, a single show, missing and invalid `end`, different published and retained windows, and 3000 seeded random lists against the invariants.
- **Uncertainty:** the unknown-`end` policy (Decision 4) and the start-based catch-up (Decision 6) are conservative choices, not provider facts; the provider's real recording delay after `end` is not known and is not promised.

## Follow-ups

AIR-434, AIR-435 and AIR-436 (children of the epic [AIR-432](https://trello.com/c/r1uaF4c4)) consume the contract; a separate card may align `predictionPriority`'s `availableNow` if the owner wants hot processing to follow the same lifecycle.
