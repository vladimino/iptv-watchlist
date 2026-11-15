# Core shard test-speed quality threshold: 180 seconds (15 Nov 2026)

**Scope:** documentation-only update of the existing non-blocking GitHub Actions test-speed quality target. It does not change `ci.yml`, test routing, job timeouts, merge protection or the nightly workflow. Functional correctness and safety failures still block delivery.

**Owner decision (15 Nov 2026):** use **180 seconds per core `Run tests` shard** as the review/quality threshold. A slower step requires investigation, including runner variance and the slowest tests; a confirmed regression merits follow-up. A slow runner alone does not block a merge or deployment. The [maintained policy](../../process/agent-workflow.md#test-suite-performance-quality-gate) is authoritative for future reviews.

## Recent CI evidence

Read-only GitHub Actions observations after AIR-490, from the `Run tests` **step** timestamps (not job duration, queue time or local wall time). All eight listed runs passed their three core test jobs.

| Workflow run | Trigger | Shard 1 | Shard 2 | Shard 3 |
| --- | --- | ---: | ---: | ---: |
| [43715157281](https://github.com/vladimino/iptv-watchlist/actions/runs/43715157281) | PR | 66 s | 74 s | 68 s |
| [43714759267](https://github.com/vladimino/iptv-watchlist/actions/runs/43714759267) | main | 67 s | 90 s | 84 s |
| [43714245736](https://github.com/vladimino/iptv-watchlist/actions/runs/43714245736) | PR | 39 s | 52 s | 63 s |
| [43714031031](https://github.com/vladimino/iptv-watchlist/actions/runs/43714031031) | PR | 39 s | 74 s | 51 s |
| [43714006115](https://github.com/vladimino/iptv-watchlist/actions/runs/43714006115) | PR | 39 s | 53 s | 90 s |
| [43713412568](https://github.com/vladimino/iptv-watchlist/actions/runs/43713412568) | main | 66 s | 90 s | 69 s |
| [43712962750](https://github.com/vladimino/iptv-watchlist/actions/runs/43712962750) | PR | 48 s | 89 s | 55 s |
| [43712689876](https://github.com/vladimino/iptv-watchlist/actions/runs/43712689876) | PR | 50 s | 88 s | 67 s |

Across these 24 shard steps the mean was approximately **65.4 seconds**, with an observed range of **39–90 seconds**. The highest observation is 90 seconds, giving a factor-of-two headroom to the 180-second quality target. This is a small, non-independent sample; it is not a guarantee of future runner speed, and a quality threshold must not be converted into a delivery blocker because of it.

## Historical boundary

The 13 Nov 2026 review policy used **240 seconds as a mandatory per-shard gate**. AIR-490 on 15 Nov 2026 removed the mandatory wall-clock gate and separated runner-dependent checks from the core suite. See [AIR-490 evidence](air-490-nonfunctional-suite-2026-11-15.md), [13 Nov historical policy change](test-suite-air-374-m2b-gate-rebalance-2026-11-13.md) and [14 Nov measured runner variance](test-suite-air-374-ci-weights-recalibration-2026-11-14.md). Those dated statements remain unchanged: they describe earlier decisions or measured values, not today's threshold.

No production call, scheduled job, worker, D1/R2 operation, or new CI action was performed for this document.
