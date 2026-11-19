# ADR 0179: A weekly Worker cron retries TMDB for catalog films without a poster and hydrates D1 through one shared core

**Status:** Proposed  
**Original decision date:** 2026-11-19 (product goal and weekly cadence); fork decisions A1 and B1 recorded 2026-11-19  
**Recorded at:** 2026-11-19  
**Approval source:** [Product Owner decision on the AIR-543 card, 19 November 2026 (Europe/Madrid)](https://trello.com/c/GQDcwdVx): approves the product goal and a weekly cadence; the same card records the owner's fork decisions **A1** (daily `24 3 * * *`, Sunday sweep, pending-only otherwise) and **B1** (one CAS-protected R2 checkpoint) and the observability scope below. The ADR is **not yet accepted**: final owner acceptance follows a fresh independent review of this revision. It does **not** approve the new production cron, any TMDB sweep or any production write.  
**Related work:** [AIR-543](https://trello.com/c/GQDcwdVx); [AIR-515](https://trello.com/c/FMWcvvWI); [AIR-526](https://trello.com/c/olszZU9B); [AIR-302](https://trello.com/c/9rqjCMhy); [ADR 0048](0048-permanent-catalog-poster-maintenance-route.md); [ADR 0063](0063-catalog-poster-negative-index.md); [ADR 0174](0174-discovery-only-fast-recovery-cron.md)  
**Supersedes:** [ADR 0048](0048-permanent-catalog-poster-maintenance-route.md) decision 5 and [ADR 0063](0063-catalog-poster-negative-index.md) decision 2, **for the automated paths only** (see "Authorization override"). ADR 0063's rejection of a cron for plain record expiry is not reversed: this cron performs a real retry and hydration. Takes effect only when Accepted and activated.  
**Superseded by:** None

## Context

D1 `discovery_admission` is the authority for the catalog and its posters. Today a film without a poster is handled only by the owner-only `POST /api/enrichment/catalog/posters`. The R2 negative index (`epg/catalog-poster-negatives.json`) remembers `no_poster_on_tmdb` for 90 days, but an expired entry is only *actionable*; nothing acts on it. At 19 November 2026, 12 Film rows have no poster, none is indexed, and Discovery makes the TMDB detail call at admission but does not record a missing `poster_path`. The owner wants this to run without manual steps. The Worker already has two crons (`0 * * * *`, `1-59/2 * * * *`).

## Decision (proposed)

1. **Seed at admission.** When Discovery has a complete TMDB movie detail whose `id` equals the verified canonical id and `poster_path` is absent, it writes `no_poster_on_tmdb` (`checkedAt`, `nextCheckAt = checkedAt + 90 d`) through the existing index compare-and-swap, with no second TMDB request. Network error, 429, 5xx, incomplete body, id mismatch and unverified identity are never recorded as "no poster". An index failure never blocks the admission; the film is left for the weekly catch-up.
2. **One shared core.** The body of the poster route (partition, TMDB detail, validation, guarded D1 conditional update, lease, generation and authority guards, negative-index CAS) is extracted into one bounded internal service. The owner route and the weekly handler both call it; the weekly handler does not call the Access-protected route. D1 only: no R2 catalog writer or fallback. `tmdb_id_mismatch` is never rechecked automatically.
3. **Weekly sweep on a separate cron branch.** `src/worker.js` dispatches on the exact `controller.cron`; the weekly branch runs only the poster service and none of EPG, Ratings, Monitor or Discovery recovery. Existing `0 * * * *` and `1-59/2 * * * *` are unchanged and asserted by test. Candidates: current D1 Film with no HTTPS poster, verified TMDB id, not retired/superseded, and no index entry or an expired `no_poster_on_tmdb`. Batch size, TMDB pacing and per-run request budget are bounded; a cursor resumes a large backlog.
4. **Outcomes.** Real `poster_path` → guarded HTTPS poster in D1. Absent again → new `checkedAt`, `nextCheckAt +90 d`. 429 → honour `Retry-After`; 5xx, network, timeout → candidate stays due with bounded backoff and no 90-day penalty. Stale, superseded or already-present → no-op with 0 TMDB calls and no new **domain** writes (see decision 7 for the operational-state boundary).
5. **Busy Discovery lease / EPG priority.** A `409`/busy is not a skipped week. The run records a checkpoint and resumes (fork A1 below; the accepted bound is stated there) without holding the lease while waiting and without competing with EPG or Discovery priority.
6. **Observability: three existing surfaces, one fact source.** The handler records, in the B1 checkpoint object, the operational facts below; the Monitor, the footer and the Events Log all derive from that object and from nothing else, so they agree. Contracts are in "Observability contract". `GET /api/admin/posters` stays side-effect free.
7. **No-op boundary (exception for owner acceptance).** Domain writes (D1 posters, negative-index entries) happen only for a real outcome. A Monday-Saturday *idle* pending-only tick (no pending run, or `nextRetryAt` not reached), an ineligible film and an already-present poster create **no** write of any kind: one checkpoint read, no TMDB call. The **Sunday weekly report** is different: even with zero due and zero hydrated films it persists the minimal operational state (checkpoint `lastScheduledAt`/`lastCompletedAt`/summary) and emits one Events entry, because monitoring needs positive evidence that the run happened. This is a narrow, deliberate exception to the card's "0 D1/R2 writes on no-op"; it is recorded here for explicit owner acceptance and is at most one checkpoint write and one event per week, plus the writes of an unfinished run's retries.

## Authorization override (explicit)

This proposal deliberately changes two Accepted contracts, for the automated paths only:

- **ADR 0048 decision 5** ("every production execution call stays a separate owner-approved operation"): superseded for the weekly handler. After **one** owner-approved activation GO for the Cloudflare schedule, each scheduled retry and its D1 poster writes run without a further approval.
- **ADR 0063 decision 2** (negative verdicts are stored only from an explicit owner `POST`): superseded for (a) the admission-time seed and (b) the weekly handler's own TMDB answers.
- **Unchanged:** the manual `POST /api/enrichment/catalog/posters` keeps its owner gate, dry run, `recheck` and receipts; `tmdb_id_mismatch` is never rechecked automatically; no R2 catalog writer; `GET /api/admin/posters` stays side-effect free.
- **Approving this Proposed ADR activates nothing.** Activation needs a separate explicit owner GO on the Cloudflare schedule before the implementation PR merges. Cross-ADR status text in 0048 and 0063 is updated with the implementation PR, when this ADR is Accepted.

## Observability contract

The checkpoint object `epg/catalog-poster-weekly.json` (B1) carries: `runId`, `weekStart` (the Sunday 03:24 UTC the run belongs to), `lastScheduledAt` (the cron firing the handler saw), `lastAttemptAt`, `lastCompletedAt`, `status` (`running`, `pending`, `completed`, `failed`), `cursor`, `nextRetryAt`, `retryAttempts`, the last summary (`scanned, due, checked, hydrated, noPoster, retryable, deferredBusy, pending, rateLimit, duration`), the `reportId` of the logical weekly report and an `eventOwed` flag. Every status read is bounded: one R2 read of this object, no TMDB request, no domain write, no repair. An absent, unreadable or schema-invalid object is `unknown`, never `healthy`.

**1. Production Monitor (`GET /api/monitor/status`, [monitor reference](../reference/api/monitor.md)).** `catalog_posters` is a separately evaluated stream in the existing hourly Cloudflare Monitor, reusing its alert deduplication, cooldown, recovery and notification transport; no new external heartbeat service. The Monitor detects a **missing run from the checkpoint timestamps, not from handler logs**:

| State | Condition | Monitor result |
| --- | --- | --- |
| `unknown` | Object absent, unreadable or corrupt, outside the grace below | `unknown`, alert after the existing unknown policy |
| `grace` | Before activation plus the first full scheduled week (first Sunday 03:24 UTC after activation, plus 26 h) | no alert; reported as `grace` |
| `healthy_idle` | Latest weekly report `completed`, no pending run, `lastCompletedAt` within 8 days; includes zero due films and normal 90-day `no_poster_on_tmdb` holds | healthy |
| `waiting` | `pending` with `nextRetryAt` in the future or within one daily firing plus 2 h, `retryAttempts` below the cap | healthy (legitimate backoff) |
| `overdue` | No `lastScheduledAt` within 26 h of the latest expected daily firing, or no completed report within 8 days of `weekStart` | degraded, then alert after 2 hourly evaluations |
| `stalled` | `running` with `lastAttemptAt` older than the handler's worst case (the request budget, two hours) or `pending` past `nextRetryAt` by more than one daily firing plus 2 h | degraded/alert |
| `failed` | `status=failed`, retry exhaustion (cap reached) or persistent 429 across two consecutive daily firings | alert |

An empty due set, a normal `no_poster_on_tmdb` verdict and a legitimate wait are **never** a fault. Thresholds are constants in the implementation and are listed in the monitor reference. The same projection (same states, same timestamps, plus `nextExpectedAt`, `freshnessAt`) is exposed read-only in the owner data-health read (`GET /api/admin/health`, [data-health reference](../reference/domain/data-health.md)) as a bounded `catalogPosters` section.

**2. Footer automation status (`GET /api/enrichment/footer/status`, [enrichment reference](../reference/api/enrichment.md)).** A dedicated source `Постеры` is added to `integrations.sources` (currently five integrations, so six), reflected in the aggregate `Автоматизация` indicator and the details disclosure; it is not a sixth top-level KPI. Its states map one to one: `unknown` (neutral, never green), healthy idle / no new poster (green, with last outcome), waiting for the next attempt (green with the retry time), degraded/stalled (warning), failure (error). It shows the last real weekly outcome, due/pending/retry state, checked/hydrated counts and the checkpoint's `freshnessAt` as its freshness timestamp. A normal TMDB no-poster verdict is shown as idle, not as a fault; missing evidence is never green. Read cost stays one R2 read, the GET stays read-only, and public and admin views keep the shared footer parity ([UI and read models](../architecture/ui-and-read-models.md)). The source-count change (5 to 6) is a documented contract change with its UI test.

**3. Events Log (`GET /api/events`, [events reference](../reference/domain/events.md)).** One new type `catalog_posters` in the established `events/items` stream, with a product-friendly card, a type filter and a detail view; raw technical logs do not go into the user journal. One truthful weekly-run result is emitted per logical report, including zero posters found, with checked/hydrated/no-poster/retryable/deferred/pending counts, timestamp and outcome. Daily idle probes emit nothing. An unfinished run emits one **deferred** report (`outcome=pending`) the first time it carries over; its eventual end is a **completed** report under the same `reportId` family with a new deterministic id (`catalog_posters:<weekStart>:deferred` and `catalog_posters:<weekStart>:final`), so a week produces at most two events and a deferred event is never read as terminal success. Ordering: the checkpoint (with `eventOwed=true`) is committed first, then the event put, then a CAS clears `eventOwed`. A failed or crashed event put leaves `eventOwed`, and the next firing re-emits the same deterministic id (idempotent) **without re-running TMDB**. `GET /api/events` stays strictly read-only.

## Recorded owner decisions

**Fork A, how a busy or rate-limited run resumes: A1 accepted** (owner, AIR-543, 19 November 2026). One daily Cloudflare Worker cron `24 3 * * *` UTC. Sunday starts the full weekly sweep; Monday-Saturday firings are pending-only: one checkpoint read, resuming only when a run is `pending` and `nextRetryAt` has passed. `Retry-After` is honoured. The accepted limits: retry granularity is one day (worst added delay about 24 h plus `Retry-After`), and a week can still end `pending` if the lease stays busy on every daily firing; that is reported, not hidden. The existing hourly and Discovery crons are unchanged and not used for poster checks.

**Fork B, where the checkpoint lives: B1 accepted** (owner, AIR-543, same date). One R2 object `epg/catalog-poster-weekly.json` with version-aware compare-and-swap, like the negative index. On a CAS conflict or failure the implementation keeps guarded D1 hydration idempotent, loses no due candidate and resumes by re-reading authoritative D1 and the negative index. **No D1 schema migration.**

### Rejected options (kept for the record)

| Option | Mechanism | Why not |
| --- | --- | --- |
| A2 | Checkpoint plus a poster check on the two-minute Discovery fast tick. | Adds a poster read to a tick ADR 0174 defines as Discovery-only; couples two recovery clocks; 720 extra reads a day. |
| A3 | A new Cloudflare Workflow with `step.sleepUntil`. | New binding, class, rollover path and instance ownership rules; disproportionate for one weekly low-priority job. |
| A (original) | `24 3-9 * * 0`, seven Sunday firings. | Cannot resume after the last Sunday firing; liveness overstated (review of 19 November 2026). |
| B2 | A D1 table. | Stronger consistency, but an owner-gated schema migration for one small row. |

## Alternatives considered

- Keep the owner-only manual route: rejected by the owner for routine operation.
- Self-fetch the owner POST: rejected; it would require bypassing Access.
- Adding the weekly work to the hourly tick: rejected; it would run on every tick and couple poster retry to EPG/Ratings/Monitor.

## Consequences

- Posters that appear on TMDB reach D1 without manual action; a film with no poster costs one TMDB call per 90 days (checked weekly, held until due).
- A third schedule entry exists in live configuration (daily firing, weekly sweep); deploy replaces schedules with `wrangler.jsonc`.
- The Monitor, the footer and the Events Log gain one stream/source/type each, all fed by the one checkpoint object; the footer source count changes from five to six.
- At most one checkpoint write and one event per week are made even when nothing is found (decision 7).
- An automatic D1 writer exists. Its safety is the existing guards; seed adds one conditional R2 write per newly admitted film without a poster.

## Recovery and migration boundary

Revert the pull request to remove the cron and handler; already stored D1 posters and index entries are not rolled back. This ADR authorizes **no** production operation: the new production cron needs a separate explicit owner GO before merge of the implementation, and no manual TMDB, Discovery, EPG or poster POST, D1/R2 write, lease reset, flag, Task or Access change is authorized.

## Evidence

- **Original decision:** AIR-543 card (above).
- **Implementation:** not started; waits for a fresh independent review of this revision, the owner's final acceptance of this ADR, and then a separate implementation PR.
- **Dated verification:** not recorded. Positive hydration is unproven until a real `poster_path` appears on a natural weekly run.
- **Uncertainty:** whether 03:24 UTC is quiet enough versus EPG/Discovery and whether the monitor thresholds (26 h, 8 days, 2 h) fit the platform's real scheduling delay; both are to be measured on the first natural weeks, not assumed. The decision 7 exception awaits owner acceptance.

## Follow-ups

The implementation PR, not this one, ships and tests the following; this ADR only names them.

- **Documentation:** `docs/reference/api/monitor.md`, `docs/reference/api/admin.md`, `docs/reference/api/enrichment.md` (footer), `docs/reference/api/catalog.md`, `docs/reference/domain/events.md`, `docs/reference/domain/data-health.md`, `docs/architecture/observability-and-failures.md`, `docs/architecture/ui-and-read-models.md`, `docs/architecture/scheduling-and-orchestration.md`, `docs/architecture/discovery-and-resolution.md`, the runbook `docs/runbooks/catalog-poster-hydration.md`, the cross-ADR status text of 0048 and 0063, and evidence.
- **Tests:** deterministic Monitor policy (all states above, including stale or missing schedule and first-run grace), no-poster and no-op, 429/409/backoff, corrupt R2 checkpoint, CAS race, repeated cron, lost event write and replay without a TMDB call, aggregate-footer and Events UI/filter tests, exact cron routing and unchanged existing schedules.
- **Visual QA:** rendered Mermaid on GitHub and a browser check of the footer and Events Log at desktop and mobile widths, written in the implementation PR (no screenshots).
- Activation of the new production cron remains a separate explicit owner GO before the implementation PR merges.
