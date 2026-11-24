# ADR 0211: Admitted Films are enriched by a canonical catalog-enrichment producer, independent of EPG airing

**Status:** Proposed (no owner decision on this record; each choice below is separate and awaits an explicit, ADR-specific Product Owner decision)  
**Original decision date:** not decided  
**Recorded at:** 2026-11-24. Revised the same day after the [design review of the package](https://github.com/vladimino/iptv-watchlist/pull/975#pullrequestreview-6039232220), its [re-review](https://github.com/vladimino/iptv-watchlist/pull/975#pullrequestreview-6040005516) and the [second re-review](https://github.com/vladimino/iptv-watchlist/pull/975#pullrequestreview-6040703398).  
**Approval source:** not decided. Requested as the companion of [ADR 0207](0207-letterboxd-admissions-coordinated-in-d1-only.md) by the owner's disposition 6C on [PR #975](https://github.com/vladimino/iptv-watchlist/pull/975#issuecomment-7131137347): "не вижу смысла упускать возможность сразу начать подготовку к глобальному каталогу, даже если миграция из-за этого займет больше времени". That chose the direction; it does not accept this design.  
**Related work:**
- [AIR-555](https://trello.com/c/JPgjoBzK), under [AIR-275](https://trello.com/c/4x7hH0gI).
- [ADR 0207](0207-letterboxd-admissions-coordinated-in-d1-only.md) retires the R2 rated enrichment.
- [ADR 0213](0213-film-identity-evidence-ledger.md), a sibling record.

**Supersedes (only on acceptance):** In part [ADR 0087](0087-rated-archive-film-admission.md) decision 4: metadata written onto the R2 admission entry.  
**Superseded by:** None

## Context

### What exists (main `26cfd115`, 24 Nov 2026)

**`writeFilmFacts` (`src/canonical-film-writers.js`).**
- Every input section except the `film` row is optional. A metadata-only caller (`metadata_sync`) passes `requireExisting: true`, the stored `contractVersion` and `metadata`.
- The `film` row is always upserted. Identity and title fall back to the stored values.
- **`film_metadata` has no per-field source and no owner or reviewed guard.** A non-blank incoming value overwrites the stored one, whatever wrote it. Only blank-never-overwrites protects it.
- Owner and reviewed values are protected only on the dimension rows, the localization sources and the identity and title fields.
- At commit time it asserts: the marker generation, the Film revision, no redirect, existence (with `requireExisting`), up to 12 caller guards, and the producer fence when one is bound.

**Credits** are add-only (`film_credits`): a missing credit is added, nothing is removed or reordered, at most 50 per unit.

**Persons** are identified by role-specific ids:
- TMDB: `tmdb_actor/<id>`, `tmdb_director/<id>`, which are stable;
- Letterboxd: `actor/<slug>`, which falls back to the display name when the slug is missing.

**The two receipted metadata producers see only EPG-listed Watchlist Films:**
- `metadata_sync` runs in the EPG metadata stage;
- the `epg` `film_facts` units come from the sealed generation.

With the Watchlist marker at `d1` (production, generation 3), a pinned EPG run fetches no metadata (`src/worker.js:1315`), and the Letterboxd Sync has no metadata phase. **714 of 714 admitted Films have no `film_metadata` row** (L0 read, 24 Nov 2026 12:21 UTC).

**There is no shared upstream limiter.**
- Discovery sleeps 200 ms per TMDB request and honours Retry-After for its own decisions.
- The metadata stage fetches 3 pages at a time with no spacing.
- The Diary and Watchlist checks and the rated step have their own timeouts.

**Scheduling.**
- The hourly cron runs `reconcileDiscoveryWorkflow` (45 s head), then `Promise.allSettled` over the EPG ensure, Monitor and prediction ordering. It has no per-step deadline, swallows errors, and the Worker CPU limit is 120,000 ms.
- **Leases.** `projection_run` is a per-name lease store.
- **Monitoring.** Producer outcomes are drained to the Events Log. Monitor has hard-coded fact readers.
- **Subrequests.** The platform subrequest limit is not verified in this repository (ADR 0140 decision 9).

## Decision (proposed)

### 1. A metadata-only writer contract

The producer calls `writeFilmFacts` with **only** `metadata`, `sync` and `localization.sources`. It does **not** pass `dimensions.metadata`: that row's `provenance_json` is replaced by other metadata writers (`canonical-film-writers.js:175-177` keeps provenance keys only for the identity dimension), so it cannot hold this producer's state (decision 3). It always passes:
- `requireExisting: true`;
- the stored `contractVersion`;
- the `expectedRevision` of its own snapshot, so a stale plan fails on the revision and is re-planned, never forced.

It never passes `watchlist`, identity, title or `canonical_identity` input. It never creates a Film or changes a claim.

Two commit guards are added to the batch:
- **trusted TMDB ownership** `EXISTS (SELECT 1 FROM film_external_id WHERE film_id=? AND scheme='tmdb' AND value=? AND trusted=1 AND conflicting=0)`, together with no other trusted owner of that id;
- **no current retirement** of that movie id, the same predicate the catalog reader uses.

**Fill-only metadata.** Because `film_metadata` has no per-field source or owner guard, the producer writes a field **only when the stored value is blank**. This is re-asserted in the batch with one guard per written field.

The `core` part is **one** `writeFilmFacts` batch. Its required fields are `runtime`, `genres`, `poster` and `year`; `url` is optional. The guards stay within the cap of 12:
- at most 5 per-field guards;
- trusted ownership;
- no retirement;
- the lease;
- the activation generation.

It never overwrites a value that the EPG producers, an owner edit or an earlier run wrote. Per-field provenance, which would let a newer automatic value replace an older one, is option 0211-1b and needs a schema change.

**Localization** goes only into `film_localization_source` with the automatic sources `tmdb` and `wikidata`. The existing resolver keeps owner and reviewed values on top.

**Credits** go only through the existing add-only `person_mutation` and `film_credits` units, and only with TMDB person ids (`tmdb_actor/<id>`, `tmdb_director/<id>`). A credits unit is written only from a **complete** TMDB credits response: HTTP 200, parsed, with the cast list present. It is capped at 10 actors and all directors in TMDB order. A partial response writes nothing. Existing credits are never removed.

### 2. Sources and identity agreement

- **TMDB is the only source in the first delivery** (option 0211-2a). It provides `movie/<id>` with credits and translations, keyed by the trusted canonical id, so it needs no Letterboxd identity.
- **A Letterboxd page** (option 0211-2b, a later decision) would be used only when the page's identity agrees with the Film's:
  - the trusted `letterboxd` claim, or the verified short code, names the page;
  - the page carries exactly that `data-tmdb-id`.

  A known URL alone is not identity. An inferred admission (ADR 0213 `restricts`) is never enriched from a Letterboxd page.
- **Wikidata** (Russian titles) uses the existing localizer as an automatic source.

### 3. Parts, partial success and receipts

Enrichment has three independent **parts**:
- `core`: runtime, genres, poster, year and URL;
- `credits`;
- `localization`.

**Part state lives in its own minimal store**, an additive table `catalog_enrichment_part(film_id, part, status, source_version, refresh_epoch, attempts, retry_at, last_error, updated_at)`, primary key `(film_id, part)`. No other writer touches it. It is not kept in the `metadata` dimension's `provenance_json`, which the EPG producers overwrite.
- **Completion comes from canonical state plus one small work list.**
  - **`core` is complete** when its four required fields are non-blank.
  - **`localization` is complete** when a `film_localization_source` row of source `tmdb` or `wikidata` exists for the Film.
  - **`credits` is complete** when every credit of the part's **expected set** exists. The expected set is the TMDB person ids and roles, at most 10 actors and 5 directors, taken from the complete response; it is stored on the state row when the part is planned. It is a work list, not a proof payload, and a hash alone is not used to judge completeness.
  - **A source answer that is complete but empty** (no cast, no Russian title, no poster) is recorded on the state row as `complete_with_gaps`, listing the fields or sets that the source did not have. It counts as done.
- **The state row records the outcome.** Besides the expected set and the gaps, it records attempts, backoff and the source version. A lost state update causes at most one redundant fetch, never a wrong write.
- **A lost state update** therefore causes at most one redundant fetch, never a wrong write.

**Fill-only and freshness.** Because writes are fill-only, a part whose required fields are all filled is `complete` and is **not** fetched again by a 30-day staleness rule.
- If the source has no value for a field (an empty or optional result, for example no poster), the part is `complete_with_gaps` and lists the missing fields. It is not retried on a schedule.
- `film_sync_state.metadata_at` is set only when, after the write, every required `core` field is non-blank. It is not set after a skipped guard or an absent field.
- A later legitimate refresh is an explicit, separately decided action. It raises the part's `refresh_epoch`, and that is part of the request identity.

**Unit identities.** Every canonical write is one receipted unit with a deterministic identity. The event carries the part's `refresh_epoch`, and the digest carries the `sourceVersion`: SHA-256 of the canonical JSON of the source fields used, with no clocks.

| Part | Unit | Target | `operation_key` | Bound |
| --- | --- | --- | --- | --- |
| core | one `film_metadata`/`film_sync_state` write | the Film | `enrich:<film>:core` | one batch, ≤ 12 guards |
| localization | one `localization_source` write per source | the Film | `enrich:<film>:localization:<source>` | ≤ 10 sources (existing cap) |
| credits | one `person_mutation` per missing person | the Person | `enrich:person:<tmdb_role>/<id>` | ≤ 40 persons per unit (existing cap) |
| credits | one add-only `film_credits` unit | the Film | `enrich:<film>:credits` | ≤ 50 credits per unit; this part uses ≤ 15 |

- **Cross-origin correlation.** A Person or credit may already exist from another origin (the EPG chain). The person unit is insert-if-absent, so it is a no-op and opens no receipt. The credits unit adds only what is missing, so the outcome does not depend on which origin wrote first.
- **Sequencing and partial recovery.** `credits` runs its person units first, then its credits unit. A credit whose Person is missing is refused (`film_person_reference`), so the order is enforced by the database. If some units applied before an interruption, the retry recomputes the missing persons and credits from canonical state against the stored expected set and writes only those.
- **Receipts per unit** follow the **reconcile-then-reserve** protocol of ADR 0207 decision 3: history fingerprint, settle unresolved receipts, reserve atomically, and a loser replans. A changed source therefore never races an unknown or stale receipt of the same unit.
- **Tests (C1 acceptance):**
  - a lost response of each unit kind;
  - a partially applied `core` or `credits` part (persons applied, credits not);
  - a changed source with an unresolved receipt of the same unit;
  - a stale lease writing nothing;
  - person units already written by the EPG origin;
  - complete-but-empty source answers;
  - a pause between the check and the request (residual request, no write).
- **0211 depends on the receipt `operation_key` (card R1) regardless of 0207-U1.** Its units have no writer record that could hold a K1 pointer. If 0207 chooses K1, R1 is still delivered, as a prerequisite of C1.

**A failed part** changes only its own state row: attempts plus 1, a doubling backoff, and after 6 attempts `needs_attention`. Parts that succeeded are never retried because another part failed.

### 4. Eligibility, scope and fairness

- **A Film is due when all of these hold:**
  - it has a `film_rated_admission` row (scope 0211-4a);
  - it exists, is not redirected and holds one trusted `tmdb` claim;
  - its movie id is not retired;
  - one of its parts is not `complete`/`complete_with_gaps` and its `retry_at` has passed (no staleness rule under fill-only);
  - its `metadata` dimension is not owner- or reviewed-locked.
- **Fairness.** Due Films are taken **oldest first** by the time they became due (`due_since`, the admission time, or the part's `retryAt` for a retry), so a stream of new admissions cannot starve older ones.
- **New-only activation (decision 6)** adds `verified_at ≥ cutoff`.
- **Scope widening is a separate decision:**
  - (0211-4b) the existing 714 admitted Films;
  - (0211-4c) Watchlist members, which would close the pinned-run gap of the Context. That changes the Watchlist metadata path and is **not** included silently.

### 5. Operational contract

- **Lease.** One existing-schema `projection_run` row (`projection = 'catalog_enrichment'`: `lease_id`, `lease_until`, `summary_json`). A fresh random `lease_id` per acquisition is the fence: every write batch asserts that its own `lease_id` is current and `lease_until` is still ahead (one guard), so a stale tick cannot write after another took over. Overlapping ticks are impossible.
- **Deadline.** Each tick has an absolute deadline of **25 s** from its start, with a 5 s write reserve. Every fetch timeout is `min(source timeout, deadline − reserve − now)`. No write starts without the reserve.
- **Per-tick bounds.** At most **2 Films**, serially. Each Film makes at most 1 TMDB request (`append_to_response=credits,translations`) and 1 Wikidata request. That is at most 4 upstream subrequests and a small fixed number of D1 statements per tick, well below any platform limit.
  - The bound of 2 is a starting value. It is raised only by an owner decision after the measurement below.
  - At 2 per hour the 714 legacy Films (if 0211-4b is chosen) would take at least 15 days. That is a minimum, not an ETA.
- **Upstream politeness, initial local policy:**
  - requests are serial, at least 250 ms apart for TMDB;
  - a 429, a challenge or a 403 stops the tick for that source and stores `backoff_until` (Retry-After, clamped to 30-3,600 s, else 1 hour) in the producer's **own** state;
  - every tick reads that state before any request.

  This coordinates only this producer.
- **Cross-producer coordination (option 0211-5).** A shared `upstream_backoff(source, backoff_until, reason, updated_at)` table is only actually shared once other producers read and write it. This record does not change Discovery, the metadata stage or the Diary and Watchlist checks.
  - (a) Local policy now. A shared table, with each producer's adoption as its own card and decision, later.
  - (b) Create the shared table now with this producer as its only participant. It is still effectively local until the adoption cards land.
- **Scheduling.** The step joins the hourly cron's `Promise.allSettled` as its own entry, and its errors are recorded, not swallowed.
- **Outcome outbox.** The existing `canonical_producer_outcome` (migration 0038) is specific to the EPG Producer chain (`programme_run_id`, `input_generation`, `owner_epoch`) and cannot hold these ticks. The producer therefore uses a small dedicated outbox `catalog_enrichment_tick(tick_id PRIMARY KEY, started_at, finished_at, state, counts_json, delivered_at, delivery_attempts)`.
  - `tick_id` is stable for the tick: the lease id plus the hour. Delivery to the Events Log deduplicates by it and retries like the existing drains.
  - A tick writes `started` before its first request and `finished` or `stopped` at the end.
  - A Monitor fact reader (code in `monitor.js` and `MonitorPolicy`) reports a tick still `started` past its deadline plus a margin, repeated backoff, and due Films not progressing.
  - The outbox is in card CM. Activation refuses (fails closed) when it, or any other required table, is absent.
- **Measurement before raising the bound.** The dormant implementation ships an offline harness for the tick cost. The first activation runs at the bound of 2. Each tick's outcome records its wall time, fetch times and D1 statements, and the owner raises the bound only from those numbers.

### 6. Activation, pause and rollback

- **Dormant delivery.** The implementation is delivered dormant: no activation row, so every tick reads "not active" and writes nothing.
- **Activation.** Durable D1 activation state `{state, cutoff_at, scope}`, written by an owner-authorized operation. It lives either in the same `projection_run` row's `summary_json`, asserted with `json_extract`, or in one small additive single-row table. The implementation card chooses; the requirement is durability plus an in-batch assertion. New-only eligibility uses `cutoff_at`, never the deploy date.
- **Pause.** An owner operation sets `state = paused` and raises the activation generation.
  - **No new request after a pause.** The tick re-reads the state fresh before every upstream request and before every write.
  - **Residual.** A request already authorized by the last successful check (read, then request) may still be sent, and requests already in flight complete. This is a bounded residual of at most one request per source, and the drain is waiting the longest fetch timeout (25 s).
  - **Every durable effect is fenced.** Every write asserts the activation generation and the lease: Film units, Person units, the part state row and the outbox. After a pause, nothing a residual request returns is written.
  - **Reporting after a pause.** The only write permitted is the tick's terminal outbox entry (`stopped`, with the reason `paused`). It is reporting only and asserts the lease, not the activation state.
  - **A code revert** stops future ticks but does not cancel a running one. The pause is the stop control.
- **Rollback of data.** None: metadata already written is valid canonical data under fill-only and precedence. A wrong value is corrected by owner and review routes.

## Alternatives considered

- **Reuse `metadata_sync` with a second eligibility source.**
  - Against: it is bound to the EPG run document, keyed by lid through `metadata_cache`, and stops when the Watchlist is pinned.
- **Overwrite merge, as the EPG producers do.**
  - Against: without per-field provenance it would replace owner-edited or newer values. Fill-only is safe now; per-field provenance (0211-1b) is the upgrade.
- **A Letterboxd page as the primary source.**
  - Against: it needs a verified Letterboxd identity that inferred and short-code Films may lack, and its person ids fall back to display names.
- **A code constant as the activation, as in the previous revision.**
  - Against: no durable cutoff, and a revert does not stop a running tick. Replaced by the durable row.
- **6 Films per tick, as in the previous revision.**
  - Against: an unmeasured budget. Replaced by a measured start at 2.

## Consequences

- **Admitted Films get canonical metadata** without EPG airing, through the existing writers, with no new metadata authority and no identity effect.
- **New durable contracts:**
  - fill-only metadata with commit guards;
  - a part-state table owned by this producer, with completion derived from the canonical fields;
  - a `projection_run` lease and activation row;
  - a dedicated tick outbox, and a shared `upstream_backoff` table only if 0211-5 = (b);
  - one outcome stream and one Monitor reader.
- **Metadata can stay partial** (fill-only, TMDB only) until 0211-1b and 0211-2b are decided.

## Recovery and migration boundary

- Additive tables: `catalog_enrichment_part` and `catalog_enrichment_tick`, possibly a small activation table (decision 6), and the shared backoff table only if 0211-5 = (b). No change to existing tables.
- Activation, pause and scope are durable owner operations. Data written is kept.
- This ADR, even when Accepted, authorizes no activation, fetch or write.

## Evidence

- Code surveys made for this record (24 Nov 2026), summarized in the Context.
- Production L0 read, 24 Nov 2026 12:21 UTC: Watchlist marker `d1` generation 3; 714 of 714 admitted Films without `film_metadata`.

## Owner choices in this record

| # | Choice | Recommended |
| --- | --- | --- |
| 0211-1 | (a) fill-only metadata, or (b) per-field provenance (schema change) | (a) |
| 0211-2 | (a) TMDB only, or (b) also a Letterboxd page with identity agreement | (a) |
| 0211-3 | Three independent parts with their own state table, completion derived from the canonical fields, fill-only without staleness refetch, explicit refresh epochs (decision 3) | yes |
| 0211-4 | Scope: (a) admitted Films after the cutoff; (b) also the 714 existing; (c) also Watchlist members | (a) now; (b) and (c) separate decisions |
| 0211-5 | Cross-producer coordination: (a) local policy now, shared table with separate adoption cards later; (b) create the shared table now (still local until adoption) | (a) |
| 0211-6 | The durable activation, pause and cutoff row (decision 6) | yes |
