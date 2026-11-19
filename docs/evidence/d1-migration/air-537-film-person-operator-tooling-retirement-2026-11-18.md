# AIR-537 slice 2: Film/Person migration operator tooling retired, 18 November 2026

**Trello:** [AIR-537](https://trello.com/c/wbe7jjNs). **Basis:** [AIR-79 final retirement audit](air-79-final-retirement-audit-2026-11-18.md), scope item 2; slice 1 is [the Discovery installer ledger](air-537-discovery-installer-retirement-2026-11-18.md). **Captured:** 18 November 2026 (UTC) on `main` `0273c7e`. Static code and documentation change; no production read or write, no operator run.

## Method

Import graph over `src/`, `scripts/`, `tests/`, `build.mjs`, `scripts/run-tests.mjs`, `scripts/test-classification.mjs` and the maintained docs, before and after the deletions. The removed set is closed: its only importers are itself, `src/mcp.js` plus `build.mjs` (the open-handoff operator) and test allowlists. Production is `d1`/`open` generation 2 for Film/Person, so no `prepared` marker can be served ([ADR 0162](../../adr/0162-d1-only-authority-retire-rollback-toolchain.md)).

## Ledger (path, consumer, disposition)

| Path | Consumer found | Disposition and reason | Rollback |
| --- | --- | --- | --- |
| `src/film-person-baseline.js` | `src/film-person-cutover-minimum.js`, `-cutover-accepted.js`, `scripts/film-person-capture.mjs`, `-cutover-run.mjs`, `-connector-run.mjs`; not bundled | **Removed.** Offline baseline ledger for the `r2` to `prepared` move; no Worker, MCP or runbook path in force. | Revert |
| `src/film-person-cutover-minimum.js`, `src/film-person-cutover-accepted.js` | each other, baseline, connector and cutover-run scripts | **Removed.** Gates for the baseline recording paths of a move that is complete. | Revert |
| `scripts/film-person-capture.mjs`, `-cutover-run.mjs`, `-connector-run.mjs`, `-prepared-loader.mjs`, `-h1-verify.mjs` | each other and their tests only | **Removed.** Offline operator copy, H1 load planning and verification; the H1 load was executed ([evidence](air-374-h1-load-2026-11-13.md)). | Revert |
| `src/film-person-open-handoff.js` | `src/mcp.js` through the `build.mjs` bundle entry | **Removed.** One guarded `UPDATE ... WHERE mode='prepared'`; it never handled `held`. No Scheduled Task, cron or recovery procedure calls it. | Revert (restores a tool whose flip cannot apply at `open`) |
| `scripts/film-person-open-handoff.mjs`, `tests/film-person-open-handoff.mjs` | REST dry-run of the above | **Removed** with it. | Revert |
| MCP tool `film_person_open_handoff`: `src/mcp.js` registration, dispatch, `MCP_INSTRUCTIONS`; `build.mjs` bundle entry | owner-only `/mcp` | **Removed.** `tools/list` no longer names it; `tools/call` answers an unknown tool. Access and JWT checks untouched. | Revert |
| `readMarker`, `transitionAuthority`, `open`/`held` state machine, SQL triggers and fences (`src/film-person-authority.js`) | readers, writers, `tests/film-person-authority.mjs` | **Retained.** Emergency forward-fix path (`open` to `held` to `open`); owner gate for any change. | n/a |
| `scripts/film-person-0019-preflight.mjs`, `-0020-preflight.mjs`, `-e6-measure.mjs` and their tests; `scripts/epg-producer-m2b.mjs` | import only `schema-preflight.mjs` (and the m2b stand-in helpers); none imports a removed file | **Retained** (default for read-only diagnostics). | n/a |
| Tests of the removed files (17 files, incl. mutation harnesses) | none outside the set | **Removed**; registries in `scripts/run-tests.mjs` and `scripts/test-classification.mjs` pruned. | Revert |
| Importer allowlists and `activationAudit` uses in `tests/canonical-*.mjs` | assertions that named `src/film-person-open-handoff.js` | **Updated**, no coverage dropped: the producer-wired assertions keep the `PRODUCER_WIRING` check; `tests/canonical-handoff-readiness.mjs` now asserts the three H1 class counts (708, 398, 4) literally instead of through the loader's `EXPECTED`. | Revert |
| `tests/mcp-tools.mjs`, `tests/mcp.mjs`, `tests/get-write-baseline.mjs` | tool inventory and write-tool list | **Updated:** the tool is absent from the listing and from the write inventory. | Revert |

## Not changed

`FILM_PERSON_DB_OPTIONAL`, `routeSkipMs`, `writerRoute.r2Allowed`, the admin recovery writers and every authority or recovery semantics (scope item 4, owner gate: default retain). Historical evidence and Accepted ADRs are not rewritten; maintained runbooks carry a retired status, and the open-handoff runbook keeps the `held` recovery section.
