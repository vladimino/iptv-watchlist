# AIR-320 pipeline status: D1 bind cap (4 November 2026)

- **Captured:** 2026-11-04 23:20:55 UTC, side-effect-free MCP `epg_pipeline_status` on Worker `iptv` after PR #373 deployed on `main` `10e804a`.
- **Scope:** reader only. No R2/D1 write, discovery chunk, TMDB, Task, flag or lease.
- **Verdict:** **LIVE STATUS FAILED CLOSED** — Worker returned `D1_ERROR: too many SQL variables at offset 344: SQLITE_ERROR`. This is not a zero-count success and does not prove the 36999 D1 observations were lost.
- **Cause:** `visitActivePage` kept `LEDGER_PAGE=500` and bound those 500 keys twice in `IN (...)` for shows and decisions. Cloudflare D1 allows 100 bound parameters per query. The local SQLite stand-in does not enforce that cap, so the 36999-row test on #373 passed.
- **Not this record:** Finds, Admin limbo, a runtime D1 writer, or a later green status after the bind-safe walk.

Coordinator source: Trello AIR-320 comment at 2026-11-04 23:21 UTC.
