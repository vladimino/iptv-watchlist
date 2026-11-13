# AIR-374 P3c: Discovery admission producer, offline verification (13 Nov 2026)

**Scope:** offline code and tests on the sqlite3-CLI D1 stand-in. No production, R2, D1, Cloudflare, flag, Task, migration or marker access. Counts only; no payload, title or personal data.

**What was verified**

- `src/canonical-discovery-admission-producer.js` (operation kind `film_mutation`, origin `discovery`): create, land on the Film that already holds the trusted `tmdb` id, fill a blank title only, never overwrite a stored title or contract version, typed refusals before any receipt (`identity_collision`, `film_person_redirect`), one atomic fenced batch with the applied receipt, no receipt for a no-op.
- The call in `upsertAdmissions` (one call site, `typeof` guard): below the marker `open` it is exactly the marker read, cached per binding for 60 s; at `open` it is bounded (10 admissions, reconcile 10, sweep 5), honours the deadline and never throws.
- Origin reconcile re-plans from the CURRENT `discovery_admission` row; a moved source is abandoned, a superseded or missing admission is never replayed; a D1 read failure propagates.
- `PRODUCER_OPERATIONS` registers the atomic spec; `handoffReadiness` clears exactly `receipts_protocol_unregistered` and `producer_not_wired:discovery_admission`; the other three producers stay unwired.
- `external_ids_not_pruned_by_the_planner` is `accepted` (owner revision of 13 Nov 2026, variant B): twelve accepted, none open. This is a revision of a decision, not proof that pruning is wired.
- The Worker bundle builds with the new named scopes (`scopedImports`): 7 modules, the generated entry passes the wrangler dry-run of `scripts/check-discovery-workflow-bundle.mjs`; `node --check` of the bundle passes.

**Results**

- `tests/canonical-discovery-admission-producer.mjs`: passes (12 sections including the registry hooks called directly).
- `tests/canonical-discovery-admission-producer-mutation.mjs`: 34 mutants killed, none survive.
- Full suite `npm test`: 394 of 394 files pass (wall 359.5 s locally, summed 2048 s).
- Updated static tests (importer allowlists, bundle scopes, R2 inventory, readiness fixtures) keep their intent and now name the new scopes and the one registered operation.

**Not verified / limitations**

- No production measurement: admission volume per chunk, the Film rows that already exist for admitted ids and the added statements per chunk (E6) are unknown; the caps (10, 5, 10) and the 60 s skip are provisional.
- Behaviour at the marker `open` is proven only on the stand-in; nothing here moves the marker.
- The GitHub PR run (tests/build) and the post-merge run with `Deploy to Cloudflare` are recorded on the pull request, not here.

Decision: [ADR 0134](../../adr/0134-discovery-admission-producer-wiring.md) (Proposed). Card: [AIR-374](https://trello.com/c/ha7ais3w).
