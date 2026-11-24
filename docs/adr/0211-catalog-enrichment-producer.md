# ADR 0211: Admitted Films are enriched by a canonical catalog-enrichment producer, independent of EPG airing

**Status:** Proposed (no owner decision on this record; each choice below is separate and awaits an explicit, ADR-specific Product Owner decision)  
**Original decision date:** not decided  
**Recorded at:** 2026-11-24. Revised the same day after the [design review of the package](https://github.com/vladimino/iptv-watchlist/pull/975#pullrequestreview-6039232220).  
**Approval source:** not decided. Requested as the companion of [ADR 0207](0207-letterboxd-admissions-coordinated-in-d1-only.md) by the owner's disposition 6C on [PR #975](https://github.com/vladimino/iptv-watchlist/pull/975#issuecomment-7131137347): "не вижу смысла упускать возможность сразу начать подготовку к глобальному каталогу, даже если миграция из-за этого займет больше времени". That chose the direction; it does not accept this design.  
**Related work:**
- [AIR-555](https://trello.com/c/JPgjoBzK), under [AIR-275](https://trello.com/c/4x7hH0gI).
- [ADR 0207](0207-letterboxd-admissions-coordinated-in-d1-only.md) retires the R2 rated enrichment.
- [ADR 0210](0210-film-identity-evidence-ledger.md), a sibling record.

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

The producer calls `writeFilmFacts` with **only** `metadata`, `sync`, `localization.sources` and `dimensions.metadata`. It always passes:
- `requireExisting: true`;
- the stored `contractVersion`;
- the `expectedRevision` of its own snapshot, so a stale plan fails on the revision and is re-planned, never forced.

It never passes `watchlist`, identity, title or `canonical_identity` input. It never creates a Film or changes a claim.

Two commit guards are added to the batch:
- **trusted TMDB ownership** `EXISTS (SELECT 1 FROM film_external_id WHERE film_id=? AND scheme='tmdb' AND value=? AND trusted=1 AND conflicting=0)`, together with no other trusted owner of that id;
- **no current retirement** of that movie id, the same predicate the catalog reader uses.

**Fill-only metadata.** Because `film_metadata` has no per-field source or owner guard, the producer writes a field **only when the stored value is blank**. It is re-asserted in the batch: one guard per written field, within the 12-guard cap, so the core fields are written in at most two units. It never overwrites a value that the EPG producers, an owner edit or an earlier run wrote. Per-field provenance, which would let a newer automatic value replace an older one, is option 0211-1b and needs a schema change.

**Localization** goes only into `film_localization_source` with the automatic sources `tmdb` and `wikidata`. The existing resolver keeps owner and reviewed values on top.

**Credits** go only through the existing add-only `person_mutation` and `film_credits` units, and only with TMDB person ids (`tmdb_actor/<id>`, `tmdb_director/<id>`). A credits unit is written only from a **complete** TMDB credits response: HTTP 200, parsed, with the cast list present. It is capped at 10 actors and all directors in TMDB order. A partial response writes nothing. Existing credits are never removed.

### 2. Sources and identity agreement

- **TMDB is the only source in the first delivery** (option 0211-2a). It provides `movie/<id>` with credits and translations, keyed by the trusted canonical id, so it needs no Letterboxd identity.
- **A Letterboxd page** (option 0211-2b, a later decision) would be used only when the page's identity agrees with the Film's:
  - the trusted `letterboxd` claim, or the verified short code, names the page;
  - the page carries exactly that `data-tmdb-id`.

  A known URL alone is not identity. An inferred admission (ADR 0210 `restricts`) is never enriched from a Letterboxd page.
- **Wikidata** (Russian titles) uses the existing localizer as an automatic source.

### 3. Parts, partial success and receipts

Enrichment has three independent **parts**:
- `core` (runtime, genres, poster, year, URL);
- `credits`;
- `localization`.

Each part has its own state in the `metadata` lifecycle row's `provenance_json`: `{part: {status, sourceVersion, at, attempts, retryAt, lastError}}`. These are existing columns, so no schema change is needed.

- **A failed part** changes only its own state: attempts plus 1, a doubling backoff, and after 6 attempts `needs_attention`. It never retries a part that succeeded.
- **Freshness.** `film_sync_state.metadata_at` is set only when `core` succeeded. Freshness (30 days, the existing rule) is per part.
- **`sourceVersion`** is the SHA-256 of the canonical JSON of the TMDB fields actually used (or the Wikidata fields), with no clocks. The request id is `catalog_enrichment:<operation>:digest(event enrich:<film>:<part>, target, sourceVersion)`.
- **The same source** gives the same request, and a lost response is answered by the receipt.
- **Changed content** gives a new request. The earlier unapplied receipt is abandoned visibly as `producer_source_changed` by its readback, the existing mechanism.
- **An `unknown` result** stays non-terminal and is reconciled by the origin's own inline reconcile before that part of that Film is re-planned.

### 4. Eligibility, scope and fairness

- **A Film is due when all of these hold:**
  - it has a `film_rated_admission` row (scope 0211-4a);
  - it exists, is not redirected and holds one trusted `tmdb` claim;
  - its movie id is not retired;
  - one of its parts is missing, stale or past its `retryAt`;
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
- **Shared upstream backoff (option 0211-5a).** One additive D1 table `upstream_backoff(source PRIMARY KEY, backoff_until, reason, updated_at)`.
  - A 429, a challenge or a 403 from `tmdb`, `letterboxd` or `wikidata` writes `backoff_until`: Retry-After, clamped to 30-3,600 s, else 1 hour.
  - Every catalog-enrichment tick reads it before any request, and stops for the source while it is in force.
  - Discovery, the metadata stage and the Diary and Watchlist checks keep their own policies until each adopts the table in its own card. **This record does not change them.**
  - Option 0211-5b: no shared table, per-producer backoff only, as today.
- **Scheduling.** The step joins the hourly cron's `Promise.allSettled` as its own entry. Its errors are recorded, not swallowed:
  - each tick writes one outcome row to the existing `canonical_producer_outcome` drain (Events Log), with counts per part and the stop reason;
  - a Monitor fact reader is added (code in `monitor.js` and `MonitorPolicy`) for "due Films not progressing" and repeated backoff.
- **Measurement before raising the bound.** The dormant implementation ships an offline harness for the tick cost. The first activation runs at the bound of 2. Each tick's outcome records its wall time, fetch times and D1 statements, and the owner raises the bound only from those numbers.

### 6. Activation, pause and rollback

- **Dormant delivery.** The implementation is delivered dormant: no activation row, so every tick reads "not active" and writes nothing.
- **Activation.** Durable D1 activation state `{state, cutoff_at, scope}`, written by an owner-authorized operation. It lives either in the same `projection_run` row's `summary_json`, asserted with `json_extract`, or in one small additive single-row table. The implementation card chooses; the requirement is durability plus an in-batch assertion. New-only eligibility uses `cutoff_at`, never the deploy date.
- **Pause.** An owner operation sets `state = paused`.
  - Every tick reads the state at its start, and every write batch asserts it (one guard). After a pause, no new fetch starts and no write lands.
  - A fetch already in flight completes but cannot write.
  - A code revert stops future ticks but does **not** cancel a running one. The pause is the stop control.
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
  - per-part lifecycle state in an existing column;
  - a `projection_run` lease and activation row;
  - optionally the `upstream_backoff` table;
  - one outcome stream and one Monitor reader.
- **Metadata can stay partial** (fill-only, TMDB only) until 0211-1b and 0211-2b are decided.

## Recovery and migration boundary

- With 0211-5a, one additive table, plus possibly one small activation table (decision 6). Otherwise no schema change.
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
| 0211-3 | Three independent parts with per-part lifecycle state (decision 3) | yes |
| 0211-4 | Scope: (a) admitted Films after the cutoff; (b) also the 714 existing; (c) also Watchlist members | (a) now; (b) and (c) separate decisions |
| 0211-5 | (a) the shared `upstream_backoff` table, or (b) per-producer backoff only | (a) |
| 0211-6 | The durable activation, pause and cutoff row (decision 6) | yes |
