# Film availability lifecycle

Contract of [ADR 0114](../../adr/0114-film-availability-lifecycle.md) (Proposed; the product rules were approved by the owner on [AIR-433](https://trello.com/c/D3mlCSiC)). One pure function, `filmAvailability(shows, now)` in `src/domain/film-availability.js`, says what a **film** offers at an instant. The same source runs in the Worker (bundle name `FilmAvailability`) and in the browser (`/film-availability.js`, loaded before `app.js`). It reads only the shows it is given: no storage, network, clock or time zone, and it changes nothing.

IPTV is used to choose a film from the archive (catch-up), not to watch linear television.

## States

| State | Word | Condition |
| --- | --- | --- |
| `available` | «Доступно» | Some show has **ended** and is still inside the 72-hour catch-up (`end <= now` and `start + 72 h > now`) |
| `soon` | «Скоро» | No such show, and a show is **on air now** (`start <= now < end`) or **starts in the next 24 hours** (`now < start < now + 24 h`) |
| `unavailable` | «Недоступно» | Neither |

- **Archive wins.** If a ready recording exists the state is `available`, whatever is on air or ahead. A repeat or a show on air is only additional information (`nextStart`, `onAir`). `available` and `soon` never hold together.
- **A show on air is not an archive.** The film turns `available` at the **end** of the show. For `soon`, `appearsAt` is the earliest known **end** among the candidates (the show on air, and shows starting inside the next 24 hours), never a start.
- **Elapsed time, not calendar days.** `+24 h` and `72 h` are millisecond arithmetic, so a 23-hour or 25-hour day (DST) and a call at 23:50 Madrid behave like any other instant. A show exactly 24 hours ahead is outside; one millisecond inside is `soon`.
- **The catch-up is counted from the start of a show** (the existing `availableUntil` = last start + 72 h). At exactly `start + 72 h` the recording is gone.
- **Only the given shows count.** The 168-hour retention of stored shows is storage, not a product horizon: a show later than 24 hours ahead is not read as `soon`, and holding more shows than the product windows never changes the answer.

## Unknown end

An `end` that is missing, not a time, or not after the `start` is **unknown and never guessed**:

| Show | Effect |
| --- | --- |
| started, no usable end | **ignored**: neither a ready recording nor a promised one; it cannot make a film `available` |
| future (inside 24 h), no usable end | the film is `soon`; `appearsAt` is the earliest known end among the other candidates or `null`; `appearsAtKnown` is `false`, so no exact hour is promised |
| future (inside 24 h), end known | `soon`, `appearsAt` = that end, `appearsAtKnown: true` |

A show without a usable `start` is ignored. A `now` that is not a finite number gives `unavailable`.

## Result

| Field | Meaning |
| --- | --- |
| `state`, `label` | `available` / `soon` / `unavailable` and its word |
| `appearsAt` | `soon` only: the earliest known end among the candidates, milliseconds; `null` otherwise or when no end is known |
| `appearsAtKnown` | `soon` only: `true` when every candidate has a known end; `false` means do not promise an hour; `null` otherwise |
| `archiveUntil` | `available` only: the latest start of a ready show + 72 h, milliseconds |
| `archiveShow` | `available` only: `{start, end}` of that show (helper only; not in the API field) |
| `onAir` | A show is on air now. It does not make the film available |
| `nextStart` | The first start later than `now` among the given shows (helper only; the API keeps its own `nextStart`) |

`showPhase(show, now)` gives the phase of one show: `future`, `on_air`, `archive`, `expired` (ended and the window over), `unknown` (started without a usable end) or `invalid`.

## Relation to the catalog fields

`GET /api/catalog/available` and `GET /api/catalog/film/<id>` carry `films[].availability` / `film.availability` ([catalog API](../api/catalog.md)): `{state, label, appearsAt, appearsAtKnown, archiveUntil, onAir}`. Nothing else changed:

| Legacy field | Still means | Differs from the lifecycle |
| --- | --- | --- |
| `shows[].status` | `future` (not started), `on_air` (started, not ended), `archive` (the rest) | `archive` is also given to a show **without an end**; that is not a ready recording. A film with a show `on_air` is `soon`, not available |
| `availableNow` | Some returned show has started | A show on air counts; the lifecycle does not |
| `nextStart` | The earliest returned show that has not started | Same as the helper's `nextStart` |
| `availableUntil` | Latest start + 72 h | Same as `archiveUntil` when the film is `available` |

Consumers that decide "can this be watched now" use `availability`. `public/app.js` (shortlist, Finds, film page) and `predictionPriority` still compute their own values until AIR-434 to AIR-436 (children of [AIR-432](https://trello.com/c/r1uaF4c4)) move them; see the ADR.

Tests: `tests/film-availability.mjs` (a table of transitions, 23:50 Madrid, both DST nights, boundaries, missing and invalid `end`, windows, and a seeded sweep of invariants) and the catalog tests.
