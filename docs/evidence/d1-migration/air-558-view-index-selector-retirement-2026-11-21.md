# View index selector and raw object retirement: delivery evidence

**Date:** 2026-11-21 UTC. **Source tree:** `main` `668d069` plus the AIR-558 change (uncommitted at the time of writing; the pull request carries the exact tested SHA). **Work:** [AIR-558](https://trello.com/c/eSs4w27U); decision [ADR 0192](../../adr/0192-retire-view-index-selector-and-raw-object.md) (Proposed until the owner merges); executes the retirement step that [ADR 0183](../../adr/0183-view-index-membership-from-d1-rows.md) deferred; read-source rollout accepted by the owner on [AIR-552](https://trello.com/c/Hk2dJf2U).

## Scope and evidence boundary

Repository change and documentation only. **No production operation was performed for this report: no read, no write, no flag or binding change, no migration, no R2 operation, no deploy.** Statements about production in this note are limited to what ADR 0192 records: the owner set the selector to `d1` on 20 November 2026 and accepted the rollout on 21 November 2026. The current production value of the `VIEW_INDEX_SOURCE` binding was not read for this report and is not asserted.

## Delivered in code

- The view index is **always** derived from D1 (`derivedViewIndex` in `src/worker.js`; `footerViewIndex` in `src/enrichment.js`; Admin health, Admin limbo and prediction recovery; `LetterboxdFacts.readJSON` ratings-only). There is no selector and no raw fallback; a domain that is not authoritative refuses with its own code (503).
- `VIEW_INDEX_SOURCE` stays in the `feature_flags` registry as retired (`retired: true`, `effective: null`). A set binding is inert and `r2` is no rollback; absence is the target state.
- `GET /api/enrichment/diagnostics/export` group `global` no longer returns the raw view-index object.
- `POST /api/enrichment/moods/backfill` and `POST /api/enrichment/fingerprint-view/backfill` answer `410 Gone`.
- A Letterboxd projection that the ratings domain does not own (marker not `d1` and open) projects nothing (`changed: 0`); the only remaining `view_index_not_owned` refusal is a direct compare-and-swap on the view-index key, which no production caller makes.

## Inventory of retired raw paths

| Kind | Retired item |
| --- | --- |
| Read selector | `VIEW_INDEX_SOURCE` (`viewIndexSource`, `viewIndexIsD1`); the `r2` branch of every reader |
| Raw readers | `loadJSON` raw base plus overlays, the footer streaming reader over the raw object, the raw branches of Admin health, Admin limbo and prediction recovery, the raw reader of the Letterboxd facts layer, the raw object of the `global` diagnostics export |
| Raw writers | `updateViewIndex` (prediction submit, batch submit, fingerprint write), `ensureInitialRatings`, the mood backfill, the fingerprint-view backfill, the Letterboxd compare-and-swap writers on the view index (`projectRecords` raw branch, the removed-film restore of raw fields in the Letterboxd rollback) |
| Routes | `POST /api/enrichment/moods/backfill`, `POST /api/enrichment/fingerprint-view/backfill` (now `410 Gone`) |

## What remains

- The raw R2 object `enrichment/view-index.json` is **not deleted** and still exists in the bucket and in snapshot exports. It is stale from the first deploy of this change on and must not be used as a source unless rebuilt from D1.
- The Cloudflare binding `VIEW_INDEX_SOURCE` is **not removed** by this change (`keep_vars: true`). Its removal and a `feature_flags` readback of `state: absent` are a separate owner decision.
- `scripts/r2-snapshot-export.mjs` still copies the bucket, raw object included. The four Letterboxd operator scripts are to require `--view-index-d1 <file>` from `scripts/view-index-d1-export.mjs` (that script change is delivered separately from these documentation updates).
- The local development store (`scripts/local-store.mjs`, `scripts/local-fixtures.mjs`) still writes a stand-in `enrichment/view-index.json`; the Worker never reads it; they serve operator tools and snapshot import only.
- **Local development degrades.** After this change the local stack serves programme, started and admin reads, but `/api/enrichment/view`, Finds and the footer refuse with `502` or `503`: the view index is derived from D1 and local development has no authoritative D1. A D1 that satisfies the ratings contract also forces the published-EPG authority ([ADR 0162](../../adr/0162-d1-only-authority-retire-rollback-toolchain.md) stand-ins apply only while those tables are absent). The owner accepted this temporary limitation on the PR (21 Nov 2026); restoring the full local D1 and R2 environment is [AIR-576](https://trello.com/c/ONq20jy9), without a production raw fallback or a new local runtime flag.
- The simple rollback to `r2` is gone. Returning to the raw object needs an owner-approved plan (restore the code, set the binding, rebuild the object from D1); none exists as a routine.
- Dated verification is pending: post-merge CI and deploy, and the `feature_flags` readback after the binding removal. The residual HTTP 5xx and `exceededMemory` risk accepted on AIR-552 is neither caused nor cured by this change and needs its own RCA.

## Documentation updated

[View index contract](../../reference/domain/view-index-read-model.md), [feature flag contract](../../reference/feature-flags.md), [view index source runbook](../../runbooks/view-index-source.md) (retired as an operating runbook), the API, data, domain and integration references and architecture pages that described the raw object or its writers, and the runbooks that named it as a current dependency. Dated evidence and archive files were left untouched as historical records, including [the field audit](air-552-view-index-field-audit-2026-11-20.md) and [the read source implementation](air-552-d1-read-source-implementation-2026-11-20.md).
