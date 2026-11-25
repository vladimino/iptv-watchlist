# ADR 0219: Films are enriched by one event-driven, priority-ordered Catalog Enrichment Producer; Discovery-only Films join it through a scope that starts at activation

**Status:** Proposed  
**Original decision date:** not decided  
**Recorded at:** 2026-11-25, from `main` `40c8a3a`. Rewritten as one coherent contract for the Product Owner's directions: the [selections 1B / 2A / 3A / 4A / T1-a](https://github.com/vladimino/iptv-watchlist/pull/1005#issuecomment-7174458421), the [resource-bounded draining correction](https://github.com/vladimino/iptv-watchlist/pull/1005#issuecomment-7175276886) and the [strategic decisions P1 to P6 with the event-driven contract](https://github.com/vladimino/iptv-watchlist/pull/1005#issuecomment-7176847638). The earlier observation-and-intake design (1C) and the polling-first revision (reviewed at `46fadce`) are kept only as unselected alternatives  
**Approval source:** not documented. The owner's directions above are directions for a consolidated Proposed revision, not the ADR disposition, which still needs an ADR-specific decision on this text. The owner's direction replaces the former Choice 5, so **no open owner choice remains in this record**  
**Related work:** [AIR-655](https://trello.com/c/YIPK38Tg). Native prerequisite [AIR-644](https://trello.com/c/nFBGvvnU) ([ADR 0218](0218-film-lifecycle-dimensions-revision.md), Accepted). Builds on Accepted [ADR 0083](0083-inert-discovery-workflow.md), [0093](0093-discovery-workflow-cron-reconcile.md), [0094](0094-discovery-workflow-invocation-budget.md), [0098](0098-discovery-workflow-step-failure-recovery.md), [0134](0134-discovery-admission-producer-wiring.md), [0135](0135-epg-priority-discovery-pause.md), [0155](0155-retire-enrichment-projector-cron.md), [0174](0174-discovery-only-fast-recovery-cron.md), [0175](0175-epg-priority-holds-until-run-complete.md), [0207](0207-letterboxd-admissions-coordinated-in-d1-only.md), [0211](0211-catalog-enrichment-producer.md), [0214](0214-film-metadata-per-field-provenance.md), [0216](0216-canonical-film-lifecycle-and-unified-read-contract.md) and [0218](0218-film-lifecycle-dimensions-revision.md), and on the Accepted source-independent admission of [AIR-643](https://trello.com/c/e1Q9H1bG) ([ADR 0217](0217-source-independent-film-admission.md)). Evidence: the [AIR-627 census continuation](https://trello.com/c/IOERZ9GI#comment-6b06a0deb3fbeaeb5f93f8b2) and its [disposition](https://trello.com/c/IOERZ9GI#comment-6b06d8c178a1d27ed10c4e8f). The producer is implemented by [AIR-605](https://trello.com/c/jnqrdG71) and first activated for rated Films by [AIR-607](https://trello.com/c/Daq02gYy); provenance enforcement is [AIR-636](https://trello.com/c/0jJADYxg); projection-aware localization is [AIR-662](https://trello.com/c/P8cCPv1V); rated and Watchlist widenings are [AIR-614](https://trello.com/c/wUHl13Yw) and [AIR-615](https://trello.com/c/fCXSmk7K), which this record neither extends nor duplicates  
**Supersedes:** None  
**Amends, only upon acceptance of this record, narrowly and by the clauses named in decision 11:** [ADR 0211](0211-catalog-enrichment-producer.md) decisions 2, 3, 3b, 4, 5 and 6 (the shared upstream coordination 0211-5 = C is preserved) and [ADR 0214](0214-film-metadata-per-field-provenance.md) decision 10; and adds an admission signal to the Discovery authority contract  
**Superseded by:** None

## Context

### What exists (main `40c8a3a`, 25 Nov 2026)

- **The only canonical writer for a Discovery Film is minimal by design.** Since the projector was retired ([ADR 0155](0155-retire-enrichment-projector-cron.md)), a Discovery admission reaches canonical state only through the `film_mutation` unit of [ADR 0134](0134-discovery-admission-producer-wiring.md) decision 5 (`src/canonical-discovery-admission-producer.js`, origin `discovery`): the Film, the trusted `tmdb` claim and a title written only when blank. It writes no `film_metadata`, credits, Persons, aliases, localization or `canonical_identity`. When the Film already has its claim and title the mutation is a no-op with **no receipt**.
- **Every richer writer is bounded to another cohort.** EPG `film_facts` and credits target Watchlist Films only; `metadata_sync` is Watchlist only; the dictionary covers its entries; the Catalog Enrichment Producer ("C1", ADR 0211) is scoped to rated admissions (`film_rated_admission.verified_at >= cutoff_at`) with the widenings C3a (AIR-614) and C3b (AIR-615). C1's code and tables are **not yet in `main`**.
- **C1 already fetches what Discovery Films lack.** Its TMDB request is `movie/<id>?append_to_response=credits,translations`, one response with year, runtime, genres, poster, overview, the credits and the translations. Every Film/part/source has one state row and a stable receipt `operation_key` (ADR 0211 decision 3).
- **The Discovery payload is Discovery's own serving record**, not a source: it mixes TMDB values with EPG fallbacks, a poster that another path can fill, and aliases and availability that change on every EPG touch (`src/discovery.js:352`, `POSTER_UPDATE_SQL`). It is **not an input** of this design.
- **Identity facts already change under transactional writers.** `film_external_id` (claims), `tmdb_retirement_decision`, `film_redirect`, the metadata lock and the owner release rows are written by the canonical writers in fenced D1 batches, and the repository already uses database triggers for such invariants (ADR 0214).
- **Credit limits are scattered.** ADR 0211 bounds the expected set at 10 actors and 20 directors and the Persons at 30 per Film, within a unit cap of 50; the canonical credit reader refuses a Film with more than 200 credits (`CREDIT_READ_CAP`, `src/canonical-catalog-reader.js`); the EPG chain refuses a credit list over 50; the user interface shows the first ten.
- **EPG publication conflicts with Discovery over the catalog (resolver) lease and the projector window**, not with the canonical Film and Person tables (ADR 0135, 0175): enrichment takes neither the `discovery_lease` nor the `projector_window` and writes only canonical Film and Person state behind the Film/Person authority marker.
- **No Discovery Film has a Russian title in canonical state.**

### Census (AIR-627, L0, dated 25 Nov 2026, main `681b5c1`, Film/Person g2, EPG P519)

Dated aggregates, not live counts; the eligible historical counts per field and part are **not known**. Minimal Discovery Films (since 16 Nov, `film_mutation` only): 2 525, with no `film_metadata`, credits or aliases. Projector-era Discovery Films: 9 730, with projector credits and aliases but mostly no `film_metadata`. Future admissions: about 2 525 in about 9 days, so about 280 per day (a dated estimate). Rated (714, 473 with metadata missing) and Watchlist (391) Films belong to C1 and its widenings. `canonical_identity` NULL is not a proof of missing identity: each holds a trusted `tmdb` claim.

### The problem

Canonical Film/Person D1 is the authority (ADR 0216), but for Discovery Films it holds an id, a claim and a title, and nobody owns refresh. C1 is the accepted owner of enrichment, but its scope does not reach Discovery Films, and its accepted design is **polling-first**: a fixed per-tick quota, a scan that finds new work within hours and an anchor maintenance that finds changed identity within a day. The owner's direction is an event-driven producer: known work is enqueued **immediately** by the change that causes it.

### Settled decisions this record keeps

- `film_mutation` stays minimal (ADR 0134 decision 5). Discovery admission is unchanged except for the signal of decision 2.
- After enrichment the canonical row is the authority; the Discovery payload stays Discovery's serving record and is never copied into canonical state or read as source evidence.
- One producer, one queue and state owner: ADR 0211's planner, fetcher and state machine, with its anchors and agreement, the 72 h transport-only fallback (0211-7 = B), the credits namespace rule, write intent, epochs, lease, control, pause, shared upstream cooldown (0211-5 = C) and visibility; ADR 0214's rank and locks. No second producer, no Discovery ingestion producer, no parallel work queue, no observation pipeline.
- Identity is never inferred from a title, a year or a name. No Letterboxd or Wikidata anchor is invented. A 404 is neither a retirement nor proof of another Film.
- No unsolicited time-based **upstream** refresh.
- ADR 0218 keeps a `film_dimension` row only for owner or reviewed decisions, the ADR 0214 metadata lock, `titleSource` and the effective-localization projection.
- Mass enrichment waits for AIR-607 and AIR-636 natural acceptance; this gates activation, not this design.

## Owner directions and what each means here

| Direction | Selected | Reading in this record |
| --- | --- | --- |
| 1 Owner of metadata and credits | **1B** extend C1 | one producer; Discovery Films join it (decision 3) |
| 2 Russian localization | **2A** | the typed selection applied to C1's own TMDB response (decision 4) |
| 3 Cohorts and cutoff | **3A**, **P1 = B** | the Discovery stream starts at the **actual approved activation**; everything earlier is the history cohort (decision 3) |
| 4 Refresh | **4A**, **event-driven contract** | known work is enqueued immediately by its cause; the former Choice 5 is replaced by the contract of decision 2 |
| T1 History | **T1-a** | no legacy payload adoption; planning card HA (decision 10) |
| Execution | resource-bounded draining correction | decision 6 |
| **P2 = B** | retained membership | an admitted Film stays in the catalog and its work continues while it is no longer current or airing (decision 3) |
| **P3 = B** | personal and current relevance first | decision 5 |
| **P4 = B** | EPG priority without a blanket hold | decision 6 |
| **P5 = B** | automatic recovery of repairable errors | decision 7 |
| **P6 = A** | all correctly identified credits | decision 8 |

## Decision

### 1. One producer, one queue and state owner

C1 (ADR 0211; AIR-605) is the only planner, fetcher and state machine, and **the only consumer of the signal inbox** of decision 2. Emitters append signals and never edit C1's private state. A Film has **one** state row per part and source and the **existing** stable receipt keys of ADR 0211 decision 3 (`enrich:<film>:core`, `enrich:<film>:localization:<source>`, `enrich:<film>:credits:<source>:<chunk>` (decision 8) and `enrich:person:<person id>`), whatever scope admitted it. A scope is a **membership**, not a task: C1's eligible set is the union of its enabled scopes (rated, C3a, C3b, the Discovery scope C3c and, later, the history cohort and the source-independent admissions of ADR 0217). A Film in several scopes is planned once.

### 2. The event contract: a shared signal and invalidation inbox

**Principle.** Known work is made durably pending **by the change that causes it, in the same transaction**, and executed as soon as its guards allow. Enqueue is immediate; execution still respects approved activation, locks, verified identity, resources, backoff and contention. This replaces the polling-first discovery of ADR 0211 and the former Choice 5.

**The inbox.** One small, append-only, source-independent table, `enrichment_signal`, is the whole contract between emitters and C1: `id` (autoincrement, never reused), `kind`, `subject` (a Film id or a source key such as `tmdb:<n>`), `source`, `part` (nullable), `cause_digest`, `state` (`pending` or `consumed`), `armed_at`, `consumed_at`, with a **unique key on `(kind, subject, source, part)`**. It is justified by a concrete necessity: only a row written in the causal transaction is lossless without coupling the causal writers to C1's private state, and a trigger-written inbox reaches **every writer path**, the old Worker versions and the canonical writers alike. It is the only new persistent mechanism of the contract and holds at most one row per `(kind, subject, source, part)`, so it is bounded by the catalog.

**Coalescing without a waiting window.** An emitter writes with an upsert that re-arms (`state = 'pending'`, a new `armed_at`) when the cause is semantically new. A signal that is already `pending` is not duplicated and needs no new wake, so a burst coalesces to one item with no timer. A digest-carrying signal re-arms only when `cause_digest` differs from the stored one, so an identical observation writes nothing and wakes nothing.

**What is, and is not, an event** (the source, authority and event matrix):

| Event | Authority that changes | Emitter | Signal | What C1 does |
| --- | --- | --- | --- | --- |
| a new Discovery admission **after the Discovery scope is enabled** | `discovery_admission` insert | a trigger gated by the scope's `enabled` flag (decision 3) | `admitted`, source `discovery`, subject `tmdb:<n>` | records a retained membership; creates the Film's state rows when the Film resolves |
| a new verified rated admission | `film_rated_admission` insert | a trigger gated by the rated scope's flag | `admitted`, source `rated` | membership under the approved cutoff (AIR-607's predicate is unchanged) |
| a Watchlist member gained | `watchlist_film` insert (the ADR 0203 membership effect) | a trigger gated by the Watchlist scope's flag, with AIR-615 | `admitted`, source `watchlist` | membership |
| a verified Letterboxd-only admission (ADR 0217) | its admission coordinator | its own emitter, in a later delivery | `admitted`, source `letterboxd` | membership; staged, not activated now |
| a trusted anchor added, removed or corrected, **including a competing owner of the same value** | `film_external_id` insert, update or delete | a trigger, for the row's Film **and every other Film holding the same `(scheme, value)`** | `anchor_changed` | reopens as ADR 0211 3b |
| a retirement | `tmdb_retirement_decision` | a trigger, for the Films holding that TMDB id | `anchor_changed` | same |
| a redirect or merge | `film_redirect` insert | a trigger, for the source and the survivor | `anchor_changed` | membership and state follow the survivor |
| a **protection released** (the metadata lock, an owner pin, reviewed localization) | `film_dimension`, `film_metadata_field` (once PV1 delivers it), the release row | triggers on a change from protected to unprotected | `protection_released` | wakes the part the protection held |
| a **meaningful verified source-data change** | a producer's own verified response | a code emitter in the batch that handles that response (initially Discovery's verified TMDB detail) | `source_changed`, with a digest | marks the part due when the digest differs from what C1 applied (below) |
| an owner refresh or retry | C1's own admin route | the route updates C1's state and kicks | direct, no signal | the part is due |
| a retry, a cooldown end, a source recovery | C1's own durable `retry_at` and `upstream_cooldown` | a parked wake (below) | none | the item is runnable at its due time |
| **not an event** | an EPG touch, a poster or payload update, the admission `generation`, a status flip of an admission, a bulk load that only updates existing rows, **C1's own writes and bookkeeping**, a repeated identical observation | none | none | none |

