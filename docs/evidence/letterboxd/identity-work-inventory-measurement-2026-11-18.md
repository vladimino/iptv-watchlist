# Identity work inventory: read-only measurement of `letterboxd/imports/`, 18 November 2026

**Scope:** the production R2 bucket `iptv`, prefix `letterboxd/imports/`, to confirm the caps of [ADR 0170](../../adr/0170-unified-identity-work-inventory.md) before the inventory is used. Trello: [AIR-527](https://trello.com/c/LWneTNYq); decision: ADR 0170.

**Method:** [`scripts/identity-work-measure.mjs`](../../../scripts/identity-work-measure.mjs), a signed S3 `ListObjectsV2` of the prefix with the read-only snapshot credential. No `GetObject`, no ZIP, no write, no key or archive hash printed. Run at 16:52 UTC (17:52 Madrid) on 18 November 2026. Reproduce with `set -a; . ~/.config/iptv/r2-snapshot.env; set +a; NODE_USE_ENV_PROXY=1 node scripts/identity-work-measure.mjs`.

**Result (aggregates only):**

| Measure | Value |
| --- | --- |
| Listing pages / objects | 1 / 98 |
| Archive prefixes | 3 (cap of one delimiter listing: 1000) |
| Objects by kind | 48 `chunks/<n>.intent.json`, 48 `chunks/<n>.receipt.json`, 1 `chunks/<n>.candidates.json`, 1 `rated-candidates.json` |
| `registry.json` | absent |
| Archives without a candidate document | 2 of 3 |
| `rated-candidates.json` size | 1 object, 13,906 bytes (cap 2 MiB, 0 over) |
| Objects per archive | min 2, median 6, max 90 |
| Registry size at this count | about 840 bytes estimated (cap 256 KiB, 500 archives) |

**Verdict:** the proposed caps hold with a wide margin for the present data: the delimiter listing fits in one page, the one candidate document is far below 2 MiB and the registry would be well below 1 KiB. The 98 objects are the three Letterboxd import prefixes created by earlier acceptance tests, not new production imports. Because the registry is absent, all three archives are `unindexed` for the inventory until each is written again by a normal candidate mutation; none of them was touched.

**Limits:** object sizes only; the candidate counts per state inside the one document were not read, so no queue size is claimed. One point-in-time listing; it does not bound future growth, which the caps and the `partial` / `unindexed` states handle. The measurement authorizes no cleanup, backfill or import.
