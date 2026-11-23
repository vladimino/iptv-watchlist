# AIR-554: first successful cold `T_cut` of the production R2 auxiliary scope (23 Nov 2026)

[AIR-554](https://trello.com/c/UrS1gflv) · observation 10:15-10:18 UTC, 23 November 2026. One bounded **read-only** cold export series under the owner's explicit GO in the AIR-554 thread, as requested in the [handback](https://trello.com/c/UrS1gflv#comment-6b040e3f130f3c8862171618) and accepted as a GO-request by the [coordinator](https://trello.com/c/UrS1gflv#comment-6b04107e38e2cba30f33ce35). Counts, bytes, hashes, times and statuses only; no object keys of private data, bodies, run ids or tokens. The snapshot and the converted tree stay in a private directory outside the repository. **P3 stays OPEN**; this authorizes no production operation.

## What was done

Code: `main` at `e883610f`. Preflight by read-only D1 `SELECT` only (the two lease rows and the latest `prediction_run`): the latest run was `complete`, stop reason `manifest_spent`, at 10:14:39 UTC, runner and writer lease released (`expires_at` 0). The export started at 10:15:54 UTC, 75 seconds after that run ended. S3 `ListObjectsV2`, `HeadObject` and `GetObject` on bucket `iptv` with the owner-issued read-only, bucket-scoped credential from the environment (never printed). No write to R2 or D1, no migration, marker, Task, Workflow, flag, Access or lease change.

Commands, in a new and empty private output directory (0 files before the start): `node scripts/r2-snapshot-export.mjs --output <dir> --scope prediction-aux --concurrency 16` (with `NODE_USE_ENV_PROXY=1`), then `--verify --scope prediction-aux`, then `node scripts/prediction-aux-export-convert.mjs <dir> <converted>`.

## Result (one attempt, cold, `consistent_fenced`)

| Step | Duration |
| --- | --- |
| export | 109.3 s (10:15:54 to 10:17:43 UTC), exit 0, no NO-GO reasons |
| verify | 0.50 s, same status and aggregate |
| converter | 0.72 s, exit 0 |
| **`T_cut` = export + verify + converter** | **110.5 s = 1.84 min** |

- Objects 2,101, bytes 37,479,543, aggregate SHA-256 `9bc94bd34761c20d90c9442956318eb64a69e2cd73e5841e3f8f8daa47114189`, scope digest `7a5d4116be42d58a8d2c81c7dc2df94b206dfd8f3d4a1c5c7702b30c1584e067` (the 22 Nov cut had 1,947 objects and 34.8 MB).
- Calls: list 8, head 4,210, get 2,101, total 6,319 (limit 7,000); read 37.5 MB (limit 60 MB). About 58 requests per second at concurrency 16, against about 12.7 at concurrency 4 on 22 Nov.
- **Cold:** `resumed` 0 and `get` equals the object count, so no checkpoint was reused. This is the first successful cold measurement; the 22 Nov numbers (warm 2 min 21 s, rejected near-cold 7 min 37 s) are not comparable.
- Fence: the ETag of both lease objects was unchanged between the opening and the closing inventory; no object of the scope changed. No HTTP 401, 403, 429 or 5xx and no network error; concurrency was not changed.
- After the cut (10:18 UTC) a new run had taken the runner lease: the next Task run started about 2.5 minutes after the previous one ended. The previous run lasted from 10:06 to 10:14 UTC, longer than the usual few minutes, and delayed the start of this series.

## P3 with the measured `T_cut` (provisional)

`S = 5 + T_cut + K*T_chk + 1 + M*T_slc`, `F = S + T_cut + 5`, with `T_cut` 1.84 min used for both cuts (the second one may be faster) and `K = M = 7` (a growth margin over the real 6 and 6). The per-unit tiers come from the [scratch measurement](air-554-p3-scratch-d1-measurement-2026-11-23.md): observed maximum 6.52 and 6.57 s, a p99 model of 8.2 s, a stress case of 19.7 s.

| Tier | S (min) | F (min) | `now+A` must be at most (S bound / F bound) |
| --- | --- | --- | --- |
| observed maximum | 9.37 | 16.21 | 20.6 / 28.8 |
| p99 model | 9.75 | 16.59 | 20.3 / 28.4 |
| stress | 12.44 | 19.28 | 17.6 / 25.7 |

The `S` bound is the binding one in every tier. These are sensitivity figures, not proven upper bounds.

## Limits of this measurement

- One attempt (n = 1); the variability of a cold cut is unknown.
- The network path is the agent sandbox through an HTTPS proxy; the owner's machine and another time of day will differ.
- The dataset keeps growing and `T_cut` grows roughly with the object count; the window will see a larger one.
- Not measured: the `closed` step, the drain wait, the real `A`, D1 under production load (P5), the per-unit `appliedNow[].ms` on production D1, and a second cut taken after a first one.
- The series did not exercise a NO-GO path: it ended at the first `consistent_fenced`.

## Residual gates (unchanged)

P3 (worst-case units on production D1, `A`, drain, owner acceptance of the window), P4 (the standing choice of scope), P5, P6 (`0034` and `0035` not applied to production), P7, P8 are open. The credential is not used again; its revocation is the owner's action. The private directories stay until the owner says "приёмка".
