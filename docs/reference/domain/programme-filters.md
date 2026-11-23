# Programme period filter and shortlist

Contract of the main page filters that depend on film availability. They consume the single lifecycle of [ADR 0114](../../adr/0114-film-availability-lifecycle.md) ([film availability](film-availability.md)); this page does not redefine it. Implementation: `public/app.js` (`filmLifecycle`, `periodShows`, `shortlistAvailability`, `buildShortlist`), `public/index.html`. Tests: `tests/period-filter.mjs`, `tests/shortlist.mjs`.

## Period selector «Все показы / Архив / Скоро»

The selector is a **film-level** filter, not a filter on single shows:

| Value (`period=`) | Label | Films it keeps |
| --- | --- | --- |
| `all` (default, not written to the URL) | Все показы | Films that are `available` or `soon`: the union of the two sets below |
| `archive` | Архив | Film state `available`: a show has ended and is inside the 72-hour catch-up (counted from the show start) |
| `soon` | Скоро | Film state `soon`: no ready archive, and a show is on air or starts inside the rolling next 24 hours |

- **The sets never overlap.** A film with a ready archive is `archive` however many repeats follow; a repeat never moves it to «Скоро». A film with only a show on air is «Скоро» until the show's effective end (the EPG end, else start plus the film runtime), then `archive`, with no EPG reload: the state is computed from the clock, and the quiet refresh tick rebuilds the grid and the shortlist when a film crosses the boundary.
- **Counters and cards are the same sets.** The three counters, the visible cards, the result summary and the shortlist read `periodShows(film, period)`, which reads only the lifecycle (`filmLifecycle`, built on `filmAvail` and the shared `FilmAvailability` module). A film in `all` shows its ready recordings in the «АРХИВ» group and its on-air or upcoming shows in «ДАЛЬШЕ» (for an archive film that group is information about a repeat).
- **Windows are elapsed time.** The rolling 24 hours and the 72-hour catch-up are millisecond arithmetic: 23:50 Madrid, a 23-hour or 25-hour DST day and midnight are not special cases. The stored 168-hour retention and the 24-hour hot processing are unchanged and are not product horizons.
- **Unscheduled and black zone.** `view=watchlist` («включить без показа») lists a film with no show in the window under «Все показы» only, and only when it is switched on; such a film is never listed under «Архив» or «Скоро», and never when a channel is selected (a channel needs a show). The black zone keeps listing the watchlist under every tab with the «Архив» and «Скоро» counters at 0. The lifecycle reads no shows in the black zone.
- **Counters do not depend on the selected tab.** The three counters are fixed by the other filters (search, genres, channels, prediction thresholds and so on) and never by which tab is selected: choosing «Скоро» or «Архив» changes the visible list, not a counter. For films with at least one show in the window, «Все показы» equals «Архив» plus «Скоро». The facet options (genres, mechanics, moods, channels) are counted for the selected tab, as the list they will produce.

## Channel filter

With channels selected (OR across channels) a film's state is the lifecycle over **the shows on the selected channels only**, as in the Finds: a recording on another channel is not an archive for a viewer who chose this channel, and a repeat on the chosen channel is the only show there («Скоро» when it is on air or starts within the next 24 hours, with no archive on a selected channel). A film passes the channel filter when it has a show on a selected channel in the window; the tab then chooses its archive or soon part, so the channel constraint is the same for all three tabs. The cards, the show groups, the archive deadline («последний шанс», «Сначала исчезающие») and the shortlist read the same channel-scoped state and list only the shows of the selected channels. A channel is offered as an option under a tab when its own shows put the film into that tab's state.
- **«Последний шанс»** and the sort «Сначала исчезающие» read the archive deadline only (`archiveDeadline`: the latest ready start + 72 h). A «Скоро» film has no deadline: it is never a last chance and sorts after films that have one. There is no sort «Сначала появляющиеся».

## Shortlist «Что посмотреть» («Доступно / Скоро»)

Two **disjoint sets of films**, selected by `shortlist=`:

| Value | Label | Films |
| --- | --- | --- |
| `available` (default, not written) | Доступно | Film state `available`; text `Архив · <channel> · до <archive end>` |
| `soon` | Скоро | Film state `soon`; text `Сейчас в эфире · <channel> · …` or `<start> · <channel> · …`, ending with the shared `soonTail` wording («архив появится после …», «архив ожидается около … (по длительности фильма)» or «время появления архива неизвестно») |

- No archive film fills «Скоро», however few candidates there are; an empty group shows an honest empty state that names the other group.
- The five roles (best, last chance, continue, short, rewatch) apply in both groups with one exception: **«последний шанс» exists only for «Доступно»** (it means the archive expires within eight hours), and is never offered for «Скоро».
- The shortlist takes its candidates from the same filtered list as the grid, so the selected period constrains it: with period «Архив» the «Скоро» group is empty, and with «Скоро» the «Доступно» group is empty. It shows no poster and therefore no hourglass; the shared `soonBadge` is only for poster surfaces.

## URL, presets and assistant tool

- `period=soon` and `shortlist=soon` are the written values; defaults (`all`, `available`) are not written.
- **Old values are normalised, never rejected.** `period=future` (the former «Следующие сутки») reads as `soon`; `shortlist=today` (the former «Сегодня») reads as `soon`; `shortlist=now` and any unknown shortlist value read as `available`; an unknown `period` reads as `all`. Saved presets store the query string, so an old preset applies through the same reader, and `presetKey` is canonical: an old preset and the new spelling of the same state are the same preset (the «current» mark follows).
- The assistant tool `filter_watchlist_programme` accepts `period` `all`, `archive`, `soon` and `future` (an alias of `soon`); the state stores `soon`.
- Finds follow the same period names: `period=soon` keeps finds whose state is `soon`.

