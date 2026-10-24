# Replay, cutover preparation and later evidence

All dates October **2026**. Lifecycle: preserved historical samples. Operational authority: **historical only**, not permission to repeat any TMDB call or toggle a flag. See each report for exact pinned EPG generation/source SHA, counts and missing populations.

| Evidence | Captured / verdict | Scope | Used by | Later evidence or gate |
| --- | --- | --- | --- | --- |
| [AIR-86 retry census](air-86-census.md) | 23 Oct 17:19:42 UTC; **MEASUREMENT** | 105 stored retryAt decisions; 30 blocked at that instant, not all candidates | [AIR-86](https://trello.com/c/INQy9Hca) cohort | Replay plan, not a current count |
| [AIR-86 replay plan](air-86-replay-plan.md) | 23 Oct 17:52:50 UTC; **APPROVED COHORT/CAP** | Frozen 38 items and owner-approved **one-time** 130-call cap, not an executed dry run | [AIR-86](https://trello.com/c/INQy9Hca) | [Replay result](air-86-replay.md) |
| [AIR-86 replay result](air-86-replay.md) | 23 Oct 18:23:05 UTC; **NO-GO / LIMITED RECALL** | 38 offline replay rows, 2 verifications, no production writes | AIR-86 → [AIR-95](https://trello.com/c/kD8xjvVu), [AIR-96](https://trello.com/c/prY7T5iE) | [AIR-97](https://trello.com/c/Lopu9evA) rescored frozen calls |
| [AIR-97 verdict](air-97-verdict.md) | 24 Oct; **NO-GO** | Five structural proposals lacked stored detail cards; whole live readyNow population unmeasured | [AIR-97](https://trello.com/c/Lopu9evA) → [AIR-99](https://trello.com/c/SHbYQwll) | Later AIR-99/AIR-100; not a retroactive GO |
| [AIR-99 detail audit](air-99-verdict.md) | 24 Oct 08:43:16 UTC; **ACCEPTED PARTIAL EVIDENCE, NO CUTOVER GO** | 5/5 detail_verified, 49,715-row ledger, ~15k readyNow mostly not matched locally | [AIR-99](https://trello.com/c/SHbYQwll), [PR #70](https://github.com/vladimino/iptv-watchlist/pull/70) → [AIR-100](https://trello.com/c/4441YtSU) | AIR-68 later approved narrower scored-only window |
| [AIR-100 rollout plan](air-100-rollout.md) | 24 Oct; **ACCEPTED PLAN, NOT EXECUTION** | Cheap-pass safeguards, one bounded scored/rollback window | [AIR-100](https://trello.com/c/4441YtSU), [PR #72](https://github.com/vladimino/iptv-watchlist/pull/72), **consumed** by [AIR-68](https://trello.com/c/qbLDc6Ql) | The actual owner-approved 24 Oct cutover is in AIR-68; plan grants no reusable approval |

Machine-readable originals sit beside these reports: [replay manifest](air-86-replay-manifest.json), [replay results](air-86-replay-results.json), [AIR-99 detail](air-99-detail.json). [AIR-115](https://trello.com/c/TRp1oXpA) moved them together with the script and test paths. They remain historical samples.
