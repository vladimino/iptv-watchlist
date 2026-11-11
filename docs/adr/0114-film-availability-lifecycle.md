# ADR 0114: Film availability is one computed lifecycle: available, soon, unavailable

**Status:** Accepted (11 Nov 2026: every product rule and design choice is the owner's own decision, see Approval source; recorded after the independent re-review of PR #509 and the GitHub-rendered check of the state diagram. It changes no data, flag, schedule or authority marker and authorizes no production operation)  
**Original decision date:** 2026-11-11 (owner's product rules); technical contract recorded the same day  
**Recorded at:** 2026-11-11  
**Approval source:** the owner's approved rules on [AIR-433](https://trello.com/c/D3mlCSiC) and the umbrella [AIR-432](https://trello.com/c/r1uaF4c4) (11 Nov 2026, Madrid), and the owner's final product decisions for AIR-433 posted on [PR #509](https://github.com/vladimino/iptv-watchlist/pull/509) on 11 Nov 2026 (Europe/Madrid): the 72 elapsed hours counted from show START, the effective end from the film runtime, availability at the effective end with no provider probe, and the explicit change of the existing API fields. Those decisions supersede the first draft's unknown-end fallback and its additive-only compatibility plan  
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
3. **The boundary is the EFFECTIVE END of a show.** A show on air is not an archive. For `soon` the film turns `available` at the **effective end** of the candidate show (for a future show too, not its start), with no further delay: `appearsAt` is the earliest known effective end among the candidates (`appearsAtEstimated` says whether it came from the runtime). It is a **schedule-based calculation, not verified availability of a recording at the provider** (owner decision, AIR-433): nothing here probes the provider, adds a buffer or applies an advertising heuristic, and the UI must not present it as a guarantee.
4. **The effective end (owner decision, AIR-433).** It is the EPG `end` when that is a time after the start; otherwise `start + film.runtime × 60 000 ms` when the film has a finite positive runtime in minutes (the helper takes `options.runtimeMinutes`; both catalog endpoints pass `film.runtime`; browser consumers pass the same field); otherwise it is **unknown and never invented**. The owner accepts the minor divergence between film runtime and broadcast duration. A show that has started with no effective end is `unknown`: **ignored** (neither a ready recording nor a promised one). A future show with no effective end still makes the film `soon`, with `appearsAt` taken from the candidates that do have one, or `null`, and `appearsAtKnown: false` so no exact hour is promised. This cannot create a false `available`.
5. **Windows are elapsed time.** The rolling 24 hours is `start < now + 24 h` and the catch-up is `start + 72 h > now`, in milliseconds: a 23-hour or 25-hour day (DST) and a call at 23:50 Madrid are not special cases and the helper has no time zone. It reads only the shows it is given: the 168-hour retention is storage, not a product horizon, and a show beyond 24 hours ahead is not read as `soon`.
6. **The catch-up is 72 elapsed hours counted from the START of a show** (owner decision, AIR-433: the earlier open reading is closed). `archiveUntil` is the latest ready start + 72 h. Counting from the end would lengthen each recording by its duration and is not adopted.
7. **One pure module, two consumers.** `src/domain/film-availability.js` (`filmAvailability(shows, now)`, `showPhase`) has no imports, storage, network, clock or time zone. `build.mjs` embeds it in the Worker bundle (`FilmAvailability`) and serves the same source to the browser as `/film-availability.js`, loaded before `app.js`.
8. **The existing API fields change meaning now (owner decision, AIR-433).** The owner chose not to keep two contradictory semantics. Both catalog endpoints (`GET /api/catalog/available`, `GET /api/catalog/film/<id>`) take every availability field from the one helper: `availability` (new object), `availableNow` = `availability.state === 'available'`, `availableUntil` = `archiveUntil` as an ISO time when `available` and `null` otherwise, and `shows[].status` in the five phases `future`, `on_air`, `archive`, `expired`, `unknown` (the spelling of the first three is unchanged; `shows[].effectiveEnd` is added, `end` stays the EPG value). `nextStart` is unchanged. This is a **breaking semantic change** for API consumers, explicitly authorized; the in-repo clients do not read these catalog fields, and the compatibility impact is documented in the [reference](../reference/domain/film-availability.md) and the [catalog API](../reference/api/catalog.md).
9. **Hot processing is unchanged.** Hot-processing eligibility and the 24-hour horizon, `predictionPriority`'s own `availableNow`/`availableUntil` (`src/enrichment.js`) and the stored watchlist `availableUntil` are not changed: they are internal priority signals, distinct from the user-visible archive readiness of this lifecycle. No discovery, queue, cron, model run or production flag changes.
10. **Not decided here (follow-ups).** The UI: the filters «Доступно / Скоро» and «Все показы / Архив / Скоро», replacing «Сегодня» and «Следующие сутки» by «Скоро», the hourglass mark, Finds ordering and the film page «Показы» block are AIR-434 to AIR-436. Migrating the browser's own functions and `predictionPriority` to this helper is done by those cards and by a hot-processing card, not here: this PR adds the contract and the Worker field and changes no screen.

## Alternatives considered

- **Keep per-consumer logic and align it case by case.** Rejected: it is how the four disagreements arose.
- **Store a precomputed state on the film.** Rejected: it depends on `now`, would need a writer and would be stale between publications. A pure function of the shows already in hand has no storage and no staleness.
- **Treat a started show as available** (the current behavior). Rejected by the owner's rule: a recording does not exist until the show ends.
- **Guess an end for a show without one by a buffer or an advertising heuristic.** Rejected by the owner; only the film runtime is used, and only when the EPG end is missing or invalid. With neither, the end stays unknown.
- **Count the 72 hours from the end of the show.** Not adopted (Decision 6); available if the owner prefers it, as a change of the single constant use in the helper and of `availableUntil`.
- **Keep the legacy fields as they were and add only `availability`** (the first draft). Superseded by the owner's decision of 2026-11-11: two contradictory semantics in one response is worse than one deliberate breaking change.

## Consequences

- One definition, one table of tests, used by the browser and the Worker. A later UI card changes a consumer, not the rules.
- The Worker response grows by one small object per film; no extra read or write.
- Until AIR-434 to AIR-436 land, the screens still use their own functions: the new field and the browser module are available but unused by the UI. The disagreement between `app.js` and the helper therefore remains visible in the product until those cards are delivered; this PR makes it measurable, not fixed.
- The API fields change meaning: `availableNow` is false for a film that is only on air, `availableUntil` is `null` unless a recording is ready, and a show with no determinable end is `unknown` instead of `archive`. Any external consumer must be checked; none exists in the repository.
- A show without an EPG end is dated by the film runtime. When the broadcast ran longer or shorter, the film turns available slightly early or late; the owner accepted this and no probe corrects it.

## Recovery and migration boundary

Code only: no data, flag, schedule, migration or authority marker. Reverting the PR removes the module, the asset and the additive field. No production operation is authorized or needed.

## Evidence

- **Original decision:** the owner's rules on [AIR-433](https://trello.com/c/D3mlCSiC) / [AIR-432](https://trello.com/c/r1uaF4c4), 2026-11-11.
- **Owner decisions:** [PR #509 comment of 11 Nov 2026](https://github.com/vladimino/iptv-watchlist/pull/509) (final product decisions for ADR 0114 / AIR-433), recorded on [AIR-433](https://trello.com/c/D3mlCSiC).
- **Implementation:** the AIR-433 pull request (`src/domain/film-availability.js`, `tests/film-availability.mjs`, the shared lifecycle in `src/worker.js`, asset in `build.mjs`).
- **Rendered diagram check (11 Nov 2026):** the `stateDiagram-v2` of the [EPG and availability page](../architecture/epg-and-availability.md) was loaded on GitHub in a headless browser at the pull request head. GitHub's own Mermaid frame drew a state diagram with the three states and six transitions (unavailable to soon, soon to available, soon to unavailable, available to unavailable, available to soon, unavailable to available), each with its label text and one arrowhead, no render error and no text outside the drawing; the arrow ends were matched against the node positions. No screenshot was saved.
- **Dated verification:** offline tests only: a table of transitions (future, on air, ended, archive, expired), archive plus repeat, the 24-hour edge, 23:50 Madrid, both DST nights, the 72-hour boundary, a single show, missing and invalid `end`, different published and retained windows, the runtime fallback (future, on air, archive, expired; exact end and 72-hour boundaries; unknown without end and runtime), both catalog endpoints, `availableNow` consistency, all five show statuses, and 3000 seeded random lists against the invariants.
- **Uncertainty:** `appearsAt` is a scheduled or runtime-estimated end, not an observed recording; the runtime estimate (Decision 4) and the start-based catch-up (Decision 6) are owner-accepted calculations, not provider facts; the provider's real recording delay after `end` is not known and is not promised.

## Follow-ups

AIR-434, AIR-435 and AIR-436 (children of the epic [AIR-432](https://trello.com/c/r1uaF4c4)) consume the contract; a separate card may align `predictionPriority`'s `availableNow` if the owner wants hot processing to follow the same lifecycle.
