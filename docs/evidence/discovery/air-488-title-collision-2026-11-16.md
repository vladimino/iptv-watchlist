# AIR-488 known-film title collision — offline fixtures

16 November 2026. Code and fixture scans only. No production EPG, Discovery, TMDB, D1 or R2 read or write. The reported XMLTV slot for «Кровь за кровь» was not in the repository, so this file does not measure how many published showings the new rule would withhold.

## What the fixtures show

`tests/epg-title-collision.mjs` runs `scanEPG` on a two-channel XML string:

| Fixture | Result |
| --- | --- |
| Yearless «Кровь за кровь», 108 minutes, Four Brothers (2005, 109) and catalog Transfusion (2023, 106) | No film showing. One discovery observation, `confirmedTmdbId` null, diagnostic `identity_collision` |
| Title year 2005, 108 minutes, both films | Four Brothers attached, `basis` `title_year` |
| Title year 2023, both films | Observation confirms `842544`, watchlist film not attached |
| Title year 2005, 180 minutes, Four Brothers only | No film showing, `contradictory_runtime` |
| Title year 1999, both films | No confirmation, `insufficient_year_or_duration` |
| Yearless, Four Brothers only | Showing attached |
| Yearless, second identity with no runtime | `identity_collision` |
| Yearless, one film with no runtime | `insufficient_year_or_duration` |
| Same normalized alias via punctuation | Collision |
| Different normalized title | No collision |
| Same year on two identities | `identity_collision` |
| Second identity at 220 minutes | Near runtime still attaches |
| Two channels, same yearless title | One observation, two shows, no film showing |

`stats.identityCollision` is a count of hot-window slots. It does not store titles.

A yearless 155-minute slot that uniquely confirms the catalog film (155) and a yearless 105-minute slot that collides with a 100-minute watchlist film share one observation. In either feed order `confirmedTmdbId` is null. `confirmedSlots` names only the 155-minute slot. `slotScanConfirmation` plus `slotEligibility` then grants `scan_confirmed` to that slot alone.

The owner accepted ADR 0150, including `max(45 minutes, 40%)` and `max(8 minutes, 12%)`, on 16 November 2026 (Europe/Madrid) in [PR #674](https://github.com/vladimino/iptv-watchlist/pull/674#issuecomment-6911666774). These fixtures still do not measure a live feed.

## Not measured

Production recall, the size of `identityCollision` on a live feed, and whether the owner's reported showing was this collision. Those need the next natural EPG publication and a read-only comparison. This change does not start that publication.