**A meaningful verified source-data change.** The source producers share one pure function that projects a verified response onto the typed fields of a part (core fields; the credit set with person ids and source order; the Russian-title selection) and takes the digest of that projection. An observer writes a `source_changed` signal **only from its own verified response**, never from a serving payload. C1 treats the signal as a **hint**: it compares the digest with the `source_version` of the part it last applied, drops it when they are equal (no fetch, no write), and otherwise marks the part due, **fetching its own fresh response with its own `observed_at`**. This gives proof (the observer's own verification), dedup (the digest, the coalescing key) and **no feedback loop** (C1's writes emit no signal, and no emitter reads C1's output). Discovery's verified TMDB detail is the first emitter; the EPG Letterboxd metadata sync and others adopt the same contract in their own deliveries.

**Atomicity, and no network call in the transaction.** Triggers fire inside the causal statement, so the signal and the change commit or fail together. A code emitter appends its signal in the same batch as the change it reports. No emitter makes a network call. A crash after the commit and before any wake loses nothing, because the pending signal is durable.

**Prompt wake, due-time wake and recovery.**
- **Kick.** Every Worker code path that commits a causal change calls `kick` after the commit (`ctx.waitUntil`, best-effort): a control read, the run record and, only when an instance is alive, one platform call; idle producer: it creates the instance now, parked producer: it sends it a `kick` event. An idle producer is therefore started **promptly after the commit, not at the next cron**.
- **Due time.** When every remaining item is deferred (a future `retry_at`, an active cooldown), the instance **parks** with `step.waitForEvent` whose timeout is the earliest known due time, and resumes at that time or at a kick, whichever is first; a parked instance holds no lease, uses no CPU and does not count toward concurrency.
- **Recovery, not the ordinary path.** A reconcile cron (every five minutes by default) and a bounded scan **only recover** what a lost kick, a path without the hook (a manual statement, an old Worker version) or an instance failure left behind: it starts a run when a pending signal, a due part or an unowned lease exists. The scan is also the daily safety net for the invariants the triggers cover. No fixed 24-hour or five-minute discovery delay is part of the ordinary path.

**Dormancy.** An emitter gated by a scope's flag writes nothing before that scope is enabled, and C1 does nothing while its control is not `active`. The anchor and protection triggers, being cohort-independent, write only the bounded coalesced inbox; C1 ignores their subjects that belong to no enabled scope.

### 3. The Discovery scope C3c: starts at activation, membership retained

**The cutoff is the activation.** C3c is activated by its own owner operation (card C3c-A), which in **one D1 batch** sets the scope's `enabled` flag. From that commit on, every genuinely new Discovery admission emits an `admitted` signal; everything admitted before it belongs to the **history cohort** (decision 10), unless independently eligible through another enabled scope. **No timestamp, sequence, column or backfill is needed**, and none is invented.

**Why no admission fact columns.** The signal row is itself the durable fact, and the activation races are closed by construction:
- *Activation race:* the trigger evaluates the committed flag per insert, so a row inserted before the activation commit is history and one after is stream.
- *A new admission of an already existing Film, and a no-op canonical receipt:* the trigger is on the admission row, independent of any canonical mutation or receipt.
- *Delayed canonical admission:* the `admitted` signal stays `pending`, and C1, on consuming the `anchor_changed` of a Film, resolves every pending `admitted` signal whose subject `tmdb:<n>` equals that Film's trusted `tmdb` claim. The claim's appearance is itself an event, so no scan is needed.
- *A pre-activation admission swept to its canonical Film later:* the Film's claim emits only `anchor_changed`, and C1 ignores an anchor signal for a Film with no membership, so the old admission is **never silently promoted**.
- *Transfer and restore:* there is **no update trigger**, and the insert trigger fires only for a row that did not exist. A transfer moves existing rows to `pending` and upserts them back, which **updates** them and creates no signal; a restore of the database restores the inbox consistently. A row the transfer inserts is genuinely new (the code inserts it `current`). So a row that existed before the activation can never become stream, whatever transition it later undergoes.
- *Historical classification:* no signal is history; nothing is classified by a clock.

**Membership is retained (P2 = B).** On consuming an `admitted` signal C1 creates a **retained membership** `catalog_enrichment_member(film_id, scope, admitted_at, signal_id)` once the Film resolves. From then on the Film's eligibility **does not depend on its still being current or airing in Discovery**: a superseded admission, an EPG change, a transfer or a re-admission neither discards outstanding work nor excludes the Film. Kept as accepted, whatever the membership: an explicit cohort disable or pause (a Film is processed while at least one of its memberships is in an **enabled** scope); an authoritative retirement; an invalid or conflicting identity; the redirect or merge rules (membership and state follow the survivor); the metadata lock and owner pins. A Film retained after a superseded admission, an in-flight change, a later re-admission, a merge or a lock keeps **one work item per Film, part and source**; a re-admission is coalesced and creates nothing new.

**Reconciliation with accepted records.** The existence of a Film is independent of membership (ADR 0216); this record changes no Film's existence. The rated and Watchlist scope boundaries are unchanged, and AIR-607's rated cutoff predicate stays: only the **intake** of its candidates becomes an event. ADR 0217's source-independent admission is a future emitter of the same `admitted` signal; **a source-only Film outside every approved scope stays excluded**, and its integration is a later, separately approved delivery, not activated here.

**Sources, anchors and agreement are unchanged.** For a Film in C3c, C1 derives the applicable sources as ADR 0211 decision 2 does: the `tmdb` anchor makes `tmdb` and `wikidata` applicable; `letterboxd` only with an existing trusted lid claim, never invented. Agreement, the 72 h fallback, precedence and `identity_disagreement` are unchanged.

### 4. 2A: the typed Russian title comes from C1's own TMDB response

C1's `localization` part writes the `tmdb` source row from the response that already carries `credits,translations`, with **no separate fetch**. The selection reads the `translations.translations` entries with `iso_639_1 = 'ru'`: exactly one distinct non-blank `data.title` is the value; several entries are decided by `iso_3166_1 = 'RU'`, and if they still differ the selection is **ambiguous** and nothing is written (a recorded gap, owner-resolvable); no `ru` entry is a legitimate absence (`complete_with_gaps`); a missing or malformed section of an otherwise complete response is **unreadable** and is a repairable failure (decision 7). The response `title`, aliases and `movieTitles` are never read as a Russian title. The unit is the existing per-source key `enrich:<film>:localization:tmdb` (the `letterboxd` and `wikidata` keys stay distinct), written through the AIR-662 projection-aware operation with reviewed and owner precedence. The original 2A carried the translation through a Discovery observation; under 1B that transport does not exist, because C1 fetches the response itself, and reusing Discovery's response would need the rejected observation subsystem, so it is not reintroduced.

### 5. Priority and fairness (P3 = B)

**Supersedes the global strict oldest-first rule of ADR 0211 decision 4.** The one queue has two classes:
- **Live:** Watchlist, rated and the current Discovery stream, **one tier**, ordered inside it by age (oldest `due_since` first). No order between the personal and the current categories is invented.
- **History:** background historical work (the later cohort of decision 10), served after live work.

**Starvation prevention.** At least **one of every eight Films started** is taken from the oldest due history item whenever history has runnable work and live work continues to arrive, so history always makes progress. A Film appearing in a live scope is live. Unknown membership or availability is never treated as irrelevant. The share, the choice of eight and the order inside a tier are engineering defaults in one module, measured and adjusted, not owner parameters.

**Measured, not promised.** The harness reports completion latency per class, oldest due age, history progress under sustained mixed load, EPG holds and retries; no zero-degradation claim is made.

### 6. Execution: a resource-bounded queue drainer, event-woken

The producer is a **work-conserving, resource-bounded queue drainer from its first implementation (AIR-605), across every scope**. ADR 0211 decision 5's starting design values (a 25 s tick deadline, a 5 s reserve, 2 Films per hourly invocation, a 12-unit budget, a derived 8-request ceiling, a 10 s second-Film rule, a measure-first rule, hourly scheduling) were never a provider limit or a separate owner selection ([the executor's comment of 24 Nov](https://github.com/vladimino/iptv-watchlist/pull/975#issuecomment-7132176638)) and are removed as normative limits, **without being replaced by larger numbers**. Safety budgets stay; throughput quotas go. The execution reuses the proven Discovery pattern ([ADR 0083](0083-inert-discovery-workflow.md), [0093](0093-discovery-workflow-cron-reconcile.md), [0094](0094-discovery-workflow-invocation-budget.md), [0098](0098-discovery-workflow-step-failure-recovery.md), [0174](0174-discovery-only-fast-recovery-cron.md)):

| Part | Design |
| --- | --- |
| Executor | one Workflow class; an instance is a run; **a step is a bounded group of units of one Film** (sized by a statement slice, decision below), durable and replay-safe; one owner through the `projection_run` lease and a deterministic series and instance id |
| Resource guard | the instance counts the D1 statements it issues, **failing and replayed calls included**, and **hands over** to a successor at the budget, created before it finishes (ADR 0094) |
| Continuation | a run ends only for: no runnable work (it **parks** or finishes), the statement or step budget (**handover**), every remaining item deferred (it **parks** until the earliest due time), a pause, a lost lease, or a repairable step failure (decision 7) |
| Wake | the kick, the parked event and the reconcile cron of decision 2 |
| Cooldown, receipts, units, guards, epochs | unchanged (ADR 0211 decisions 3 and 5, ADR 0207 decision 3) |

**Resource guards and defaults** (engineering-owned tuning, constants in one module and reported in each run's outbox entry): the instance statement budget of **6,000** is the ADR 0094 initial guard, not a provider limit; **Workflow steps hand over at 5,000**, half the documented 10,000; subrequests share the statement counter against the documented default of 10,000; CPU is bounded by the configured `cpu_ms` (120,000), with the harness showing the statements bind first; the lease TTL is five minutes, renewed before each step; the per-request timeouts (TMDB 12 s, Letterboxd 15 s, Wikidata 15 s) are provider-response bounds and **no run deadline**; the per-scope upstream concurrency is one; a step takes a statement slice of about 500; read pages are 500 rows. **There is no whole-Film-fit rule:** a step starts when the remaining budget covers **its own unit group plus a finalize-and-successor reserve** (initially 1,000 statements, set by the harness), progress is durable per unit, and a Film with many missing Persons spans as many steps and instances as it needs and is **never deferred for not fitting**.

**Atomic handover.** The predecessor records the successor intent by compare-and-swap, creates the instance (idempotent by id), **releases its lease** by compare-and-swap and stops writing; the successor writes only after acquiring a new `lease_id`. A create whose response was lost, a crash between create and release, an expired lease during a parked or sleeping step, and a replayed step (which re-checks owner and lease first) are specified and tested. Platform step retries are capped (default three, the ADR 0098 tiers); the counters include failing and replayed calls.

**EPG priority without a blanket hold (P4 = B).**
- *Verified conflict surface.* EPG publication and Discovery contend over the catalog (resolver) lease and the projector window (ADR 0135, 0175). The producer takes neither, and writes only canonical Film and Person state behind the Film/Person authority marker with the Film revision, anchor and epoch fences. The surfaces it actually shares with EPG are D1 itself and those authority fences.
- *No hold.* **Enqueue is durable and immediate regardless of the EPG window.** The producer does **not** read the EPG priority gate as a stop, and an unrelated failed or stalled EPG is never a stop. **The EPG pause of Discovery admission is unchanged and not weakened.**
- *Narrow, per-item yield.* When a canonical batch fails a **shared authority fence** (the Film/Person marker held or unreadable, a writer-route refusal) or a **contention class** (D1 overload, a reset), that item is deferred with a short bounded backoff and the run continues with the independent work; a repeated contention class backs the whole run off by the ADR 0098 tiers. No concurrent write violates a generation, lease, projector or authority boundary.
- *Evidence required.* Tests and harness measurements show safe enrichment while EPG is active, a contention that yields, an EPG failure with no artificial indefinite hold, recovery, and unchanged EPG priority; the harness reports EPG publication latency with the producer running. A real conflict found there is returned as a trade-off, not hidden behind a new hold or timeout.

**The 72 h fallback is unchanged by local stops.** A handover, a yield, a pause, a lost lease or a resource stop leaves `pending_since` unchanged, consumes no failure, sets no cooldown and writes no transport outcome. An active shared upstream cooldown counts as upstream unavailability, as ADR 0211 accepted.

**Cron delivery, declarative and durable.** `wrangler.jsonc` owns the cron definitions. The reconcile expression is delivered by the **activation change of AIR-607 as a reviewed, versioned configuration change under its owner GO**; AIR-605's deploy carries only the dormant dispatch and binding, which do nothing while the control is inactive. Readback is the trigger list with the control; rollback is the configuration revert and a pause.

**Resource facts, as read on 25 Nov 2026** (Cloudflare documentation, Workers Paid; the repository's `wrangler.jsonc`, handler and `src/discovery-workflow.js`): CPU per invocation defaults to 30 s and can be set up to 5 minutes (the repository sets `cpu_ms` to 120,000); subrequests per invocation or Workflow instance default to 10,000 and are configurable up to 10 million, and a D1 call is one; a Workflow step has unlimited wall time subject to the CPU limit, `step.sleep` is capped at a year, an instance allows 10,000 steps by default and waiting instances do not count toward concurrency; a Cron Trigger invocation is limited to 15 minutes of wall time. The Workers Paid baseline of `AGENTS.md` applies: these are measurements, not gates. TMDB's published protective limit (about 40 requests per second, `429` handling required, per the owner handoff and not fetched here) is respected by the one-request-per-scope rule and the shared cooldown with `Retry-After` and is not read as a throughput allowance; Wikidata's limits are not assessed here.

**Acceptance is the ordinary AIR-605 acceptance by its offline cost harness**, on the real migrated schema with representative mixed-scope fixtures: real resource use, stop reasons, completed Films against arrivals, oldest due age, per-class latency, partial-unit resume, overlap and restart safety, absence of busy loops and starvation, upstream errors and cooldown, and EPG contention. It must show that the design drains more than two Films when resources permit, crosses step and instance boundaries without waiting an hour, wakes on a kick and on a due time without a cron, and sustains the intended arrival workload with headroom; no production capacity is claimed from fixtures, and a real constraint is answered by identifying its bottleneck, not by a manufactured quota.

### 7. Failures and automatic recovery of repairable errors (P5 = B)

ADR 0211's six definite failures and its `needs_attention` stop were an owner-facing manual gate for every definite failure. They are narrowed. Three things are kept distinct: **platform step retries** (capped, default three), **item failure diagnosis**, and **eventual recovery of repairable work**.

| Class | Examples | Treatment |
| --- | --- | --- |
| transport | 403, challenge, 429, timeout, network, 5xx, an active cooldown | unchanged: no failure consumed; the 72 h fallback rules are unchanged |
| **repairable definite** | a response that does not parse, a missing required section, a schema change, a provider or system error, a code defect | bounded retries with backoff; after the sixth the item is **`deferred_repair`**, a quarantine with diagnostics and an **automatic recovery condition**, never a hot loop |
| **irreparable or owner** | an identity conflict or disagreement, owner-protected data, an ambiguous translation, a 404 of an anchored entity (a hint, **not a retirement** and not proof of another Film) | stays with the owner; no automatic fallback or trust relaxation |

**Automatic recovery of `deferred_repair`** (scoped to the failed part and source; the settled parts are kept): the item is retried **once** when (a) the **code version** differs from the one recorded with the failure (a repair or deploy), (b) a **source recovery** is observed (a successful verified response of the same source and class for another Film), or (c) the failing source's **response digest** differs from the last failing one; and otherwise by a **low-frequency bounded recheck** (1 hour, then 6, then 24 hours, capped at 24) while the failure may still be repairable. The same failure signature on the same code version and the same response digest after a recheck is recorded as `irreparable_known` and is retried only on (a) or (c). Each failure records its class, signature, code version and response digest. The instance-level recovery of a Workflow step failure keeps ADR 0098's tiers and its last tier **repeats** (no terminal `quarantine` that needs a person), and a new code version retries at once. No explicit 0211-7 = B rule, no known-disagreement override and no trust relaxation is changed.

### 8. All correctly identified credits (P6 = A)

The catalog retains **every correctly identified credit in the supported roles (actor and director) available from the verified selected source**, with a stable Person identity, the source order as the ordinal, and dedup; existing valid relationships are preserved, nothing is deleted, no role is broadened, no identity is inferred from a name, and no incompatible person namespace is mixed (the ADR 0211 one-namespace rule). The original top-ten-actors choice was a personal display heuristic and is **not** a catalog limit; source completeness is separated from display selection, and **no change to the user interface's top-ten display is made or authorized**. The requirement is the full supported verified relationships, not a claim that a provider supplies every credited person.

**Hidden truncation removed from the common producer.** The expected set is **every** supported credit of the verified response (no 10 and 20), stored durably in bounded chunks by ordinal; Person acquisition has **no per-Film cap** (the 30 missing Persons go) and runs as many `enrich:person:<person id>` units as the set needs; credits are written in **stable chunks** of at most the existing unit cap (50) with the keys `enrich:<film>:credits:<source>:<chunk>`, where the chunk is the ordinal range, so a replay finds the same chunk; progress and completion are per chunk and per Person. The step slice, the handover and the absence of a whole-Film-fit rule (decision 6) let a Film of any size span steps and instances and resume exactly. **A genuinely complete set** (every expected credit exists) is distinguished from **truncated legacy coverage** (for example the first ten actors written earlier): the part is never complete merely because ten exist; the missing credits are added, in the one namespace, with existing ordinals kept (ADR 0120's differential) and the new credits appended after the highest of their role.

**Limits found in the actual code and contracts, and their effect.**

| Limit | Where | Effect on the full contract |
| --- | --- | --- |
| expected set 10 and 20, Persons 30, credits unit "≤ 30 (cap 50)" | ADR 0211 decisions 2 and 3 | **amended** here (decision 11) |
| the upstream response | TMDB's credits arrays are complete in the response; the Letterboxd page and Wikidata give what the verified page or item holds | source completeness is what the verified response holds, parsed without a cap; the parsers are checked in AIR-605 |
| the credits unit cap of 50 | the existing canonical credit writer | kept as a **chunk** size, not raised |
| the Person unit | ADR 0130: one Person, at most 40 external ids and aliases | per-Person, unaffected |
| the EPG chain's refusal of a credit list over 50 | the EPG producer path | unchanged, outside the common producer |
| the canonical reader's refusal above 200 credits (`CREDIT_READ_CAP`, fail closed) | `src/canonical-catalog-reader.js` | **a material change outside this record**: a Film with more than 200 credits would make that read unavailable. The reader must page or select for display instead of refusing. It is coordinated with the D1 credits reader work (AIR-656) and **must be in place before the common producer writes more than 200 credits for a Film in production**; this record does not change it |
| the Discovery payload's ten and ten | the serving record | not an input; unchanged |
| the user interface's top ten | display | unchanged |

**Fixtures:** a cast over 100 and one or two directors; an ensemble cast with known credits beyond ten; a cast needing many units and a rollover; several directors; a missing Person identity; interrupted and replayed work; legacy partial credits; the one-namespace refusal.

### 9. Schema, scope control, apply boundaries, compatibility and rollback

**The tracking columns, the early fact migration, the cyclic traversal and its cursor are not needed** and are withdrawn; the signal of decision 2 replaces them. No new table beyond the following is introduced.

| Addition | Domain | Purpose | Apply prerequisite |
| --- | --- | --- | --- |
| `enrichment_signal` and its triggers on `film_external_id`, `tmdb_retirement_decision`, `film_redirect`, `film_dimension` and, when PV1 delivers them, `film_metadata_field` and the release row | the common mechanism, with AIR-605's own schema | the source-independent inbox and the identity and protection emitters | AIR-605's migration and its apply; compatibility: the triggers write only the inbox and an old Worker version ignores it |
| `catalog_enrichment_scope(scope, enabled, cutoff_at, revision, updated_at, updated_by)` and `catalog_enrichment_member(film_id, scope, admitted_at, signal_id)` | catalog enrichment control and state | per-scope flags the gated emitters read, and the retained membership | after C1's control table exists; a forward migration unless AIR-605 approves carrying it |
| the gated `admitted` trigger on `discovery_admission` (on insert only, no update trigger) | Discovery authority | the Discovery emitter | with C3c-D's migration, after the scope table; it writes nothing while the scope is disabled |
| the gated `admitted` triggers on `film_rated_admission` and `watchlist_film` | rated and Watchlist | the rated and Watchlist emitters | AIR-605 (rated, gated by AIR-607) and AIR-615 (Watchlist); each its own apply |

**Coordination and boundaries.** A delivered migration is **never** edited because it has not been applied. AIR-605's schema is not in `main`; carrying the common additions in it needs AIR-605's explicit scope approval, otherwise they are forward migrations. AIR-600 delivers the receipt operation-key implementation and **AIR-603 is its apply gate**; every added object has its own apply, readback and rollback boundary. The Workflow binding and the dormant dispatch are deploy artifacts that create no instance while inactive. **Rollback:** a pause stops all scopes at once; disabling a scope stops its emitter (its gated trigger writes nothing) and its work; written values stay, corrected by the owner and review routes; a code revert stops future runs and leaves the inbox harmless.

### 10. Delivery graph, history and dependencies

The standalone capacity card is folded into AIR-605 and AIR-607, and the admission-fact card is withdrawn. **Planning authorizes nothing, creates no card and changes no existing dependency**; the Coordinator reconciles the actual Trello scope after this record is reviewed and accepted. Statuses are read live at delivery (at the last review AIR-662 was Done and AIR-605, AIR-607 and AIR-636 were in backlog).

| Card | Name | Kind | Depends on |
| --- | --- | --- | --- |
| **AIR-605** (existing) | Catalog Enrichment Producer, initial dormant implementation | offline, dormant: the **common mechanism**: the signal inbox and its identity and protection emitters, the event-woken drainer, the priority queue, the automatic recovery, the full credits, the contention behavior, and the **ordinary harness acceptance** | its own accepted prerequisites |
| **AIR-607** (existing) | Initial activation for the approved new rated cohort | an owner production operation under its existing GO: activates only the approved rated scope, delivers the reconcile cron as a versioned configuration change and verifies the initial natural runtime | AIR-605 delivered and applied (AIR-603); the credit-reader coordination of decision 8 |
| **C3c-D** (planned) | Discovery scope in the Catalog Enrichment Producer | offline, dormant: the gated `admitted` trigger, the retained membership, the Discovery `source_changed` emitter in the revalidation, the translation selection, per-scope counts, and the Discovery-specific capacity and acceptance in the existing harness | AIR-605 delivered; AIR-662 (delivered) |
| **C3c-A** (planned) | Activation of the Discovery scope | an owner production operation with readback and natural acceptance: enables the scope in one batch; the cutoff is that activation | AIR-607 and AIR-636 natural acceptance; the operation-key schema applied (AIR-603); C3c-D delivered and its schema applied |
| **HA** (planned) | Historical enrichment planning | L0 planning only (below) | none |
| **HR** (later, not planned now) | Historical enrichment rollout | a separately approved historical scope and activation | HA's plan and its own decision |

**No cycle, no new blockers.** No Discovery card is required before the initial rated implementation and activation, C3c adds **no AIR-275 prerequisite**, and AIR-614 and AIR-615 keep their plans and adopt the `admitted` signal in their own deliveries; the order of C3c-A relative to them is free. Genuinely necessary coordination, not a card: the credit reader of decision 8. The assumption this graph makes of the existing cards, that AIR-605 implements the event-woken drainer, the signal inbox, the priority, the recovery and the full credits rather than the polling-first limits, is a scope correction for the Coordinator to reconcile, not something this record applies.

**History (T1-a).** No legacy payload adoption, and no historical Film is written by this record. **HA** is a standalone, near-term planning deliverable, runnable in parallel with the safe design and dormant work, from approved evidence, offline copies or a separately authorized bounded read only (no fetch, no write): the measured per-field gaps and overlaps of the eligible historical Films (core fields, **all credits**, Russian title), excluding the live scopes and counting unresolved identities; the acquisition and budget options using the common producer, where one TMDB response carries core, credits and translations and so they share **one** response per Film; and the gates and capacity needed, read against the drainer. A Russian title for historical Films arrives only through a later approved historical scope.

### 11. Amendments to accepted contracts (explicit, scoped, effective only upon acceptance)

| Contract and clause | Amendment |
| --- | --- |
| ADR 0211 **decision 2**, the credits rule | the expected set is every supported credit of the verified response; the one-namespace rule is unchanged |
| ADR 0211 **decision 3**, "`credits` is complete" (at most 10 actors and 20 directors), the unit table (Persons per Film, "≤ 30 credits (existing cap 50)"), and the definite-failure rules (six failures, `needs_attention`) | the full expected set stored in chunks; Persons uncapped; credits in stable chunks of at most 50 keyed `enrich:<film>:credits:<source>:<chunk>`; definite failures become `deferred_repair` with automatic recovery (decision 7); the "this tick's own deadline or unit budget never counts" rule and the "Deadline between sources" paragraph become **any local stop** never counts; the 72 h rule is unchanged; the TMDB translation selection rule (decision 4) |
| ADR 0211 **decision 3b**, "Anchor check before filtering due work" | anchor changes are **events** (`anchor_changed`) that reopen the work at once; the per-Film digest recomputation before planning stays; the oldest-`anchor_checked_at` page of 20 becomes the **recovery and reconciliation scan only** |
| ADR 0211 **decision 4**, the initial scope and the **strict oldest-first fairness** | the Discovery scope C3c joins C3a and C3b; the live and history classes of decision 5 replace the global oldest-first rule; rated candidate intake becomes an event, with AIR-607's cutoff predicate unchanged |
| ADR 0211 **decision 5**, the **Deadline**, **Per-tick bounds** (2 Films, 8 requests), **Sources in parallel** (the deadline formula), **Writes after the fetches** (the 12-unit budget), **A second Film starts only with time left**, **Measurement before raising the bound**, **Scheduling** and the **Outcome outbox** (`tick_id`, interrupted-tick detection), and **Lease** wording | superseded by decision 6; the per-Film cap of at most 4 requests and the per-Film unit kinds are kept; the shared upstream coordination (0211-5 = C) is **preserved** |
| ADR 0211 **decision 6**, the control | a per-scope row with its own enabled flag and cutoff, the retained membership, and the activation as the one-batch enable; the initial rated activation is unchanged |
| ADR 0214 **decision 10**, the refresh triggers | extended from the five listed triggers to the events of decision 2 (admission and membership, anchors, protection release, a meaningful verified source-data change, owner refresh, source recovery), still with **no time-based upstream refresh** |
| Discovery authority contract | an admission signal emitted by a gated trigger on insert; no admission behavior and no column changes |
| `docs/architecture/scheduling-and-orchestration.md` and the Workflow and cron reference | the producer Workflow, the kick, the parked wake and the reconcile cron, recorded at implementation |

**Registry cross-reference on acceptance.** The ADR 0211 registry row is updated, on acceptance and not before, to point to this amendment, so that the superseded quota, the polling-first discovery and the credit limits cannot be mistaken for current policy.

## Alternatives considered (not selected; not normative)

- **1A** retain minimal admission and payload serving; **1C** a Discovery-published observation applied by a separate intake (five reviews; the owner selected 1B for a simpler architecture); **1D** widen `film_mutation`.
- **Polling-first with a scan and a maintenance interval** (the revision reviewed at `46fadce`): replaced by the event contract at the owner's direction.
- **A dedicated Discovery ingestion queue, or writers that edit C1's state directly:** rejected as a parallel queue and a cross-domain coupling; the neutral inbox and C1 as sole consumer replace them.
- **Writers append the signal in their own batch instead of triggers:** equivalent, but it misses every path that is not that writer (old Worker versions, manual statements) and must be repeated per writer; triggers cover them at the cost of a small write per change.
- **Admission fact columns (`first_current_at`, `fact_tracked`), a cyclic keyset traversal and an early migration:** withdrawn; the signal row is the fact under an activation-bound stream.
- **A blanket EPG hold, or reading the EPG gate as a stop:** rejected by P4; the producer takes no resolver lease and yields only per item on a real fence or contention.
- **Raising the fixed limits (2 to 20, 25 s to 5 minutes, 12 to another number), hourly-only continuation, a single long Cron Trigger run, a Queue or a Durable Object alarm:** rejected; the Workflow pattern already exists.
- **Keeping the top-ten and top-twenty expected set, or a larger arbitrary cap:** rejected by P6.
- **T1-b** a bounded legacy adoption of payload values: not selected.

## Examples

- **A new Discovery Film.** After C3c-A, `tmdb_123` is inserted into `discovery_admission`: the gated trigger writes `admitted` in the same transaction, and the Discovery code kicks. The producer wakes, creates the membership when the Film's `tmdb` claim exists (an existing Film immediately, a new one when `film_mutation` adds it, which is itself an `anchor_changed`), fetches `movie/123?append_to_response=credits,translations` and writes the core fields, **every** credit, and the `ru` selection, each with C1's own `observed_at`.
- **A pre-activation admission swept later.** Its row was inserted before the activation, so no signal exists. The sweep adds the Film's claim, which emits only `anchor_changed`; the Film has no membership, so the signal is ignored. It is history.
- **An EPG touch, a poster update or a revalidation.** No signal: nothing wakes and nothing is fetched. A verified Discovery revalidation whose digest equals the one C1 applied writes nothing; one whose digest differs marks the part due, and C1 fetches its own fresh response.
- **A superseded admission.** The Film's membership is retained; outstanding work continues. Disabling the Discovery scope stops it; nothing else does.
- **A lid claim appears on a complete Film.** The `film_external_id` trigger writes `anchor_changed` in the claim's own transaction; the producer wakes at once, reopens only Letterboxd's gaps and commits once; with nothing changed no run starts.
- **A burst.** Forty Films arrive; each coalesced signal kicks one producer, which drains them live-first with one history Film in every eight; at the statement budget it hands over to a successor and continues at once; with only deferred work it parks until the earliest due time or a kick; with none it quiesces.
- **An EPG publication runs.** Enrichment continues; one batch fails the Film/Person marker fence, that Film is deferred briefly, the others proceed; the EPG pause of Discovery admission is untouched.
- **A parser break.** A provider changes a section; six Films fail; each becomes `deferred_repair`; the next deploy changes the code version and they are retried once and recover; an unchanged failure is `irreparable_known` and is not retried until the code or the response changes.
- **An ensemble cast.** A Film with 140 cast and two directors writes 142 credits in three chunks of at most 50 and the missing Persons as individual units, across two instances.
- **A lock released.** The owner clears a metadata lock; the trigger writes `protection_released` and the held part is wakened.

## Acceptance scenarios and synthetic test plan (the AIR-605 harness and C3c-D, on the real migrated schema)

- **Signal contract:** every emitter of the matrix writes its signal in the **causal transaction**, and a failed change writes none; a burst and a duplicate coalesce to one pending item with no waiting window; an identical digest writes nothing and wakes nothing; `anchor_changed` is emitted for the row's Film and for every other Film holding the same value; a redirect and a retirement emit; a protection release emits; EPG touches, payload and poster updates, `generation` moves, status flips, bulk loads of existing rows and C1's own writes emit **nothing**; the inbox is bounded by the unique key.
- **Wake:** the kick starts an idle producer promptly and wakes a parked one; a lost kick (a crash after commit before wake, a path without the hook, an old Worker version) is recovered by the reconcile cron; a due `retry_at` or a cooldown end wakes the parked instance at its due time without a cron; an empty queue quiesces with no polling; no wakeup is lost across handover, pause and resume.
- **Discovery scope and cutoff:** an admission inserted before the activation batch is history and one after is stream; a new admission onto an existing Film and a no-op canonical receipt are admitted; a delayed canonical admission resolves on the claim event; a pre-activation admission swept later is not promoted; a transfer that updates existing rows and a restore emit nothing; a row re-confirmed or current again re-arms only an existing signal; the membership is retained through a superseded admission, an in-flight change, a re-admission, a merge and a lock; a disabled scope stops its work; overlapping scopes plan one Film with one state set and the existing keys.
- **Priority:** live work first with one history Film in every eight; history progresses under sustained live arrivals; the per-class latency, oldest due age and history progress are reported; membership or availability unknown is not irrelevant.
- **EPG:** safe enrichment while EPG is active; a contention class and a held marker yield per item; an EPG failure or stall is no stop; recovery; the EPG pause of Discovery admission is unchanged; EPG publication latency is measured with the producer running.
- **Recovery:** six or more parse failures then a real code fix recovers once; a provider recovery and a changed response digest retry; an unchanged failure is `irreparable_known`; a conflict and an owner-protected item stay with the owner; a 404 is not a retirement; a crash and restart, and a replay, write nothing twice; local stops never count toward the 72 h fallback while an active cooldown does.
- **Credits:** a cast over 100 with one or two directors; an ensemble beyond ten; many units across a rollover; several directors; a missing Person identity; legacy ten-credit coverage completed, not marked complete; the one-namespace refusal; stable chunk keys on replay; a Film never deferred for not fitting.
- **Execution:** more than two Films drain when resources permit; step and instance boundaries are crossed without an hour's wait; the statement, step and subrequest counters (failing and replayed calls included) hand over; the successor create with a lost response, a crash between create and release and an expired lease during a park behave as specified; no repeated empty handover.
- **Control and delivery:** the dormant dispatch does nothing while inactive; the cron comes only from the versioned configuration and survives deploys; the per-scope flags gate their emitters; old-version compatibility of every added object.

## Consequences

- One producer enriches rated, Watchlist, Discovery and later historical Films, woken by the change that causes the work: no polling-first delay, no second queue, no handoff.
- The accepted ADR 0211 is amended in six decisions and ADR 0214 in one, narrowly and only on acceptance; the shared upstream coordination and the 72 h fallback are unchanged.
- One small inbox and its triggers are the cost of an event-driven contract; the admission fact columns and cyclic traversal are gone.
- The catalog keeps all supported credits; a canonical reader change outside this record is a coordinated prerequisite of writing more than 200 credits in production.
- Each Discovery Film costs a TMDB request Discovery has already made once; the owner accepted this for simplicity.
- The producer is a work-conserving drainer; real throughput and EPG effect are shown by the harness, not claimed here.
- History is not written; HA plans it, and a later HR needs its own decision.

## Recovery and migration boundary

This record authorizes nothing: no migration, trigger, control or scope change, no activation, no cron, flag or Task change, no production fetch or write, and no card creation. Each card of decision 10 has its own gate. Code rollback does not remove written values or signals; correction is through the ADR 0214 owner route or a forward write.

## Evidence

- **Original decision:** the owner's directions on this PR: the [selections](https://github.com/vladimino/iptv-watchlist/pull/1005#issuecomment-7174458421), the [draining correction](https://github.com/vladimino/iptv-watchlist/pull/1005#issuecomment-7175276886) and the [strategic decisions P1 to P6](https://github.com/vladimino/iptv-watchlist/pull/1005#issuecomment-7176847638); the ADR disposition is pending.
- **Implementation:** none.
- **Dated verification:** the AIR-627 census of 25 Nov 2026 (L0, `rows_written=0`); the code references (`src/discovery.js`, `src/discovery-authority.js`, `src/canonical-discovery-admission-producer.js`, `src/canonical-catalog-reader.js`, `wrangler.jsonc`, the `scheduled` handler in `src/worker.js`, `src/discovery-workflow.js`, ADR 0094, 0135, 0174 and 0175, ADR 0211 decisions 2 to 6) read statically on `main` `40c8a3a`; the platform limits read from the Cloudflare documentation on 25 Nov 2026. The TMDB rate-limit statement is quoted from the owner handoff, not fetched.
- **Uncertainty:** real per-Film cost, throughput, signal volume and EPG contention (shown by the AIR-605 harness, not claimed); the actual admission rate; the eligible historical counts; whether AIR-605 delivers the common schema and the drainer or the Coordinator reconciles them differently; whether the parsers of each source expose the full credit set; the apply state of the operation-key schema (AIR-603); Wikidata's limits; the live status of AIR-605, AIR-607, AIR-636 and AIR-603 (read from Trello at delivery).

## Follow-ups

The existing AIR-605 and AIR-607 (the common mechanism, then the approved rated activation) and the planned C3c-D, C3c-A and HA as in decision 10; HR only after HA and its own decision; the credit reader coordination of decision 8; the `admitted` emitters of AIR-614, AIR-615 and ADR 0217 in their own deliveries; the Coordinator reconciles the actual Trello scope after this record is reviewed and accepted.
