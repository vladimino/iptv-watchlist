# Film availability lifecycle

Contract of [ADR 0114](../../adr/0114-film-availability-lifecycle.md) (Accepted; the owner decisions behind it are recorded in the ADR). One pure function, `filmAvailability(shows, now, {runtimeMinutes})` in `src/domain/film-availability.js`, says what a **film** offers at an instant. The same source runs in the Worker (bundle name `FilmAvailability`) and in the browser (`/film-availability.js`, loaded before `app.js`). It reads only the shows it is given: no storage, network, clock or time zone, and it changes nothing.

IPTV is used to choose a film from the archive (catch-up), not to watch linear television.

## States

| State | Word | Condition |
| --- | --- | --- |
| `available` | «Доступно» | Some show has **ended** and is still inside the 72-hour catch-up (`end <= now` and `start + 72 h > now`) |
| `soon` | «Скоро» | No such show, and a show is **on air now** (`start <= now < end`) or **starts in the next 24 hours** (`now < start < now + 24 h`) |
| `unavailable` | «Недоступно» | Neither |

- **Archive wins.** If a ready recording exists the state is `available`, whatever is on air or ahead. A repeat or a show on air is only additional information (`nextStart`, `onAir`). `available` and `soon` never hold together.
- **A show on air is not an archive.** The film turns `available` at the **effective end** of the show, with no further delay. For `soon`, `appearsAt` is the earliest effective **end** among the candidates (the show on air, and shows starting inside the next 24 hours), never a start. It is a **schedule-based calculation** (the EPG end, or start + film runtime), not verified availability of a recording at the provider: no provider probe, no buffer and no advertising heuristic are used, and a client must not present it as a guarantee.
- **Elapsed time, not calendar days.** `+24 h` and `72 h` are millisecond arithmetic, so a 23-hour or 25-hour day (DST) and a call at 23:50 Madrid behave like any other instant. A show exactly 24 hours ahead is outside; one millisecond inside is `soon`.
- **The catch-up is 72 elapsed hours counted from the START of a show** (an owner decision, see the ADR). At exactly `start + 72 h` the recording is gone; the end of the window of the latest ready show is `archiveUntil`.
- **Only the given shows count.** The 168-hour retention of stored shows is storage, not a product horizon: a show later than 24 hours ahead is not read as `soon`, and holding more shows than the product windows never changes the answer.

## The effective end of a show

The end that every rule above uses is the **effective end**:

1. the EPG `end` when it is a time after the `start`;
2. otherwise `start + runtime × 60 000 ms` when the film has a finite positive `runtime` in minutes (`options.runtimeMinutes` of the helper; the catalog consumers pass `film.runtime`). The owner accepts the minor divergence between the film runtime and the broadcast duration; there is no buffer, no advertising heuristic and no provider probe;
3. otherwise the end is **unknown and never invented**.

| Show | Effect |
| --- | --- |
| started, effective end unknown | `unknown`: **ignored**, neither a ready recording nor a promised one; it cannot make a film `available` |
| future (inside 24 h), effective end unknown | the film is `soon`; `appearsAt` is the earliest known end among the other candidates or `null`; `appearsAtKnown` is `false`, so no exact hour is promised |
| future (inside 24 h), effective end known | `soon`, `appearsAt` = that end, `appearsAtKnown: true`; `appearsAtEstimated` is `true` when the earliest end was derived from the runtime and `false` when the EPG gave it |

A show without a usable `start` is ignored. A `now` that is not a finite number gives `unavailable`. The end instant itself already belongs to the archive (`end > now` is on air, `end <= now` is ready).

## Result

| Field | Meaning |
| --- | --- |
| `state`, `label` | `available` / `soon` / `unavailable` and its word |
| `appearsAt` | `soon` only: the earliest known **effective** end among the candidates (scheduled or estimated), milliseconds; `null` otherwise or when no end is known. Not a promise that the provider's recording is ready then |
| `appearsAtKnown` | `soon` only: `true` when every candidate has an effective end; `false` means do not promise an hour; `null` otherwise |
| `appearsAtEstimated` | `soon` with a known `appearsAt` only: `true` when that earliest end came from the film runtime, `false` when the EPG gave it; `null` otherwise |
| `archiveUntil` | `available` only: the latest start of a ready show + 72 h, milliseconds |
| `archiveShow` | `available` only: `{start, end}` of that show (helper only; not in the API field) |
| `onAir` | A show is on air now. It does not make the film available |
| `nextStart` | The first start later than `now` among the given shows (helper only; the API keeps its own `nextStart`) |

`showPhase(show, now, {runtimeMinutes})` gives the phase of one show: `future` (not started), `on_air` (started, before the effective end), `archive` (ended, still inside the start-based 72 hours), `expired` (ended, past the catch-up), `unknown` (started and no valid end can be determined) or `invalid` (no usable start). A show that has not started is `future` whether or not its end is known.

## Relation to the catalog fields

`GET /api/catalog/available` and `GET /api/catalog/film/<id>` take **all** their availability fields from this helper ([catalog API](../api/catalog.md)), so they cannot contradict each other:

| Field | Value |
| --- | --- |
| `availability` | `{state, label, appearsAt, appearsAtKnown, appearsAtEstimated, archiveUntil, onAir}` |
| `availableNow` | `availability.state === 'available'`: a ready recording exists. A show on air is **not** one |
| `shows[].status` | The five phases above: `future`, `on_air`, `archive`, `expired`, `unknown` |
| `shows[].effectiveEnd` | The effective end in milliseconds (the EPG `end`, else start + runtime), or `null`. `shows[].end` is the EPG value or `null` |
| `availableUntil` | `availability.archiveUntil` as an ISO time when the film is `available`, else `null` (nothing to watch now). A repeat never extends it |
| `nextStart` | The earliest returned show that has not started |

The list order of `GET /api/catalog/available` and the choice between two ids of one identity use an internal key (latest returned start + 72 h), not a response field. A client must read `availability` and the five statuses; the in-repo clients (`public/app.js`) do not read these catalog fields. The ADR records how these fields changed meaning and the compatibility impact. `predictionPriority`'s own `availableNow`/`availableUntil` (hot processing, `src/enrichment.js`), the stored watchlist `availableUntil` (`src/sources.js`, `src/domain/film-person.js`) and the browser's own availability functions are **not changed** by this lifecycle: hot-processing eligibility and the horizon stay as they are, and its internal priority signals are not user-visible archive readiness. The main period selector and the shortlist already read the helper ([programme filters](programme-filters.md)); the film page show layout moves to it in later UI work.

Tests: `tests/film-availability.mjs` (a table of transitions, 23:50 Madrid, both DST nights, exact end and 72-hour boundaries, the runtime fallback future → on air → archive → expired, unknown without end and runtime, windows, and a seeded sweep of invariants) and the catalog tests (`tests/catalog-available.mjs`, `tests/catalog-film.mjs`: both endpoints reuse the one helper, all five show statuses, `availableNow` consistency).
