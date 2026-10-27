# Owner «Смотрел» mark in Finds: production rollout

**Captured:** 2026-10-27, 23:29–23:37 UTC; production Worker `iptv`, code at `main` `0ae2308` (the implementation, deployed with Test and build and Deploy to Cloudflare green) or later  
**Scope:** each step was approved separately by the owner:
1. The owner read the Worker Variables.
2. The owner set `FINDS_WATCHED_MARK=on`.
3. One read-only `GET /api/catalog/available` through the owner's Access session in the built-in browser.
4. The owner's own marks from the Finds page.
5. One further read-only `GET /api/catalog/available`.

The agent wrote nothing, made no mark and sent no Letterboxd or TMDB request.

**Verdict:** the switch and the owner route work as specified. The owner marked the watched films the title rule could not reach, until the top of Finds showed only unwatched films, and saw no unexpected hide. Persistence across a new EPG generation is not yet measured.

**Used by:** [AIR-215](https://trello.com/c/MC9Ku87Z); design: [ADR-0032](../../adr/0032-owner-watched-mark-by-tmdb-identity.md); contract: [catalog API](../../reference/api/catalog.md#owner-watched-mark).

Aggregates only. Titles of the marked films and the owner's watch history are not recorded here.

## Preconditions

| Check | Result |
| --- | --- |
| `LETTERBOXD_FACTS`, read by the owner in the Worker Variables on 2026-10-28 (local time) | `on`, kept since the [AIR-173](https://trello.com/c/w2bVRb72) baseline import, so the mark adds no new writer behaviour for the routine sync |
| `FINDS_WATCHED_MARK` before the change | absent (effective `off`) |

## Production reads

| Measure | After the switch, before marks (23:29 UTC) | After the owner's marks (23:37 UTC) |
| --- | --- | --- |
| Pinned generation | `b2699929…` | same |
| `watchedMarkEnabled` | `true` | `true` |
| `displayExclusion` | `applied`, 476 | `applied`, 476 |
| Eligible films | 1,154 | 1,138 |
| Strong Finds (≥ 4.0, P(4.0+) ≥ 0.70, confidence not low) | 49 | 32 |

The title-rule count did not change, so the marks did not touch the display-only exclusion. The drop in eligible and strong films combines the owner's marks with the availability window moving by eight minutes.

The one owner-reported false Find that no display rule covers (an alias match with a one-year difference, recorded in the [AIR-198 evidence](air-198-finds-exclusion-rollout-2026-10-27.md)) is absent after the marks, as is its sequel.

## Not yet measured

- Persistence after the next published EPG generation: one read-only GET is approved for after that generation.
- The number of marks: the owner marked several films; the agent did not read the fact records or the view index.

## Rollback

- **Switch off:** setting `FINDS_WATCHED_MARK` to anything other than `on` hides the button and refuses new marks. Marks already written stay valid owner facts and keep their films out of Finds.
- **One mark:** the owner revokes it from the notice right after marking. No bulk removal is defined.