## «Моя оценка» (own rating threshold)

The sidebar field under «Шанс 4.0+» (AIR-585) filters by the stored Letterboxd rating, not by the forecast: **Любая** (default, no constraint; films without a rating stay), **3.5+**, **4.0+**, **4.5+** (`rating=3.5|4|4.5`; «Любая» is not written; any other value reads as «Любая»). A threshold keeps only a film whose rating, read through the same identity resolution as «Пересмотр» (`filmEnrichmentItem`) and validated like the «МОЯ ОЦЕНКА» badge (`ratingValue`: 0.5 to 5 in half steps), is at or above it; a missing, invalid or merely «просмотрен» film does not pass. It combines with every other filter by AND and switches or clears nothing; «Новые» with a threshold is the ordinary empty state. Thresholds are disabled until the ratings load, and a restored threshold shows «Загружаем оценки и прогнозы…» instead of «Таких фильмов не найдено». Finds hold no rated film, so a threshold leaves that section empty. Presets keep `rating` (the server normalizer accepts the same three values) and the browser tool `filter_watchlist_programme` takes `minActualRating` (`null`, 3.5, 4, 4.5).

## Saved filter presets: API and storage contract

A preset is a named, normalized main-page filter query. One document `{schemaVersion:1, presets:[{id,name,schemaVersion:1,query,createdAt,updatedAt}]}` holds at most 30 presets in creation order; `id` is a UUID, `name` is 1 to 80 characters without control characters, `query` is the normalized URL query (at most 4000 characters; unknown keys and values are dropped on write and on read). Implementation: `src/filter-presets.js` (route, validation, normalization), `src/filter-presets-d1.js` (D1 storage). Tests: `tests/filter-presets.mjs` (R2 path), `tests/filter-presets-d1.mjs` (D1 path, import, activation), `tests/filter-preset-ui.mjs`.

| Method and path | Result |
| --- | --- |
| `GET /api/ui/filter-presets` | `200` with the document and a quoted `ETag`. Never writes. |
| `POST /api/ui/filter-presets` | `201` with the new document. |
| `PATCH /api/ui/filter-presets/:id` | `200`; `name`, `query` or both; nothing to update is `400`. |
| `DELETE /api/ui/filter-presets/:id` | `200` with the remaining document. |

There is no `PUT`. Every write needs `If-Match`: absent is `428`, a token that is not the current one is `412` with the current document and `ETag` in the answer (the client refreshes and retries), a cross-origin write is `403`, a malformed id is `404`, invalid input is `400` and writes nothing. An unreadable stored document is `500` on reads and writes alike.

**Revision token.** The empty state of a store that holds no document is `"none"`. In R2 the token is the object's ETag. In D1 it is `"d1:<generation>"` (`"none"` only at generation 0), and every committed write adds one. The two spellings are never interchangeable: after the switch a stale R2 token is `412`, so a client re-reads and never updates through an old token. Two writers that start from one token cannot both commit; the second gets `412`.

**Authority.** One marker row (`filter_preset_authority`, schema v28) decides where the document lives, per request:

| Marker state | Behavior |
| --- | --- |
| The database proves it is pre-migration (tables absent and `schema_contract` below version 28) | R2 object `ui/filter-presets.json` serves, exactly as before schema v28. |
| `mode r2`, writes `open` | R2 serves; no D1 preset row is read or written. |
| `mode r2`, writes `held` | R2 serves reads; every write is `503` (the import fence). |
| `mode d1`, writes `open` | D1 rows serve; R2 is never read or written for presets. |
| `mode d1`, writes `held` | D1 rows serve reads; every write is `503`. |
| Binding missing, database without `schema_contract`, version 28 without the tables, tables present but marker unreadable or unknown, or a storage error | `503`. The route never falls back to R2. Only the explicit local stand-in `FILTER_PRESETS_DB_OPTIONAL=standin` (tests, never production) runs without a database. |

A D1 read takes the marker, the rows and the marker again and retries once on disagreement; rows of another generation are never served. A request on the R2 branch re-reads the marker right before its R2 write and answers `503` when writes are held; a write admitted earlier is stopped by the operator's fence write on the R2 object: the stored bytes plus one trailing newline, because R2 ETags are content-derived and identical bytes would not rotate the ETag (its conditional PUT then fails). A database binding that points at a different but valid database below version 28 is not detected by the marker; the runbook requires a binding identity check before every cutover. A write whose reply is lost is reported as success only when the stored rows are exactly its own document. A D1 write is one batch: a compare-and-swap of the marker generation, a fence statement that aborts the whole batch when that update changed nothing, then the rows are replaced. An empty D1 table is never evidence that R2 holds no presets: the switch happens only through the documented import with a parity proof ([runbook](../../runbooks/filter-presets-cutover.md)). Code rollback does not move data: presets written in D1 are not in R2.

## Not in this contract

Poster hourglass and the film page show layout ([ADR 0114](../../adr/0114-film-availability-lifecycle.md) follow-ups), sorting by appearance time, any change of the discovery window, hot processing or retention.
