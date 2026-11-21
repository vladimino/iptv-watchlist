# View index selector, raw object and Letterboxd rollback retirement: delivery evidence

**Date:** 2026-11-21 UTC. **Source tree:** `main` `668d069` plus the AIR-558 change (uncommitted at the time of writing; the pull request carries the exact tested SHA). **Work:** [AIR-558](https://trello.com/c/eSs4w27U), pull request [#865](https://github.com/vladimino/iptv-watchlist/pull/865); decision [ADR 0192](../../adr/0192-retire-view-index-selector-and-raw-object.md) (Accepted); executes the retirement step that [ADR 0183](../../adr/0183-view-index-membership-from-d1-rows.md) deferred; read-source rollout accepted by the owner on [AIR-552](https://trello.com/c/Hk2dJf2U).

## Owner approvals

- Scope approved on 2026-11-21 (Europe/Madrid) as the combination A, B, A, A, C: [Trello comment](https://trello.com/c/eSs4w27U#comment-6b01ff797b847672337b5e6f) and [pull request comment](https://github.com/vladimino/iptv-watchlist/pull/865#issuecomment-7068807276).
- D1 read-source rollout accepted on [AIR-552](https://trello.com/c/Hk2dJf2U), with the residual HTTP 5xx and `exceededMemory` risk recorded there.
- Accepted explicitly: the loss of the simple R2 rollback with no replacement D1 to R2 rebuild developed, and the retirement of the Letterboxd rollback and unlink without a dedicated reversal.
- The temporary local development limitation was accepted on the pull request (21 Nov 2026); restoring the full local environment is [AIR-576](https://trello.com/c/ONq20jy9).

## Scope and evidence boundary

Repository change and documentation only. **No production operation was performed for this report: no read, no write, no flag or binding change, no migration, no R2 or D1 operation, no data deletion, no deploy.** Statements about production are limited to what ADR 0192 records: the owner set the selector to `d1` on 20 November 2026 and accepted the rollout on 21 November 2026. The current production value of the `VIEW_INDEX_SOURCE` binding was not read for this report and is not asserted.

## Delivered in code

- The view index is **always** derived from D1 (`derivedViewIndex` in `src/worker.js`; `footerViewIndex` in `src/enrichment.js`; Admin health, Admin limbo and prediction recovery; `LetterboxdFacts.readJSON` ratings-only). There is no selector and no raw fallback; a domain that is not authoritative refuses with its own code (503).
- `VIEW_INDEX_SOURCE` stays in the `feature_flags` registry as retired (`retired: true`, `effective: null`). A set binding is inert and `r2` is no rollback; absence is the target state.
- `GET /api/enrichment/diagnostics/export` group `global` no longer returns the view index.
- Both legacy backfill routes are removed entirely and answer an ordinary 404.
- The four operator scripts keep the mandatory explicit `--view-index-d1 <D1 export file>` input.
- A Letterboxd projection that the ratings domain does not own (marker not `d1` and open) projects nothing (`changed: 0`).
- The Letterboxd archive rollback and the inferred-film unlink are retired. The apply capability's compensation kind is `none`, and the page says «Отменить изменение будет нельзя.»; receipt copy says «Итог — в квитанции.» and «Эта партия уже есть в квитанции импорта. Повтор записи идемпотентен.».

## Inventory of retired operations

| Kind | Retired item |
| --- | --- |
| Read selector | `VIEW_INDEX_SOURCE` (`viewIndexSource`, `viewIndexIsD1`); the `r2` branch of every reader |
| Raw readers | `loadJSON` raw base plus overlays, the footer streaming reader over the raw object, the raw branches of Admin health, Admin limbo and prediction recovery, the raw reader of the Letterboxd facts layer, the raw object in the `global` diagnostics export |
| Raw writers | `updateViewIndex` (prediction submit, batch submit, fingerprint write), `ensureInitialRatings`, the mood backfill, the fingerprint-view backfill, the Letterboxd compare-and-swap writers on the view index |
| Enrichment routes | `POST /api/enrichment/moods/backfill`, `POST /api/enrichment/fingerprint-view/backfill` (ordinary 404) |
| Baseline CLI | commands `rollback` and `unlink`, the `rollback.json` output file, the `--lid` option |
| Baseline Worker routes | `/api/letterboxd/baseline/rollback`, `/api/letterboxd/baseline/unlink` (ordinary 404; `validate` and `commit` remain) |
| Admin archive | capability `letterboxd_archive_rollback`, routes `/api/admin/letterboxd-archive/rollback-confirm` and `/rollback`, action record prefix `admin/actions/letterboxd_archive_rollback/v1/`, candidate rollback `LetterboxdRatedCandidates.rollbackCandidates`, and the page buttons «Подтвердить откат партии N», «Откатить партию N», their retry variants and banners |
| Dedicated reversal code | `RatingsD1.reverseView`, `reverseFacts`, `rollbackBaselineChunk`, `unlinkBaselineFilm`, `unlinkInferred`, and the test `tests/ratings-view-reversal-d1.mjs` |

An earlier iteration of this pull request added a D1 reversal (etag fence and row compare-and-set) for rollback and unlink. It no longer exists, and no document describes it as current.

## Preserved

Archive preview, confirm and commit; validate, replay and resume of an interrupted commit; idempotency; intent and commit receipts, including `viewBefore` (stored `rollback` and `rollback-intent` objects from old receipts stay readable and have no writer); conflict, identity and authority guards; historical `ratingHistory` and `rolled_back` entries (still read and merged); data, provenance and legacy receipts; the other independent correction and recovery operations (owner mark, rating overrides, link repair, identity retry). No production data is deleted. A future repair of a mistaken identity is case-specific and needs a separate owner decision.

## What remains

- The raw R2 object `enrichment/view-index.json` is **not deleted** and still exists in the bucket and in snapshot exports. It is stale from the first deploy of this change on and is not a source.
- The Cloudflare binding `VIEW_INDEX_SOURCE` was **not removed by the code change** (`keep_vars: true`); the owner removed it afterwards as a separate action, read back as absent (section below).
- `scripts/r2-snapshot-export.mjs` still copies the bucket, raw object included.
- The local development store (`scripts/local-store.mjs`, `scripts/local-fixtures.mjs`) still writes a stand-in `enrichment/view-index.json`; the Worker never reads it. **Local development degrades:** `/api/enrichment/view`, Finds and the footer refuse locally with `502` or `503`, because the view index is derived from D1 and local development has no authoritative D1 (AIR-576, unchanged).
- The simple rollback to `r2` is gone and no D1 to R2 rebuild is developed or planned.
- Dated verification of the release and the binding removal is recorded in the section below (appended 2026-11-21, after delivery). The residual HTTP 5xx and `exceededMemory` risk accepted on AIR-552 is neither caused nor cured by this change and needs its own RCA.

## Verification

Checked for this note by reading the working tree against `git diff origin/main..HEAD` and `git diff HEAD` (2026-11-21 UTC):

- The baseline Worker handler answers only `validate` and `commit`; any other action is 404 `Not found` (`src/letterboxd-facts.js`).
- The baseline CLI accepts `plan`, `validate` and `commit` only, and its usage text lists `--view-index-d1` for `plan` (`scripts/letterboxd-baseline-import.mjs`).
- The archive route table in `src/admin/letterboxd-archive-apply.js` contains six routes (apply-confirm, apply, identity-status, identity-step, identity-retry-confirm, identity-retry); no rollback route or capability is registered, and the apply capability declares compensation `none`.
- A search of `src`, `public` and `scripts` finds no caller of the removed reversal functions, no rollback or unlink button copy, and no reference to the two backfill routes; `tests/ratings-view-reversal-d1.mjs` is deleted.
- `node scripts/check-timeless-documentation.mjs` was run on the documentation change (result in the pull request).

Not independently verified here: that every one of the retired names has no remaining mention in dated evidence or archive files (those are historical and were left untouched); the full test and build run on the final head (the pull request carries it); and any production behavior, including that the removed routes answer 404 on the deployed Worker.

## Documentation updated

[View index contract](../../reference/domain/view-index-read-model.md), [feature flag contract](../../reference/feature-flags.md), [view index source runbook](../../runbooks/view-index-source.md) (retired as an operating runbook), [enrichment](../../reference/api/enrichment.md), [admin](../../reference/api/admin.md) and [admin actions](../../reference/api/admin-actions.md) API references, [Letterboxd user facts](../../reference/integrations/letterboxd-user-facts.md), [baseline import runbook](../../runbooks/letterboxd-baseline-import.md), the [Letterboxd ingestion](../../architecture/letterboxd-ingestion.md) sequence and [UI read models](../../architecture/ui-and-read-models.md) pages, and the ADR register (partial supersession notes on ADR 0023, 0053, 0068 and 0104). Dated evidence and archive files were left untouched as historical records, including [the field audit](air-552-view-index-field-audit-2026-11-20.md) and [the read source implementation](air-552-d1-read-source-implementation-2026-11-20.md).

## Production release and binding removal (appended 2026-11-21, UTC)

This section is a dated record added after delivery. The sections above describe the repository change as reviewed and are not rewritten. Sources: the Controller's and the owner's records on [AIR-558](https://trello.com/c/eSs4w27U) ([release comment](https://trello.com/c/eSs4w27U#comment-6b0206a1559105b36222070d), [handoff comment](https://trello.com/c/eSs4w27U#comment-6b0207ca1deca2ba5a9ca85d)), not a new production read by this change.

| Item | Recorded value |
| --- | --- |
| Pull request | [#865](https://github.com/vladimino/iptv-watchlist/pull/865), squash commit `7f989b63452650095919451b436b1d5f60709f4f`, `main` at the same commit |
| CI and deploy | [Run 44949097196](https://github.com/vladimino/iptv-watchlist/actions/runs/44949097196) on that commit: `Test and build`, `Test shard 2 of 3`, `Test shard 3 of 3` and `Deploy to Cloudflare` completed with success |
| Deployed version | Worker `iptv` version `bb05bf88-54b3-4b67-9c30-f2a8cc283990`, uploaded and deployed 21:00:56 UTC by the deploy log; Cloudflare deployment `49dffb84-7ea1-43cd-82bf-82da91a51e05` of 21:00:53 UTC with 100% traffic and the annotation of #865 |
| Readback on the released version | Owner-only MCP `feature_flags`: `VIEW_INDEX_SOURCE` `state: set`, `raw: d1`, `valid: false`, `issue: retired`, `effective: null`, `retired: true`. The binding was inert |
| D1 after the deploy (read-only, `changed_db: false`) | schema 33; prediction authority `d1`, writes `held`, generation 35940; ratings authority `d1`, cutover `open`, generation 4220; `prediction_pointer`, `prediction_fingerprint` and `ratings_view` rows 5350, 5350 and 4497, unchanged by the deploy |
| Binding removal | Done by the owner in the Cloudflare Worker `iptv` settings after the release, authorized on AIR-558. The exact time of the action is **unknown**; the readback below was recorded on AIR-558 at 21:06 UTC, after the release readback of 21:01 UTC |
| Readback after the removal | Owner-only MCP `feature_flags` (independent of the owner's action): `state: absent`, `raw: null`, `effective: null`, `retired: true`, `valid: true`, `issue: null` |
| Raw R2 object | `enrichment/view-index.json` retained, not read and not written by the Worker; no R2 or D1 operation was performed for this retirement beyond the ordinary deploy |

Limitations. The `feature_flags` tool reads the Worker bindings only; it does not show when the binding was removed and does not prove any live route behavior. No live HTTP call to a retired route (a `404`) and no production UI check was made for this record, and none is claimed. The binding removal changed no behavior, because the released version already ignored the binding. A new stabilization window is not required by the owner. The residual HTTP 5xx and `exceededMemory` risk accepted on [AIR-552](https://trello.com/c/Hk2dJf2U) is neither caused nor cured by this change and remains for its own RCA.
