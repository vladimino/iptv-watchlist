# ADR 0219: Discovery-only Films are enriched by the existing Catalog Enrichment Producer through a separately activated Discovery scope

**Status:** Proposed  
**Original decision date:** not decided  
**Recorded at:** 2026-11-25, from `main` `40c8a3a`. Rewritten as a coherent design for the Product Owner's [recorded selections](https://github.com/vladimino/iptv-watchlist/pull/1005#issuecomment-7174458421) (1B / 2A / 3A / 4A / T1-a), then revised after the [independent review](https://github.com/vladimino/iptv-watchlist/pull/1005#issuecomment-7174943533) of `10f4d14`; the earlier observation-and-intake design (1C) was reviewed five times and is kept only as an unselected alternative  
**Approval source:** not documented. The selections above are the owner's choices on the options of this record; they are **not** the disposition of the ADR, which still needs an ADR-specific decision on the consolidated text  
**Related work:** [AIR-655](https://trello.com/c/YIPK38Tg). Native prerequisite [AIR-644](https://trello.com/c/nFBGvvnU) ([ADR 0218](0218-film-lifecycle-dimensions-revision.md), Accepted). Builds on Accepted [ADR 0134](0134-discovery-admission-producer-wiring.md), [ADR 0155](0155-retire-enrichment-projector-cron.md), [ADR 0207](0207-letterboxd-admissions-coordinated-in-d1-only.md), [ADR 0211](0211-catalog-enrichment-producer.md), [ADR 0214](0214-film-metadata-per-field-provenance.md), [ADR 0216](0216-canonical-film-lifecycle-and-unified-read-contract.md) and [ADR 0218](0218-film-lifecycle-dimensions-revision.md). Evidence: the [AIR-627 census continuation](https://trello.com/c/IOERZ9GI#comment-6b06a0deb3fbeaeb5f93f8b2) and its [disposition](https://trello.com/c/IOERZ9GI#comment-6b06d8c178a1d27ed10c4e8f). The producer is implemented by [AIR-605](https://trello.com/c/jnqrdG71) and first activated for rated Films by [AIR-607](https://trello.com/c/Daq02gYy); provenance enforcement is [AIR-636](https://trello.com/c/0jJADYxg); projection-aware localization is [AIR-662](https://trello.com/c/P8cCPv1V); rated and Watchlist widenings are [AIR-614](https://trello.com/c/wUHl13Yw) and [AIR-615](https://trello.com/c/fCXSmk7K), which this record neither extends nor duplicates  
**Supersedes:** None  
**Amends, only upon acceptance of this record:** [ADR 0211](0211-catalog-enrichment-producer.md) decision 4 (a Discovery scope, "C3c", joins the widenings C3a and C3b), decision 6 (a per-scope control row) and decision 3 (the TMDB translation selection rule of the localization part), and the Discovery authority contract (an additive admission fact), each named in decision 9. [ADR 0211](0211-catalog-enrichment-producer.md) decision 5 (capacity) and [ADR 0214](0214-film-metadata-per-field-provenance.md) decision 10 (refresh triggers) are **not** amended  
**Superseded by:** None

## Context

### What exists (main `40c8a3a`, 25 Nov 2026)

- **The only canonical writer for a Discovery Film is minimal by design.** Since the projector was retired ([ADR 0155](0155-retire-enrichment-projector-cron.md)), a Discovery admission reaches canonical state only through the `film_mutation` unit of [ADR 0134](0134-discovery-admission-producer-wiring.md) decision 5 (`src/canonical-discovery-admission-producer.js`, origin `discovery`, operation `film_mutation`): the Film, the trusted `tmdb` claim and a title written only when blank. It writes no `film_metadata`, credits, Persons, aliases, localization or `canonical_identity`.
- **Every richer writer is bounded to another cohort.** EPG `film_facts` and credits target Watchlist Films only (`src/canonical-producer-workflow.js`); `metadata_sync` is Watchlist only; the dictionary covers its entries; the Catalog Enrichment Producer ("C1", ADR 0211) is scoped to `film_rated_admission.verified_at >= cutoff_at`, with the widenings C3a (the 714 existing admitted Films, AIR-614) and C3b (Watchlist members, AIR-615) as separate owner decisions. C1's code and tables are **not yet in `main`** (no `catalog_enrichment` object in `src/` or `migrations/` at `40c8a3a`).
- **C1 already fetches what Discovery Films lack.** Its TMDB request is `movie/<id>?append_to_response=credits,translations` (ADR 0211 decision 5), one response that carries year, runtime, genres, poster, overview, credits with stable person ids and translations. Each applicable source writes its own `film_localization_source` row; credits are bounded to at most 20 directors and 10 actors; every Film/part/source has one state row and a stable `operation_key` (ADR 0211 decision 3).
- **The Discovery payload is Discovery's own serving record.** `discovery_admission.payload_json` mixes TMDB values with EPG fallbacks (`candidate.year`, `candidate.description`, `src/discovery.js:352`), a poster that can be kept or filled by another path (`POSTER_UPDATE_SQL`), and aliases and availability that change on every EPG touch. It has no observation time of a TMDB response. The Film page and Finds read it directly. It is **not** an input of this design.
- **A Discovery admission has no durable first-admission time today.** `generation` is moved by every upsert, `discoveredAt` lives in the mutable payload, and a canonical mutation receipt is not the admission (the mutation is a no-op, with no receipt, when the Film already has its claim and title).
- **`discovery_admission` is unique per movie id** (`discovery_admission_identity (media_kind, tmdb_id)`), keyed by the Discovery key `tmdb_<n>`, not `film.id`.
- **No Discovery Film has a Russian title in canonical state.**

### Census (AIR-627, L0, dated 25 Nov 2026, main `681b5c1`, Film/Person g2, EPG P519)

Dated aggregates, not live counts. The eligible historical counts per field and part are **not known**.

| Group | Size | Canonical state |
| --- | --- | --- |
| Minimal Discovery Films (since 16 Nov, `film_mutation` only) | 2 525; 1 213 airing in P519 | no `film_metadata`, credits, aliases, dimensions; `canonical_identity` NULL |
| Projector-era Discovery Films | 9 730 | have projector credits and aliases; `film_metadata` rows exist for only 414 Films in the whole catalog, so most lack core metadata |
| Future admissions | about 2 525 in about 9 days, so about 280 per day (a dated estimate, not a guarantee) | as the minimal group |
| Rated (714; 473 with metadata missing) and Watchlist (391) | — | owned by C1 and its widenings AIR-614, AIR-615 |

The gap differs by group: minimal Films miss everything; projector-era Films mostly miss core metadata and a Russian title but keep credits. `canonical_identity` NULL is not a proof of missing identity: each of these Films holds a trusted, non-conflicting `tmdb` claim.

### The problem

Canonical Film/Person D1 is the authority (ADR 0216), but for Discovery Films it holds an id, a claim and a title, and for the minimal group nothing else. Readers that do not go through Discovery lose year, runtime, synopsis, poster, genres, credits and every Russian title, and nobody owns refresh. C1 is the accepted owner of exactly this enrichment, but its scope does not reach Discovery Films.

### Settled decisions this record keeps

- `film_mutation` stays minimal (ADR 0134 decision 5). Discovery admission is unchanged.
- After enrichment the canonical row is the authority; the Discovery payload stays Discovery's serving record and is never copied into canonical state.
- ADR 0218 keeps a `film_dimension` row only for owner or reviewed decisions, the ADR 0214 metadata lock, `titleSource` and the effective-localization projection kept for read cost; processing dimensions are neither written nor read for decisions here.
- ADR 0211 is the one planner, fetcher and state machine: anchors and agreement, the 72 h transport-only fallback, credits namespace and expected set, write intent, epochs, lease, control, pause, shared upstream cooldown, fair bounded scheduling and visibility. ADR 0214 is the one rank and lock rule. This record adds a scope to them; it adds no producer and no second queue.
- Identity is never inferred from a title or a year. No Letterboxd or Wikidata anchor is invented.
- Mass enrichment waits for AIR-607 and AIR-636 natural acceptance; this gates activation, not this design.

## Owner selections and what each means here

| Choice | Selected | Reading in this record |
| --- | --- | --- |
| 1 Owner of canonical metadata and credits | **1B** extend C1 to Discovery admissions | one producer, no new subsystem. The owner's reason is a simpler architecture and delivery plan; extra TMDB requests are accepted as a cost, not a defect (TMDB's published protective limit is discussed in decision 6, not claimed to be unlimited) |
| 2 Russian localization | **2A** typed selection | the typed `ru` translation selection, applied to the translations of C1's **own** TMDB response (decision 4) |
| 3 Cohorts and cutoff | **3A** stream first | a separately activated Discovery scope with an exact, durable membership predicate (decision 2); history is not written (decision 8) |
| 4 Refresh policy | **4A** event-driven | the accepted ADR 0214 decision 10 triggers, unchanged (decision 5) |
| T1 History | **T1-a** defer | no legacy payload adoption; near-term planning card HA (decision 8) |

