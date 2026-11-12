# Film retention

A Film admitted by a Letterboxd watchlist boolean stays in the catalog after it leaves the current programme and watchlist. Membership, watched state and availability stay independent. The decision is [ADR 0086](../adr/0086-durable-watchlist-film-retention.md). This page does not authorize a write.

## What a deploy does

The reader and the enrichment projector share one admission rule. The projector reads `enrichment/view-index.json` as an optional object. A missing object admits nobody. A present object contributes only a Letterboxd lid whose `watchlist` field is `true` or `false`.

`D1_ENRICHMENT_WRITE` is already `on`. A deploy of this rule makes the next projector cron apply the wider view under the existing lease, batch and query budget. A Film the view newly contains is upserted. A Film the view no longer contains is marked absent, and `releaseFilm` removes watchlist membership only. One cron does not drain a large set; later crons continue. There is no new flag and no separate import command.

That deploy is not implied by accepting the ADR: merging to `main` also expands the next projector's writes, so it requires an **explicit approved L3 rollout plan** covering the changed writer behavior and holdpoints. This is a genuine high-impact exception, not a routine docs/Mermaid approval. See [authorization](../process/authorization-and-escalation.md).

An admitted lid that is on neither current list and has no usable metadata does not replace an existing Film. The write moves watchlist membership only. Credits, metadata, trusted external ids, identity and metadata dimensions, and sync clocks stay. A cache row whose id names another film is not used as the body, and the lid stays admitted. A Film row that does not exist yet is still inserted.

The watchlist grid still reads the watchlist document. Finds hide a catalog row when its own view-index entry has either watchlist boolean, or when a Letterboxd lid with either boolean bridges to that row's TMDB id by one agreed stored id. Two stored ids, or none, do not bridge. Titles are not compared. Neither surface deletes the Film.

## What this delivery does not do

- It does not import historical rows that lack a watchlist boolean. The October 2026 class C audit remains a snapshot, not a queue.
- It does not re-seed `projection_state`. The offline seed still keys the view without this admission. Running it after the projector has stored admitted Films stops on a state conflict. Leave the seed unused for this change.
- It does not change schema, switch a marker, run ratings or discovery, reset a lease, or call a route that writes.
- `reconcileDepartedFilms` classifies offline inputs as `resolved`, `ambiguous`, `conflict` or `unresolved`. It writes nothing. A `conflict` waits for a separate repair card.

## Recovery

Do not merge until the approved high-impact rollout plan above is recorded; do not assume PR acceptance alone authorizes the expanded projector writes. A merge deploys the Worker, and the next cron would then upsert admitted Films.

Code rollback stops later projector runs from using the new admission. Film rows, credits, fingerprints, predictions and R2 objects already written stay. Membership can be removed by a later release; the Film row is not what `releaseFilm` deletes. Restoring a previous view that drops an admitted Film marks that Film absent and removes membership only.

A repair that joins orphans with no watchlist boolean needs its own card, its own approval, and a fresh read of production. Do not treat a missing migration as if the historical films had been restored.

## Safe check

After the separately approved deploy, confirm `Test and build`, `Test shard 2 of 3`, `Test shard 3 of 3` and `Deploy to Cloudflare` completed with success on the exact merge SHA, and one read-only MCP `probe_read`. Do not call `GET /api/enrichment/view`, `GET /api/events`, `GET /api/enrichment/status` or `GET /api/enrichment/runs` as a smoke test. Do not start the projector by hand.
