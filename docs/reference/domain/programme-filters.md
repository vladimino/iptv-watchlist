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

## Not in this contract

Poster hourglass and the film page show layout ([ADR 0114](../../adr/0114-film-availability-lifecycle.md) follow-ups), sorting by appearance time, any change of the discovery window, hot processing or retention.
