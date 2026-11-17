# AIR-79 flag closure audit and legacy export route removal, 17 November 2026

**Trello:** [AIR-79](https://trello.com/c/485tlGLA). **Code reference:** `main` at `30896e2f74d4e47f4e1df0100ec14b3b6840b00f`. **Captured:** 17 November 2026 (UTC). Continues the [first audit](air-79-legacy-r2-runtime-audit-2026-11-17.md) and the [orphaned ratings runtime slice](air-79-orphaned-ratings-runtime-2026-11-17.md).

## Scope and method

The flag closure audit asked for in the card: compare the registry in `src/feature-flags.js`, the maintained documentation, the live `feature_flags` readout, and the environment names that the code reads, and register any further migration orphan without changing a binding.

**Live observations** were two reads of owner-only MCP tools that are documented as non-writing (`feature_flags` never touches storage, and `ratings_sync_status` takes no lease and requests nothing). They were made by the author at 13:44:57 UTC. **Code reading** used one scan of `src/` for names read as `env.NAME`, `source.NAME` and similar forms, then a lookup of each name in the flag reference and in all maintained documentation outside ADRs, evidence and the archive.

**Binding inventory:** not read when this audit was first written; it was read afterwards and is recorded in [Binding inventory](#binding-inventory). No binding, flag, secret, marker, schedule or stored object was changed by either read.

## Live readout

| Source | Observation at 13:44:57 UTC |
| --- | --- |
| `feature_flags` | 23 registered flags: 2 set (`MONITOR` = `on`, `MONITOR_TRANSPORT` = `telegram`), 21 absent, 0 invalid. All 20 retired flags are absent, including `D1_ENRICHMENT_WRITE`, `D1_ENRICHMENT_WINDOW`, `D1_ENRICHMENT_BULK`, `DISCOVERY_LEDGER_MODE`, `DISCOVERY_EXECUTOR`, `RATINGS_PIPELINE`, `LETTERBOXD_FACTS` and `CATALOG_POSTER_HYDRATION`. `LIFECYCLE_LOCALIZATION` is absent with effective `off`, as the card records. `storage` is `not_accessed`, `sideEffects` is `none`. |
| `ratings_sync_status` | `migration` is `complete`; the removal queue is schema version 2 with 14 entries and 0 legacy entries; `pipeline` is `idle`; orchestration `mode` is `cloudflare`, health `idle`, last run finished 16 Nov 16:01 UTC with outcome `recent_window`. `sideEffects` is `none`. |

The second row is the live precondition of the separate slice that would retire the ratings storage migration tool: the migration the tool performs is recorded complete. It does not perform that slice.

## Registry, documentation and code

The registry and the flag reference agree: all 23 registered names are documented, and the live readout adds no unregistered name. The scan found 31 environment names read by the Worker. Seven of them are registered flags (`LIFECYCLE_LOCALIZATION`, `MONITOR`, `MONITOR_TRANSPORT`, and the retired `DISCOVERY_LEDGER_MODE` and `D1_ENRICHMENT_WRITE`, `_WINDOW` and `_BULK`, which the code still names but ignores). The other 16 registered flags are retired and no longer read at all. The remaining 24 names are settings and bindings, not flags.

| Name | Read by | Documented in maintained docs |
| --- | --- | --- |
| `BUCKET`, `DISCOVERY_WORKFLOW`, `EPG_XML_URL`, `LETTERBOXD_USERNAME`, `TMDB_API_READ_ACCESS_TOKEN`, `MONITOR_WEBHOOK_URL`, `MONITOR_TELEGRAM_BOT_TOKEN`, `MONITOR_TELEGRAM_CHAT_ID`, `RATINGS_DB_REQUIRED`, `PREDICTION_DB_REQUIRED` | several files | in the flag reference |
| `EPG_WORKFLOW`, `RATINGS_WORKFLOW`, `PRODUCER_WORKFLOW`, `EPG_DIAGNOSTIC_WORKFLOW`, `EPG_DIAGNOSTIC_RESOURCE_ID`, `MCP_ACCESS_AUD`, `MCP_ACCESS_TEAM_DOMAIN`, `MONITOR_HEARTBEAT_URL`, `TMDB_REQUEST_INTERVAL_MS`, `FOOTER_SOURCE_TIMEOUT_MS` | one file each | in runbooks, references or the MCP contract, not in the flag reference (they are bindings, settings or secrets, not flags) |
| `OWNER_REVIEW_DB_OPTIONAL` | `src/owner-review-d1.js` | **nowhere before this change**; now in the local setup runbook next to its published-EPG counterpart |
| `MIGRATION_EXPORT_ENABLED`, `MIGRATION_EXPORT_KEY`, `MIGRATION_EXPORT_SITE_ID` | `src/migration-export.js` only | only in the archive; see the finding below |

`PUBLISHED_EPG_DB_OPTIONAL` is read through a different access form and was found by search, not by the scan; it is documented in the local setup runbook. The scan is limited to the access forms above.

## Finding: the legacy Site export route (removed from the Worker)

`src/migration-export.js` served `GET /api/migration-export/list|head|object`, a read of any R2 object by key, for the snapshot exporter of the retired Site. Its guard returns `404 {"error":"Not found"}` unless **all four** hold: the request origin is exactly the old Site's host (`https://iptv.vladimino.chatgpt.site`), `MIGRATION_EXPORT_SITE_ID` equals a hard-coded legacy site id, `MIGRATION_EXPORT_ENABLED` is `true`, and a shared-secret header matches `MIGRATION_EXPORT_KEY`. The Worker is served from its own host, so the first condition can never hold there and the route could only ever answer 404; its own comment says the key is "deliberately absent from the new Cloudflare Worker environment".

**Change.** The route and its build entry are removed from the Worker bundle. The module moved to `tests/support/legacy-migration-export-route.js` and stays as the server side of the archived exporter tests (`tests/migration-export.mjs`, `tests/migration-import.mjs`); the exporter and importer scripts are unchanged. The get-write audit no longer registers the `/api/migration-export/` prefix. About thirty tests listed the file in their own copy of the Worker file list; that one entry is dropped from each.

**Effect on the Worker.** A request to those paths now reaches the dispatcher's common `404 {"error":"Not found"}`, the same status as before. Whether a `POST` or `PUT` that carries a foreign `Origin` header got `404` before this change was not tested against the old code (the old route accepted only `GET`); after it, the dispatcher's origin check answers `403`. Both are refusals; neither reads R2. The surface that reads an arbitrary R2 key by request is gone from the production bundle.

**Bindings.** The binding inventory read afterwards shows no `MIGRATION_EXPORT_*` binding on the Worker (see [Binding inventory](#binding-inventory)), so no binding removal is needed. The three names remain in the deny list of the isolated EPG diagnostic environment (`src/epg-diagnostic.js`) on purpose: they must never be copied into that environment, and that list is not the route.

**Regression protection.** `tests/migration-export-route-absent.mjs` builds the Worker and runs the built bundle with the exporter's former origin, flags and key. It requires the route's path, handler, key header and legacy site id to be absent from the bundle, `404` on GET, HEAD, POST and PUT for every retired path, `403` for a foreign `Origin` on POST and PUT, and no call at all on the bucket.

## Binding inventory

**Read:** 17 November 2026, after the change above was merged, by the author through the Cloudflare API connector: one `GET` of the Worker script settings of `iptv`. Only binding names and types were kept; no value was returned, printed or stored, and nothing was written.

| Type | Count | Names |
| --- | --- | --- |
| `r2_bucket` | 1 | `BUCKET` |
| `d1` | 1 | `DB` |
| `workflow` | 4 | `DISCOVERY_WORKFLOW`, `EPG_WORKFLOW`, `PRODUCER_WORKFLOW`, `RATINGS_WORKFLOW` |
| `plain_text` | 9 | `EPG_XML_URL`, `LETTERBOXD_USERNAME`, `MCP_ACCESS_AUD`, `MCP_ACCESS_TEAM_DOMAIN`, `MONITOR`, `MONITOR_TELEGRAM_CHAT_ID`, `MONITOR_TRANSPORT`, `PREDICTION_DB_REQUIRED`, `RATINGS_DB_REQUIRED` |
| `secret_text` | 3 | `MONITOR_HEARTBEAT_URL`, `MONITOR_TELEGRAM_BOT_TOKEN`, `TMDB_API_READ_ACCESS_TOKEN` |

Checks against the code and the registry:

- `MIGRATION_EXPORT_ENABLED`, `MIGRATION_EXPORT_KEY` and `MIGRATION_EXPORT_SITE_ID` are **not bound**. Neither are `OWNER_REVIEW_DB_OPTIONAL` and `PUBLISHED_EPG_DB_OPTIONAL` (the local stand-ins), nor any retired selector: `D1_ENRICHMENT_WRITE`, `D1_ENRICHMENT_WINDOW`, `D1_ENRICHMENT_BULK`, `DISCOVERY_EXECUTOR`, `DISCOVERY_LEDGER_MODE` and `RATINGS_PIPELINE` are all absent.
- Every bound name has at least one reader in `src/`, so there is no binding without a consumer. The bindings of the detached EPG diagnostic runtime (`EPG_DIAGNOSTIC_WORKFLOW`, `EPG_DIAGNOSTIC_RESOURCE_ID`) are not present either.
- Names the code reads without a binding are optional settings with a default or a transport that is not selected (`MONITOR_WEBHOOK_URL` is used only by the webhook transport, and `MONITOR_TRANSPORT` is `telegram`; `TMDB_REQUEST_INTERVAL_MS` and `FOOTER_SOURCE_TIMEOUT_MS` have defaults).

The independent review of the first audit reported 23 Worker bindings. This read returned 18 entries. The difference is not explained here; the table is what the API returned, and the number 23 also matches the count of registered flags, which are a different set.

## Result

No further migration orphan flag exists in the registry, and all retired selectors are absent from the live Worker. One legacy route with its three settings was removed from the bundle, and one undocumented stand-in setting is now documented. The binding inventory check for `MIGRATION_EXPORT_*` is done and shows no such binding; no removal card is needed.

## Verification

Local, on the final checkout of this change after a fresh `npm ci`: `npm run test:all` passed with the core suite at 420 of 420 files and the non-functional suite at 40 of 40; `npm run build` and `git diff --check` were clean; the mutation-anchor preflight passed (137 anchors, 2 harnesses); the documentation governance and timeless-documentation checks passed with no errors. The affected tests were also run on their own first: `migration-export`, `migration-import`, `get-write-audit` and `get-side-effects`. `get-side-effects` initially failed with `ENOENT` because it loads the Worker from its own file list, which named the moved file; the entry was dropped from that list and from the other 30 test lists that carried it. CI results of the pull request and the independent review are recorded on the card and the pull request, not here.

**Follow-up (binding inventory and regression test).** On the checkout that adds `tests/migration-export-route-absent.mjs`, after a fresh `npm ci`: `npm run test:all` passed with the core suite at 421 of 421 files and the non-functional suite at 40 of 40; the new test ran in 0.4 s; `npm run build` and `git diff --check` were clean; the mutation-anchor preflight passed (137 anchors, 2 harnesses); `tests/test-classification.mjs` and `tests/run-tests-runner.mjs` pass with the new entry. The test first failed on a bundle needle that was too broad: `MIGRATION_EXPORT_ENABLED`, `_KEY` and `_SITE_ID` also appear in the isolated diagnostic environment's deny list, which is a guard and not the route, so the needles were narrowed to the route's path, handler, key header and legacy site id.
