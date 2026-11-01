# External integrations

- [Letterboxd ratings](letterboxd-ratings.md): the retired ratings-only refresh and its read-only status, ratings in the EPG commit, the removal lookup queue, and the separate ratings pipeline behind `RATINGS_PIPELINE` (run record, lease, steps, queue version 2, storage migration).
- [Letterboxd account export](letterboxd-export.md): CSV parsing rules, derived sets, the strict matching of export rows with stored films and identity from Letterboxd film pages.
- [Letterboxd Diary viewing history](letterboxd-diary-history.md): viewing-id entries or per-film-and-day counts with honest lower bounds, page 1 of a migrated ratings run (`LETTERBOXD_DIARY_HISTORY` retired, ADR 0075), run state, coverage limits and the read API (ADR 0049).
- [Letterboxd user facts](letterboxd-user-facts.md) (design, not implemented): watched, rating and watchlist as separate facts with provenance, the newer-observation merge rule, projections, baseline import protocol and D1 mapping.
- [MCP contract](../api/mcp.md): owner-only Cloudflare Access, OAuth and Worker JSON-RPC.

References describe contracts, not approval to fetch or change production data.