## Decision

### 1. One producer: C1 gets a Discovery scope

The existing Catalog Enrichment Producer (ADR 0211; implementation AIR-605) is the only planner, fetcher and state machine for Discovery Films. This record adds **no** observation table, publication step, sequence, cursor, intake unit, receipt origin, intent table, credit-attribution table or intake-to-C1 handoff, and it adds no second queue: a Film has **one** state row per part and source and the **existing** stable receipt keys of ADR 0211 decision 3, whatever scope admitted it: `enrich:<film>:core`, `enrich:<film>:localization:<source>` (one per source), `enrich:<film>:credits:<source>` and `enrich:person:<person id>`. None of them is collapsed or renamed here.

**A scope is a membership predicate, not a task.** C1's eligible set is the union of its activated scopes: the initial rated scope (AIR-607), the widenings C3a (AIR-614) and C3b (AIR-615), and the Discovery scope **C3c** of this record. A Film that belongs to several scopes is planned once. Scope activations are independent owner operations in any order; none widens another implicitly, and no activation is a prerequisite of another except as decision 8 states.

### 2. The Discovery scope C3c: a membership predicate over a durable Discovery admission fact

**Why a receipt is not the fact.** A canonical mutation receipt is **not** an admission timestamp: `planAdmissionFilm` and `applyRouted` (`src/canonical-discovery-admission-producer.js`) return a no-op with **no receipt** when the Film already holds its trusted `tmdb` claim and a title, so a valid new Discovery admission onto an existing Film can have none; `admitDiscoveryFilms` defers work and its sweep admits **earlier** current admissions later, so an old admission's first receipt can land after any cutoff; and a merge or identity correction can separate a receipt's original target from the current claim owner. The cutoff is therefore taken from a fact of the **admission state itself**.

