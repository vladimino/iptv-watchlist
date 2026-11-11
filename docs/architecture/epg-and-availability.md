# EPG publication and availability

The active programme is a **published-generation projection**, not an append-only lifetime schedule. Sources: [EPG publication ADR](../adr/0008-atomic-epg-publication.md), [Film/Person availability contract](../reference/domain/film-person.md), [discovery reference](../reference/domain/candidate-discovery.md), and [Worker routing](../../src/worker.js).

```mermaid
flowchart TD
    source["Configured EPG XML source"]
    parse["Authorized sync: parse broadcasts and match shows"]
    staging["Stage the generation:<br/>immutable discovery ledger in R2,<br/>staging payload; the run moves to stage seal"]
    seal["Bounded seal steps (about 30 s each):<br/>ledger rows and cursor in one D1 batch,<br/>archive, then the catalog difference"]
    pointer[("Published generation pointer:<br/>D1 published_epg_authority (d1 / open);<br/>R2 pointer is a compatibility mirror")]
    readers["Programme / film page / availability readers"]
    window["Availability projection:<br/>past 72h, future 24h for hot"]
    ensure["Hourly ensure: R2 mirrors"]
    previous["Prior published generation remains readable"]
    stale{"Writer still owns pinned generation?"}
    update["Apply generation-scoped catalogue/decision update"]
    reject["Abort stale update without touching newer generation"]
    source --> parse --> staging --> seal --> pointer
    pointer --> readers --> window
    pointer --> ensure
    seal -.->|until pointer switch| previous
    pointer --> stale
    stale -->|yes| update
    stale -->|no| reject
```

## Film availability lifecycle

On the published shows a film is, at every instant, in one of three states ([ADR 0114](../adr/0114-film-availability-lifecycle.md), [reference](../reference/domain/film-availability.md)). The state is computed from the shows, never stored. A ready archive outranks live and future; a show on air is not an archive until it ends; `soon` turns `available` at the END of the show.

```mermaid
stateDiagram-v2
    [*] --> unavailable
    unavailable --> soon: a show starts within the next 24 h or is on air
    soon --> available: the show ends (its recording is ready)
    available --> unavailable: 72 h after the start of the last ready show
    soon --> unavailable: the candidate shows are gone without an archive
    available --> available: a repeat or a show on air changes nothing
```

The 72-hour catch-up and the rolling 24 hours are the existing [EPG horizons](../reference/domain/epg-horizons.md); the 168-hour retention is storage only.

The publication pointer changes **after** the complete generation exists, and with D1-authoritative discovery after its ledger is sealed ([ADR 0092](../adr/0092-resumable-bounded-ledger-seal.md)): the commit stages the generation and returns, bounded `epg_sync_step` calls seal the ledger, update the catalog and publish, and the previous generation stays readable meanwhile. A partial write does not expose mixed versions. A newly published generation replaces its current show lists; current availability does not carry forward old shows. Show observations and `epgLastAiring` are not permanent Film identity attributes. Where the published generation is known, absent or mismatched `showsProgrammeRunId` cannot prove the film is hot; explicit `shows: []` means no known availability.

After the pointer switch the commit opens the discovery series of the new generation before its memory-heavy tail (watchlist and events, prediction queue, ratings); the write is fenced to the published generation and keeps a live writer or an existing series of the same generation. See [ADR 0030](../adr/0030-discovery-queued-at-publication.md). The tail's prediction queue rebuild is a conditional write that rebuilds on conflict with another queue writer ([ADR 0064](../adr/0064-prediction-queue-conditional-writes.md), Accepted 2026-10-31). A conflict it cannot resolve is recorded as `enrichmentQueueError` and does not fail the commit.

Retention and display are separate from hot processing ([EPG horizons](../reference/domain/epg-horizons.md)): the published generation keeps reliable watchlist shows up to 168 hours ahead, and the 24-hour future window below remains the hot discovery, resolver, prediction and catalog horizon. Availability calculations use a 72-hour lookback for hot showings and a 24-hour future planning window; the last known airing supports a 72-hour availability horizon. These domain computations are not equivalent to ingesting a new EPG. Late resolver activity must respect the pinned generation before writing programme or decisions.

**Current production (3 November 2026):** [ADR 0079](../adr/0079-d1-authoritative-published-epg.md) (Accepted) is activated: migration `0008` applied, `published_epg_authority.mode=d1`, `cutover=open`. D1 owns the published generation, programme/watchlist membership and generation fence. `programme.json`, `watchlist.json` and `epg/published-generation.json` are R2 compatibility mirrors, not a fallback on a D1 failure. GET and HEAD of programme, watchlist, catalog availability and Admin read the pinned D1 generation and do not repair those mirrors; the existing hourly `EpgOrchestration.ensure` and the publication/revert tails do ([ADR 0108](../adr/0108-epg-mirror-reconciliation-writer.md)). Discovery decisions and admission follow the discovery marker. [ADR 0085](../adr/0085-d1-authoritative-discovery.md) (Accepted 2026-11-04, [AIR-320](https://trello.com/c/4cA5GlJn)) is activated: migration `0011` applied, `discovery_authority.mode=d1`, `cutover=open` at generation 1 ([activation record](../evidence/d1-migration/air-320-discovery-activate-2026-11-04.md)). `0009`, `0010` and `0011` are applied. The revised staging/current-state label was visually approved by the owner on 2026-11-04; the original diagram was approved on 1 November. [Production evidence](../evidence/d1-migration/air-319-production-cutover-2026-11-03.md) records a first successful post-cutover generation: a scheduled-task-created run completed by one owner-authorized manual step on 3 November (published run `00ff34fa…`). Raw D1/R2 parity and programme/watchlist/availability consumers remain pending separate safe verification.

**Proposed Cloudflare executor recovery.** Under the shared reliability contract ([ADR 0089](../adr/0089-shared-orchestration-reliability-contract.md), Accepted; not activated), an EPG executor publishes at most once per Europe/Madrid date after 17:00 local time. A failure before the D1 pointer switch leaves the earlier generation published; after a lost response, reading the pointer decides whether this run is already published. Mirror repair writes R2 mirrors only from the currently published D1 generation. Publication may queue Discovery's fenced intent as a fast path, but not in one transaction with the pointer switch; Discovery's `ensure` reconstructs the intent from the published generation if it is missing, and EPG never waits for it. The flowchart above is unchanged; the executor is drawn on the [scheduling page](scheduling-and-orchestration.md#proposed-cloudflare-executors-and-shared-recovery). Contract: [orchestration reliability](../reference/orchestration-reliability.md#epg).
