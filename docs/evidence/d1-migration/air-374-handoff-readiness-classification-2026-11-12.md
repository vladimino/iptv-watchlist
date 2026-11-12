# AIR-374: handoffReadiness recomputed offline, every blocker classified

**Captured:** 2026-11-12 (UTC), offline, from `main` at `97ff6bc`. Authority: [AIR-374](https://trello.com/c/ha7ais3w) (Controller handoff of 12 Nov 2026, item 7). **Nothing was run against production.** No D1, R2, Cloudflare, connector, MCP, Trello or GitHub-comment call was made; no flag, task or setting was touched. This page changes no readiness verdict and authorizes nothing.

**Result in one sentence:** on the repository's own modelled state, `handoffReadiness` returns `ready:false` with **29 blockers**, the same number as the hypothesis in the [decision pack](../../runbooks/film-person-holdpoint-decision-pack.md); the count is a **modelled figure, not a live production fact**.

## Method and what "safe copy" means here

The state is built from the repository's own fixtures: the sqlite3-CLI D1 stand-in on the real migration chain `0001` to `0019` (schema 19, the state production is documented to have after H0), marker `prepared`/open/generation 1 with baseline `verified`, `film_rated_admission`, `film_retention` and `tmdb_retirement_decision` empty (0 rows), `canonical_revision` 0 rows, no receipts, lease free, window idle. This is the fixture of [the readiness test](../../../tests/canonical-handoff-readiness.mjs) (`fresh()` of [the differential helper](../../../tests/canonical-differential-helper.mjs)), the real registries (`PRODUCER_WIRING`, `PRODUCER_OPERATIONS`, `CANONICAL_READER_REGISTRY`, `EMPTY_CLASSES`, the two exception lists), no `evidence` override, and `now` fixed to `2026-11-12T12:00:00.000Z`. It reads no production data, so it is evidence about the **code and registries**, not about the live database. The test asserts the same blocker list on every run, so a registry change that moves the count fails that test.

Reproduce (offline; builds the chain once, about a second): import `fresh` and `envOf` from `tests/canonical-differential-helper.mjs` and `handoffReadiness` from `src/canonical-producers.js`, then call `handoffReadiness(envOf(fresh()),{now:'2026-11-12T12:00:00.000Z'})` and pass the result to `classifyBlockers` of [the classification helper](../../../src/canonical-readiness-classes.js).

## Exact recomputed output

`ready:false`, 29 blockers, `gaps: []` (the seven former producer gaps are all cleared by the differential coverage registry), `clearedGaps: 7`. No `marker_*`, `baseline_*`, `schema_*`, `projector_*` or `receipts_schema_*` blocker is present: `receipts_schema_missing` is gone because the modelled schema is 19.

| Count | Blocker kind | Names (exact) |
| --- | --- | --- |
| 10 | `exception_not_accepted:` | `blank_never_overwrites`, `reviewed_owner_rows_protected`, `redirected_film_refused`, `credits_not_pruned_by_the_planner`, `external_ids_not_pruned_by_the_planner`, `updated_at_is_write_time`, `held_localization_not_recorded`, `noop_write_keeps_updated_at`, `canonical_identity_requires_trusted_tmdb`, `credit_ordinals_kept` |
| 1 | `receipts_protocol_unregistered` | (no atomic operation in `PRODUCER_OPERATIONS`) |
| 4 | `producer_not_wired:` | `epg_commit`, `metadata_sync`, `discovery_admission`, `rated_admission_retention` |
| 11 | `reader_not_moved:` | catalog film route optional `metadata.json`; catalog available route `metadata.json`; `ratingsFilmLabels` `metadata.json` and `titles.json`; `metadataSync` working set (writer); `epgSync` title and people localization (writer); admin read; admin limbo; admin health source list; admin Letterboxd archive `metadata.json`; footer `metadata.json`; migration export of the mirrors (group global) |
| 3 | `empty_class_not_loaded:` | `ratedAdmission:0/708`, `retention:0/401`, `retirement:0/4` |
| **29** | | 10 + 1 + 4 + 11 + 3 |

Against the decision pack: its 30-blocker text (11 Nov 2026, schema 18) listed one more, `receipts_schema_missing`, which H0 cleared; the other 29 are the same by name and count. The "expected 29" hypothesis is therefore **reproduced by the model**, with the caveat above.

## Classification of every blocker

`classifyBlockers` (new, pure, dormant) groups the strings as follows; the verdict and the computation of `handoffReadiness` are untouched.

| Class | Blockers | Count |
| --- | --- | --- |
| `registry_code` | `receipts_protocol_unregistered`, 4 `producer_not_wired:*` | 5 |
| `data_load` (data/H1) | 3 `empty_class_not_loaded:*` | 3 |
| `owner_exception` | 10 `exception_not_accepted:*` | 10 |
| `read_move` | 11 `reader_not_moved:*` | 11 |
| `operational_state` | none in the modelled state | 0 |
| `unclassified` | none | 0 |

### 1. Registry/code (5)

| Blocker | What clears it | Stage (the proposed ADR 0128 plan, S4 to S5; AIR-374 task plan P3) |
| --- | --- | --- |
| `receipts_protocol_unregistered` | At least one `atomic:true` operation in `PRODUCER_OPERATIONS` (derived, never a flag). The first producer PR that registers its operations clears it. | S5-1 (EPG wiring); also P3b to P3d for the other producers. Schema 19 is applied, so ADR 0119 no longer blocks it. |
| `producer_not_wired:epg_commit` | Re-derive `requires` from the kinds the EPG producer really uses, register an atomic operation for each, and bundle the modules. `person_mutation` has no producer yet. | S4-1 to S4-4 (pure plan module, migration `0020` file, store, durable driver), the `0020` apply holdpoint, S5-0 (`person_mutation`), then S5-1 (wiring, dormant at `prepared`). |
| `producer_not_wired:metadata_sync` | Wire `metadataSync` with its four kinds (`film_metadata`, `film_sync_state`, `localization_source`, `localization_conflict`). | P3b (not in the ADR 0128 plan, which covers EPG only). |
| `producer_not_wired:discovery_admission` | Wire Discovery catalog admission (`film_mutation`). | P3c (not in the ADR 0128 plan). |
| `producer_not_wired:rated_admission_retention` | Wire rated admission and retention (`film_admission`, `film_retention`). | P3d (not in the ADR 0128 plan). |

ADR 0128 is a proposal on its own branch at the time of writing and is not on `main`; the stage names are those of its staged plan, and this page claims nothing about whether it is accepted.

### 2. Data/H1 (3)

| Blocker | What clears it |
| --- | --- |
| `empty_class_not_loaded:ratedAdmission:0/708`, `retention:0/401`, `retirement:0/4` | The H1 live load of 1,113 rows (708 + 401 + 4) into `film_rated_admission`, `film_retention` and `tmdb_retirement_decision` while `prepared`, under a separate owner GO with a fresh source snapshot and plan digest. The expected counts are accepted data in `EMPTY_CLASSES`; if a fresh snapshot gives a different count, that is a new count the owner must accept and a registry change, not a silent edit. Not a code change; not authorized by this page. |

### 3. Owner exceptions (10): drafts, none accepted

All ten are `status:'draft'` in the registries today (`blank_never_overwrites`, `reviewed_owner_rows_protected` and `redirected_film_refused` in `P6_DIFFERENTIAL_EXCEPTIONS` of `src/canonical-film-writers.js`; the other seven in `EXTRA_EXCEPTIONS` of `src/canonical-differential-registry.js`). Two more in the writers list, `sync_null_clock_keeps_stored` and `identity_provenance_title_source`, are already `accepted` and are not blockers. The owner decided on 12 Nov 2026 that each draft is reviewed individually, never as a group. **The "preferred direction" column is the Controller's stated lean for the review, not an owner acceptance and not a proposal to flip any status.** Clearing one means either a small PR that sets `status:'accepted'` after the owner decides (ADR 0128 plan S5-2), or a writer change that removes the difference.

| Exception (registry status `draft`) | Difference (from the registry rule) | Preferred direction (Controller lean; NOT acceptance) |
| --- | --- | --- |
| `blank_never_overwrites` | A blank incoming value keeps the stored one; the projector overwrites. | Protect: keep the canonical behaviour. |
| `reviewed_owner_rows_protected` | A reviewed or owner row is never replaced by an automatic write; the projector guards only localization. | Protect: keep the canonical behaviour. |
| `redirected_film_refused` | A redirected Film is refused; the projector skips membership release silently. | Protect: keep the canonical behaviour (refuse). |
| `canonical_identity_requires_trusted_tmdb` | Canonical identity is written only when the Film holds that TMDB id as a trusted, non-conflicting external id; the projector writes the identity it is given. | Trusted TMDB only: keep the canonical behaviour. |
| `credits_not_pruned_by_the_planner` | The planner only upserts credits; the projector rewrites the whole list, so a dropped credit stays. | Keep (no pruning) while there is no deletion policy. |
| `credit_ordinals_kept` | Canonical writers keep an existing ordinal and append after the highest of its role; the projector renumbers. | Keep (no renumbering) while there is no deletion policy. |
| `held_localization_not_recorded` | When a reviewed or owner localization holds, the projector also records the held automatic value as an alias and a `localization_conflict` row; the canonical facts writer records neither. | Prefer FIXING the loss: have the producer record the alias and conflict evidence (a code change), rather than accepting the loss. |
| `updated_at_is_write_time` | Projector stamps the source's update time and leaves an unrewritten Film alone; canonical writers stamp write time, so an unchanged entity is restamped. | Needs a substantive analysis first (who reads `updated_at`, whether restamping changes any reader, projector, EPG or ordering behaviour). No direction yet. |
| `noop_write_keeps_updated_at` | A canonical call whose rows are all stored writes nothing and so does not restamp; the projector rewrites with the newer source time. | The Controller named no direction; it is the mirror image of `updated_at_is_write_time` and belongs in the same analysis. |
| `external_ids_not_pruned_by_the_planner` | The planner only upserts external ids; the projector replaces the full set. | Needs a substantive analysis first (stale-id harm, trust of dropped ids, interaction with the trusted-TMDB rule). No direction yet. |

### 4. Read-move (11): registry entries of `CANONICAL_READER_REGISTRY`

All 11 are `class:'freeze'`, `moved:false`. Already moved (`moved:true`, not blockers): the catalog film rated-archive fallback, `/api/d1/*` catalog routes, programme `titles.json` and watchlist `titles.json`. Stages follow the AIR-374 task plan: P4c-1 admin readers, P4c-2 ratings/film readers, conditional P4c-3 `catalogLidTmdb`, P4c-4 registry. Those are planned scopes, not necessarily existing PRs; assigning an entry to one is this page's reading, not a decision.

Decision E1 (12 Nov 2026): `metadata.json` is the live, D1-authoritative **metadata-cache mirror** and an exception under [ADR 0073](../../adr/0073-metadata-cache-d1-authority.md); `titles.json` and `people.json` stay frozen at `open`. An entry becomes an exception only if its **actual read semantics** are the metadata cache. No entry is reclassified by this page: today's 11 blockers stand until a registry change after the P4c audit.

| Reader (file) | Reads | Class today | Would move in | E1 note |
| --- | --- | --- | --- | --- |
| catalog film route optional `metadata.json` (`src/worker.js`) | `metadata.json` only | freeze, not moved | P4c-2 | Exception candidate: metadata-cache semantics (an optional poster/metadata fallback). Audit confirms. |
| catalog available route `metadata.json` (`src/worker.js`) | `metadata.json` | freeze, not moved | P4c-2 | Exception candidate, same audit; it also feeds `catalogLidTmdb`. |
| `ratingsFilmLabels` `metadata.json` and `titles.json` (`src/worker.js`) | `metadata.json` and `titles.json` | freeze, not moved | P4c-2 | Mixed: the `titles.json` part is frozen at open and must read D1; the metadata part may be an exception. Likely stays a move. |
| footer `metadata.json` (`src/enrichment.js`) | `metadata.json` (with programme, watchlist) | freeze, not moved | P4c-2 (the plan names no separate stage; this is a reading) | Exception candidate: metadata-cache semantics. Also a `catalogLidTmdb` consumer. |
| admin read `titles.json`, `people.json` (`src/admin/read.js`) | `titles.json`, `people.json` | freeze, not moved | P4c-1 | Not metadata cache: stays a move to D1. |
| admin limbo `titles.json`, `people.json` (`src/admin/limbo.js`) | `titles.json`, `people.json` | freeze, not moved | P4c-1 | Not metadata cache: stays a move to D1. |
| admin health source list `titles.json`, `people.json` (`src/admin/health.js`) | source list naming the dictionaries | freeze, not moved | P4c-1 | Not metadata cache: stays a move (or a source-list change). |
| admin Letterboxd archive `metadata.json` (`src/admin/letterboxd-archive.js`) | `metadata.json` | freeze, not moved | P4c-1 | Exception candidate: metadata-cache semantics; admin stage. Audit confirms. |
| `metadataSync` `titles.json`, `people.json`, `metadata.json` working set, writer (`src/worker.js`) | writer and reader of all three | freeze, not moved | Not named in the plan; follows the metadata producer (P3b) and the P4c-4 registry change | Mixed: the metadata part is metadata-cache; the dictionary part is frozen at `open`. |
| `epgSync` title and people localization, writer of `titles.json`, `people.json` (`src/worker.js`) | writer of the dictionaries | freeze, not moved | Follows the EPG producer wiring (S5-1) and P4c-4 | Dictionaries: frozen at `open`; not metadata cache. |
| migration export of the mirrors, group `global` (`src/enrichment.js`) | exports `metadata.json`, `titles.json` among other objects | freeze, not moved | P4c-4, with an explicit classification of this diagnostic export | The E1 decision requires the export to be classified explicitly in the audit. |

`catalogLidTmdb` (P4c-3) is conditional: the catalog available route and the footer pass it `metadata.json`; if E1 makes those reads exceptions, P4c-3 may be unnecessary.

### 5. Ops/H2: required for H2, but NOT blockers of `handoffReadiness`

These do not appear in the 29 and `classifyBlockers` has nothing to classify for them (class `operational_state` is 0 in the model). They block the H2 holdpoint, not the computed verdict; clearing all 29 is necessary, not sufficient.

| Item | What is missing | Depends on |
| --- | --- | --- |
| Activation tooling | `scripts/film-person-open-handoff.mjs` (named in ADR 0117) does not exist in `scripts/`; no tool emits the preflight reads, the single flip batch and its readback. | All 29 cleared, a reviewed design, independent review before any GO. |
| Safe-copy held drill | The drill harness is not shipped (procedure only in the open handoff runbook). Needs a safe copy and the drill passing. | Activation tooling for the flip, and a safe copy. |
| Mirror inventory | The frozen-mirror classification object by object (ADR 0117 decision 3) is not recorded. | The P4c audit (E1) and the diagnostic-export classification. |
| Atomic lease, window and baseline assertions | `transitionAuthority` asserts none of them, and the 0013 trigger checks the baseline only when leaving `r2`; the flip batch must assert them itself. | New reviewed code in the activation tooling. |
| `recordBaseline` emitter | `recordBaseline` in `src/canonical-receipts.js` takes a D1 binding and has no operator emitter or CLI. | The activation tooling, after the flip (the baseline tables accept inserts only at `open`). |

## Limits and next steps

- **Modelled figure.** 29 comes from the repository's registries and fixtures. It is not a live reading of production; production could differ (for example a row count, the baseline state or the lease). A **live** `handoffReadiness` needs a separate, scoped read-only owner GO when it is needed for H2; it was not run and was not requested here.
- The 11 read-move blockers and the 10 exceptions are unchanged by this page. Exception-candidate notes in section 4 are readings of the code, to be confirmed by the P4c audit, and change nothing.
- The classification helper is a reporting aid only. It does not feed `handoffReadiness`, is not bundled and cannot clear or add a blocker.

Verdict: `handoffReadiness` stays not ready. Registry: [evidence index](README.md).
