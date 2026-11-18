# AIR-501: external TMDB verification of the six remaining candidates

**Captured:** 2026-11-18 13:55–14:10 UTC (14:55–15:10 Europe/Madrid). Public TMDB API `GET /3/movie/{id}` (`en-US` and `ru-RU`, with keywords, release dates, credits) through the session's proxy credential. Read-only; no Worker route, no D1, no R2, no write. Stored values are from the [inventory](air-501-empty-genre-inventory-2026-11-18.md).
**Used by:** [AIR-501](https://trello.com/c/ShipZn0N), [ADR 0170](../../adr/0170-owner-reviewed-policy-exclusion-list.md). **This is a verification, not a GO and not an exclusion.**

## Result

TMDB lists none of these six with the Documentary genre (`genres` is `Music` or empty), and the Russian overview that D1 stored is empty or a placeholder, which is why the writer's synopsis rule does not reach them. The English overview and the card itself settle what each is.

| film_id | TMDB card (id, date, minutes) | What the card says | Reading |
| --- | --- | --- | --- |
| `tmdb_450202` | Britney Spears: Apple Music Festival, 2016-09-27, 88 | Performance at the Apple Music Festival of her Las Vegas residency `Britney: Piece of Me` for the album `Glory` | recording of a real concert |
| `tmdb_1126350` | DJ BoBo - EVOLUT30N, 2023-01-13, 134 | The `EVOLUT30N` tour for his 30th stage anniversary | recording of a real concert |
| `tmdb_1603159` | TesseracT: RADAR, 2025-12-05, 90 | `RADAR is the concert film` of the Radar Festival 2024 in Manchester, performed to a sold-out crowd | recording of a real concert |
| `tmdb_1623086` | Арктика. Очищение, 2020-12-01, 55 | 18 men of different professions clear Vilkitsky Island in the Kara Sea of scrap metal by hand; real expedition, no cast | documentary |
| `tmdb_569928` | Большой белый танец, no date, 68 | `The tape is dedicated to the great white shark`; the viewer learns about the predator with each dive | documentary |
| `tmdb_1603299` | Северный морской путь, или Русская дорога в океане, no date, 64 | Describes who works on the Northern Sea Route, how nuclear icebreakers are built, ice forecasts, the route's role for Russia | documentary |

Year, minutes and genre in D1 match the TMDB card for all six, so no id drift. The reading is the executor's from the card text and is recorded for the owner's review; the owner approves each film by GO, not this table.

## Limits

- A reading from an overview is not a certification: the Russian overviews are empty for four of the six and the English ones are short.
- TMDB had no `Documentary` genre on the three non-fiction cards; the reading is by content.