**The fact.** One additive nullable column on the Discovery authority's own table, `discovery_admission.first_current_at` (ISO UTC), the time the row **first became `state='current'`**, never changed afterwards. It is stamped by a database trigger, so every writer, including an old Worker version, gets it, and no code path can skip or move it:
- `AFTER INSERT` with `NEW.state='current'` stamps the row;
- `AFTER UPDATE OF state` stamps it only on the transition **`pending` → `current`** when the column is still NULL;
- nothing else ever writes it; `ON CONFLICT DO UPDATE` leaves it alone (the upsert's update list does not name it);
- **no trigger stamps while `discovery_transfer.state = 'loading'`**, so a bulk transfer or a restore load inserts rows as unknown rather than as new.

**Semantics (nothing invented, nothing promoted silently).**

| Case | Result |
| --- | --- |
| rows that exist when the column is added (the migration backfills nothing) | `NULL` = **unknown history**, permanently; a later `superseded` → `current` transition does **not** stamp them |
| a new admission after the column exists | stamped at its insert as `current` (or at its `pending` → `current` promotion) |
| a re-admission or a revalidation (the upsert) | the stamp does not move |
| `superseded` → `current` of a stamped row | the stamp does not move (it was first current earlier) |
| a canonical mutation that is a no-op (the Film exists with its claim and title) | irrelevant: the fact is on the admission row, so the new admission **stays eligible** |
| a deferred admission, and an old admission swept after activation | the stamp is its own first-current time, so an old one is history or unknown, never stream |
| a lost response | the admission batch is atomic: either the row (with its stamp) exists, or it does not and the retry creates it, so the stamp is the first **durable** creation |
| a transfer or a D1 restore | a load under `loading` inserts unknown (`NULL`); a restore of the table restores the stored values; neither invents a timestamp |
| a merge, a redirect or an identity correction | membership resolves through the **current** trusted `tmdb` claim `n` to the admission row `(movie, n)`, not through any receipt target; redirect and retirement are the ADR 0211 eligibility and anchor rules |

**The membership predicate.** A Film is in C3c when **all** hold, read from authoritative tables at plan and asserted by C1's own guards in each batch:
1. The Film exists and is not a redirect source or retired (the ADR 0211 eligibility).
2. It holds exactly one trusted, non-conflicting `tmdb` movie claim `<n>` with no other trusted owner and no `tmdb_retirement_decision` (the ADR 0211 `tmdb` anchor).
3. `discovery_admission` holds the row for `(media_kind='movie', tmdb_id=<n>)` (unique by index) with `state='current'`, and its stored `first_current_at` is **not NULL and at or after the scope's `cutoff_at`**. The batch asserts that exact stored value by equality with the one read at plan, together with the Discovery authority route and generation and `discovery_transfer.state <> 'loading'`, so a moved or reloaded admission fails the batch and the unit replans.

**Classification, with nothing promoted silently.** Every Discovery admission is exactly one of: `new` (stamped at or after the cutoff: in scope); `before_cutoff` (stamped earlier: history, provable); `unknown_history` (`NULL`: history, not provable); `superseded`; or `unresolved_identity` (no unique trusted `tmdb` claim yet). All are counted per scope. An unknown admission is never inferred from `discoveredAt`, the payload, `generation` or a receipt, and only a separate approved historical scope (decision 8) can enrich history.

**The earliest possible cutoff.** The stream can begin no earlier than the apply of the column, because earlier admissions are unknown by construction. This follows from the exactness that 3A asks for and is not a reinterpretation of stream-first; it is why the fact (card C3c-F) should be applied **early**, independently of C1, so that new admissions are stamped from then on.

**Activation.** C3c is activated by its own owner operation (C3c-A), which sets the Discovery scope's `cutoff_at` **no later than the activation** and **no earlier than the apply of the column**, as C2 does for rated Films (ADR 0207 decision 7). New admissions are eligible from day one and enriched at the following ticks, not instantly.

**Revalidation, retries and source-set changes.** Discovery's revalidation never changes membership (the stamp is fixed). Retries, backoff, the 6-failure `needs_attention` cap, anchor corrections, retirements, a lid claim that appears later (which makes Letterboxd applicable and reopens only its gaps), redirects and `identity_disagreement` are exactly ADR 0211 decisions 3 and 3b.

**Overlap.** A Film also in the rated or Watchlist scope is one Film with one state set; C1 plans it once, with one set of existing keys, and no handoff exists because there is one writer. C3c reuses the AIR-614 and AIR-615 widening plans and neither duplicates nor widens them.

**Candidate discovery: bounded, indexed, with progress.** The tick materializes C1 state rows for in-scope Films with an indexed, ordered, anti-joined read, not a `LIMIT` over already selected items:
- the read selects admissions `state='current'` with `first_current_at >= cutoff` in `first_current_at` order, joined through the trusted `tmdb` claim (the existing `film_external_id` index on scheme and value) to a Film that has **no C1 state row yet**, and takes at most `n` **resolved** candidates; an admission with no trusted claim yet (a deferred canonical admission) does not match the join, so it **cannot block progress**, and it matches as soon as the sweep creates the claim;
- an index on `discovery_admission (state, first_current_at)` makes the range read ordered;
- **progress is a materialization watermark** `(first_current_at, tmdb_id)` kept in the scope's control row (decision 7), advanced only over the contiguous prefix whose admissions each have a C1 state row or a recorded permanent classification, and written under the control generation and revision CAS, so the prefix is not rescanned every tick and a stale tick cannot move it;
- the work an unresolved prefix costs is **counted and reported** (`unresolved_admissions`, its oldest age), and C3c-D proves with `EXPLAIN` on the real migrated schema that the read is indexed and bounded.

### 3. Sources, anchors and agreement are unchanged

For a C3c Film C1 derives the applicable sources exactly as ADR 0211 decision 2 does: the `tmdb` anchor makes `tmdb` and `wikidata` applicable (Wikidata via P4947); `letterboxd` is applicable **only** when a trusted lid claim already exists, and is never invented or fetched without one. Agreement, the 72 h transport-only fallback, precedence and `identity_disagreement` are unchanged; credits keep the one-namespace rule, the expected set (at most 20 directors and 10 actors) and `superseded_credits`; the ADR 0214 rank, owner pins, the metadata lock, hold mode and the no-clear rule apply to the single writer as accepted. C1 obtains its **own** fresh response with a real `observed_at`; no mixed serving value is copied.

This record does not add a source or broaden a fetch. Whether Wikidata is worth its request for this scope is a measurement question of C3c-M; a change of applicability would be a scoped amendment of ADR 0211 decided with capacity, not assumed here.

### 4. 2A: the typed Russian title comes from C1's own TMDB response

C1's `localization` part already writes the `tmdb` source row from the same TMDB response that carries `credits,translations`. 2A is applied there, with **no separate per-film translation fetch**:
- the selection reads the `translations.translations` entries with `iso_639_1 = 'ru'`;
- exactly one distinct non-blank `data.title` is the value; several entries are decided by `iso_3166_1 = 'RU'`; if they still differ, the selection is **ambiguous** and nothing is written (a recorded gap);
- no `ru` entry is a legitimate **absence** (`complete_with_gaps`, as ADR 0211 already records);
- a missing or malformed `translations` section of an otherwise complete response is **unreadable**: it is the ADR 0211 *definite* failure (a missing required section), consumes one of the six and is retried with the accepted backoff, ending in `needs_attention`; it is neither an absence nor a write of any title;
- the response `title`, `aliases`, `movieTitles` and any alias are **never** read as a Russian title.

**Keys and counts.** The unit is the existing per-source key `enrich:<film>:localization:tmdb`; the `letterboxd` and `wikidata` sources keep their own keys (`enrich:<film>:localization:letterboxd`, `:wikidata`), so distinct sources are never collapsed. **Ambiguous** is a recorded terminal gap (`translation_ambiguous`), not retried by itself and reopened only by an accepted ADR 0214 trigger; **absent** and **unreadable** are counted apart. The per-scope counts of ADR 0211 decision 5 report each state accurately (complete, `complete_with_gaps`, `translation_ambiguous`, unreadable-failing, `needs_attention`), and no source request is made solely for the translation.

The row is written through the AIR-662 projection-aware operation (the effective projection recomputed in the same batch, the Film revision CAS and the owner-review authority and content token, ADR 0218 decision 3), and reviewed and owner values keep their precedence through the existing resolver. ADR 0211 states the source row but not this selection rule; this record states it (decision 9) and adds no source.

**Adaptation from the original 2A.** The original 2A carried the translation from **Discovery's own detail response** through a Discovery observation. Under 1B that transport does not exist: C1 fetches the response itself, which already asks for translations. Reusing Discovery's response would need the observation subsystem, which is 1C and was not selected; it is not reintroduced. The consequence is one TMDB request per Film that Discovery has already made once, which the owner accepted by choosing 1B.

### 5. 4A: event-driven refresh through ADR 0214, with no extension assumed

Refresh for C3c Films is exactly ADR 0214 decision 10: fallback recovery, a source-set change, an identity correction, unknown or superseded fields met in a fetch that is due anyway, and an owner `refresh`; no periodic sweep. Anchor changes, lock release and retry, and the no-op rule remain as accepted, with `observed_at` set by C1's own response.

**A Discovery verification is not a trigger.** A Discovery revalidation or re-verification does not reopen anything in C1: nothing Discovery holds is a fresh verified response for C1, and copying its mixed serving values is excluded. So repeated unchanged verification and every EPG touch cause **no** redundant fetch, and no event intake exists to deduplicate. Consequently a complete C3c Film is refreshed only by the accepted triggers and by the owner, as a rated Film is; a periodic policy is the separate ADR 0214 PVT question.

Whether a Discovery revalidation should become an **additional** bounded, coalesced trigger is a new material question, not part of the recorded selections. It is presented separately as Choice 5 below and, unless chosen, is **not** part of this design.

### 6. Capacity is the principal remaining feasibility gate

ADR 0211 decision 5 is **not amended**. Its starting bound is 2 Films per hourly tick, a 25 s deadline with a 5 s write reserve, 12 write units, at most 4 upstream requests per Film and 8 per tick, and 48 Films per day is an optimistic ceiling. The dated Discovery stream estimate is about 280 per day, which needs about **12 completions per hour** for the stream alone, before rated and Watchlist work, retries, any backlog and margin. At the accepted bound the stream alone would grow a backlog of roughly 230 Films per day. **No runtime throughput is established or approved by this record.**

**Requests per Film.** A C3c Film normally has the `tmdb` and `wikidata` sources (about 2 requests; Letterboxd only with an existing claim), so about 4 requests per 2-Film tick; the unit budget (core 1, localization up to 3, one per missing Person up to 30, credits 1) is C1's.

**TMDB's published limit.** Per the official documentation, [rate limiting](https://developer.themoviedb.org/docs/rate-limiting), the legacy limit was disabled and a changeable protective limit of about 40 requests per second remains, with `429` handling still required. This was quoted in the owner handoff of this record and was **not independently fetched here**. It is not read as unlimited capacity or as a proven allowance. Our average rate for a 280-per-day stream is far below it; what binds is the tick model below, the shared cooldown (Retry-After and 429 respected, ADR 0211 decision 5) and the aggregate with Discovery's own TMDB use and the poster cron. Wikidata's endpoint limits are not assessed here and are measured in C3c-M.

**Execution models (proposals, none selected; each changes a material setting and needs its own documented owner gate):**
- **X1, more Films per tick:** raise the per-tick Film count and unit budget within the deadline, using the parallel fetch across sources and the per-scope concurrency of one.
- **X2, a bounded drain run:** the hourly tick starts a bounded run of steps (each step the C1 tick: lease, 2 Films, 25 s) until the due set is empty or a per-run cap on steps, requests and time, reusing C1's lease, state and cooldown; the cap keeps the run clear of the EPG window.
- **X3, a more frequent trigger:** change the cadence from hourly to a shorter interval, bounded by the budgets below.

**Budgets any model must respect:** the shared upstream cooldown and Retry-After; the D1 statement and batch caps (ADR 0094) and the unit budget; Worker CPU and wall time; the EPG publication pause and window (ADR 0135); and **no degradation of the existing cohorts**: ADR 0211's oldest-`due_since`-first order decides who is served first, but **it is not a throughput guarantee**, so the measurement must show the completion latency of rated and Watchlist work under each model with the stream running.

**Measurement (C3c-M, offline, no production fetch or write).** Real-schema fixtures with representative recorded inputs (counts and shapes, no private rows) measure per Film: wall time, requests per source, statements, batches and rows, including missing Persons up to 30, the receipt, reservation and guard costs, and external latency, cooldown and `429` scenarios. They measure **completed Films per hour, not selected Films**, under a **mixed-scope arrival rate** (the stream with rated and Watchlist work, retries and any backlog), with **EPG pauses**, the **shared cooldown**, the **12-unit budget** and the existing cohorts, and they report the throughput of X1 to X3 and the aggregate request rate. The measured models are inputs to **later owner decisions**, not approved settings. The result is evidence plus a simple, bounded model proposal; the owner gate decides any change. C3c is **not** activated until the measured capacity exceeds the observed admission rate with margin under an approved model.

### 7. Schema, scope control, apply boundaries, compatibility and rollback

**No new producer, queue or per-Film state.** C3c uses C1's state, outbox, control and cooldown tables and the existing receipt `operation_key`. AIR-600 delivers the receipt operation-key **implementation**; the actual schema **apply** is the separate gate AIR-603 (as read at review; the live status is read from Trello at delivery). The schema work this record adds is exactly the following, each with its own apply prerequisite:

| Addition | Domain | Purpose | Apply prerequisite |
| --- | --- | --- | --- |
| `discovery_admission.first_current_at` (nullable), the two triggers of decision 2 and an index on `(state, first_current_at)` | Discovery authority | the durable admission fact and the ordered candidate read | its own forward migration, an owner apply operation with readback; independent of C1 and applicable early; compatibility tested with an old Worker version (inserts without the column still work, the trigger stamps) |
| `catalog_enrichment_scope`, one row per scope | Catalog enrichment control | independent enabled flag, `cutoff_at` and materialization watermark per scope | **after** C1's own control table exists (AIR-605 and its apply); a forward migration |

**The scope-control shape.** `catalog_enrichment_scope(scope TEXT PRIMARY KEY, enabled INTEGER, cutoff_at TEXT, materialized_through TEXT, revision INTEGER, updated_at TEXT, updated_by TEXT)`. This record defines only the `discovery` row; the rated scope keeps its `cutoff_at` and `scope` on C1's control row exactly as AIR-605 and AIR-607 deliver them (**the initial rated scope and its activation are unchanged**), and C3a and C3b (AIR-614, AIR-615) keep their own plans and may adopt the same per-scope table.
- **Independent flags and cutoffs.** Enabling or disabling a scope and setting its cutoff are separate owner operations, each a compare-and-swap on that scope row's `revision`, so a stale request changes nothing and says so.
- **No batch survives a scope change.** Every scope operation also raises C1's control `generation`, which every batch of every Worker version already asserts, so no batch planned before the change commits after it. Discovery Films are planned only by code that has the predicate; an older version has no Discovery membership and never selects them.
- **Fail closed.** Without the scope table, or with the `discovery` row disabled or absent, C3c plans nothing.

**Coordination with AIR-605 and what is not edited.** A delivered migration is **never** edited because it has not been applied. AIR-605's schema is not in `main`; coordinating the per-scope table into AIR-605 before its delivery is possible **only with explicit scope approval of AIR-605**, which this record does not assume. Otherwise the table is a forward migration after AIR-605's. AIR-605's and AIR-607's initial rated scope and the AIR-275 boundary are preserved either way.

**Compatibility.** Dormant code reads "not active"; an old Worker version ignores the new column, trigger, index and table; activating C3c needs every apply prerequisite and fails closed otherwise.

**Rollback.** Pause stops all scopes at once (the existing control, generation fence and drain); disabling the `discovery` row stops that scope alone. Written values stay: they are valid canonical data under fill-only and precedence, corrected by the owner and review routes. A code revert stops future ticks but does not undo data, and the admission fact stays harmlessly in place.

### 8. Delivery graph, history and dependencies

Five planned cards and one later rollout, around the existing cards. **Planning them authorizes none of them.** Each is named, with its shorthand. Statuses are read live at delivery; at review AIR-662 was Done and AIR-605, AIR-607 and AIR-636 were backlog.

| Card | Name | Kind | Depends on |
| --- | --- | --- | --- |
| **C3c-F** | Discovery admission first-current fact | offline code and tests of the column, triggers and index (decision 2), with the old-version and transfer tests; then its own owner apply operation with readback, as early as approved | none in C1; independent of AIR-605 and AIR-607 |
| **C3c-D** | Discovery scope in the Catalog Enrichment Producer | offline, dormant code and tests: the predicate and guards of decision 2, the candidate read and watermark, the translation selection of decision 4, the `catalog_enrichment_scope` shape of decision 7, per-scope counts in `/api/admin/settings`; no behavior change without activation | AIR-605 (C1 code) delivered; AIR-662 (delivered); C3c-F delivered and its fact applied (the predicate reads it) |
| **C3c-M** | Capacity and execution-model measurement | offline evidence and a model proposal; no activation, no setting change | AIR-605's offline cost harness; independent of C3c-D, can run in parallel |
| **C3c-A** | Activation of the Discovery scope | an owner production operation with readback and natural acceptance in `Верификация`: enables the `discovery` row and sets its `cutoff_at` no later than the activation and no earlier than the apply of the fact | AIR-607 and AIR-636 natural acceptance; the receipt operation-key schema applied (AIR-600 implementation, AIR-603 apply gate); C3c-F applied; C3c-D delivered and deployed and the scope table applied; C3c-M accepted and any model change through its own owner gate |
| **HA** | Historical enrichment planning | L0 planning only (below) | none; runs in parallel with safe design and dormant work |
| **HR** (later, not planned now) | Historical enrichment rollout | a separately approved historical scope and activation | HA's plan and its own owner decision and GO |

**No cycle.** C3c-F has no prerequisite. C3c-D follows AIR-605 and C3c-F; C3c-A follows AIR-607, AIR-636, the operation-key apply, C3c-F, C3c-D and C3c-M. AIR-607 does not wait for any C3c card, and C3c adds no blocker to AIR-275. AIR-614 and AIR-615 keep their plans; their order relative to C3c-A is free.

**History (T1-a).** No legacy payload adoption: no value of `discovery_admission.payload_json` is written to canonical state, and no historical Film is written by this record. Admissions that exist before the fact are `unknown_history` by construction (decision 2) and are only ever decided by a later approved scope. **HA** is a standalone, near-term planning deliverable, runnable in parallel with the safe design and dormant work and independent of activation, from approved evidence, offline copies or a separately authorized bounded read only (no fetch, no write):
- the **measured per-field gaps and overlaps** of the eligible historical Films (core fields, credits, Russian title), by the classes of decision 2, excluding Films in the rated or Watchlist scope and counting superseded and unresolved identities;
- the **acquisition and budget options using the common producer**: because C1's single TMDB response carries core, credits and translations, metadata, credits and the Russian title share **one** response per Film and are not separate passes by default;
- the gates and the capacity needed, as input to a later HR decision.

A Russian title for historical Films therefore arrives only through a later approved historical scope; 2A alone does not solve history.

### 9. Amendments to accepted contracts (explicit, scoped, effective only upon acceptance)

| Contract | Amendment | Registry and contract pointers |
| --- | --- | --- |
| ADR 0211 decision 4 (eligibility, scope) | adds the Discovery scope C3c as a widening beside C3a and C3b, with the predicate of decision 2 | `docs/adr/README.md` rows 0211 and 0219; the catalog enrichment reference at implementation |
| ADR 0211 decision 6 (control) | adds the per-scope `catalog_enrichment_scope` row with its independent enabled flag, `cutoff_at`, watermark and revision CAS; the initial rated scope is unchanged | the control reference and `docs/reference/data/d1-schema.md` at implementation |
| ADR 0211 decision 3 (localization part) | states the deterministic TMDB translation selection and its terminal states (decision 4); adds no source and no key | the producer reference |
| Discovery authority contract | adds the additive `first_current_at` fact and its triggers and index; changes no admission behavior | `docs/architecture/discovery-and-resolution.md`, `docs/reference/data/d1-schema.md`, the migration registry |
| ADR 0211 decision 5 (capacity) | **not amended**; any change of cadence, deadline, unit cap, scheduling or concurrency needs its own documented owner gate | `docs/architecture/scheduling-and-orchestration.md` if a model is approved |
| ADR 0214 decision 10 (refresh triggers) | **not amended** unless Choice 5B is chosen, and then only by an explicit bounded contract and scoped amendments for review | — |

## Choice 5 (new, separate; not one of the recorded selections)

**Should a verified Discovery revalidation be an additional refresh trigger for C1?** The normative design assumes **5A**.

| Option | What it means | Benefits | Drawbacks |
| --- | --- | --- | --- |
| **5A** None (assumed; recommended) | the accepted ADR 0214 triggers only (decision 5) | no new coupling, no redundant fetch, no event intake; consistent with 4A as accepted | a complete C3c Film is refreshed only by the accepted triggers and the owner, so a drift Discovery has seen is not fetched by C1 |
| **5B** A coalesced signal | a verified Discovery revalidation that moved an identity-relevant fact raises one Film's `core` `refresh_epoch` through a single guarded statement, at most once per Film per coalescing window, in Discovery's existing revalidation batch | refresh follows a real event | Discovery would write C1-owned state (a new cross-domain write path and fence); the signal is only a trigger, so C1 still fetches its own response and may refetch for an unchanged value; needs bounded event intake, deduplication and fairness design; an explicit bounded contract and scoped amendments of ADR 0214 decision 10 and ADR 0211 decision 3 for review, and not a new observation producer |

**Recommendation: 5A.** Choosing 5B would be a separately reviewed extension, not an implicit part of 4A.

## Alternatives considered (not selected; not normative)

- **1A** Retain minimal Discovery admission and payload serving: no canonical write; rejected because canonical stays incomplete, every non-Discovery reader depends on Discovery, and no one owns refresh.
- **1C** Discovery publishes a versioned TMDB observation and a separate intake applies it: no extra TMDB request, but a second producer, an observation table with a durable token, an intake state machine, receipts and attribution, and an intake-to-C1 handoff. It was reviewed five times (the last at `2a233b5`, in this PR's history) and reached design readiness, but the owner selected 1B for a simpler architecture and plan. It is **not** reintroduced by any decision above.
- **1D** Widen `film_mutation` itself: breaks ADR 0134 decision 5 and the admission budget.
- **2B** C1 fetches translations in a separate pass: the 2A selection already rides on C1's single response, so a separate pass is not needed. **2C** leave localization missing.
- **3B** Everything at activation: not deliverable without a separately accepted historical plan (HA, HR). **3C** Future only: HA's plan would not be pursued.
- **4B** Fill-only forever; **4C** periodic refresh (the ADR 0214 PVT question).
- **T1-b** A bounded legacy adoption of blank fields from payload values: a real additional policy decision; not selected.
- **Parsing a Russian title from `movieTitles`:** rejected; the languages share a script.

## Examples

- **A new Film.** `tmdb_123` is admitted at 10:00 after the cutoff: the trigger stamps its admission row `first_current_at = 10:00`, it holds one trusted `tmdb` claim, and its admission is current. It is in C3c **whether or not its canonical mutation was a no-op**, and C1 fetches `movie/123?append_to_response=credits,translations` and Wikidata at a following tick, writes the six core fields, up to 30 credits and the `tmdb` localization source (the `ru` selection), each with C1's own `observed_at`.
- **An admission before the cutoff, or from before the fact.** A stamped admission earlier than the cutoff is `before_cutoff`; a row that existed when the column was added is `unknown_history` (`NULL`), permanently. Both are history, counted, served from the payload and decided only by HA; neither is promoted by a sweep that creates its canonical Film later.
- **An EPG touch or a revalidation.** The payload and the admission `generation` move; the stamp does not; membership is unchanged and no fetch is triggered.
- **A rated and Discovery Film.** It is in two scopes and planned once, with one state set and the one set of existing keys (`enrich:<film>:core` and the others of decision 1).
- **A lid claim appears later.** Letterboxd becomes applicable and reopens only its gaps (ADR 0211), and the Film stays in C3c.
- **An ambiguous translation.** Two different `ru` titles with no `RU` winner: nothing is written and the gap is recorded; the response `title` is not used.

## Synthetic test plan (C3c-D and C3c-M, on the real migrated schema)

- **Membership and the admission fact:** a new admission is stamped by the trigger at insert (and at `pending` → `current`) and is in scope at or after the cutoff; **a new admission onto an existing titled Film whose canonical mutation is a no-op with no Discovery receipt stays in scope**; **an old admission swept to its canonical Film after the activation is history, not stream**; a rows-before-the-column admission is `unknown_history` and a later `superseded` → `current` does not stamp it; a re-admission, EPG touch, revalidation, poster update and payload change never move the stamp; `discoveredAt`, `generation` and receipts are not read; a trigger does not stamp while `discovery_transfer.state='loading'`; an old Worker version's insert is stamped; a lost response, a transfer and a table restore never invent a timestamp; a merge, a redirect and an identity correction resolve through the current claim; a superseded admission, a retired id, a missing or conflicting `tmdb` claim and a non-movie admission are not members; **overlapping scopes plan one Film with one state set and the existing keys**; activation order of C3c, C3a and C3b in each order; the batch asserts the stored `first_current_at`, the Discovery route and generation and `loading`.
- **Sources and agreement:** no Letterboxd anchor is invented or fetched; Letterboxd applies only with an existing trusted claim; the fallback and `identity_disagreement` are unchanged; credits namespace and expected set unchanged.
- **Translation selection:** a single `ru`, several with `RU`, ambiguous (a terminal gap, no retry), absent, unreadable (the definite failure with bounded retry and `needs_attention`); the per-source keys are kept apart and the counts are accurate; the response `title` and every alias are never used; the AIR-662 receipt and owner-review fence; reviewed and owner precedence; the effective projection equals the resolver output on the rows read back.
- **Refresh:** the ADR 0214 triggers reopen as accepted; a Discovery revalidation reopens nothing; an unchanged repeated verification causes no fetch.
- **Control and counts:** a per-scope cutoff in the control row; old-row compatibility; the per-scope counts in `/api/admin/settings`; pause stops all scopes at once and keeps the cutoff and pending work.
- **Capacity (C3c-M):** per-Film wall time, requests per source, statements, batches and rows with up to 30 missing Persons; receipt, reservation and guard costs; latency, cooldown and `429` with Retry-After; **completed Films per hour under a mixed-scope arrival rate with EPG pauses, the shared cooldown and the 12-unit budget**, and the completion latency of rated and Watchlist work; the throughput and aggregate request rate of X1 to X3 against the admission rate.
- **Candidate discovery:** `EXPLAIN` shows the ordered read is indexed and bounded; an unresolved admission (no trusted claim yet) does not block resolved ones and matches once the claim exists; the watermark advances only over a contiguous prefix and only under the generation and revision CAS; `unresolved_admissions` and its oldest age are reported; a stale tick cannot move the watermark.

## Consequences

- One producer enriches rated, Watchlist and Discovery Films: no new subsystem, no second queue, no handoff, and the accepted protections apply unchanged.
- Each Discovery Film costs a TMDB request that Discovery already made once; the owner accepted this for simplicity.
- Capacity is the principal gate: at the accepted bound the stream cannot drain. A change of cadence, deadline, unit cap, scheduling or concurrency is a separate owner gate after C3c-M.
- ADR 0211 decisions 3, 4 and 6 and the Discovery authority contract (one additive admission fact) are amended, narrowly and only upon acceptance; ADR 0211 decision 5 and ADR 0214 decision 10 are not.
- The stream can begin no earlier than the apply of the admission fact: every earlier admission is `unknown_history` by construction and is never promoted silently. Applying the fact early (C3c-F) maximizes the stream.
- Two additive schema changes with their own apply gates (the admission fact, and the per-scope table after C1's control table), and no new producer, queue or per-Film state.
- History is not written; HA plans it from approved evidence, and a later HR needs its own decision.

## Recovery and migration boundary

This record authorizes nothing: no control row change, no scope activation, no migration apply, no trigger, flag or Task change, no production fetch or write, and no card creation. Each card in decision 8 has its own gate. Code rollback does not remove written values; correction is through the ADR 0214 owner route or a forward write. Old code ignores the new column or index.

## Evidence

- **Original decision:** the owner's [recorded selections](https://github.com/vladimino/iptv-watchlist/pull/1005#issuecomment-7174458421) on this PR; the ADR disposition is pending.
- **Implementation:** none.
- **Dated verification:** the AIR-627 census of 25 Nov 2026 (L0, `rows_written=0`), linked in Context; the code and migration references (`src/discovery.js`, `src/canonical-discovery-admission-producer.js`, `migrations/0011`, `0019`, ADR 0211 decisions 3 to 6) were read statically on `main` `40c8a3a`. The TMDB rate-limit statement is quoted from the owner handoff, not fetched.
- **Uncertainty:** the eligible historical counts (every admission before the fact is unknown by construction); the admission rate (a dated estimate); whether AIR-605 delivers its schema before the per-scope table is needed, and whether AIR-605's scope approval allows coordinating it; the apply state of the receipt operation-key schema (AIR-603); real per-Film cost and throughput; Wikidata's limits; the live status of AIR-605, AIR-607, AIR-636 and AIR-603 (read from Trello at delivery).

## Follow-ups

C3c-F, C3c-D, C3c-M, C3c-A and HA as in decision 8, each its own card; HR only after HA and its own decision; Choice 5 only if the owner chooses 5B.
