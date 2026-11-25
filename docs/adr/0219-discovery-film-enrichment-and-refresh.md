# ADR 0219: Discovery-only Films are enriched by the existing Catalog Enrichment Producer through a separately activated Discovery scope

**Status:** Proposed  
**Original decision date:** not decided  
**Recorded at:** 2026-11-25, from `main` `40c8a3a`. Rewritten as a coherent design for the Product Owner's [recorded selections](https://github.com/vladimino/iptv-watchlist/pull/1005#issuecomment-7174458421) (1B / 2A / 3A / 4A / T1-a); the earlier observation-and-intake design (1C) was reviewed five times and is kept only as an unselected alternative  
**Approval source:** not documented. The selections above are the owner's choices on the options of this record; they are **not** the disposition of the ADR, which still needs an ADR-specific decision on the consolidated text  
**Related work:** [AIR-655](https://trello.com/c/YIPK38Tg). Native prerequisite [AIR-644](https://trello.com/c/nFBGvvnU) ([ADR 0218](0218-film-lifecycle-dimensions-revision.md), Accepted). Builds on Accepted [ADR 0134](0134-discovery-admission-producer-wiring.md), [ADR 0155](0155-retire-enrichment-projector-cron.md), [ADR 0207](0207-letterboxd-admissions-coordinated-in-d1-only.md), [ADR 0211](0211-catalog-enrichment-producer.md), [ADR 0214](0214-film-metadata-per-field-provenance.md), [ADR 0216](0216-canonical-film-lifecycle-and-unified-read-contract.md) and [ADR 0218](0218-film-lifecycle-dimensions-revision.md). Evidence: the [AIR-627 census continuation](https://trello.com/c/IOERZ9GI#comment-6b06a0deb3fbeaeb5f93f8b2) and its [disposition](https://trello.com/c/IOERZ9GI#comment-6b06d8c178a1d27ed10c4e8f). The producer is implemented by [AIR-605](https://trello.com/c/jnqrdG71) and first activated for rated Films by [AIR-607](https://trello.com/c/Daq02gYy); provenance enforcement is [AIR-636](https://trello.com/c/0jJADYxg); projection-aware localization is [AIR-662](https://trello.com/c/P8cCPv1V); rated and Watchlist widenings are [AIR-614](https://trello.com/c/wUHl13Yw) and [AIR-615](https://trello.com/c/fCXSmk7K), which this record neither extends nor duplicates  
**Supersedes:** None  
**Amends, only upon acceptance of this record:** [ADR 0211](0211-catalog-enrichment-producer.md) decision 4 (a Discovery scope, "C3c", joins the widenings C3a and C3b), decision 6 (the control row carries a cutoff per scope) and decision 3 (the TMDB translation selection rule of the localization part), each named in decision 9. [ADR 0211](0211-catalog-enrichment-producer.md) decision 5 (capacity) and [ADR 0214](0214-film-metadata-per-field-provenance.md) decision 10 (refresh triggers) are **not** amended  
**Superseded by:** None

## Context

### What exists (main `40c8a3a`, 25 Nov 2026)

- **The only canonical writer for a Discovery Film is minimal by design.** Since the projector was retired ([ADR 0155](0155-retire-enrichment-projector-cron.md)), a Discovery admission reaches canonical state only through the `film_mutation` unit of [ADR 0134](0134-discovery-admission-producer-wiring.md) decision 5 (`src/canonical-discovery-admission-producer.js`, origin `discovery`, operation `film_mutation`): the Film, the trusted `tmdb` claim and a title written only when blank. It writes no `film_metadata`, credits, Persons, aliases, localization or `canonical_identity`.
- **Every richer writer is bounded to another cohort.** EPG `film_facts` and credits target Watchlist Films only (`src/canonical-producer-workflow.js`); `metadata_sync` is Watchlist only; the dictionary covers its entries; the Catalog Enrichment Producer ("C1", ADR 0211) is scoped to `film_rated_admission.verified_at >= cutoff_at`, with the widenings C3a (the 714 existing admitted Films, AIR-614) and C3b (Watchlist members, AIR-615) as separate owner decisions. C1's code and tables are **not yet in `main`** (no `catalog_enrichment` object in `src/` or `migrations/` at `40c8a3a`).
- **C1 already fetches what Discovery Films lack.** Its TMDB request is `movie/<id>?append_to_response=credits,translations` (ADR 0211 decision 5), one response that carries year, runtime, genres, poster, overview, credits with stable person ids and translations. Each applicable source writes its own `film_localization_source` row; credits are bounded to at most 20 directors and 10 actors; every Film/part/source has one state row and a stable `operation_key` (ADR 0211 decision 3).
- **The Discovery payload is Discovery's own serving record.** `discovery_admission.payload_json` mixes TMDB values with EPG fallbacks (`candidate.year`, `candidate.description`, `src/discovery.js:352`), a poster that can be kept or filled by another path (`POSTER_UPDATE_SQL`), and aliases and availability that change on every EPG touch. It has no observation time of a TMDB response. The Film page and Finds read it directly. It is **not** an input of this design.
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

The existing Catalog Enrichment Producer (ADR 0211; implementation AIR-605) is the only planner, fetcher and state machine for Discovery Films. This record adds **no** observation table, publication step, sequence, cursor, intake unit, receipt origin, intent table, credit-attribution table or intake-to-C1 handoff, and it adds no second queue: a Film has **one** state row per part and source and **one** stable receipt key (`enrich:<film>:<part>`, per-Person keys) whatever scope admitted it.

**A scope is a membership predicate, not a task.** C1's eligible set is the union of its activated scopes: the initial rated scope (AIR-607), the widenings C3a (AIR-614) and C3b (AIR-615), and the Discovery scope **C3c** of this record. A Film that belongs to several scopes is planned once. Scope activations are independent owner operations in any order; none widens another implicitly, and no activation is a prerequisite of another except as decision 8 states.

### 2. The Discovery scope C3c: an exact, durable membership predicate

A Film is in C3c when **all** of these hold, read from authoritative canonical tables and asserted by C1's own guards in each batch:

1. The Film exists and is not a redirect source or retired (the ADR 0211 eligibility).
2. It holds exactly one trusted, non-conflicting `tmdb` movie claim `<n>` with no other trusted owner and no `tmdb_retirement_decision` (the ADR 0211 `tmdb` anchor).
3. `discovery_admission` holds the row for `(media_kind='movie', tmdb_id=<n>)`, unique by index, with `state='current'`.
4. **The cutoff.** The Film's **first applied Discovery admission** is at or after the scope's `cutoff_at`: `MIN(settled_at)` over `canonical_write_receipt` rows with `origin='discovery'`, `operation='film_mutation'`, `target_kind='film'`, `target_id=<film>` and `state='applied'` is `>= cutoff_at`. Receipts are append-only and never deleted (ADR 0119), so this fact is **durable and immutable**: a later EPG touch, a revalidation, a poster update or a re-admission adds receipts but never moves the minimum. It is **not** `discoveredAt`, not the payload and not `discovery_admission.generation` (which every upsert moves), and no sequence is invented.

**Activation, pre-activation and post-cutoff.** C3c is activated by its own owner operation (card C3c-A), which sets the scope's `cutoff_at` **no later than the activation**, as C2 does for rated Films (ADR 0207 decision 7). Films whose first admission is at or after it are eligible from day one and enriched at the following ticks, not instantly. Films admitted before it are **history**: they stay on payload serving, are counted, and are decided only by decision 8. A Film that existed before its first Discovery receipt (for example one created from a rated admission) has the receipt of its own mutation or none; the predicate says so honestly, and it is covered by its own scope.

**Revalidation, retries and source-set changes.** Discovery's revalidation never changes membership (the first receipt is fixed). Retries, backoff, the 6-failure `needs_attention` cap, anchor corrections, retirements, a lid claim that appears later (which makes Letterboxd applicable and reopens only its gaps), redirects and `identity_disagreement` are exactly ADR 0211 decisions 3 and 3b; nothing here restates or relaxes them.

**Overlap.** A Film also in the rated or Watchlist scope is one Film with one state set; C1 plans it once, and no handoff or ownership transfer exists because there is one writer. C3c reuses the AIR-614 and AIR-615 widening plans and neither duplicates their scope nor widens it implicitly.

**Candidate discovery.** C1 materializes missing state rows for in-scope Films through a bounded, indexed read per tick, as it does for the rated scope. Whether the receipt table already offers an adequate index for `(origin, operation, state, settled_at)` is checked in C3c-D; if it does not, the index is an additive migration with its own apply boundary (decision 7). No full scan per tick is acceptable.

### 3. Sources, anchors and agreement are unchanged

For a C3c Film C1 derives the applicable sources exactly as ADR 0211 decision 2 does: the `tmdb` anchor makes `tmdb` and `wikidata` applicable (Wikidata via P4947); `letterboxd` is applicable **only** when a trusted lid claim already exists, and is never invented or fetched without one. Agreement, the 72 h transport-only fallback, precedence and `identity_disagreement` are unchanged; credits keep the one-namespace rule, the expected set (at most 20 directors and 10 actors) and `superseded_credits`; the ADR 0214 rank, owner pins, the metadata lock, hold mode and the no-clear rule apply to the single writer as accepted. C1 obtains its **own** fresh response with a real `observed_at`; no mixed serving value is copied.

This record does not add a source or broaden a fetch. Whether Wikidata is worth its request for this scope is a measurement question of C3c-M; a change of applicability would be a scoped amendment of ADR 0211 decided with capacity, not assumed here.

### 4. 2A: the typed Russian title comes from C1's own TMDB response

C1's `localization` part already writes the `tmdb` source row from the same TMDB response that carries `credits,translations`. 2A is applied there, with **no separate per-film translation fetch**:
- the selection reads the `translations.translations` entries with `iso_639_1 = 'ru'`;
- exactly one distinct non-blank `data.title` is the value; several entries are decided by `iso_3166_1 = 'RU'`; if they still differ, the selection is **ambiguous** and nothing is written (a recorded gap);
- no `ru` entry is a legitimate **absence** (`complete_with_gaps`, as ADR 0211 already records); a missing or malformed section is **unreadable** (not an absence, not a failure of the Film);
- the response `title`, `aliases`, `movieTitles` and any alias are **never** read as a Russian title.

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

**Budgets any model must respect:** the shared upstream cooldown and Retry-After; the D1 statement and batch caps (ADR 0094) and the unit budget; Worker CPU and wall time; the EPG publication pause and window (ADR 0135); and **no starvation of the existing cohorts**: ADR 0211's oldest-`due_since`-first fairness already means a large stream cannot starve older rated or Watchlist work, and the measurement checks it with mixed scopes.

**Measurement (C3c-M, offline, no production fetch or write).** Real-schema fixtures with representative recorded inputs (counts and shapes, no private rows) measure per Film: wall time, requests per source, statements, batches and rows, including missing Persons up to 30, the receipt, reservation and guard costs, and external latency, cooldown and `429` scenarios; and they report the throughput of X1 to X3 and the aggregate request rate. The result is evidence plus a simple, bounded model proposal; the owner gate decides any change. C3c is **not** activated until the measured capacity exceeds the observed admission rate with margin under an approved model.

### 7. Schema, apply boundaries, compatibility and rollback

- **No new table and no new producer state.** C3c uses C1's state, outbox, control and cooldown tables (CM) and the existing receipt `operation_key` (AIR-600, migration `0039`).
- **One control-shape amendment.** ADR 0211's control row carries one `cutoff_at` and one `scope`, which cannot hold an independent cutoff for C3c. The amendment (decision 9) gives each scope its own `cutoff_at`. C1's control table is not in `main` yet, so the shape is **delivered inside AIR-605's own schema if that migration is not yet applied**; if it has been applied, it is an additive nullable column in a separate migration with its own apply boundary and a compatibility test against the old row. Which case holds is read live at delivery, not assumed here.
- **A possible additive index** on the receipt table for candidate discovery (decision 2), only if C3c-D's check shows the existing indexes inadequate; otherwise none.
- **Compatibility.** Dormant code reads "not active" without a control row; an old Worker version ignores the new column or index; activating C3c needs the control and tables applied (CM) and fails closed otherwise.
- **Rollback.** Pause stops new work at once (the existing control, generation fence and drain). Written values stay: they are valid canonical data under fill-only and precedence, corrected by the owner and review routes. A code revert stops future ticks but does not undo data.

### 8. Delivery graph, history and dependencies

Four planned cards and one later rollout, around the existing cards. **Planning them authorizes none of them.** Each is named, with its shorthand.

| Card | Name | Kind | Depends on |
| --- | --- | --- | --- |
| **C3c-D** | Discovery scope in the Catalog Enrichment Producer | offline, dormant code and tests: the predicate and cutoff of decision 2, the translation selection of decision 4, the per-scope cutoff in the control shape, per-scope counts in `/api/admin/settings`, no behavior change without activation | AIR-605 (C1 code) delivered; AIR-662 delivered; reads the control shape as in decision 7 |
| **C3c-M** | Capacity and execution-model measurement | offline evidence and a model proposal; no activation, no setting change | AIR-605's offline cost harness; independent of C3c-D, can run in parallel |
| **C3c-A** | Activation of the Discovery scope | an owner production operation with readback and natural acceptance in `Верификация`: sets the scope's `cutoff_at` no later than the activation | AIR-607 and AIR-636 natural acceptance; the receipt `operation_key` schema applied (AIR-600, CM); AIR-662 delivered; C3c-D delivered and deployed; C3c-M accepted and any model change through its own owner gate |
| **HA** | Historical enrichment planning | L0 planning only (below) | none; runs in parallel with safe design and dormant work |
| **HR** (later, not planned now) | Historical enrichment rollout | a separately approved historical scope and activation | HA's plan and its own owner decision and GO |

**No cycle.** C3c-D follows AIR-605; C3c-A follows AIR-607, AIR-636, CM, C3c-D and C3c-M; AIR-607 does not wait for any C3c card, and C3c adds no blocker to AIR-275. AIR-614 and AIR-615 keep their plans; their order relative to C3c-A is free.

**History (T1-a).** No legacy payload adoption: no value of `discovery_admission.payload_json` is written to canonical state, and no historical Film is written by this record. **HA** is a standalone, near-term planning deliverable, runnable in parallel with the safe design and dormant work, from approved evidence, offline copies or a separately authorized bounded read only (no fetch, no write):
- the **measured per-field gaps and overlaps** of the eligible historical Films (core fields, credits, Russian title), by the scopes above, excluding Films in the rated or Watchlist scope and counting superseded and unresolved identities;
- the **acquisition and budget options using the common producer**: because C1's single TMDB response carries core, credits and translations, metadata, credits and the Russian title share **one** response per Film and are not separate passes by default;
- the gates and the capacity needed, as input to a later HR decision.

A Russian title for historical Films therefore arrives only through a later approved historical scope; 2A alone does not solve history.

### 9. Amendments to accepted contracts (explicit, scoped, effective only upon acceptance)

| Contract | Amendment | Registry and contract pointers |
| --- | --- | --- |
| ADR 0211 decision 4 (eligibility, scope) | adds the Discovery scope C3c as a widening beside C3a and C3b, with the membership predicate and cutoff of decision 2 | `docs/adr/README.md` rows 0211 and 0219; `docs/reference/` catalog enrichment contract at implementation |
| ADR 0211 decision 6 (control) | the control row carries an independent `cutoff_at` per scope; activation and widening stay owner operations | the control reference and `docs/reference/data/d1-schema.md` at implementation |
| ADR 0211 decision 3 (localization part) | states the deterministic TMDB translation selection of decision 4; adds no source | the producer reference |
| ADR 0211 decision 5 (capacity) | **not amended**; any change of cadence, deadline, unit cap, scheduling or concurrency needs its own documented owner gate | `docs/architecture/scheduling-and-orchestration.md` if a model is approved |
| ADR 0214 decision 10 (refresh triggers) | **not amended** unless Choice 5B is chosen, and then only by the scoped extension of that choice | — |

## Choice 5 (new, separate; not one of the recorded selections)

**Should a verified Discovery revalidation be an additional refresh trigger for C1?** The normative design assumes **5A**.

| Option | What it means | Benefits | Drawbacks |
| --- | --- | --- | --- |
| **5A** None (assumed; recommended) | the accepted ADR 0214 triggers only (decision 5) | no new coupling, no redundant fetch, no event intake; consistent with 4A as accepted | a complete C3c Film is refreshed only by the accepted triggers and the owner, so a drift Discovery has seen is not fetched by C1 |
| **5B** A coalesced signal | a verified Discovery revalidation that moved an identity-relevant fact raises one Film's `core` `refresh_epoch` through a single guarded statement, at most once per Film per coalescing window, in Discovery's existing revalidation batch | refresh follows a real event | Discovery would write C1-owned state (a new cross-domain write path and fence); the signal is only a trigger, so C1 still fetches its own response and may refetch for an unchanged value; needs bounded event intake, deduplication and fairness design; an explicit amendment of ADR 0214 decision 10 and ADR 0211 decision 3 |

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

- **A new Film.** `tmdb_123` is admitted at 10:00 after the cutoff: its first applied Discovery receipt is at 10:00, it holds one trusted `tmdb` claim, and its admission is current. It is in C3c, and C1 fetches `movie/123?append_to_response=credits,translations` and Wikidata at a following tick, writes the six core fields, up to 30 credits and the `tmdb` localization source (the `ru` selection), each with C1's own `observed_at`.
- **A Film before the cutoff.** Its first applied receipt is earlier: history, counted, served from the payload, decided only by HA.
- **An EPG touch or a revalidation.** The payload and the admission `generation` move; the first receipt does not; membership is unchanged and no fetch is triggered.
- **A rated and Discovery Film.** It is in two scopes and planned once, with one state set and one receipt key.
- **A lid claim appears later.** Letterboxd becomes applicable and reopens only its gaps (ADR 0211), and the Film stays in C3c.
- **An ambiguous translation.** Two different `ru` titles with no `RU` winner: nothing is written and the gap is recorded; the response `title` is not used.

## Synthetic test plan (C3c-D and C3c-M, on the real migrated schema)

- **Membership and cutoff:** the first applied receipt is at or after the cutoff; a later re-admission, EPG touch, revalidation, poster update and payload change never move it; `discoveredAt` and `generation` are not read; a superseded admission, a redirect, a retired id, a missing or conflicting `tmdb` claim and a non-movie admission are not members; a Film that existed before its first Discovery receipt; two scopes overlap with one state row and one receipt key; activation order of C3c, C3a and C3b in each order; a cutoff earlier than the activation does not strand a Film.
- **Sources and agreement:** no Letterboxd anchor is invented or fetched; Letterboxd applies only with an existing trusted claim; the fallback and `identity_disagreement` are unchanged; credits namespace and expected set unchanged.
- **Translation selection:** a single `ru`, several with `RU`, ambiguous, absent, unreadable; the response `title` and every alias are never used; the AIR-662 receipt and owner-review fence; reviewed and owner precedence; the effective projection equals the resolver output on the rows read back.
- **Refresh:** the ADR 0214 triggers reopen as accepted; a Discovery revalidation reopens nothing; an unchanged repeated verification causes no fetch.
- **Control and counts:** a per-scope cutoff in the control row; old-row compatibility; the per-scope counts in `/api/admin/settings`; pause stops all scopes at once and keeps the cutoff and pending work.
- **Capacity (C3c-M):** per-Film wall time, requests per source, statements, batches and rows with up to 30 missing Persons; receipt, reservation and guard costs; latency, cooldown and `429` with Retry-After; mixed-scope fairness with no starvation of rated or Watchlist work; the throughput and aggregate request rate of X1 to X3 against the admission rate.
- **Candidate discovery:** the bounded indexed read finds in-scope Films without a full scan; the index check of decision 2.

## Consequences

- One producer enriches rated, Watchlist and Discovery Films: no new subsystem, no second queue, no handoff, and the accepted protections apply unchanged.
- Each Discovery Film costs a TMDB request that Discovery already made once; the owner accepted this for simplicity.
- Capacity is the principal gate: at the accepted bound the stream cannot drain. A change of cadence, deadline, unit cap, scheduling or concurrency is a separate owner gate after C3c-M.
- ADR 0211 decisions 3, 4 and 6 are amended, narrowly and only upon acceptance; ADR 0211 decision 5 and ADR 0214 decision 10 are not.
- History is not written; HA plans it from approved evidence, and a later HR needs its own decision.

## Recovery and migration boundary

This record authorizes nothing: no control row change, no scope activation, no migration apply, no trigger, flag or Task change, no production fetch or write, and no card creation. Each card in decision 8 has its own gate. Code rollback does not remove written values; correction is through the ADR 0214 owner route or a forward write. Old code ignores the new column or index.

## Evidence

- **Original decision:** the owner's [recorded selections](https://github.com/vladimino/iptv-watchlist/pull/1005#issuecomment-7174458421) on this PR; the ADR disposition is pending.
- **Implementation:** none.
- **Dated verification:** the AIR-627 census of 25 Nov 2026 (L0, `rows_written=0`), linked in Context; the code and migration references (`src/discovery.js`, `src/canonical-discovery-admission-producer.js`, `migrations/0011`, `0019`, ADR 0211 decisions 3 to 6) were read statically on `main` `40c8a3a`. The TMDB rate-limit statement is quoted from the owner handoff, not fetched.
- **Uncertainty:** the eligible historical counts; the admission rate (a dated estimate); whether AIR-605's control migration is applied when C3c-D lands; whether the receipt table has an adequate index for candidate discovery; real per-Film cost and throughput; Wikidata's limits; the live status of AIR-605, AIR-607 and AIR-636 (read from Trello at delivery).

## Follow-ups

C3c-D, C3c-M, C3c-A and HA as in decision 8, each its own card; HR only after HA and its own decision; Choice 5 only if the owner chooses 5B.
