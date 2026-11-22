# AIR-571: Watchlist bootstrap import (B) and authority activation (C1 and C2)

Date: 22 Nov 2026 (Madrid is UTC+01:00). **Operations:** the bootstrap import B about 16:48 to 16:50 UTC (17:48 to 17:50 Madrid); the first C1 attempt and its back-out after 16:50 and before 17:08 UTC; the second C1 and C2 pass from 17:08:04 UTC (the `status` that opened it) to about 17:10 UTC, by the machine clock. **Later read-only validation:** the independent readbacks right after each step, and one `GET /api/watchlist` after the switch, before 17:27 UTC; the exact time of that request was not recorded. The rounded times in the AIR-571 card comments (up to about 17:16 and 17:25 UTC) were estimates, not receipts. Owner GO per operation on the card: "GO на B", "GO на C1+C2", then "да, откатывай" and "еще одна попытка активации, сделай все шаги еще раз". The operators are `scripts/watchlist-bootstrap-production.mjs` and `scripts/watchlist-cutover-production.mjs`; every command ran with an explicit `--confirm`, fresh pins read by `status` just before it, and **no automatic retry**. There was **one owner-authorized repeat**: the first `fence-root` was repeated once with the same etag after the owner chose that option on the card (both attempts are in the table). Evidence only: nothing here authorizes a further operation.

## Result

**The Watchlist authority marker is `d1` / `open` / generation 3 and `GET /api/watchlist` is served from the D1 snapshot.** Snapshot version 1 (`c14a7aef-c91b-4389-9137-050cb0b01a39`, 394 members, list SHA-256 `a25c14186a32a4ae2aa16f6a3cc700666a88d8f381577da1b656d6170a63da1a`) was imported from the certified published EPG generation 517 and became the served list. The Letterboxd Sync mode is not created (0 rows), D, E and F are not performed, the root mirror delivery is pending (`mirror_delivered_snapshot_id` is null), and the natural EPG run after the switch has not run yet.

## Preconditions

