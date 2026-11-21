# AIR-551: EPG checkpoint cutover to D1 (H2 to H4b)

Date: 21 Nov 2026, 18:04-18:47 UTC (19:04-19:47 Madrid, UTC+01:00). Owner GO: "GO на H2-H4" in the AIR-551 session, with stop-on-failure and no retries. The operator is `scripts/epg-checkpoint-production.mjs`; every command ran once, credentials from the environment, only sizes, ETags and digests printed. No payload is recorded here.

## Result

**The EPG run checkpoint (`sync.json`) and the ingest status (`watchlist-ingest.json`) are D1-authoritative.** Marker `epg_checkpoint_authority` = `d1` / `open` / generation 2, read back by the operator `status` and by a direct D1 `SELECT`. R2 objects are frozen as of the import and unchanged. The first natural run on D1 (22 Nov 2026 16:00 UTC, 17:00 Madrid) is **not yet observed**; that is H5.

## Preconditions (T-0 before H2)

- Schema 33 (migration 0030 applied on 21 Nov, [0030 evidence](air-551-0030-apply-2026-11-21.md)); marker `r2` / `open` / 0, checkpoint tables empty.
- Drain proof (hold): the same-day run `7bce173c-2cfe-420d-baaf-efebced1b410` complete, lease released, phase `done`, pause clear, no event debt, orchestration mode `cloudflare`, instance finished, inventory of the six non-terminal Workflow statuses = 0, one deployment at 100% built from a commit containing routing commit `28f6737b`, next start 16:00 UTC next day (well above 30 minutes). Historical control version pinned, not compared with the deployed one ([ADR 0189](../../adr/0189-h0-checks-compatible-deployment-not-version-equality.md)).
- Frozen R2 identities: `sync.json` ETag `a4f27097ce9c159b855c19fcd3837a9b`, SHA-256 `608a2a260a87afbb222110c887df4b05cc072bdec645a4da4c278666b89ff42b`; `watchlist-ingest.json` ETag `77a2d6f7ab36ec6d6de3de2931bb1c89`, SHA-256 `ac846988fcdc29d6b0722acad3c2b55a04781a7848f7bca29e97b95e60b5ca91`.

## Steps

| Step | UTC | Command | Outcome |
|---|---|---|---|
| H2 hold | 18:06:38 | `--hold --expect-generation 0` | committed; marker `r2/held/1`; bookmark `000009fe-00000000-0000512a-b186…` |
| H3 import | 18:07:10 | `--import --expect-generation 1` + four identity flags | committed; `parity: verified`, 1 body chunk, ingest imported; bookmark `000009fe-00000002-…` |
| H4a activate | 18:07:23-29 | `--activate --expect-generation 1` + identity flags | transition **committed** (marker `d1/held/2`), operator exited 1 `reason: failed` (see below); bookmark `000009fe-00000004-…` |
| H4b release, attempt 1 | 18:33:29 | `--release --expect-generation 2` | refused **before any write**: `checkpoint_unavailable`, `writeState: none` (see below) |
| H4b release, attempt 2 | 18:47:04 | `--release --expect-generation 2` | committed; marker `d1/open/2`; bookmark `00000a0b-00000012-0000512a-f37c…` |

## Two operator defects found during the run

Both were in the operator's REST binding, not in the data or the repository code, and both were invisible to the offline suite because the sqlite stand-in returns rows from `db.batch` directly.

1. **H4a read-back.** `Checkpoint.loadRun` reads through `db.batch([...SELECTs])`; `createPublishedBinding.batch` executed writes only and returned nothing, so the post-activation read-back raised and the operator reported `failed` after the transition had committed. Stopped without retry or manual SQL. Read-only checks showed marker `d1/held/2`, fence 1, the run complete with body SHA-256 `608a2a26…` equal to R2, 1 body row, 0 film rows, 1 receipt, 1 ingest row; the repository's own `loadRun` against production returned ok. Fixed in PR #868 (a SELECT-only `readBatch` on the D1 adapter, returned rows from all-SELECT batches).
2. **H4b attempt 1.** The operator hands the binding `trackProductionWrites(adapter)`, which did not pass `readBatch` through; `loadRun` swallowed the TypeError as `unavailable` and `--release` stopped before writing. Marker stayed `d1/held/2`. The regression test of #868 had built the binding over the raw adapter. Fixed in PR #869 (passthrough) with a test over the operator's real wrapper chain, red without the fix.

Both fixes were reviewed independently, merged by the Controller after green exact-head CI, and deployed (`f481bc28`, all four post-merge jobs green) before the second release. Merging inside the agreed no-deploy window was an owner-granted narrow exception for these two operator-only PRs; unrelated PR #859 (AIR-575) was also merged in the window and cancelled the first post-merge run of #868, so the deployed state was re-verified before release.

## Read-back after release (18:47 UTC and after)

- Operator `status`: schema 33, marker `d1` / `open` / generation 2, fence `cas` 1; run `7bce173c-…` stage `complete`, body SHA-256 `608a2a26…`; counts run 1, body 1, film 0, receipt 1, ingest 1; orchestration `cloudflare`, phase `done`, lease released.
- Direct D1 `SELECT` of `epg_checkpoint_authority`: `d1` / `open` / 2.
- R2: `sync.json` and `watchlist-ingest.json` ETags unchanged (`a4f27097…`, `77a2d6f7…`).
- Deployment at release: one version at 100%, created 18:44 UTC; zero non-terminal instances of `iptv-epg`.

## Limits and residual risk

- **Unproven until the natural run (H5):** the real film count and largest film entry (O2), Worker CPU and memory, and queries per invocation on the D1 path. There is no mid-run rollback; rollback after the run starts is the fenced `--hold-rollback` / `--export-rollback` / `--revert-authority` procedure of the [runbook](../../runbooks/epg-checkpoint-d1.md).
- R2 is frozen, not retired: H6 (removing the R2 arm) is a separate gate.
- Maintained docs and diagrams are updated after H5 observes the natural run, not on this record alone.
