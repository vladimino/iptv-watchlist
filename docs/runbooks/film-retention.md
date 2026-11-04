# Film retention

A Film admitted by a Letterboxd watchlist boolean stays in the catalog after it leaves the current programme and watchlist. Membership, watched state and availability stay independent. The decision is [ADR 0084](../adr/0084-durable-watchlist-film-retention.md). This page does not authorize a write.

## What a deploy does

The reader and the enrichment projector share one admission rule. The projector reads `enrichment/view-index.json` as an optional object. A missing object admits nobody. A present object contributes only a Letterboxd lid whose `watchlist` field is `true` or `false`.

While `D1_ENRICHMENT_WRITE` is `on`, the next projector cron applies that view under the existing lease, batch and query budget. A Film the view newly contains is upserted. A Film the view no longer contains is marked absent, and `releaseFilm` removes watchlist membership only. One cron does not drain a large set; later crons continue. There is no new flag and no separate import command.

The watchlist grid still reads the watchlist document. Finds hide a catalog row whose view-index entry has either watchlist boolean. Neither surface deletes the Film.

## What this delivery does not do

- It does not import historical rows that lack a watchlist boolean. The October 2026 class C audit remains a snapshot, not a queue.
- It does not re-seed `projection_state`. The offline seed still keys the view without this admission. Running it after the projector has stored admitted Films stops on a state conflict. Leave the seed unused for this change.
- It does not change schema, switch a marker, run ratings or discovery, reset a lease, or call a route that writes.
- `reconcileDepartedFilms` classifies offline inputs as `resolved`, `ambiguous`, `conflict` or `unresolved`. It writes nothing. A `conflict` waits for a separate repair card.

## Recovery

Code rollback stops later projector runs from using the new admission. Film rows, credits, fingerprints, predictions and R2 objects already written stay. Membership can be removed by a later release; the Film row is not what `releaseFilm` deletes.

A repair that joins orphans with no watchlist boolean needs its own card, its own approval, and a fresh read of production. Do not treat a missing migration as if the historical films had been restored.

## Safe check

After deploy, confirm both GitHub Actions jobs and one read-only MCP `probe_read`. Do not call `GET /api/enrichment/view`, `GET /api/events`, `GET /api/programme` or `GET /api/watchlist` as a smoke test. Do not start the projector by hand.