- Schema 33, marker `epg` / `open` / 0, pointer version 0, all `watchlist_*` tables empty. Published EPG `d1` / `open`, generation 517, run `bf89ba90-07eb-46ac-9723-15d309517830`, certified (`finalized_run_id` equal). EPG checkpoint authority `d1` / `open` (AIR-551 H5 accepted by the owner as the O4 dependency, [decision](https://trello.com/c/b6UrtwUG#comment-6b03190159f3effd45453f33)). Outside the 16:30 to 17:00 Madrid window.
- Pins from the stored source and from the authoritative `GET /api/watchlist` response of generation 517, which the owner's Access login allowed: count 394; raw SHA-256 `a25c1418…63da1a`; membership SHA-256 `7e984693c14c08677eb663c2b36ca36758c7e021f409e255934f7b9d6f401844`. The `--digest` of the saved API response equals the stored source's membership digest (same ids, same order). The saved response itself is not published.
- EPG step lease absent (`epgBusy: null`). Discovery of the same run was running and its lease live: recorded as health, not a stop condition (runbook rule).

## Steps

| Step | Command (pins elided) | Outcome | Time Travel bookmarks (before to after) |
|---|---|---|---|
| B bootstrap | `watchlist-bootstrap-production.mjs --bootstrap --confirm bootstrap` + run, EPG generation 517, count, both digests | committed, 35 statements; pointer version 0 to 1, 394 members, marker unchanged `epg/open/0`, change/effect/pending 0 | `00000ae9-00002241-0000512b-43ba…` to `00000ae9-0000225d-0000512b-3902…` |
| C1 hold (attempt 1) | `watchlist-cutover-production.mjs --hold --expect-generation 0` + pins | committed; `epg/open/0` to `epg/held/1` | `00000ae9-00002465-…` to `00000ae9-00002485-0000512b-c872…` |
| C1 fence-root (attempt 1) | `--fence-root --expect-generation 1 --expect-root-etag 132fc654…` | **`write_uncertain`**, exit 3, `fenced: false`, root etag unchanged | before `00000ae9-000024bf-…` |
| C1 fence-root (repeat, owner-authorized) | the same command | **`write_uncertain`** again; root etag still `132fc654d5e6403ba595346c8f1dbcd0` | before `00000ae9-000025d3-…` |
| C1 release-abort | `--release-abort --expect-generation 1` | committed; `epg/held/1` to `epg/open/1` | `00000ae9-000025eb-…` to `00000ae9-00002607-0000512b-b3ad…` |
| C1 hold (attempt 2) | `--hold --expect-generation 1` + pins | committed; `epg/open/1` to `epg/held/2` | `00000af1-00000000-…` to `00000af1-00000006-…` |
| C1 fence-root (attempt 2, RW pair) | `--fence-root --expect-generation 2 --expect-root-etag 132fc654…` | **committed**; root etag `132fc654…` to `64381c914417ade2b3b22face0c8b5f8`, fence generation 2 | `00000af1-00000030-…` to `00000af1-0000003e-…` |
| C2 activate | `--activate --expect-generation 2 --expect-root-etag 64381c91…` + pins | committed; `epg/held/2` to `d1/held/3`; mirror receipt cleared | `00000af1-00000042-…` to `00000af1-0000006c-…` |
| C2 release | `--release --expect-generation 3` + pins (no EPG generation) | committed; `d1/held/3` to `d1/open/3` | `00000af1-0000008a-…` to `00000af1-00000090-0000512b-ca68…` |

## The first fence attempts and the credential

The first `--fence-root` attempt and the owner-authorized repeat both ended `write_uncertain`; the readback showed the etag of the root unchanged, so no put took effect, and the hold was backed out with `--release-abort` (documented rollback of C1). The operator prints no error class for this outcome, so **the exact cause is not established**. Those two attempts ran with the `R2_INSTALL_*` credential (with `R2_SNAPSHOT_ACCOUNT_ID` supplied from `D1_BACKFILL_ACCOUNT_ID`, which the operator needed to configure itself); the `R2_INSTALL_*` token had also been refused by the bucket in [AIR-549](air-549-filter-presets-cutover-2026-11-20.md). The second attempt used the owner's read-write pair (`R2_RW_ACCES_KEY_ID` and `R2_RW_ACCESS_SECRET_ACCESS_KEY`, mapped into `R2_INSTALL_*` for the command only; values never printed) and the conditional put succeeded, with a changed etag read back. The credential is the most likely cause, but only the pair of outcomes is observed, not the failure reason. Naming the RW pair in the runbooks is a separate change ([PR #904](https://github.com/vladimino/iptv-watchlist/pull/904)).

Generations: each of `hold`, `release-abort`, `activate` raises or keeps the marker generation by its own rule, so the second pass started at `--expect-generation 1`, not 0. The marker generation 3 at `d1/open` is the expected final value.

## Independent readback

After B, after the abort and after C2: the operator `status` in a separate process and a separate read-only `SELECT` through the Cloudflare connector (`rows_written: 0`). After C2: marker `d1/open/3`, pointer version 1, revision 2, snapshot `c14a7aef…`, film count 394, list SHA-256 equal to the source, `mirror_delivered_snapshot_id` null, members 394, change/effect/admission_pending 0, published EPG `d1/open/517/bf89ba90…` unchanged, EPG checkpoint `d1/open`, `letterboxd_sync_mode` 0 rows, `epgBusy` null.

**Served list after the switch** (one `GET /api/watchlist` through the owner's Access login, HTTP 200, `cache-control: no-store`): a new `snapshot` block (version 1, snapshot id `c14a7aef…`, `lastSuccessAt` 2026-11-22T16:06:55.344Z, `stale: false`) and `removed: []`; the 394 ids and their order are identical to the response before the activation (membership digest `7e984693…`). The request wrote nothing: the pointer revision and all counts were unchanged afterwards. The Access token and the login log were deleted at once.

## Not proven and open

- The first natural daily EPG run after the switch: **17:00 Europe/Madrid on 23 Nov 2026, 16:00 UTC** (`EPG_SCHEDULE` in `src/domain/orchestration-policy.js`); its result, reading the D1 snapshot, is the acceptance of the EPG side. The Worker cron tick `24 3 * * *` is not the daily EPG due time.
- The root `watchlist.json` carries the generation 2 fence (the same list); its delivery to the D1 snapshot's mirror belongs to the root mirror reconcile after D2/E.
- D1 (close the Ratings executor), D2, E (binding and cron), F1, F2: not performed, each needs its own owner GO and fresh pins.
- The cause of the first two `write_uncertain` outcomes. A follow-up could make the operator print the error class without secrets.

## Rollback

Not needed. The documented order if ever needed: `--hold-rollback`, `--export-rollback`, `--fence-root-rollback`, `--revert-authority`, `--release-rolled-back`, each with its own GO ([sync runbook](../../runbooks/letterboxd-sync.md)).
