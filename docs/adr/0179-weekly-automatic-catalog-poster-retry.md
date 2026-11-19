# ADR 0179: A weekly Worker cron retries TMDB for catalog films without a poster and hydrates D1 through one shared core

**Status:** Accepted (Product Owner final architecture acceptance, 2026-11-19, Europe/Madrid; no production activation authorized)  
**Original decision date:** 2026-11-19 (product goal and weekly cadence); A1 and B1 recorded 2026-11-19; final acceptance 2026-11-19  
**Recorded at:** 2026-11-19  
**Approval source:** [Product Owner final acceptance of ADR 0179 with R1 + H1 + F1, 19 November 2026 (Europe/Madrid)](https://trello.com/c/GQDcwdVx#comment-6aff64773c9f44b10a8953dd), following [independent technical PASS on PR #795](https://github.com/vladimino/iptv-watchlist/pull/795#pullrequestreview-5983223372). The owner separately approved **A1** (daily `24 3 * * *` UTC, Sunday sweep and pending-only otherwise) and **B1** (one CAS-protected R2 checkpoint) on AIR-543. Observability choices **R1** (weekly report even with zero due or zero new posters), **H1** (read-only idle daily tick) and **F1** (two write-once Monitor markers with the documented residual joint-loss risk) are accepted. **This acceptance does not authorize production cron activation, TMDB calls, D1/R2 writes, or implementation merge.**  
**Related work:** [AIR-543](https://trello.com/c/GQDcwdVx); [AIR-515](https://trello.com/c/FMWcvvWI); [AIR-526](https://trello.com/c/olszZU9B); [AIR-302](https://trello.com/c/9rqjCMhy); [ADR 0048](0048-permanent-catalog-poster-maintenance-route.md); [ADR 0063](0063-catalog-poster-negative-index.md); [ADR 0174](0174-discovery-only-fast-recovery-cron.md)  
**Supersedes:** [ADR 0048](0048-permanent-catalog-poster-maintenance-route.md) decision 5 and [ADR 0063](0063-catalog-poster-negative-index.md) decision 2, **for the automated paths only** (see "Authorization override"). ADR 0063's rejection of a cron for plain record expiry is not reversed: this cron performs a real retry and hydration. Its automated operational effects require a separately approved production activation after implementation.  
**Superseded by:** None

## Context

D1 `discovery_admission` is the authority for the catalog and its posters. Today a film without a poster is handled only by the owner-only `POST /api/enrichment/catalog/posters`. The R2 negative index (`epg/catalog-poster-negatives.json`) remembers `no_poster_on_tmdb` for 90 days, but an expired entry is only *actionable*; nothing acts on it. At 19 November 2026, 12 Film rows have no poster, none is indexed, and Discovery makes the TMDB detail call at admission but does not record a missing `poster_path`. The owner wants this to run without manual steps. The Worker already has two crons (`0 * * * *`, `1-59/2 * * * *`).

## Decision

1. **Seed at admission.** When Discovery has a complete TMDB movie detail whose `id` equals the verified canonical id and `poster_path` is absent, it writes `no_poster_on_tmdb` (`checkedAt`, `nextCheckAt = checkedAt + 90 d`) through the existing index compare-and-swap, with no second TMDB request. Network error, 429, 5xx, incomplete body, id mismatch and unverified identity are never recorded as "no poster". An index failure never blocks the admission; the film is left for the weekly catch-up.
2. **One shared core.** The body of the poster route (partition, TMDB detail, validation, guarded D1 conditional update, lease, generation and authority guards, negative-index CAS) is extracted into one bounded internal service. The owner route and the weekly handler both call it; the weekly handler does not call the Access-protected route. D1 only: no R2 catalog writer or fallback. `tmdb_id_mismatch` is never rechecked automatically.
3. **Weekly sweep on a separate cron branch.** The new daily cron `24 3 * * *` UTC starts a sweep on the first firing of a new week (weeks start Sunday 00:00 UTC) whose `weekStart` is newer than the checkpoint's, normally the Sunday firing; a missed Sunday is caught up by the next firing, and an absent checkpoint bootstraps a sweep on any day. `src/worker.js` dispatches on the exact `controller.cron`; the weekly branch runs only the poster service and none of EPG, Ratings, Monitor or Discovery recovery. Existing `0 * * * *` and `1-59/2 * * * *` are unchanged and asserted by test. Candidates: current D1 Film with no HTTPS poster, verified TMDB id, not retired/superseded, and no index entry or an expired `no_poster_on_tmdb`. Batch size, TMDB pacing and per-run request budget are bounded; a cursor resumes a large backlog.
4. **Outcomes.** Real `poster_path` → guarded HTTPS poster in D1. Absent again → new `checkedAt`, `nextCheckAt +90 d`. 429 → honour `Retry-After`; 5xx, network, timeout → candidate stays due with bounded backoff and no 90-day penalty. Stale, superseded or already-present → no-op with 0 TMDB calls and no new **domain** writes (see decision 7 for the operational-state boundary).
5. **Busy Discovery lease / EPG priority.** A `409`/busy is not a skipped week. The run records a checkpoint and resumes (fork A1 below; the accepted bound is stated there) without holding the lease while waiting and without competing with EPG or Discovery priority.
6. **Observability: three existing surfaces, one fact source.** The handler records, in the B1 checkpoint object, the operational facts below; the Monitor, the footer and the Events Log all derive from that object and from nothing else, so they agree. Contracts are in "Observability contract". `GET /api/admin/posters` stays side-effect free.
7. **No-op boundary (owner-accepted R1/H1 exception).** Domain writes (D1 posters, negative-index entries) happen only for a real outcome. A firing is **idle** only when **neither poster work nor event delivery is pending**: no run is `pending` with `nextRetryAt` reached, the current week already has its report and the outbox holds no undelivered entry. An idle firing, an ineligible film and an already-present poster create no write of any kind: one checkpoint read, no TMDB call, no event. A firing with an undelivered outbox entry is **not** idle: it replays the event without TMDB (see the Events contract). The weekly report is the exception: even with zero due and zero hydrated films it persists operational state and one event, because monitoring needs positive evidence. **Write budget, matching the state machine:** a successful zero-due week is exactly two checkpoint writes (one compare-and-swap committing the result and appending the outbox entry, one marking it delivered) and one event put. A week that carries over adds one more report (the deferred one) with the same two checkpoint writes and one event put, so at most four outbox-related checkpoint writes and two event puts per week, plus one checkpoint write per executed batch or retry attempt (bounded by the per-firing request budget and a retry cap of six). The Product Owner explicitly accepted this R1 exception to the card's "0 D1/R2 writes on no-op" on 2026-11-19.

## Authorization override (explicit)

This proposal deliberately changes two Accepted contracts, for the automated paths only:

- **ADR 0048 decision 5** ("every production execution call stays a separate owner-approved operation"): superseded for the weekly handler. After **one** owner-approved activation GO for the Cloudflare schedule, each scheduled retry and its D1 poster writes run without a further approval.
- **ADR 0063 decision 2** (negative verdicts are stored only from an explicit owner `POST`): superseded for (a) the admission-time seed and (b) the weekly handler's own TMDB answers.
- **Unchanged:** the manual `POST /api/enrichment/catalog/posters` keeps its owner gate, dry run, `recheck` and receipts; `tmdb_id_mismatch` is never rechecked automatically; no R2 catalog writer; `GET /api/admin/posters` stays side-effect free.
- **Acceptance of this ADR activates nothing.** Activation needs a separate explicit owner GO on the Cloudflare schedule before the implementation PR merges. Cross-ADR status text in 0048 and 0063 is updated with the implementation PR, now that this ADR is Accepted, as part of the implementation PR.

## Observability contract

### Facts and baseline

The B1 checkpoint object `epg/catalog-poster-weekly.json` (`schemaVersion`) carries: `runId`, `weekStart`, `status` (`running`, `pending`, `completed`, `failed`), `lastScheduledAt` (the firing that **started or resumed work**, not every idle firing), `lastAttemptAt`, `lastCompletedAt`, `cursor`, `nextRetryAt`, `retryAttempts`, the last summary (`scanned, due, checked, hydrated, noPoster, retryable, deferredBusy, pending, rateLimit, duration`) and a bounded `outbox`. Every status read is one R2 read of this object plus the Monitor's own state document; no TMDB request, no domain write, no repair. An absent, unreadable or schema-invalid object is never `healthy`.

**Activation baseline and "ever seen" marker (durable, no new service).** The hourly `Monitor.run` already owns a state document (`monitor/state.json`). Two fields are added, both written only by `Monitor.run`, never by a GET, and **never cleared or re-armed**: `catalogPostersBaselineAt`, set once, the first time the Monitor evaluates `catalog_posters` and finds no checkpoint; and `catalogPostersSeenAt`, set once, the first time it reads a **valid** checkpoint. The bootstrap grace exists **only** before the very first checkpoint: with no checkpoint and no `SeenAt`, `bootstrapDue` is the next 03:24 UTC after the baseline and the stream is `grace` (healthy) until `bootstrapDue + 26 h`, then `overdue`, so absence cannot grant indefinite grace. An absent checkpoint **after** `SeenAt` is set is `lost`, not a new grace: it is actionable immediately (the object was deleted, lost or never rewritten), so a later loss can never mask an outage, however often it repeats. If the Monitor's own state document is also lost, the stream falls back to bootstrap grace once; that residual risk is accepted and documented. While the Monitor is off (`MONITOR` not `on`) nothing is recorded and the stream reads `unknown`.

### Monitor predicates (`GET /api/monitor/status`, [monitor reference](../reference/api/monitor.md))

`catalog_posters` is a separately evaluated stream in the existing hourly Monitor, reusing its alert deduplication, cooldown, recovery and transport. The Sunday sweep is monitored from its persisted receipt; **daily firings are monitored only when an unfinished run was actually due** (`pending` and `nextRetryAt` reached). An idle daily firing writes nothing and is deliberately **not** detectable, which is the accepted consequence of the no-write contract (decision 7); detecting every idle firing would need an explicit change of that policy. Let `now` be the Monitor's clock, `W` the start of the current week, `D = nextRetryAt` of a pending run. States are evaluated in this order and the **first true predicate wins**:

| Order | Domain state | Predicate | Monitor status (existing vocabulary) |
| --- | --- | --- | --- |
| 1 | `unknown` | object unreadable, corrupt, wrong `schemaVersion` or **incomplete for its status** (validity rules below); or Monitor off | `degraded` (an unreadable or malformed fact is a fault, not a pass) |
| 1a | `lost` | no checkpoint and `catalogPostersSeenAt` is set | `degraded`, alert and recovery per the existing rule; recovers when a valid checkpoint is read again |
| 2 | `failed` | `status=failed`, or `retryAttempts` at the cap, or `rateLimit` persistent across two consecutive due firings | `needs_owner` |
| 3 | `stalled` | the outbox holds **8 undelivered entries** (full, no new report can be created), or any undelivered entry has `at` older than 52 h (two daily firings missed its replay); or `status=running` and `now - lastAttemptAt` above the run's budget (2 h), or `status=pending` and `now > D + 26 h` (the due daily firing did not resume it) | `degraded` |
| 4 | `grace` | no checkpoint and `now <= bootstrapDue + 26 h` | `healthy` |
| 5 | `overdue` | no checkpoint and `now > bootstrapDue + 26 h`; or the checkpoint exists, `weekStart < W` and `now > W + 03:24 UTC + 26 h` (the current week has no sweep receipt) | `delayed` for 2 h, then `degraded` |
| 6 | `waiting` | `status=pending` and `now <= D + 26 h` (before or inside the due window) | `waiting` |
| 7 | `healthy_idle` | `status=completed` with valid fields, with a receipt for the current week, or the previous week's receipt before the current week's grace expires; includes zero due films and normal 90-day `no_poster_on_tmdb` holds | `healthy` |

**Validity (minimal, testable).** `completed` requires `weekStart`, `lastCompletedAt` and `runId`; `pending` requires `nextRetryAt` and `lastAttemptAt`; `running` requires `lastAttemptAt`; `failed` requires `lastAttemptAt`; every outbox entry requires `id`, `at`, `payload` and `deliveredAt` (null or a time). A record that fails its status's rule, or has an unparseable essential timestamp, is `unknown`, never `healthy_idle` or `waiting`. Redelivering a stalled outbox needs no TMDB request: the next firing replays the entries, and delivery success clears `stalled` on the next hourly evaluation.

`delayed`/`degraded` timing follows the existing EPG convention (delayed first, degraded later); alert and recovery follow the Monitor's existing rule for `degraded` and `needs_owner`. An empty due set, a no-poster verdict and a legitimate wait are never a fault. Constants live in the implementation and the monitor reference. The same projection (domain state, mapped status, `nextExpectedAt`, `freshnessAt`) is exposed read-only as a bounded `catalogPosters` section of the owner data-health read (`GET /api/admin/health`, [data-health reference](../reference/domain/data-health.md)).

### Footer (`GET /api/enrichment/footer/status`, [enrichment reference](../reference/api/enrichment.md))

A dedicated source `Постеры` is added to `integrations.sources` (five integrations become six), reflected in the aggregate `Автоматизация` indicator and the details disclosure, not as a sixth top-level KPI. Mapping from the monitor status: `lost` and `stalled` map to `degraded`, shown as warning; `healthy` and `waiting` green (with last outcome or retry time; `grace` and no-poster idle say so), `delayed` and `degraded` warning, `needs_owner` error, `unknown` neutral, never green. It shows the last real weekly outcome, due/pending/retry state, checked/hydrated counts and the checkpoint's `freshnessAt`. Read cost stays one R2 read, the GET stays read-only and public and admin views keep footer parity ([UI and read models](../architecture/ui-and-read-models.md)); the 5-to-6 count has its UI test.

### Events Log and the bounded outbox (`GET /api/events`, [events reference](../reference/domain/events.md))

One new type `catalog_posters` in the established `events/items` stream: a product-friendly card, a type filter and a detail view, no raw technical logs. At most two reports per logical week, with stable ids `catalog_posters:<weekStart>:deferred` (first time a run carries over) and `catalog_posters:<weekStart>:final`; a zero-result week emits only `final`. A deferred report is never terminal success. Idle daily firings emit nothing.

**Outbox.** The checkpoint holds `outbox`, an array of at most 8 entries `{id, at, payload, deliveredAt|null}`. `at` and `payload` are **frozen when the entry is created**, in the same compare-and-swap that commits the result, so the event key `events/items/<reverse-timestamp>-<id>.json` never changes and a replay overwrites the same object idempotently. Order: (1) commit the result and append the entry (one CAS); (2) put the event; (3) CAS-mark `deliveredAt`. A lost put or a crash after the put leaves `deliveredAt=null`, and the next firing replays the entry **without TMDB**. Entries are delivered oldest first, and **before** any week rotation: the first firing of a new week delivers every undelivered entry before it replaces `weekStart`; rotation carries undelivered entries forward and drops delivered ones, so a deferred report that failed to deliver is never overwritten by the final one and nothing disappears at the Sunday boundary. If the outbox is full with undelivered entries, no new report is created and the stream reads `stalled` (a predicate of its own, independent of `status`) until delivery succeeds; an undelivered entry older than 52 h reads `stalled` as well. A firing with an undelivered entry is not idle (decision 7). Tests cover lost put, crash after put, deferred-to-final, week supersession, a full outbox with `status=completed`, recovery after delivery and repeated delivery failure; and for the baseline: initial rollout, checkpoint deletion after success and repeated loss.

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
- The Monitor, the footer and the Events Log gain one stream/source/type each, all fed by the one checkpoint object (the Monitor also keeps two write-once fields in its own state document); the footer source count changes from five to six.
- The weekly report costs a bounded number of operational writes even when nothing is found (decision 7 gives the budget).
- An automatic D1 writer exists. Its safety is the existing guards; seed adds one conditional R2 write per newly admitted film without a poster.

## Recovery and migration boundary

Revert the pull request to remove the cron and handler; already stored D1 posters and index entries are not rolled back. This ADR authorizes **no** production operation: the new production cron needs a separate explicit owner GO before merge of the implementation, and no manual TMDB, Discovery, EPG or poster POST, D1/R2 write, lease reset, flag, Task or Access change is authorized.

## Evidence

- **Original decision:** AIR-543 card (above).
- **Final architecture acceptance:** Product Owner approved R1 + H1 + F1 on AIR-543 on 2026-11-19 after independent PASS of PR #795 (links above). The accepted design does not activate a cron or authorize production writes.
- **Implementation:** not started; requires a separate implementation PR, independent code review, appropriate CI and an explicit owner GO before activating the new production schedule.
- **Dated verification:** not recorded. Positive hydration is unproven until a real `poster_path` appears on a natural weekly run.
- **Uncertainty:** whether 03:24 UTC is quiet enough versus EPG/Discovery and whether the monitor thresholds (26 h, 2 h, the retry cap of six) fit the platform's real scheduling delay; both are to be measured on the first natural weeks, not assumed. The Product Owner accepted the decision 7 operational-report exception (R1), the intentionally undetectable idle daily firing (H1), and the residual concurrent loss risk of the write-once Monitor baseline and poster checkpoint (F1).

## Follow-ups

The implementation PR, not this one, ships and tests the following; this ADR only names them.

- **Documentation:** `docs/reference/api/monitor.md`, `docs/reference/api/admin.md`, `docs/reference/api/enrichment.md` (footer), `docs/reference/api/catalog.md`, `docs/reference/domain/events.md`, `docs/reference/domain/data-health.md`, `docs/architecture/observability-and-failures.md`, `docs/architecture/ui-and-read-models.md`, `docs/architecture/scheduling-and-orchestration.md`, `docs/architecture/discovery-and-resolution.md`, the runbook `docs/runbooks/catalog-poster-hydration.md`, the cross-ADR status text of 0048 and 0063, and evidence.
- **Tests:** deterministic Monitor policy (all states above, including stale or missing schedule and first-run grace), no-poster and no-op, 429/409/backoff, corrupt R2 checkpoint, CAS race, repeated cron, lost event write and replay without a TMDB call, aggregate-footer and Events UI/filter tests, exact cron routing and unchanged existing schedules.
- **Visual QA:** rendered Mermaid on GitHub and a browser check of the footer and Events Log at desktop and mobile widths, written in the implementation PR (no screenshots).
- Activation of the new production cron remains a separate explicit owner GO before the implementation PR merges.
