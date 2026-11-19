# ADR 0179: A weekly Worker cron retries TMDB for catalog films without a poster and hydrates D1 through one shared core

**Status:** Proposed  
**Original decision date:** 2026-11-19 (product goal and weekly cadence only; design forks below are open)  
**Recorded at:** 2026-11-19  
**Approval source:** [Product Owner decision on the AIR-543 card, 19 November 2026 (Europe/Madrid)](https://trello.com/c/GQDcwdVx): approves the product goal and a weekly cadence. It does **not** approve this design, the new production cron, or any TMDB sweep.  
**Related work:** [AIR-543](https://trello.com/c/GQDcwdVx); [AIR-515](https://trello.com/c/FMWcvvWI); [AIR-526](https://trello.com/c/olszZU9B); [AIR-302](https://trello.com/c/9rqjCMhy); [ADR 0048](0048-permanent-catalog-poster-maintenance-route.md); [ADR 0063](0063-catalog-poster-negative-index.md); [ADR 0174](0174-discovery-only-fast-recovery-cron.md)  
**Supersedes:** [ADR 0048](0048-permanent-catalog-poster-maintenance-route.md) decision 5 and [ADR 0063](0063-catalog-poster-negative-index.md) decision 2, **for the automated paths only** (see "Authorization override"). ADR 0063's rejection of a cron for plain record expiry is not reversed: this cron performs a real retry and hydration. Takes effect only when Accepted and activated.  
**Superseded by:** None

## Context

D1 `discovery_admission` is the authority for the catalog and its posters. Today a film without a poster is handled only by the owner-only `POST /api/enrichment/catalog/posters`. The R2 negative index (`epg/catalog-poster-negatives.json`) remembers `no_poster_on_tmdb` for 90 days, but an expired entry is only *actionable*; nothing acts on it. At 19 November 2026, 12 Film rows have no poster, none is indexed, and Discovery makes the TMDB detail call at admission but does not record a missing `poster_path`. The owner wants this to run without manual steps. The Worker already has two crons (`0 * * * *`, `1-59/2 * * * *`).

## Decision (proposed)

1. **Seed at admission.** When Discovery has a complete TMDB movie detail whose `id` equals the verified canonical id and `poster_path` is absent, it writes `no_poster_on_tmdb` (`checkedAt`, `nextCheckAt = checkedAt + 90 d`) through the existing index compare-and-swap, with no second TMDB request. Network error, 429, 5xx, incomplete body, id mismatch and unverified identity are never recorded as "no poster". An index failure never blocks the admission; the film is left for the weekly catch-up.
2. **One shared core.** The body of the poster route (partition, TMDB detail, validation, guarded D1 conditional update, lease, generation and authority guards, negative-index CAS) is extracted into one bounded internal service. The owner route and the weekly handler both call it; the weekly handler does not call the Access-protected route. D1 only: no R2 catalog writer or fallback. `tmdb_id_mismatch` is never rechecked automatically.
3. **Weekly sweep on a separate cron branch.** `src/worker.js` dispatches on the exact `controller.cron`; the weekly branch runs only the poster service and none of EPG, Ratings, Monitor or Discovery recovery. Existing `0 * * * *` and `1-59/2 * * * *` are unchanged and asserted by test. Candidates: current D1 Film with no HTTPS poster, verified TMDB id, not retired/superseded, and no index entry or an expired `no_poster_on_tmdb`. Batch size, TMDB pacing and per-run request budget are bounded; a cursor resumes a large backlog.
4. **Outcomes.** Real `poster_path` → guarded HTTPS poster in D1. Absent again → new `checkedAt`, `nextCheckAt +90 d`. 429 → honour `Retry-After`; 5xx, network, timeout → candidate stays due with bounded backoff and no 90-day penalty. Stale, superseded or already-present → no-op with 0 TMDB calls and 0 D1/R2 writes.
5. **Busy Discovery lease / EPG priority.** A `409`/busy is not a skipped week. The run records a checkpoint and resumes (fork A below; bound stated there) without holding the lease while waiting and without competing with EPG or Discovery priority.
6. **Observability.** One structured run summary (`runId, scanned, due, checked, hydrated, noPoster, retryable, deferredBusy, pending, nextRetryAt, rateLimit, duration`), readable through the existing read-only status/admin surface; a signal only on material failure or success, none on no-op. `GET /api/admin/posters` stays side-effect free.

## Authorization override (explicit)

This proposal deliberately changes two Accepted contracts, for the automated paths only:

- **ADR 0048 decision 5** ("every production execution call stays a separate owner-approved operation"): superseded for the weekly handler. After **one** owner-approved activation GO for the Cloudflare schedule, each scheduled retry and its D1 poster writes run without a further approval.
- **ADR 0063 decision 2** (negative verdicts are stored only from an explicit owner `POST`): superseded for (a) the admission-time seed and (b) the weekly handler's own TMDB answers.
- **Unchanged:** the manual `POST /api/enrichment/catalog/posters` keeps its owner gate, dry run, `recheck` and receipts; `tmdb_id_mismatch` is never rechecked automatically; no R2 catalog writer; `GET /api/admin/posters` stays side-effect free.
- **Approving this Proposed ADR activates nothing.** Activation needs a separate explicit owner GO on the Cloudflare schedule before the implementation PR merges. Cross-ADR status text in 0048 and 0063 is updated with the implementation PR, when this ADR is Accepted.

## Open design forks (owner decision required before implementation)

### Fork A: how a busy or rate-limited run resumes

| Option | Mechanism | Advantages | Drawbacks |
| --- | --- | --- | --- |
| **A1 (recommended, revised after review)** | One daily expression, `24 3 * * *`. Sunday firing starts the weekly sweep; every other firing is **pending-only**: it reads the checkpoint (one R2 read) and ends unless a run is `pending` and `nextRetryAt` has passed. | One new schedule entry; no Workflow or binding; no coupling to the Discovery fast tick; 7 firings a week, six of them one read. **Stated bound:** a busy lease or 429 on any day is retried at the next daily firing, so the worst added delay is about 24 h plus the `Retry-After`, and a pending run keeps being resumed through the whole week until the next Sunday sweep supersedes it. | Resume granularity is one day, not minutes. A week's work can still end `pending` if the lease is busy on every daily firing; that is reported in the run summary and is the exception the owner accepts under this option. |
| A2 | Checkpoint plus a poster check on the two-minute Discovery fast tick. | Finest resume time. | Adds a poster read to a tick that ADR 0174 defines as Discovery-only; couples two recovery clocks; 720 extra reads a day. |
| A3 | A new Cloudflare Workflow with `step.sleepUntil`. | Most precise, no lease held while sleeping. | New binding, class, rollover path and instance ownership rules; disproportionate for one weekly low-priority job. |

### Fork B: where the checkpoint lives

| Option | Advantages | Drawbacks |
| --- | --- | --- |
| **B1 (recommended)** One R2 object `epg/catalog-poster-weekly.json` (run id, cursor, `pending`, `nextRetryAt`, last summary), written by compare-and-swap like the negative index. | No migration; same proven CAS pattern; small. | Weaker consistency than D1; a lost CAS race is retried once, then the run ends and resumes next firing. |
| B2 A D1 table. | Stronger consistency, transactional with poster writes. | Needs an owner-gated schema migration for one small row. |

### Recommendation

**A1 + B1.** The daily pending-only tick spans the whole week, so a busy lease or 429 does not skip the week (it is retried within about a day, not stranded until next Sunday). It is the smallest change that meets this: no new execution surface, no change to existing schedules, no migration, one-line rollback (remove the cron entry and branch). A2/A3 buy resume precision this low-priority job does not need. If the owner later wants stronger consistency, B2 can replace B1 behind the same service interface.

## Alternatives considered

- Keep the owner-only manual route: rejected by the owner for routine operation.
- Self-fetch the owner POST: rejected; it would require bypassing Access.
- Adding the weekly work to the hourly tick: rejected; it would run on every tick and couple poster retry to EPG/Ratings/Monitor.

## Consequences

- Posters that appear on TMDB reach D1 without manual action; a film with no poster costs one TMDB call per 90 days (checked weekly, held until due).
- A third schedule entry exists in live configuration (fork A1: daily firing, weekly sweep); deploy replaces schedules with `wrangler.jsonc`.
- An automatic D1 writer exists. Its safety is the existing guards; seed adds one conditional R2 write per newly admitted film without a poster.

## Recovery and migration boundary

Revert the pull request to remove the cron and handler; already stored D1 posters and index entries are not rolled back. This ADR authorizes **no** production operation: the new production cron needs a separate explicit owner GO before merge of the implementation, and no manual TMDB, Discovery, EPG or poster POST, D1/R2 write, lease reset, flag, Task or Access change is authorized.

## Evidence

- **Original decision:** AIR-543 card (above).
- **Implementation:** not started; waits for owner decision on forks A and B and independent review of this ADR.
- **Dated verification:** not recorded. Positive hydration is unproven until a real `poster_path` appears on a natural weekly run.
- **Uncertainty:** whether Sunday 03:24–09:24 UTC is quiet enough versus EPG/Discovery; to be measured against current run records, not assumed.

## Follow-ups

Reference updates (`catalog.md`, `admin.md`), runbook `catalog-poster-hydration.md`, architecture pages and evidence ship with the implementation PR.
