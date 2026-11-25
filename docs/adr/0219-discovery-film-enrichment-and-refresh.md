# ADR 0219: Discovery-only Films get canonical metadata, credits and localization from a versioned TMDB observation that Discovery stores, applied by a bounded intake under the existing single-writer rules

**Status:** Proposed  
**Original decision date:** not decided  
**Recorded at:** 2026-11-25, from `main` `7d8d4b3`; revised after the [independent review](https://github.com/vladimino/iptv-watchlist/pull/1005#issuecomment-7168898942) of `d184a9e`  
**Approval source:** not documented (awaiting an ADR-specific Product Owner decision on each open choice below)  
**Related work:** [AIR-655](https://trello.com/c/YIPK38Tg). Native prerequisite [AIR-644](https://trello.com/c/nFBGvvnU) ([ADR 0218](0218-film-lifecycle-dimensions-revision.md), Accepted). Builds on Accepted [ADR 0134](0134-discovery-admission-producer-wiring.md), [ADR 0155](0155-retire-enrichment-projector-cron.md), [ADR 0211](0211-catalog-enrichment-producer.md), [ADR 0214](0214-film-metadata-per-field-provenance.md), [ADR 0216](0216-canonical-film-lifecycle-and-unified-read-contract.md) and [ADR 0218](0218-film-lifecycle-dimensions-revision.md). Evidence: the [AIR-627 census continuation](https://trello.com/c/IOERZ9GI#comment-6b06a0deb3fbeaeb5f93f8b2) and its [disposition](https://trello.com/c/IOERZ9GI#comment-6b06d8c178a1d27ed10c4e8f). Coordinated with, and not extending, [AIR-614](https://trello.com/c/wUHl13Yw), [AIR-615](https://trello.com/c/fCXSmk7K), PV1 [AIR-631](https://trello.com/c/i8td3wu0), PVE [AIR-636](https://trello.com/c/0jJADYxg), AIR-662 (projection-aware localization write, ADR 0218 decision 3) and the Proposed source-independent admission record of [AIR-643](https://trello.com/c/e1Q9H1bG) (ADR 0217, [PR #996](https://github.com/vladimino/iptv-watchlist/pull/996)).  
**Supersedes:** None. This record does **not** amend ADR 0214 (decision 8 below)  
**Superseded by:** None

## Context

### What exists (main `7d8d4b3`, 25 Nov 2026)

- **The only canonical writer for a Discovery Film is minimal by design.** Since the projector was retired ([ADR 0155](0155-retire-enrichment-projector-cron.md)), a Discovery admission reaches canonical state only through the `film_mutation` unit of [ADR 0134](0134-discovery-admission-producer-wiring.md) decision 5 (`src/canonical-discovery-admission-producer.js`): the Film, the trusted `tmdb` claim and a title written only when blank. It never writes `film_metadata`, credits, Persons, aliases, localization or `canonical_identity`.
- **Every richer writer is bounded to another cohort.** EPG `film_facts` and credits target Watchlist Films only (`src/canonical-producer-workflow.js`); `metadata_sync` is Watchlist only; the dictionary covers its entries; the ADR 0211 catalog-enrichment producer (C1, not yet delivered) is scoped to `film_rated_admission.verified_at >= cutoff_at` (ADR 0211 decision 4). AIR-614 and AIR-615 widen C1 to rated and Watchlist cohorts, not to Discovery-only Films.
- **The Discovery payload is a mixed serving record, not a TMDB observation.** `discovery_admission.payload_json` is built from a verified `movie/<id>?language=ru-RU&append_to_response=credits,translations,alternative_titles` response (`src/discovery.js`), but:
  - some fields are TMDB by construction: `runtime`, `genres`, `url` (built from the id), `directors` and `actors` (capped at ten each, with ids `tmdb_director/<id>`, `tmdb_actor/<id>`);
  - `year` and `synopsis` fall back to the EPG candidate (`candidate.year`, `candidate.description`) when TMDB has no release year or overview (`src/discovery.js:352`);
  - `poster` can be kept from an earlier payload by the admission conflict clause or filled later by `POSTER_UPDATE_SQL` (`src/discovery-authority.js`), so its source and time are not those of the body;
  - `aliases` and `shows` (availability) change on every EPG touch without any TMDB request (`touchCanonicalFilm`); `movieTitles` mixes ru, uk, en and RU/UA/US/GB titles without a language;
  - a revalidation (`revalidateDrift`) re-fetches the detail but only appends missing authority titles to the stored record; it does not publish a fresh complete body, and `discoveredAt` is kept;
  - there is **no observation time** of the TMDB response anywhere.
- **Serving already uses the payload.** The Film page and Finds read title, year, runtime, genres, poster and credits from it. Data are lost only on the canonical fallback (`catalogCanonicalFilmFromD1`), in `/api/d1/films` and in any reader of canonical state (ADR 0216).
- **No Discovery Film has a Russian title in canonical state**, minimal or not.
- **The `discovery_admission` key is the Discovery key** (`tmdb_<n>`), not `film.id`. It reaches a Film only through the trusted `tmdb` claim (the 21 Films without a literal `film:tmdb:<n>` row resolve that way).

### Census (AIR-627, L0, dated 25 Nov 2026, main `681b5c1`, Film/Person g2, EPG P519)

Dated aggregates, not live counts and not guarantees. Implementation cards re-measure with bounded predicates.

| Group | Size | Canonical state | Serving payload presence (not proof of source) |
| --- | --- | --- | --- |
| Minimal Discovery Films (since 16 Nov, `film_mutation` only) | 2 525; 1 213 airing in P519 | no `film_metadata`, credits, aliases, dimensions; `canonical_identity` NULL | year/runtime 2 525, synopsis 2 524, genres 2 524, actors 2 523, directors 2 519, poster 2 517 |
| Projector-era Discovery Films | 9 730 | projector credits and aliases; `film_dimension` copies (metadata `fresh`) but no `film_metadata` row for 8 216 of 8 620 `fresh` | about 99.5 % |
| Future admissions | about 2 525 in about 9 days (a dated estimate) | as the minimal group | — |
| Rated (714; 473 with metadata missing) and Watchlist (391) | — | owned by C1 / AIR-614 / AIR-615 | out of scope |

The groups overlap only through the classification of decision 3. `canonical_identity` NULL is not a proof of missing identity: each of these Films holds a trusted, non-conflicting `tmdb` claim.

### The problem

Canonical Film/Person D1 is the authority (ADR 0216), but for about 12 000 Discovery Films it holds only an id, a claim and a title. Readers that do not go through Discovery lose year, runtime, synopsis, poster, genres, credits and every Russian title, and nobody owns refresh. The serving payload cannot simply be copied: it does not say which values are TMDB, when they were observed or whether they are complete.

### Settled decisions this record keeps

- `film_mutation` stays minimal (ADR 0134 decision 5). This record adds separate units.
- After intake the canonical row is the authority; the Discovery payload stays Discovery's own serving record.
- ADR 0218: processing dimensions (identity, metadata, fingerprint, prediction) are not written or read for decisions. The **effective localization projection** is control state and is written only by the AIR-662 projection-aware operation (ADR 0218 decision 3). The `film_dimension` rows of projector-era Films are retired processing copies; their lock predicate (`status='reviewed' OR authority='owner'`) stays control and is respected.
- `writeFilmFacts` is the single metadata writer; the ADR 0214 rules (rank, locks, hold, history) and the ADR 0211 rules (anchors, agreement, credits namespace, expected set) apply unchanged. This record adds no precedence, identity or provenance rule and **does not amend ADR 0214**.
- Identity is never inferred from a title or a year. Nothing here creates, merges, redirects or retires a Film, or writes a claim, alias or `canonical_identity`.
- Mass enrichment waits for delivered and naturally accepted C1 ([AIR-607](https://trello.com/c/Daq02gYy)) and ADR 0214 `enforce` ([AIR-636](https://trello.com/c/0jJADYxg)); this gates activation, not this design.

## Decision

**Common contract.** Decisions 1–8 are the technical contract of the recommended direction (1C, 2A, 3A, 4A). They resolve defects, not owner choices. The owner choices follow in "Open choices"; a different selection removes the decisions that depend on it and nothing else.

### 1. A versioned TMDB observation, stored by Discovery from the response it already has

Discovery stores one **TMDB observation** per movie id, in its own row, built **only** from the verified detail response, never from the serving payload.

**Storage.** A new table `discovery_tmdb_observation`, keyed by `tmdb_id` (the identity of the source, not `film_id`), columns:
- `observation_version` (starts at 1);
- `observed_at`: the time the verified response was received, set by the code that received it;
- `seq`: a strictly increasing integer assigned as `1 + MAX(seq)` inside the same fenced batch as the row write (Discovery writes are serialized by `discovery_lease` and the transfer fence, so commit order equals `seq` order); an index on `seq`;
- `digest`: 64 hex characters, computed in application code from the canonical JSON of the semantic body below (**not** a SQL function, which D1 does not guarantee). Guards compare stored `(seq, digest)` by equality;
- `body_json`: the bounded semantic body.

**Semantic body** (`observed_at` and `seq` excluded from the digest, so an unchanged re-observation has the same digest):
- **core**: `year` (from `release_date` only), `runtime`, `synopsis` (ru-RU overview), `poster` (the `poster_path` URL), `url`, `genres` (ru-RU names). Each field is `value`, `absent` (a complete response without it; a blank string is absent) or `unreadable` (wrong type or malformed). EPG fallbacks (`candidate.year`, `candidate.description`), a retained or later-updated poster, aliases and availability **never** enter the observation;
- **credits**: `directors` and `actors` from the response's `credits` section in source order, each with a validated positive-integer person id and name, bounded to the C1 limits (**at most 20 directors, 10 actors**, ADR 0211 decision 3), with `directors_total`, `actors_total` and the gap `directors_truncated` when more than 20. The serving payload keeps its own ten-director cap; the observation does not inherit it. A missing `credits` section is `unreadable`; a present section with none is `absent`;
- **translations**: a deterministic selection of the Russian title from `translations.translations` entries with `iso_639_1 = 'ru'`: one distinct non-blank title is `value`; several entries are decided by `iso_3166_1 = 'RU'`, and if still different the selection is `ambiguous` and nothing is written; a section with no `ru` entry is `absent`; a missing or malformed section is `unreadable`. The response `title` (the ru-RU-or-fallback title) is **not** a Russian title and is not used.
- **section presence** per `core`, `credits`, `translations`.

**When it is written.** Only after a **successful verified detail**, in the same fenced batch family as the admission write, with no extra network request:
- a new admission (the build at `src/discovery.js:352` and the two sibling builds);
- **a revalidation** whose detail is verified, **even when no alias is missing** (today it writes nothing in that case). This is the one behavior change to Discovery's flow, in the same budget accounting as its existing writes (`writeEstimate`).

A failed, unverified or skipped detail writes no observation. An unchanged digest keeps the row and its `seq` (no new work); a changed digest moves `seq`.

**Old payloads.** Historical payload values are **not observations**. Inventory (static, from code; to be re-verified by fixture):

| Payload field | By construction | Proof |
| --- | --- | --- |
| `runtime`, `genres`, `url`, `directors`, `actors` | built from `movie` | TMDB-derived, observation time unknown, credits capped at ten each |
| `year`, `synopsis` | `movie` value **or** EPG fallback | unprovable |
| `poster` | TMDB URL, but possibly retained or updated by another path | unprovable as to time and path |
| `aliases`, `movieTitles`, `shows` | mixed | not metadata |

`discoveredAt` is the first admission time and is never used as an observation time, including on a legacy refetch. See decision 8 for what this means for history.

### 2. One owner per part: explicitly non-overlapping scopes, fenced in every batch

**Parts** are `core` (`film_metadata` fields and, when needed, nothing in `film_sync_state`), `credits` (Persons and credits) and `localization` (the `tmdb` source row and the effective projection). Intake owns all three for a Film **only while the Film is in the intake scope**, and C1 owns all three for every Film in the C1 domain. The two are disjoint by construction, and each batch asserts it.

**Intake scope (live predicate, evaluated at plan and asserted in each batch):** the Film exists and is not a redirect source; it has exactly one trusted, non-conflicting `tmdb` movie claim `<n>`, no other trusted owner of that id and no `tmdb_retirement_decision`; and **none** of:
- a Letterboxd anchor (a trusted `letterboxd` claim, by any value), or a C1 state row of any state (`complete`, `needs_attention`, `identity_disagreement`, paused, due), so a failed, disagreeing, paused or newly eligible C1 Film is never written by intake;
- membership of the C1 domain: a `film_rated_admission` row, a `film_retention` row, a `watchlist_film` row, or a scope widening of C1 (C3a, C3b) covering it;
- an EPG-chain target (Watchlist).

A Film that enters the C1 domain or gains a Letterboxd anchor later leaves the intake scope: the next batch fails its guard, the unit replans and records `handed_to_catalog_enrichment`, and intake never writes it again. C1 never selects an intake-scope Film (its scope is the rated and Watchlist domain). The overlap of a Discovery Film that is also rated or on the Watchlist belongs entirely to C1.

**Agreement.** Intake relies only on the `tmdb` anchor. Since a Letterboxd anchor excludes the Film, the writer's derived agreement is `not_required` and the ADR 0214 confidence is `confirmed`. Intake never uses the `unconfirmed` rank as permission, never invokes the ADR 0211 transport-only fallback, and a known disagreement or a Letterboxd anchor added between plan and commit fails the anchor-digest assertion (ADR 0214 decision 4).

**Precedence.** With only a TMDB anchor, only the `tmdb` source applies. The ADR 0214 rank applies unchanged: confidence first, then the ADR 0211 source order, then `observed_at`, then `value_digest`; **only a `confirmed` observation replaces a different value** (decision 8 of ADR 0214); `unknown` legacy values are replaced only by such an observation; an `owner` value, a pinned field or a dimension-locked Film is never touched; in `hold` mode intake only fills and adopts; no automatic clear exists.

**Credits.** The ADR 0211 one-namespace rule applies: intake's namespace is `tmdb_actor/<id>` and `tmdb_director/<id>`. A Film that already has credits in the other namespace (for example `actor/<slug>`) gets no credits, and the part records `credits_other_namespace`; a Film with credits in both namespaces gets none; a Film with credits only in the TMDB namespace gets only the missing ones. The expected set (from the observation, 20 and 10 at most) is stored per Film. Only entries with a valid person id are written; name-only credits are not. On an anchor correction, credits that intake added under the old anchor are held as `superseded_credits` (`needs_attention`) until the owner's retry, exactly as ADR 0211 decision 3b; units already applied before the correction stay and are never relabeled.

**Localization.** Intake writes only its own `tmdb` `film_localization_source` row, through the AIR-662 projection-aware operation (a new receipt kind and digest, the effective projection recomputed in the same batch, the Film revision CAS **and** the owner-review authority and content token, ADR 0218 decision 3). It writes nothing when the selection is `absent`, `ambiguous` or `unreadable` (recorded as a gap). The existing resolver chooses the effective title; reviewed and owner rows win.

**No sync clocks.** Intake never sets `film_sync_state.metadata_at` or any C1 clock; observation presence is not a C1 completion.

**Persons and credits** are separate units with the same gates as the Film unit: each Person batch and the credits batch assert the scope predicate, the stored observation `(seq, digest)`, the anchor digest and the control state, not merely a later Film CAS. A stale plan is refused at the Person unit.

### 3. Classification, coverage and per-part state

**Classification** is ordered, exhaustive and disjoint (first match wins), over Discovery admissions resolved to Films through the verified claim. It is a **measured snapshot** (a bounded dry run recorded as evidence, with counts), not stored state:

| # | Class | Rule |
| --- | --- | --- |
| 1 | `superseded_admission` | the admission is not `current`; counted, never forced into scope |
| 2 | `unresolved_identity` | the tmdb id resolves to no Film, to several, to a conflicting or untrusted claim, a retired id or a redirected Film |
| 3 | `c1_domain` | outside the intake scope by decision 2 (Letterboxd anchor, C1 state, rated, retention, Watchlist) |
| 4 | `no_observation` | in scope, no stored observation (every historic Film at the start) |
| 5 | `observation_pending` | an observation exists and some expected part is not applied |
| 6 | `settled` | the applied token equals the stored `(seq, digest)` and every part is `present`, `gap` or `blocked` |

The old H1/H2 labels are not used as scopes: an alias-only Film is class 4 or 5 by the same rule, and a partially filled Film is class 5. Counts of every class, including 1–3, are part of every evidence report; none is silently dropped.

**Per-part state** (not one `done` row): `discovery_intake_state(film_id, part, applied_seq, applied_digest, anchor_digest, expected_json, outcome_json, gaps_json, state, reason, attempts, retry_at, due_since, updated_at)`, `PRIMARY KEY (film_id, part)` with `part IN ('core','credits','localization')`. Each field or credit has an outcome `present`, `absent` (proved by a complete response), `unknown` (unreadable or not yet applied), `gap` (for example `directors_truncated`, `translation_ambiguous`, `credits_other_namespace`, `locked`) or `blocked` (`superseded_credits`, `handed_to_catalog_enrichment`). Coverage is reported per part and never as a single total. `unreadable` and `absent` are different outcomes, so no false negative follows from a missing section.

**Cohort cutoff and replay** use `seq`, a real stored token: the control row holds `cutoff_seq`; an observation is in the stream when `seq > cutoff_seq`. Row write times (`discoveredAt`, `updated_at`) are never a cutoff, because an EPG touch moves them.

**Work reopens** only on: a new observation with a changed digest (`seq` moves); a changed anchor digest of the Film; a lock release or a reviewed-localization change that affects a blocked part; a failed unit's `retry_at` (a D1-only retry, never an upstream request); an owner retry. There is no time-based refresh and no extra TMDB call.

### 4. Delivery, receipts and fences

- **Unit identity.** A deterministic `operation_key` per unit: `intake:<film>:<part>:<seq>:<digest-prefix>` and, for a Person unit, the person id. Intent is durable before the write: the **reconcile-then-reserve** protocol of ADR 0207 decision 3 (history fingerprint, settle unresolved receipts, an atomic reservation, a loser replans). Each unit kind is registered in `PRODUCER_OPERATIONS` with a replan from the stored observation and a `readback`; an unknown outcome is settled by readback, never replayed blind.
- **Guards in every batch, canonical and state.** The stored observation `(seq, digest)` equality; the Film's claim ownership (the exact `tmdb` row trusted and non-conflicting, no other owner, no retirement, not a redirect source) and anchor digest; the intake scope predicate (decision 2); the admission row `state='current'` with the same `tmdb_id`; the Discovery authority marker route and generation (as `ADMISSION_FENCE_SQL`); the control row `mode='on'` **and** `revision` equal to the plan's; the intake lease `lease_id` and `lease_until`; and, for localization, the AIR-662 fences. A pause, a takeover, a deadline, a moved digest or a marker movement therefore fails the batch: the unit replans and **none of these is a strike** (ADR 0128: systemic stop or recoverable refusal; three strikes only for the same unit, digest and class).
- **Events are not lost.** The observation row (with its `seq`) is written in the same fenced batch as the admission upsert, so an admission and its observation commit together. The intake drains by an **indexed bounded cursor** over `seq` (`discovery_intake_cursor(applied_through_seq)`): one batch inserts `due` state rows for up to N observations above the cursor and advances the cursor in the same batch. No payload is loaded or scanned, and the order is `seq`, so older work is not starved by newer.
- **Where and when it runs.** In its own step under its own lease (`projection_run`, `projection = 'discovery_intake'`), **not** inside `upsertAdmissions`, the EPG publication path or the hourly tick's critical work. It respects the ADR 0135 EPG pause windows. The **trigger** (cron tick, Workflow step or Task) and its measured reserved budget are **not decided here**; they are part of the activation gate, and no flag or schedule is authorized by this record.
- **Control and audit.** One control row (`mode` in `off`, `on`, `paused`; `revision`; `cutoff_seq`; `updated_at`, `updated_by`), created `off`. Each transition is an owner production operation with readback, each raising `revision`; activation is not reachable from `/admin/settings`. `paused` stops new units at once, and in-flight batches fail on the control revision guard (no blanket claim without that fence).
- **Rollback.** Written values stay; there is no bulk delete. A wrong value is corrected by the ADR 0214 owner route or replaced by a later `confirmed` observation. A code revert is not a rollback of data.

### 5. Provenance and ADR 0214 (no amendment)

Intake's field rows are `tier='automatic'`, `source='tmdb'`, `origin='catalog_enrichment'` (the audit column accepts it; the CHECK stays unchanged), anchor `tmdb=<n>`, the current `anchor_digest`, `agreement='not_required'`, `observed_at` the observation's real time. Intake is distinguished by the `write_key` prefix `intake:` and by its state table, not by a new `origin` value. This avoids a CHECK migration (a SQLite table rebuild with history and trigger compatibility) and any amendment of ADR 0214. Whether the single writer accepts a second declared caller with that origin is verified in I2 review. If PV1 (AIR-631) has not applied its DDL when I2 is accepted, a dedicated `origin` value may instead be coordinated into PV1 first; that is a PV1 change, decided there, not silently extended here.

### 6. Cost and capacity (counted, not assumed)

D1 only; no TMDB, Letterboxd or Wikidata request. The unit accounting is C1's (ADR 0211 decision 5): each receipted unit is a reconcile read, a reservation, a fenced batch and a state settle.

| Unit | Count per Film | Statements per unit (incl. guards) |
| --- | --- | --- |
| core | 1 | reconcile, reservation, one batch (≤ 12 guards), settle: about 4 round trips |
| localization | 1 (AIR-662 operation; up to 3 in ADR 0211's accounting) | about 4 round trips each |
| Person | 0 to 30 (one per **missing** Person, up to 20 directors + 10 actors) | about 4 round trips each, with Film, observation and scope guards |
| credits | 1 | about 4 round trips |

So a Film costs **about 12 round trips at best and about 130 in the worst case** (all 30 Persons missing), not 10 to 25. The unit budget per tick starts at C1's 12 units (core 1, localization up to 3, Persons per missing Person, credits 1), so a worst-case Film needs about three ticks and continues from canonical state.

**Capacity is unproven.** At an hourly tick and 12 units, a typical Film of about seven units drains about two Films per tick, which is close to C1's bound; the dated estimate of about 280 admissions per day (and C1's 48 per day) are estimates, not guarantees. Intake's advantage over 1B is **no upstream request and no upstream deadline**, not a proven drain rate. Before activation the dormant unit records per-tick wall time, statements, units and Films, and activation requires a measured capacity above the observed admission rate with margin; otherwise the cadence or the unit budget is its own owner decision. Nothing here is a Free-plan ceiling (Workers Paid baseline); these are measurements, not gates by themselves.

### 7. Delivery graph (no card is created by this ADR)

1. **I1a: observation contract code (offline, dormant):** the builder from the verified response, the projection and digest, Discovery writes the observation in the admission batch family, revalidation publishes after a verified detail; the migration file for `discovery_tmdb_observation`. Old-version compatibility: old code ignores the table.
2. **I1b: apply the I1 schema** (separate owner operation with readback; validates old-code compatibility).
3. **I2a: intake unit, state, cursor and control (offline, dormant):** the migration file, units registered, fences, tests, measurement hooks.
4. **I2b: apply the I2 schema** (separate owner operation).
5. **A1: activation of the stream:** only after delivered AIR-607 and AIR-636 natural acceptance, AIR-662 delivered, both schemas applied and dormant/old-version compatibility validated, measured capacity (decision 6) and the trigger and schedule gate; owner GO, readback and natural acceptance in `Верификация`.
6. **HA: acquisition for history** (decision 8): its own decision, never part of A1.
7. **H3: historical Russian localization** is separately designed and authorized acquisition if wanted. A typed translation selection (decision 1) fixes only the future.

No temporary flag, schedule or Task is introduced without its own gate.

### 8. History: a trade-off outside choices 1 to 4

Historical payloads are not observations (decision 1), so under the accepted ADR 0214 they cannot become `automatic` provenance. The recommended direction therefore writes **only Films that have a stored observation**: the future stream, and any historic Film whose detail Discovery verifies again (a revalidation now publishes an observation). The rest stay class `no_observation`, counted, served from the payload, and not written.

**Trade-off for the owner, separate from choices 1 to 4:**
- **T1-a (default, nothing proposed):** history waits for observations. No legacy adoption, no change of any accepted rule. A bounded acquisition (HA) is a later decision, because it needs TMDB budget or a rule.
- **T1-b (a candidate, not part of this decision):** a bounded legacy adoption that fills **blank** fields only, from payload fields TMDB-derived by construction (`runtime`, `genres`, `url`, credit ids), as `unknown`-confidence values with no field row and no time claim, never replacing, never `year`, `synopsis` or `poster`. It would write values that no observation proves and would be the first such rule since ADR 0214, so it needs its own owner decision and probably its own record.

Because T1-a defers history, selecting 3B ("all at activation") needs T1-b first.

## Open choices

### Choice 1. Who fills canonical metadata and credits of a Discovery-only Film

| Option | What it means | Benefits | Drawbacks |
| --- | --- | --- | --- |
| **1A** Retain minimal + payload serving | No canonical write; readers add a Discovery section | zero writes and no new producer | canonical stays incomplete for about 12 000 Films; every non-Discovery reader depends on Discovery; a superseded admission loses its data; no refresh owner; contradicts "canonical is the authority" |
| **1B** Extend C1 (ADR 0211) to Discovery admissions | C1 fetches TMDB (and Letterboxd when anchored) per Film | one producer; fresh data; full ADR 0211/0214 contracts | at C1's bound (2 Films per hourly tick) a stream of about 280 per day never drains and the backlog takes years; raising the bound is its own decision and adds TMDB pressure for data Discovery already fetched |
| **1C** Discovery stores a versioned observation; a bounded intake applies it (recommended) | decisions 1 to 8 | no upstream request; reuses every accepted writer protection; C1 stays the only fetcher; one owner per part by disjoint scopes | a second automatic filler of `film_metadata` (disjoint from C1 by decision 2); changes Discovery's revalidation to publish observations; new tables and a measured capacity gate; history is not covered without T1 |
| **1D** Widen `film_mutation` itself | write metadata and credits inside the admission batch | no second unit | breaks ADR 0134 decision 5 and the admission budget; one failure mode for admission and enrichment |

**Recommendation: 1C.** The data are already acquired under a verified identity, and re-fetching them (1B) spends the shared TMDB budget; 1A leaves the authority empty. The recommendation does not rest on a drain-rate claim (decision 6).

### Choice 2. Russian localization

| Option | What it means | Benefits | Drawbacks |
| --- | --- | --- | --- |
| **2A** Typed selection in the observation (recommended) | the deterministic `ru` translation selection of decision 1, written as the `tmdb` source row through the AIR-662 operation | no extra request; exact; ambiguous or missing writes nothing | history has no observation, so no Russian title until HA or H3 |
| **2B** C1 fetches translations for every Discovery Film | one TMDB request per Film | covers history | the 1B capacity problem for localization alone |
| **2C** Leave localization missing | — | nothing to build | the gap stays for all Discovery Films |

**Recommendation: 2A.** No title is derived from `movieTitles`, `aliases` or the response `title`.

### Choice 3. Cohorts and cutoff

| Option | What it means |
| --- | --- |
| **3A** Stream first (recommended) | `cutoff_seq` at activation; Films with an observation after it, plus any Film Discovery re-verifies, are applied. History without an observation (class 4) is a separate scope HA, never written from legacy payloads; H3 separate |
| **3B** Everything at activation | the stream plus the historic Films at once; requires T1-b first |
| **3C** Future only | class 4 stays on payload serving forever |

**Recommendation: 3A**, which separates the first natural acceptance of a new writer from any historical write, as ADR 0211 C3a/C3b and ADR 0214 PVE do.

### Choice 4. Refresh policy

| Option | What it means |
| --- | --- |
| **4A** Event-driven through ADR 0214 (recommended) | work reopens only on the triggers of decision 3 (a changed observation digest, a changed anchor, a lock release, an owner retry); the ADR 0214 rank decides replacement; C1's own triggers stay the only fetch-based refresh |
| **4B** Fill-only forever | intake fills blanks and never replaces; stale values wait for C1 or the owner |
| **4C** Periodic refresh | a window and sweep; this is the ADR 0214 PVT question and would pre-empt that card |

**Recommendation: 4A.** It reuses the accepted rank and costs nothing when nothing changes.

## Field, source, reader and writer matrix (recommended direction)

| Field | Source (observation) | Canonical target | Writer | Reader after intake | Rule |
| --- | --- | --- | --- | --- | --- |
| year, runtime, synopsis, poster, url, genres | core section (never EPG or retained values) | `film_metadata` + `film_metadata_field` | `writeFilmFacts` (intake) | ADR 0216 display section, fallback, `/api/d1/films` | fill, then the ADR 0214 rank; `absent` and `unreadable` write nothing |
| directors, actors | credits section, ≤ 20 and ≤ 10, valid ids | `person`, `film_person_credit` | Person and credit units | `PAGE_CREDIT_SQL`, fallback | add-only within one namespace; `superseded_credits` on correction |
| Russian title | translation selection | `film_localization_source` (`tmdb`) + effective projection | AIR-662 operation | effective localization (ADR 0218 decision 3) | existing resolver; ambiguous writes nothing |
| `title`, `original`, `aliases`, `movieTitles`, `shows` | — | not written | — | Discovery only | `original_title` stays ADR 0120 |
| `canonical_identity`, claims, aliases | — | not written | — | — | identity stays claim-based |
| processing dimensions, `metadata_at` | — | not written | — | — | ADR 0218; ADR 0211 clocks |

## Alternatives considered

Listed per choice above, and in decision 8 (T1-a, T1-b). Not offered:
- **Payload intake inside C1:** C1's per-tick bound and lease are sized for upstream fetches; it would keep the capacity problem or need two C1 modes.
- **Parsing a Russian title from `movieTitles`:** rejected; the languages share a script and the card forbids title guessing.
- **A new `origin` value:** deferred to a PV1 coordination (decision 5); a CHECK rebuild here is avoided.

## Examples

- **Stream Film.** `tmdb_123` is admitted at 10:00 with an observation (`seq` 4001, year 2004, runtime 101, six core fields, 2 directors, 10 actors, translation `ru` "Пример"). The Film is in scope (no Letterboxd anchor, not rated or Watchlist). Intake writes six fields (`origin='catalog_enrichment'`, `write_key` `intake:…`, `observed_at` 10:00), the missing Persons and credits, and one `tmdb` localization source through the AIR-662 operation.
- **Poster-only change.** `POSTER_UPDATE_SQL` fills the poster of an admission: the serving payload changes, **no observation is written**, no work reopens.
- **EPG touch.** An airing adds an alias and a show: the payload changes, the observation digest is unchanged, nothing reopens.
- **Unchanged-title reconfirmation.** A revalidation verifies the detail with no new alias: an observation is now published; an identical digest keeps `seq`, a runtime change moves it and reopens `core`.
- **A Film that gets rated.** A `film_rated_admission` row appears: the next intake batch fails its scope guard and records `handed_to_catalog_enrichment`; C1 owns it.
- **Identity correction.** The trusted claim moves from `tmdb:5` to `tmdb:6`: the anchor digest changes, intake's old credits are held as `superseded_credits`, and the unit applies only an observation of `tmdb:6`.

## Synthetic test plan (for I1a and I2a)

- **Observation:** source contamination (EPG `year`/`description` fallback, retained poster, `POSTER_UPDATE_SQL`, alias and availability changes never enter it); the digest is stable across `observed_at`; translation selection (single `ru`, several with `RU`, ambiguous, absent, unreadable); credits bounds (20/10, truncation gap, invalid ids dropped); revalidation publishes only after a verified detail and never on failure; no extra network request.
- **Old payload:** a legacy payload yields no observation and class `no_observation`; `discoveredAt` is never an observation time.
- **Scope:** C1 due, failed, disagreeing, paused and newly eligible Films are excluded; a newly added lid and a rated or Watchlist Film hand off; overlapping plans; a Film leaving scope between plan and commit fails the guard.
- **Agreement and rank:** a Letterboxd anchor added between plan and commit; the fallback never grants intake; confidence before source; only `confirmed` replaces a different value; `hold` fills only; owner pin, dimension lock and reviewed localization untouched; no clear.
- **Credits:** one namespace, both namespaces, existing EPG or C1 credits, missing Persons, `superseded_credits`, a stale plan refused at the Person unit.
- **Classification and coverage:** the six classes are exhaustive and disjoint; an alias-only Film; partial metadata; a superseded admission; per-part outcomes `present`, `absent`, `unknown`, `gap`, `blocked`; no full-coverage claim after partial success; absent versus unreadable.
- **Refresh:** a no-op repeat; a changed anchor with an unchanged digest reopens; real `seq` movement; a lock release; no time-based reopen.
- **Delivery:** lost response per unit kind; a changed source with an unresolved receipt; reconcile-before-reserve; a stale lease, pause, takeover, deadline, digest movement and marker movement are not strikes; cursor drain loses no event between the admission batch and intake and does not starve older work.
- **Localization:** the AIR-662 receipt and owner-review fence; `ambiguous` writes nothing; the effective projection equals the resolver output on the rows read back.

## Consequences

- Canonical D1 becomes complete for Discovery Films that have an observation, with no new upstream load; the ADR 0216 aggregate and fallback stop losing their data.
- Discovery gains an observation table and a revalidation write; two new schemas (I1, I2) with two owner apply operations.
- One more automatic writer of `film_metadata`, kept disjoint from C1 by explicit scopes and fenced in every batch.
- History is not covered by this record (decision 8); the payload keeps serving it.
- Capacity is a measured activation gate, not a claim.

## Recovery and migration boundary

This record authorizes nothing: no migration file apply, no control row change, no scope, no schedule, no production write, no Discovery, TMDB or sync run. Each step of the delivery graph has its own gate. Code rollback does not remove stored observations or written values; correction is through the ADR 0214 owner route or a forward write. Old code ignores the new tables.

## Evidence

- **Original decision:** pending owner selections on [AIR-655](https://trello.com/c/YIPK38Tg).
- **Implementation:** none.
- **Dated verification:** the AIR-627 census of 25 Nov 2026 (L0, `rows_written=0`), linked in Context; the code references in Context were read statically on `main` `7d8d4b3`.
- **Uncertainty:** the admission rate (a dated estimate); the share of TMDB entries with a `ru` translation or credits beyond the caps; the per-Film statement counts (estimates); how many historic Films will be re-verified by Discovery and so receive an observation; whether the single writer accepts a second declared caller with `origin='catalog_enrichment'` (to be verified in I2).

## Follow-ups

I1a, I1b, I2a, I2b, A1, HA and H3 as in decision 7, each its own card. The stale statements found by AIR-627 (`docs/architecture/film-person-lifecycle.md` on `writeFilmFacts` writing dimensions from wired producers; `docs/reference/domain/film-person.md` on Discovery metadata) are corrected in I2a.

Documentation impact of the implementation cards: `docs/architecture/film-person-lifecycle.md`, `docs/architecture/discovery-and-resolution.md`, `docs/reference/domain/film-person.md`, `docs/reference/data/d1-schema.md`, `docs/reference/scheduled-tasks.md` or `docs/architecture/scheduling-and-orchestration.md` (the trigger), the producer, state and receipt contracts, the Discovery and producer runbooks, and the migration registry. No Mermaid change is made by this record.
