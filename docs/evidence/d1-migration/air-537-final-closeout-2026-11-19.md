# AIR-79 / AIR-537 final closeout disposition, 19 November 2026

**Trello:** [AIR-537](https://trello.com/c/wbe7jjNs), successor of [AIR-79](https://trello.com/c/485tlGLA). **Basis:** [AIR-79 final retirement audit](air-79-final-retirement-audit-2026-11-18.md) and the slice ledgers [1](air-537-discovery-installer-retirement-2026-11-18.md), [2](air-537-film-person-operator-tooling-retirement-2026-11-18.md), [3](air-537-enrichment-projector-retirement-2026-11-19.md), [4](air-537-scope4-standin-and-discovery-tails-2026-11-19.md) and [4, option A2](air-537-a2-skip-reason-rename-2026-11-19.md). **Captured:** 19 November 2026 (UTC) on `main` `9f35296`. Code comments, documentation and tests only; no production read or write.

## Verdict

The serving retirement is complete and every remaining item of the AIR-79 audit now has a disposition below. This is **not** "everything legacy is deleted": what stays stays for a stated caller or safety reason. Production authority is D1 for the seven moved domains; R2 keeps its legitimate immutable, raw, receipt, archive and compatibility-mirror roles.

## Removed (code and tooling)

| Item | Slice | Evidence |
| --- | --- | --- |
| `scripts/discovery-ledger-install.mjs --apply --approved-production-writes` (R2 PutObject of the plan and the resolver lease) | 1 | `--apply` is refused before any request; the dry run stays read-only |
| Film/Person migration operator tooling: `src/film-person-baseline.js`, `-cutover-minimum.js`, `-cutover-accepted.js`, `scripts/film-person-capture`, `-cutover-run`, `-connector-run`, `-prepared-loader`, `-h1-verify` and 17 tests | 2 | slice 2 ledger |
| Owner-only MCP tool `film_person_open_handoff`, its module, CLI, bundle entry, registration and tests | 2 | not in `tools/list`; slice 2 ledger |
| `runD1EnrichmentProjection` and the 65-symbol chain only it used (readers, diff, `legacy`/`r2`/`prepared` write arms, lease and window handling), `D1_ENRICHMENT_TEST_HARNESS`, five projector bench scripts, 14 runner-only tests, the dead `LifecycleReader` bundle entry | 3 | `src/d1-enrichment.js` went from 1,095 to 54 lines; slice 3 ledger |
| The stale skip label `projector_is_writer` (renamed to `film_person_route_not_open`, 37 one-line replacements) | 4, option A2 | A2 ledger |
| False present-tense source comments in nine files (`src/admin/read.js`, `src/catalog-d1.js`, `src/worker.js`, `src/film-admission.js`, `src/canonical-film-writers.js`, `src/canonical-catalog-reader.js`, `src/film-person-authority.js`, `src/canonical-producers.js`, `src/canonical-read-model.js`); 37 comment lines changed, no other line | 5 | this PR |
| The `legacy / r2 / prepared: existing runtime` branch drawn as live in the Film/Person marker-gate diagram | 5 | `docs/architecture/film-person-lifecycle.md` now draws `open` D1, `held`/`r2`/`prepared`/unreadable refused, and the local stand-in as a dotted branch |

## Retained, with caller and safety reason

| Item | Caller or reason | Disposition |
| --- | --- | --- |
| `readMarker`, `transitionAuthority`, the `open`/`held` state machine, SQL triggers and fences | the emergency forward-fix path; readers and writers | retain (owner gate) |
| `projector_window` table, Discovery request/grant/release and the `held` admission fence | Discovery admission, `tests/projector-window.mjs` | retain |
| `d1EnrichmentStatus` (read-only, `mode`/`windowMode` constant `null`) | `src/catalog-d1.js` `/api/d1/status` | retain |
| Marker-guard vocabulary (`PROJECTOR_MARKER_*`, `projectorExpectation`, `projectorHolds`, `projectorGuard`) | `projectorFence` in `src/canonical-producers.js`; pinned by `tests/projector-marker-guard.mjs` | retain |
| The five local stand-ins `FILM_PERSON_DB_OPTIONAL`, `DISCOVERY_DB_OPTIONAL`, `PUBLISHED_EPG_DB_OPTIONAL`, `METADATA_CACHE_DB_OPTIONAL`, `OWNER_REVIEW_DB_OPTIONAL` | developer and test contract (`scripts/local-dev.mjs`, `tests/local-standins.mjs`); never set by `wrangler.jsonc` | retain, owner decision A2 |
| `r2Allowed` (Worker R2 read guard), `routeOf {open:false}`, `SKIPPED`, `routeSkipMs`, the `writerRoute` fields `writer`/`projector`/`canonical` | live fail-closed guards and compatibility fields; semantics unchanged | retain, owner decision A2 |
| `canonicalMirrorsWritable` and the frozen R2 mirror fences | EPG and Film/Person paths | retain |
| Four Discovery key-name façades `epg/resolver-lease.json`, `epg/resolver-continuation.json`, `epg/discovery-workflow.json`, `epg/discovery-resolution.json` | served from D1 through `DiscoveryAuthority`; read-only operator, snapshot and offline consumers | retain |
| Local R2 variants of the DR and DI admin recovery capabilities (`discovery_reconsider`, `discovery_identity_correct`) | run only under `DISCOVERY_DB_OPTIONAL=standin`; PE is already D1-only | retain, owner decision A2 |
| Read-only preflights `scripts/film-person-0019-preflight.mjs`, `-0020-preflight.mjs`, `film-person-e6-measure.mjs`, `scripts/epg-producer-m2b.mjs` | read-only diagnostics, no import of removed code | retain |
| `scripts/r2-s3-store.mjs`, `scripts/discovery-ledger-split.mjs` and the offline utilities | prediction-domain operator; offline rehearsal | retain |
| `scripts/d1-projection-seed.mjs` and its test | offline tool whose projector was removed | retain; whether to keep it is open, not decided here |
| `CanonicalRepository` scoped bundle entry and `src/canonical-repository.js` | no Worker caller left; exercised by tests | retain; bundle-entry removal is a possible follow-up, not needed for safety |
| `FOOTER_SOURCE_TIMEOUT_MS`, `TMDB_REQUEST_INTERVAL_MS` | not orphans: `footerGuard` in `src/enrichment.js`, `tmdbRequest` in `src/discovery.js`, about forty tests; now documented with defaults and scope in [`docs/reference/feature-flags.md`](../../reference/feature-flags.md#tuning-variables-that-are-not-feature-flags) | retain, documented (no binding or flag change) |
| `D1_ENRICHMENT_WRITE`, `D1_ENRICHMENT_WINDOW`, `D1_ENRICHMENT_BULK` retired rows | `src/feature-flags.js` reports them `retired`; the Cloudflare variables are already absent (AIR-308, AIR-512) | retain as registry rows; nothing to do in production |
| R2 families that stay legitimate: immutable Film/Person sources, frozen `titles.json` / `people.json`, immutable Discovery observation segments, ratings events, immutable prediction bodies, raw inputs and archives, published compatibility mirrors, the owner-review mirror, receipts | read-only or create-only roles by design | retain |

## Documentation closeout (slice 5)

Maintained runbooks no longer carry an executable instruction for a removed tool: `discovery-ledger-install --apply`, the Film/Person baseline, cutover, capture, connector, loader, verifier and `film_person_open_handoff` pages are banners or retired stubs; the `d1-backfill` projector and seed sections, the e6 budget note and the TMDB TV correction acceptance step are marked historical. Three genuinely dead relative links were fixed (`docs/reference/domain/film-person.md` twice, `docs/reference/integrations/letterboxd-ratings.md`). The real recovery stays documented: owner-approved forward-fix (`open` to `held` and back), D1 Time Travel as an owner-approved recovery, and the authority-marker holds. Historical evidence and Accepted ADRs were not rewritten.

## Not changed, and no production action

Production R2 and D1 data, schema and migrations, flags, bindings, Access, Scheduled Tasks, schedules, the Discovery Workflow and fast recovery cron, protected admin routes, recovery, sync, leases. Code rollback of this change is a revert of the PR and restores no data.
