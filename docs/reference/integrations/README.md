# External integrations

- [Letterboxd personal ratings refresh](letterboxd-ratings.md): last-known-good generation, HTTP 403 behavior, retry constraints and read-only status.
- [Letterboxd account export](letterboxd-export.md): CSV parsing rules, derived sets, the strict matching of export rows with stored films and identity from Letterboxd film pages.
- [Letterboxd Diary viewing history](letterboxd-diary-history.md): viewing-id entries or per-film-and-day counts with honest lower bounds, incremental bounded reads behind `LETTERBOXD_DIARY_HISTORY`, run state, coverage limits and the read API (ADR 0049).
- [Letterboxd user facts](letterboxd-user-facts.md) (design, not implemented): watched, rating and watchlist as separate facts with provenance, the newer-observation merge rule, projections, baseline import protocol and D1 mapping.
- [MCP contract](../api/mcp.md): owner-only Cloudflare Access, OAuth and Worker JSON-RPC.

References describe contracts, not approval to fetch or change production data.
