# AIR-79 Discovery D1-only slice (ADR 0162), 18 November 2026

**Trello:** [AIR-79](https://trello.com/c/485tlGLA). **Decision:** [ADR 0162](../../adr/0162-d1-only-authority-retire-rollback-toolchain.md). **Captured:** 18 November 2026 (UTC). Sixth per-domain slice of ADR 0162, after [owner reviews](air-79-owner-reviews-d1-only-2026-11-18.md), the [metadata cache](air-79-metadata-cache-d1-only-2026-11-18.md), [ratings documents](air-79-ratings-documents-d1-only-2026-11-18.md), [mutable predictions](air-79-mutable-predictions-d1-only-2026-11-18.md) and the [published EPG](air-79-published-epg-d1-only-2026-11-18.md). No production read or write was made for it; the production marker was read on 17 November ([marker read](air-79-d2-closeout-and-d1-preparation-2026-11-17.md#production-markers-read-on-17-november): Discovery `d1` / `open`, generation 189354).

## Change

| Item | Verdict |
| --- | --- |
| `readAuthority` in `src/discovery-authority.js` | Only `d1` with `cutover` `open` is served. An installed marker in mode `r2` (the migration inserts it) or with `cutover` `held`, and a marker with any other value, fail closed with `discovery_unavailable`; before, `r2` made every reader answer `handled: false` and the Worker read the R2 objects, and `held` was a fence (`discovery_fence`). `held` is now always false and `ready` is true whenever the tables are installed |
| About 30 unreachable held branches: the `gate.held` and `opened.held` throws in `src/discovery-authority.js` (17), `src/discovery.js` (4, plus the `authority_held` refusal, cause and the `records` unavailable entry), `src/worker.js` (3), `src/admin/discovery-recovery.js` (7, plus two conditions), the `held` state of `readOperationalSnapshot` and its `reason: 'held'` answer | Removed. The operational snapshot, when the marker moved between the gate read and the batch, now refuses instead of answering `handled: false` |
| `scripts/discovery-production.mjs` | Reduced from 1142 to about 390 lines: status and the schema `--apply` stay; `--load`, `--reset-load`, `--import`, `--reset-import`, `--hold`, `--activate` and `--revert` answer `retired` before any request |
| `scripts/discovery-cutover.mjs` (the library of the retired commands) | Removed |
| The `transfer` states `loading` and `committed`, the ledger seal and its replay, the lease, the generation fence, the `projector_window` fence, the schema CHECK values `r2` and `held`, `scripts/discovery-authority.mjs` (a read-only offline status that refuses writes), and the R2 ledger tools `scripts/discovery-ledger-split.mjs` and `scripts/discovery-ledger-install.mjs` (the latter's `createS3Store` is shared with the prediction production entry) | Retained. The ledger seal is the live runtime handoff, not the cutover; the ledger tools are not an authority switch and are left for a separate classification |

## Not done in this slice

A missing binding, a missing `schema_contract` or a contract below 11 is still the local stand-in (`closed()`): Discovery has no opt-in flag (`DISCOVERY_DB_OPTIONAL`), and adding one means opting in every Worker-level fixture that runs without a D1 binding. That is the same dependency ADR 0162 names for Film/Person (the shared test loader) and is the open follow-up for both. Production is unaffected: the Worker always has its binding and the schema is at 24.

## Tests

The Discovery tests that asserted a held or `r2` marker as a fence or as the R2 path now assert the refusal (`tests/discovery-authority.mjs`, `discovery-chunk-budget`, `discovery-paged-write`, `discovery-decisions-read`, `discovery-admission-packed`, `discovery-user-read-fence`, `discovery-operational-status`, `discovery-pipeline-d1-status`, `catalog-film`, `catalog-watched-d1`, `epg-priority-gate`, `projector-window`, `prediction-queue-discovery-independence`, `interrupted-recovery`); generation, ABA and loading-transfer fences are unchanged. `tests/discovery-production.mjs` is cut from 1224 to about 250 lines: the decision, status and schema-apply cases stay, and every retired command is refused before any request by the script and by the runner.

## Verification

Local, after a fresh `npm ci`: `npm run test:all` on the final checkout, `npm run build`, `git diff --check`; the result is in the pull request. No Mermaid block changed.
