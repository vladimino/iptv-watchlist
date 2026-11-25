# ADR 0219: Discovery-only Films get canonical metadata, credits and localization from a versioned TMDB observation that Discovery stores, applied by a bounded intake under the existing single-writer rules

**Status:** Proposed  
**Original decision date:** not decided  
**Recorded at:** 2026-11-25, from `main` `7d8d4b3`; revised after the [first independent review](https://github.com/vladimino/iptv-watchlist/pull/1005#issuecomment-7168898942) of `d184a9e` and the [second independent review](https://github.com/vladimino/iptv-watchlist/pull/1005#issuecomment-7169971080) of `4f88e5c`  
**Approval source:** not documented (awaiting an ADR-specific Product Owner decision on each open choice below)  
**Related work:** [AIR-655](https://trello.com/c/YIPK38Tg). Native prerequisite [AIR-644](https://trello.com/c/nFBGvvnU) ([ADR 0218](0218-film-lifecycle-dimensions-revision.md), Accepted). Builds on Accepted [ADR 0134](0134-discovery-admission-producer-wiring.md), [ADR 0155](0155-retire-enrichment-projector-cron.md), [ADR 0207](0207-letterboxd-admissions-coordinated-in-d1-only.md), [ADR 0211](0211-catalog-enrichment-producer.md), [ADR 0214](0214-film-metadata-per-field-provenance.md), [ADR 0216](0216-canonical-film-lifecycle-and-unified-read-contract.md) and [ADR 0218](0218-film-lifecycle-dimensions-revision.md). Evidence: the [AIR-627 census continuation](https://trello.com/c/IOERZ9GI#comment-6b06a0deb3fbeaeb5f93f8b2) and its [disposition](https://trello.com/c/IOERZ9GI#comment-6b06d8c178a1d27ed10c4e8f). Coordinated with, and not extending, [AIR-614](https://trello.com/c/wUHl13Yw), [AIR-615](https://trello.com/c/fCXSmk7K), AIR-600 (the receipt `operation_key`, migration `0039`), PV1 [AIR-631](https://trello.com/c/i8td3wu0), PVE [AIR-636](https://trello.com/c/0jJADYxg), AIR-662 (projection-aware localization write, ADR 0218 decision 3) and the Accepted source-independent admission record of [AIR-643](https://trello.com/c/e1Q9H1bG) ([ADR 0217](0217-source-independent-film-admission.md), [PR #996](https://github.com/vladimino/iptv-watchlist/pull/996)), which this record neither extends nor depends on for its own scope.  
**Supersedes:** None. This record does **not** amend ADR 0214 (decision 5)  
**Superseded by:** None

## Context

### What exists (main `7d8d4b3`, 25 Nov 2026)

- **The only canonical writer for a Discovery Film is minimal by design.** Since the projector was retired ([ADR 0155](0155-retire-enrichment-projector-cron.md)), a Discovery admission reaches canonical state only through the `film_mutation` unit of [ADR 0134](0134-discovery-admission-producer-wiring.md) decision 5 (`src/canonical-discovery-admission-producer.js`): the Film, the trusted `tmdb` claim and a title written only when blank. It never writes `film_metadata`, credits, Persons, aliases, localization or `canonical_identity`.
- **Every richer writer is bounded to another cohort.** EPG `film_facts` and credits target Watchlist Films only (`src/canonical-producer-workflow.js`); `metadata_sync` is Watchlist only; the dictionary covers its entries; the ADR 0211 catalog-enrichment producer (C1, not yet delivered) is scoped to the **activated** scope of ADR 0211 decision 4 (initially `film_rated_admission.verified_at >= cutoff_at`; widenings C3a and C3b are separate decisions). AIR-614 and AIR-615 widen C1 to rated and Watchlist cohorts, not to Discovery-only Films.
- **Fetchers.** Discovery is already a TMDB fetcher: its verified detail response (`movie/<id>?language=ru-RU&append_to_response=credits,translations,alternative_titles`) is the source of its payload. C1 is the *catalog-enrichment* fetcher (Letterboxd, TMDB, Wikidata). Neither is replaced here.
- **The Discovery payload is a mixed serving record, not a TMDB observation.** `discovery_admission.payload_json`:
  - some fields are TMDB by construction: `runtime`, `genres`, `url` (built from the id), `directors` and `actors` (capped at ten each, ids `tmdb_director/<id>`, `tmdb_actor/<id>`);
  - `year` and `synopsis` fall back to the EPG candidate (`candidate.year`, `candidate.description`) when TMDB has none (`src/discovery.js:352`);
  - `poster` can be kept from an earlier payload by the admission conflict clause or filled later by `POSTER_UPDATE_SQL` (`src/discovery-authority.js`);
  - `aliases` and `shows` change on every EPG touch without a TMDB request; `movieTitles` mixes languages;
  - a revalidation (`revalidateDrift`) re-fetches the detail but only appends missing authority titles; `discoveredAt` is kept;
  - there is **no observation time** of the TMDB response.
- **Serving already uses the payload.** The Film page and Finds read title, year, runtime, genres, poster and credits from it. Data are lost only on the canonical fallback (`catalogCanonicalFilmFromD1`), in `/api/d1/films` and in any reader of canonical state (ADR 0216).
- **The `discovery_admission` key is the Discovery key** (`tmdb_<n>`), not `film.id`. It reaches a Film only through the trusted `tmdb` claim.

### Census (AIR-627, L0, dated 25 Nov 2026, main `681b5c1`, Film/Person g2, EPG P519)

Dated aggregates, not live counts and not guarantees. The **eligible historical counts are not known**: the census does not say how many Films miss each field, and a Film may miss only some. What it does show:

| Group | Size | Canonical state | Serving payload presence (not proof of source) |
| --- | --- | --- | --- |
| Minimal Discovery Films (since 16 Nov, `film_mutation` only) | 2 525; 1 213 airing in P519 | no `film_metadata`, credits, aliases, dimensions; `canonical_identity` NULL | year/runtime 2 525, synopsis 2 524, genres 2 524, actors 2 523, directors 2 519, poster 2 517 |
| Projector-era Discovery Films | 9 730 | **have** projector credits and aliases; `film_dimension` copies; `film_metadata` rows exist for only 414 Films in the whole catalog, so most lack core metadata | about 99.5 % |
| Future admissions | about 2 525 in about 9 days (a dated estimate) | as the minimal group | — |
| Rated (714; 473 with metadata missing) and Watchlist (391) | — | owned by C1 / AIR-614 / AIR-615 | out of scope |

So the gap differs by group: minimal Films miss everything; projector-era Films mostly miss core metadata and a Russian title but keep credits. No Discovery Film has a Russian title in canonical state. `canonical_identity` NULL is not a proof of missing identity: each of these Films holds a trusted, non-conflicting `tmdb` claim.

### The problem

Canonical Film/Person D1 is the authority (ADR 0216), but for Discovery Films it holds an id, a claim and a title, and for the minimal group nothing else. Readers that do not go through Discovery lose year, runtime, synopsis, poster, genres, credits and every Russian title, and nobody owns refresh. The serving payload cannot simply be copied: it does not say which values are TMDB, when they were observed or whether they are complete.

### Settled decisions this record keeps

- `film_mutation` stays minimal (ADR 0134 decision 5). This record adds separate units.
- After intake the canonical row is the authority; the Discovery payload stays Discovery's own serving record.
- **ADR 0218** keeps a `film_dimension` row only for: an applied owner or reviewed decision, the ADR 0214 metadata lock, `titleSource`, and the **effective-localization projection kept for read cost**. Identity, metadata, fingerprint and prediction rows are otherwise copies and are neither written nor read for decisions here. The lock predicate (`status='reviewed' OR authority='owner'`) and `titleSource` are respected.
- `writeFilmFacts` is the single metadata writer; the ADR 0214 rules (rank, locks, hold, history) and the ADR 0211 rules (anchors, agreement, credits namespace, expected set, write intent, epochs) apply unchanged. This record adds no precedence, identity or provenance rule and does **not amend ADR 0214**.
- Identity is never inferred from a title or a year. Nothing here creates, merges, redirects or retires a Film, or writes a claim, alias or `canonical_identity`.
- Mass enrichment waits for delivered and naturally accepted C1 ([AIR-607](https://trello.com/c/Daq02gYy)) and ADR 0214 `enforce` ([AIR-636](https://trello.com/c/0jJADYxg)); this gates activation, not this design.

## Decision

**Common contract.** Decisions 1–9 are the technical contract of the recommended direction (1C, 2A, 3A, 4A). They resolve defects, not owner choices. The owner choices follow in "Open choices"; a different selection removes only the decisions that depend on it.

### 1. A versioned TMDB observation, published by Discovery on every verified detail

Discovery stores one **TMDB observation** per movie id, in its own row, built **only** from a verified detail response, never from the serving payload.

**Storage.** Table `discovery_tmdb_observation`, keyed by `tmdb_id`, columns:
- `observation_version` (starts at 1);
- `observed_at`: the time the verified response was received, set by the code that received it;
- `seq`: a strictly increasing integer taken from a **durable high-water row** (`discovery_observation_seq(id=1, seq_epoch, high_water)`), incremented in the same fenced batch as the observation write. It is not `MAX(seq)`, so a deletion cannot make it regress, and a gap (a bump whose observation write was refused) is allowed, never a reuse. The published token is the pair **`(seq_epoch, seq)`**, compared lexicographically by every guard and by the intake cursor. A restore of the observation or high-water tables is an owner L3 operation that **must raise `seq_epoch`**, so a restored lower `high_water` can never reissue a token that was already published, **even when the intake cursor lags behind**; publication also asserts `high_water >= (SELECT MAX(seq) FROM discovery_tmdb_observation)` for the current epoch, and intake refuses with `seq_regressed` whenever its cursor token is above the current token;
- `digest`: 64 hex characters of the canonical JSON of the semantic body (decision below), computed in application code (D1 offers no guaranteed SQL hash). Guards compare stored `(seq, digest)` by equality;
- `body_json`: the bounded semantic body.

**Semantic body** (`observed_at` and `seq` excluded from the digest):
- **core**: `year` (from `release_date` only), `runtime`, `synopsis` (ru-RU overview), `poster` (`poster_path` URL), `url`, `genres` (ru-RU names). Each is `value`, `absent` (a complete response without it; a blank string is absent) or `unreadable` (wrong type). EPG fallbacks, a retained or later-updated poster, aliases and availability **never** enter the observation;
- **credits**: `directors` and `actors` from the response's `credits` section in source order, each with a validated positive-integer person id and name, bounded to the C1 limits (**at most 20 directors, 10 actors**, ADR 0211 decision 3), with `directors_total`, `actors_total` and the gap `directors_truncated`. A missing `credits` section is `unreadable`; a present empty one is `absent`;
- **translations**: a deterministic selection of the Russian title from entries with `iso_639_1 = 'ru'`: one distinct non-blank title is `value`; several are decided by `iso_3166_1 = 'RU'`, and if still different the selection is `ambiguous` and nothing is written; no `ru` entry is `absent`; a missing or malformed section is `unreadable`. The response `title` is not a Russian title;
- **section presence** per `core`, `credits`, `translations`.

**Occurrence versus content.** The **digest** says whether the content changed; the **occurrence** (`observed_at`, `seq`) says that a verified detail saw it at that time. Every verified detail publishes: an unchanged digest still moves `observed_at` and `seq`, because under ADR 0214 decision 3 the same data seen later is a newer observation of the same rank (`observed_at` is the third rank component) and can outrank an intervening automatic value; keeping the first `observed_at` forever would not be rank-based refresh. The cost is one row write per verified detail, which Discovery already performs at its own bounded rate; no extra request is implied.

**When it is published.** Only after a **successful verified detail**, and **atomically with the actual verified source write**: the observation upsert and the high-water bump are statements of the same fenced batch as the admission upsert (or, for a revalidation that writes no admission, of one batch that carries its own fence), under the same authority guard as that upsert: the Discovery lease, `discovery_transfer.state <> 'loading'` and the marker route (`ADMISSION_FENCE_SQL`), **plus the observation-control row `mode='on'` and its `revision`** asserted in the batch. **An older response never replaces a newer one:** the upsert carries `WHERE excluded.observed_at > discovery_tmdb_observation.observed_at` (equal times and the same digest are a no-op), so out-of-order completion of two details of one movie keeps the later response, and the batch's change count is asserted so a refused upsert does not move the token. Sites: a new admission (the build at `src/discovery.js:352` and its two sibling builds) and a **revalidation** whose detail is verified, **even when no alias is missing** (today it writes nothing then). A failed, unverified or skipped detail writes nothing.

**Unique current mapping.** An observation maps to a Film only when exactly one `discovery_admission` row is `state='current'` for `media_kind='movie'` and the `tmdb_id`, and the id resolves through exactly one trusted, non-conflicting `tmdb` claim, not retired and not a redirect source. The batches of decision 4 assert this with a count subquery. Anything else is an `unresolved_identity` disposition (decision 3), never a guess.

**Producer enablement and old versions.** Publishing is controlled by its own row (`discovery_observation_control`: `mode` `off`/`on`, `floor_seq`, `revision`), created `off`; enabling it is an owner production operation with readback (card I1c), done only after the version that publishes is deployed. `floor_seq` is the `high_water` at enablement. A Film whose detail was verified only by an older Worker version has no observation; it is counted as class 4 (decision 3), not lost, and enters when Discovery next verifies it. The producer is independent of intake: observations accumulate dormant.

**Old payloads.** Historical payload values are not observations. Inventory (static, to be re-verified by fixture):

| Payload field | By construction | Proof |
| --- | --- | --- |
| `runtime`, `genres`, `url`, `directors`, `actors` | built from `movie` | TMDB-derived, time unknown, credits capped at ten each |
| `year`, `synopsis` | `movie` value **or** EPG fallback | unprovable |
| `poster` | TMDB URL, possibly retained or updated by another path | unprovable as to time and path |
| `aliases`, `movieTitles`, `shows` | mixed | not metadata |

`discoveredAt` is never an observation time, including on a legacy refetch. See decision 8.

### 2. One owner per part: explicit scopes, persisted dispositions, fences in every batch

**Parts** are `core` (`film_metadata` and its field rows), `credits` (Persons and credits) and `localization` (the `tmdb` source row and the effective projection). Intake owns a part of a Film only while the Film's **persisted disposition** is `intake`.

**Dispositions** (persisted **per Film** in the Film-scoped authority `discovery_intake_film` of decision 3, with the evidence and time, shared by every source item that resolves to that Film):
- `intake`: in the intake scope, below;
- `owned_by_c1`: actually in C1's **activated** scope, proven by C1's own state (its control `mode`, its scope and `cutoff_at`, its Film state row, and, for Watchlist Films, the source membership of ADR 0216, not the `watchlist_film` projection alone). Never inferred from a lid, a retention row or a rated record;
- `held_unowned`: excluded from intake conservatively but **not** in any activated C1 scope. Exclusion is safe; labeling such a Film as handed to C1 would strand it outside both domains, so it is recorded as held, with its reason (`letterboxd_anchor`, `rated_outside_c1_scope`, `retention`, `watchlist_projection`, `epg_target`, `c1_state_present`) and counted;
- `unresolved`, `superseded`: decision 3.

**Intake scope (evaluated at plan and asserted in each batch):** the Film exists and is not a redirect source; it has the unique current mapping of decision 1; and **none** of: a trusted `letterboxd` claim; a C1 state row of any state; a `film_rated_admission`, `film_retention` or `watchlist_film` row; an EPG-chain target. The eligibility rule is **conservative where coverage is unknown** (decision 3): each exclusion source must return a verdict `absent_with_coverage` under its own contract; an unreadable, lagging or verdict-less source is `unknown_coverage` and the Film is `held_unowned` (`coverage_unknown`), never written and never read as eligible or as a negative. A missing `watchlist_film` projection is **not** a negative Watchlist membership (ADR 0216: `no_verified_alias` is not a negative), and no global proof of real-world non-membership is required or possible.

**Re-entry is excluded by policy and persisted.** Once a Film leaves `intake` (to `owned_by_c1` or `held_unowned`), the exclusion is stored on its Film row and intake never writes it again, whatever the live predicate later says; only an explicit owner `reopen` can return it. This prevents oscillation between two writers. A held Film is disposed of by the card that owns its domain (AIR-614, AIR-615, a C1 widening) or by HA (decision 8); this record neither solves nor hides that cohort.

**Handoff in both directions.** On `owned_by_c1`, intake writes its attribution (decision 4) and any `superseded_credits` hold to the Film row's handoff record. The C1 side is a **real prerequisite** (decision 7, card IH), enforced inside C1's own batches and not by an informal read; the guard and the ordering that make the handoff safe on both sides before any recheck are in decision 4. In the other direction, C1's own pre-existing credits and `film_json` write intent are read by intake's namespace and attribution guards; a Film with any C1 state row is never `intake`.

**Agreement.** Intake relies only on the `tmdb` anchor. A Letterboxd anchor excludes the Film, so the writer's derived agreement is `not_required` and the ADR 0214 confidence `confirmed`. Intake never uses the `unconfirmed` rank as permission and never invokes the ADR 0211 transport-only fallback. A known disagreement, or a Letterboxd anchor added between plan and commit, fails the anchor-digest assertion (ADR 0214 decision 4) and moves the Film to `held_unowned`.

**Precedence.** With only a TMDB anchor, only the `tmdb` source applies. The ADR 0214 rank applies unchanged: confidence first, then source order, then `observed_at`, then `value_digest`; **only a `confirmed` observation replaces a different value** (ADR 0214 decision 8); `unknown` legacy values are replaced only by such an observation; an `owner` value, a pinned field or a dimension-locked Film is never touched; in `hold` mode intake only fills and adopts; no automatic clear exists.

**Credits.** The ADR 0211 one-namespace rule applies: intake's namespace is `tmdb_actor/<id>`, `tmdb_director/<id>`. A Film that already has credits in the other namespace (for example `actor/<slug>`, from the EPG chain or C1) gets none and records `credits_other_namespace`; credits in both namespaces get none; credits only in the TMDB namespace get only the missing ones. The expected set (≤ 20 directors, 10 actors) is stored. Only entries with a valid person id are written.

**Localization.** Intake writes only its own `tmdb` `film_localization_source` row, through the AIR-662 projection-aware operation (a new receipt kind and digest, the effective projection recomputed in the same batch, the Film revision CAS **and** the owner-review authority and content token, ADR 0218 decision 3). It writes nothing when the selection is `absent`, `ambiguous` or `unreadable` (a recorded gap). The existing resolver chooses the effective title; reviewed and owner rows win.

**No sync clocks.** Intake never sets `film_sync_state.metadata_at` or any C1 clock from observation presence.

### 3. Resolution, reopening and coverage

**Two durable authorities, by scope.**
- `discovery_intake_film(film_id PRIMARY KEY, disposition, exclusion_reason, exclusion_evidence_json, plan_epoch, anchor_digest, hold_json, handoff_json, updated_at)` is the **Film-scoped authority** for the disposition, the persisted exclusion, the Film `plan_epoch`, credit holds and the handoff. Its rows are never deleted. A `film_redirect` source's row is read through the redirect and **merged monotonically into the survivor** (any exclusion and any hold on either side persists), so a second `tmdb_id` that resolves to the same Film shares the same exclusion and hold and cannot bypass an owner `reopen` or a credit hold. Credit attribution (decision 4) is Film-scoped in the same way.
- `discovery_intake_item(tmdb_id PRIMARY KEY, film_id, state, previous_film_id, resolved_anchor_digest, last_seq, recheck_at, reason, updated_at)` is the **source-scoped** record, one row per `tmdb_id`, never deleted. `state` is `unresolved`, `resolved`, `superseded_admission` or `superseded_mapping`. On a remap its `film_id` changes only after the reconciliation of decision 4, `previous_film_id` keeps the old identity, and a superseded mapping stays as history. The disposition is **not** duplicated here. An index on `(state, recheck_at)`.

**The cursor advances only after durable disposition.** `discovery_intake_cursor(seq_epoch, applied_through_seq)` moves in the **same batch** that writes the item row of every selected observation (including `unresolved` and `superseded_admission`), with a compare-and-set on the cursor value read. It reads `WHERE (seq_epoch, seq) > cursor ORDER BY seq_epoch, seq LIMIT N` through the `seq` index; no payload is loaded or scanned.

**Reopening beyond a new observation is event-driven plus a bounded indexed recheck.** A seq cursor only finds new occurrences, so every other trigger has its own path:

| Trigger | How intake finds it | Bound |
| --- | --- | --- |
| a new occurrence (same or changed digest) | the `seq` cursor | `N` per tick |
| a previously `unresolved` identity (no Film yet, an ambiguous admission, a retired or conflicting claim) | `recheck_at` index over `state='unresolved'`; re-resolution through the claim and the unique current mapping | `M` per tick |
| an anchor, claim, retirement or redirect change (a remap) | each canonical batch asserts the whole anchor set; the recheck compares `resolved_anchor_digest`; a mismatch starts the **remap procedure** of decision 4 (reconcile first, then invalidate, replan or hold) | `M` per tick |
| a lock release, a reviewed-localization change, an owner `retry` or `reopen` | the owner routes set `recheck_at = now` (an owner action is the event); otherwise the periodic recheck finds it | `M` per tick |
| a C1 or other exclusion signal appearing | the live exclusion predicates in every batch fail it at once; the recheck then persists the exclusion | `M` per tick |
| a failed unit's retry | `retry_at` on the part state (D1 only, never an upstream request) | per unit |

The recheck is a **re-evaluation of eligibility from D1**, ordered by `recheck_at` with a `LIMIT` over an index, not a scan and not an upstream refresh. **Fairness and latency are a function of the population and of the budget, not of an interval alone:** with `P` items in a rechecked state, `M` rechecks per tick and a tick every `T`, the worst-case latency of a full cycle is `ceil(P / M) × T` (for example `P` = 12 000, `M` = 50, hourly: 240 ticks, ten days; `M` = 500: 24 ticks). After a recheck an item's `recheck_at` moves forward, so every item is reached in order and none starves; owner events bypass the cycle through `recheck_at = now`. Due parts have their own index `(state, due_since)` and their own per-tick bound `U` units. The total per tick is bounded by `N + M + U` units of work, and `N`, `M`, `U` and the cadence are set by the dormant measurement of decision 6, not here. **Films with no observation have no item row, are never rechecked, and are not part of the cursor path**: their census is a separate bounded measurement (decision 8), and they become items when an observation is published.

**State machine with explicit fences.** Each transition has its own prior-state and source fences. None of them grants a canonical write to an excluded Film, and a persisted disposition is **eligibility state**, distinct from the live **eligibility evidence** (decision 4's guard matrix reads both).

| Transition | Asserts | Writes |
| --- | --- | --- |
| **ingest** (cursor drain; first insert of an `unresolved` or `superseded_admission` item) | lease; observation-control mode and revision; the cursor value read; the selected observations still equal their `(seq_epoch, seq, digest)`; for a first insert, `NOT EXISTS` item (insert-only) | item rows, cursor |
| **resolve** (`unresolved` → `resolved`) | the item's prior `state` and `updated_at`; lease; control; the unique current mapping and the anchor set as read; the Film row's prior `plan_epoch` (or its absence) | the item's `film_id`; the Film row (insert, or monotonic merge of exclusions); disposition from the live evidence |
| **exclude** (`intake` → `held_unowned` or `owned_by_c1`, including `coverage_unknown`) | the prior disposition `intake` and the Film `plan_epoch`; lease | the disposition, the exclusion evidence, `plan_epoch + 1` (every older plan then fails) |
| **reopen** (`held_unowned` or `owned_by_c1` → `intake`) | an owner action only (an owner-route token); the prior disposition; **no unsettled attempt, no `attribution_owed` and no hold** | the disposition, `plan_epoch + 1`; never clears a hold or attribution |
| **attempt, settle** | lease; the part's `attempt_id` and `refresh_epoch`; for a settle, the intent row `owed` and its receipt terminal (decision 4) | the part state, the intent state |
| **remap** | decision 4 | decision 4 |

**Conservative policy when source coverage is unknown.** Eligibility needs, from **each** exclusion source, a verdict `absent_with_coverage` under that source's own contract. A source that is unreadable, lagging or without a coverage verdict gives `unknown_coverage`, and the Film is persisted as `held_unowned` (`coverage_unknown`) and rechecked; **unknown is never read as eligible and never as a negative**. In particular a missing `watchlist_film` projection is not a Watchlist non-membership (ADR 0216: `no_verified_alias` is not a negative). No global proof of real-world non-membership is asked for or possible; only a coverage verdict per named source.

**Cutover.** `floor_seq` (decision 1) is the start of the stream. Intake applies **every** observation above `(seq_epoch, floor_seq)`, so observations published between producer enablement (I1c) and activation (A1) are not stranded, and a same-digest re-observation after activation is a new `seq` handled like any other. There is no separate cutoff that would drop that cohort.

**No-op rule, with the actual comparison.** For each field the single writer plans from the stored value and field row against the observation: **fill** (blank), **adopt** (equal value with an older or no field row: the row takes the newer `observed_at`), **replace** (different value and the observation outranks per ADR 0214), **keep** (the stored value outranks or is locked), or **no-op** (equal value and a field row already at least as recent). A no-op issues no statement and **no receipt is fabricated**; the part records `noop` with the compared tokens. Applied receipts stay as history.

**Classification of items** (a measured snapshot for evidence, ordered, exhaustive, disjoint, first match wins; the Film-scoped classes read the Film row):

| # | Class | Rule |
| --- | --- | --- |
| 1 | `superseded_admission` | the admission is not `current` |
| 2 | `unresolved_identity` | no Film, several Films, an ambiguous current admission, a conflicting or untrusted claim, a retired id or a redirect source |
| 3 | `owned_by_c1` | disposition of decision 2, with C1's evidence |
| 4 | `held_unowned` | disposition of decision 2, counted by reason (including `coverage_unknown`) |
| 5 | `no_observation` | in the intake scope, no stored observation (every historic Film at the start, and Films verified only by an old Worker version) |
| 6 | `observation_pending` | an observation is stored and its token is not yet applied or a part is `due` or failed |
| 7 | `processed` | the stored `(seq_epoch, seq, digest)` token is applied and every part has a recorded outcome |

**`processed` is processing, not coverage.** The cursor and the item state only say that work was done for a token. **Coverage is reported separately**, per part and per field, by an independent predicate over canonical state (ADR 0218's usable-value rules), with these outcomes: `canonical_present` (a usable value is stored, whatever its source, including an existing value preserved when the observation was blank); `observed_absent` (a complete response without it); `unknown` (unreadable, not yet applied or unresolved); `gap` (`directors_truncated`, `translation_ambiguous`, `credits_other_namespace`, `locked`); `blocked` (`superseded_credits`, `attribution_owed`, `held`, `history_exhausted`). No report claims that canonical D1 is complete because an observation exists, and a field never counts as covered from a processed cursor.

**Per-part state** mirrors ADR 0211 decision 3 and is **Film-keyed**, like the receipts and the guards: `discovery_intake_part(film_id, part, tmdb_id, state, refresh_epoch, source_version, expected_json, gaps_json, attempt_id, failures, retry_at, due_since, updated_at)`, `PRIMARY KEY (film_id, part)`, `part IN ('core','credits','localization')`, an index on `(state, due_since)`. `source_version` is the applied observation token. The exact owed work of an attempt is in an **immutable intent row** (decision 4), not in this mutable row.

### 4. Units, keys, receipts, attribution and fences

**Stable work identity.** The receipt `operation_key` names the **item**, not the observation, as in ADR 0207 decision 3 and `src/canonical-receipts.js` (AIR-600, schema 39): `intake:<film_id>:core`, `intake:<film_id>:credits`, `intake:<film_id>:localization`, and for a Person unit `intakeperson:<person_id>`. A changed observation therefore reconciles the unresolved receipts of the earlier one. The **attempt digest** (and the request id) binds what changes between plans: the observation token `(seq_epoch, seq, digest)`, the whole `anchor_digest`, the Film `plan_epoch`, the part's `refresh_epoch` and the intent.

**The 100-receipt budget is finite and visible.** A key holds at most 100 receipts (`OPERATION_KEY_HISTORY_CAP`), and every applied fill, adoption or replacement is a receipt. Repeated adoptions on repeated re-observations can therefore consume it over a Film's life; **no-ops write nothing and consume none**. At the cap a reservation is refused (`operation_key_history_exhausted`), the part becomes `needs_attention` with that reason, and the Film is reported as `blocked` (`history_exhausted`) in the coverage report and counted in the visibility counts as its own reason, never as `processed` or covered. **No cleanup and no key rotation is invented here**; the observed rate is a measurement of I2a and, if it approaches the cap, a separate owner decision.

**Immutable intent and owned attempt.** Before each unit the intake writes an **append-only intent row** `discovery_intake_intent(attempt_id PRIMARY KEY, film_id, tmdb_id, part, operation_key, request_id, observation_seq_epoch, observation_seq, observation_digest, anchor_digest, plan_epoch, refresh_epoch, owed_json, state, created_at)`, where `owed_json` is the exact set of fields, Persons or credits **absent at plan** that the unit will add (never what already existed), and `state` is `owed`, `settled` or `abandoned`. The mutable part row only points to its current `attempt_id`. An intent is never edited: a replacement abandons the old attempt first through the reconcile protocol, and the old receipt is looked up by the intent's **stored** `operation_key` and `request_id`, never recomputed from the current mapping.

**Terminal reconciliation with a post-effect fence.** After a lost response the reconcile protocol finds the unit's receipt by key, and the registered readback decides (`applied`, `not_applied`, `settle_by_request_id`, `content_present`, `reread_and_replan`). The **settle batch asserts**: the lease; the part's `attempt_id` and `refresh_epoch`; the intent row `state='owed'`; and the **attempt's own receipt row terminal** with `request_id` equal to the intent's. It does **not** use the free-key history-fingerprint predicate, which requires that no unresolved receipt exists and cannot hold while the attempt is pending; that predicate (`operationHistoryCondition`) is used only for **reservations** and for terminal outcomes that reserve nothing. A settle of an already-applied attempt records history **even when the Film has meanwhile been excluded, paused or its observation moved**; it grants no canonical write, and the actual applied subset is what the intent and the receipt prove, not what a newer plan would apply. `content_present` alone never creates attribution.

**Credit attribution is atomic or recoverable, and gates every next step.** A Film-scoped table `discovery_intake_credit(film_id, person_id, role, anchor_digest, observation_seq_epoch, observation_seq, attempt_id, request_id, applied_at)` is the authority for which credits intake added.
- **Atomic path.** The credits unit's canonical batch carries the attribution inserts in the **same batch** as the credit inserts: each attribution statement is guarded by `NOT EXISTS` of that credit and runs **before** the credit insert, so only a credit the batch actually adds is attributed and a pre-existing credit never is.
- **Recoverable path.** If a batch cap forces a split, the owed set is the immutable intent's `owed_json` (absent at plan) and the terminal receipt is the proof; the part is set to `attribution_owed`, and the attribution is completed from the intent and the receipt, never from `content_present` or from the current canonical content.
- **Gate.** While `attribution_owed`, `superseded_credits` or any hold exists on the Film row: **no new canonical mutation** of that Film runs, no handoff to C1 and no new cast is added. An anchor correction reads this table to hold `superseded_credits` (`needs_attention`, released only by the owner's retry), and a handoff carries it.

**Person units** are keyed by person and belong to a Film's credits attempt (the intent lists the Person ids and the `intakeperson:` request ids). They insert only absent Persons, with the absent-target guard (`NOT EXISTS` person) and the Person's revision when it exists, because another origin (the EPG chain, C1) may create the same Person concurrently; the loser is a no-op. A credits unit refuses a credit whose Person is missing (`film_person_reference`).

**The remap procedure.** On a changed mapping (a second `tmdb_id` resolving to the Film, a claim correction, a merge or redirect) the order is fixed:
1. detect it (the recheck, or a failed guard);
2. **reconcile every unsettled intent and receipt of the old identity**, including Person keys, under their stored keys and the post-effect fence above, until each is terminal;
3. only then invalidate and replan, or hold: raise the Film `plan_epoch`, move the item's `film_id` while keeping `previous_film_id`, hold `superseded_credits` from the attribution table when the anchor changed, and merge the Film rows monotonically on a redirect;
4. no new canonical mutation runs before steps 2 and 3 are durable.

**Guards in every canonical batch (Film core, localization, Person, credits).** Asserted inside the batch, not only at planning; each row names what it is:

| Guard | Kind | Asserted by |
| --- | --- | --- |
| the **exact active Film mapping**: exactly one `current` admission for the `tmdb_id`; the Film is not a redirect source | evidence | every canonical batch, **including Person** |
| the **whole current anchor set** of the Film (every `film_external_id` row, including competing, untrusted and retired ones, and the retirement decisions) equals the planned set, by count and by exact rows | evidence | every canonical batch, including Person |
| the **exclusion predicates**, live: no trusted `letterboxd` claim, no C1 state row, no `film_rated_admission`, `film_retention` or `watchlist_film` row, no EPG-chain target; and each source's coverage verdict is `absent_with_coverage` | evidence | every canonical batch, including Person |
| the persisted disposition is `intake`, with no persisted exclusion or hold | persisted state | every canonical batch, including Person |
| the Film `plan_epoch` equals the plan's | persisted state | every canonical batch, including Person |
| the part's `refresh_epoch`, `attempt_id` and the intent row `owed` | persisted state | every canonical batch, including Person |
| the intake lease `lease_id` and `lease_until` | runtime | every canonical batch, including Person |
| control row `mode='on'` and `revision` equal to the plan's | runtime | every canonical batch, including Person |
| the stored observation `(seq_epoch, seq, digest)` equality for the `tmdb_id` | source | every canonical batch, including Person |
| the Film/Person marker route and generation, the Discovery marker, `discovery_transfer.state <> 'loading'` | canonical | every canonical batch, including Person |
| the Film revision CAS | canonical | Film, credits, localization |
| credit namespace: no credit of another namespace | evidence | credits |
| metadata lock, owner pins, reviewed localization | evidence | core, localization |
| Person absent-target and revision | canonical | Person |
| AIR-662 fences: owner-review token | canonical | localization |

**State batches** assert only what their transition in decision 3 names (lease, control, part CAS, source and cursor equality), **not** `disposition='intake'`, so that an unresolved item can be inserted, a held or owned transition can be persisted, and an already-applied attempt can be settled after an exclusion.

A pause, a takeover, a deadline, a moved digest, a moved epoch or a marker movement fails the batch; the unit replans, and **none of these is a strike** (ADR 0128: three strikes only for the same unit, digest and class). A pause is effective for in-flight batches only through the control-revision guard.

**Handoff is safe on both sides before any recheck.** Writing the exclusion raises `plan_epoch`, and the live exclusion predicates fail every in-flight intake canonical batch **at once**, so no stale batch can commit after a C1, EPG, rated, retention or Watchlist signal appears. The C1 side is a **real prerequisite, not an informal read** (decision 7, card IH): before any C1 widening (C3a, C3b, AIR-614, AIR-615) can admit a Film that may have an intake row, C1's batch asserts that no intake attempt of that Film is unsettled, that no `attribution_owed` or hold exists, and that the Film row's disposition is `owned_by_c1`; the widening operation first performs the **exclude** transition for the Films it admits, so neither side can write the Film in between. C1 never writes a Film whose intake attempt is unsettled, and intake never writes a Film with any C1 state row.

**Events are not lost, and publication is ordered.** See decision 1: the observation row and its high-water bump are written atomically with the actual verified source write, and an older response never replaces a newer observation. The cursor advances only after the items are durable.

**Where and when it runs.** In its own step under its own lease (`projection_run`, `projection = 'discovery_intake'`), not inside `upsertAdmissions`, the EPG publication path or the hourly tick's critical work; it respects the ADR 0135 EPG pause windows. The **trigger** (cron tick, Workflow step or Task) is **not decided here**; it is part of the activation gate with its own owner approval, and no flag or schedule is authorized.

**Control and audit.** One control row (`mode` `off`/`on`/`paused`; `revision`; `updated_at`, `updated_by`), created `off`; each transition is an owner production operation with readback and raises `revision`; activation is not reachable from `/admin/settings`.

**Rollback.** Written values stay; there is no bulk delete. A wrong value is corrected by the ADR 0214 owner route or replaced by a later `confirmed` observation. A code revert is not a rollback of data.

### 5. Provenance and ADR 0214 (no amendment, with an explicit audit gate)

Intake's field rows are `tier='automatic'`, `source='tmdb'`, `origin='catalog_enrichment'`, anchor `tmdb=<n>`, the current `anchor_digest`, `agreement='not_required'`, `observed_at` the observation's real time, `write_key` prefixed `intake:`. The contract reads `origin` as an **audit column that is never compared** (ADR 0214 decision 2), and the acceptance counts of decision 13 come from the C1 tick outbox and the EPG producer outcome, not from the `origin` column, so reuse changes no accepted rank or count.

**Audit before implementation (I2a, blocking).** Static reading cannot prove that no reader classifies by `origin` or by the `write_key` prefix: the history reader, the owner view, the visibility counts and any report must be searched. If any does, intake needs a distinct value. That is an `origin` CHECK rebuild (history and trigger compatibility, rollback) and **an accepted-rule change to ADR 0214 and a PV1 change** (AIR-631): it is exposed to the owner as its own decision **before implementation**, not silently carried here. The single writer's acceptance of a second declared caller with that origin is checked in the same audit. If PV1's DDL has not been applied when I2a is accepted, a dedicated `origin` can be coordinated into PV1 first, as a PV1 decision.

### 6. Cost and capacity (counted, measurable while dormant)

D1 only; no TMDB, Letterboxd or Wikidata request. The accounting is C1's (ADR 0211 decision 5): each receipted unit is a reconcile read with the history fingerprint, a reservation batch, a fenced canonical batch and a state-settle batch.

| Unit | Per Film | Round trips per unit | Notes |
| --- | --- | --- | --- |
| core | 1 | 4 (reconcile+fingerprint read, reservation, fenced batch with up to 12 guards and up to seven writes, settle) | fill, adopt, replace and no-op differ in writes |
| localization | 1 (up to 3 in ADR 0211's accounting) | 4 | AIR-662 operation, source row plus projection |
| Person | 0 to 30 (one per missing Person) | 4 each | Person absent-target guard, plus Film, observation and scope guards |
| credits | 1 | 4 | up to 30 credit rows, namespace guard |
| item and cursor maintenance | per observation | 1 to 2 | drain batch, recheck |

A Film costs about **12 round trips at best and about 140 in the worst case** (core, localization, credits, all 30 Persons missing, plus maintenance), each carrying its guards, rows and state writes; the exact statements per batch, rows written and wall time are **measured**, not assumed. The unit budget per tick starts at C1's 12 units (core 1, localization up to 3, Persons per missing Person, credits 1), so a worst-case Film needs about three ticks and continues from canonical state.

**Cost is a hypothesis, and capacity is unproven and measurable while dormant.** The dated 280 admissions per day and C1's 48 per day are estimates, not guarantees; an hourly tick at 12 units drains about two typical Films, close to C1's own bound. Intake's advantage over 1B is **no upstream request and no upstream deadline**, not a proven drain rate. Capacity is measured **without a production canonical write**: in offline fixtures on the real migrated schema with representative recorded inputs (counts and shapes, no private rows), or in a **separately approved bounded shadow** that reads and plans without writing. Activation requires a measured capacity above the observed admission rate with margin, including the recheck budget; if capacity fails, the trigger, cadence or unit budget is a **separate owner approval**. These are measurements, not gates by themselves (Workers Paid baseline).

### 7. Delivery graph (no card is created by this ADR)

1. **I1a: observation contract (offline, dormant):** builder, projection and digest, the high-water row, `discovery_tmdb_observation` and its control, the publish on every verified detail, migration files. Old code ignores the tables.
2. **I1b: apply the I1 schema** (owner operation with readback; old-version compatibility validated).
3. **I1c: enable the observation producer** (owner operation with readback; records `floor_seq`; the publishing version is deployed first; old versions drain by simply not publishing).
4. **I2a: intake unit, items, parts, credit attribution, cursor, control (offline, dormant),** with the `origin` audit of decision 5, the capacity fixtures of decision 6 and the tests below.
5. **I2b: apply the I2 schema** (owner operation).
6. **IH: the intake-to-C1 handoff contract (offline, dormant, a prerequisite of any C1 widening that can admit a Film with an intake row):** C1's batches assert no unsettled intake attempt, no `attribution_owed` or hold, and disposition `owned_by_c1`; the widening operation performs the `exclude` transition first; delivered with or before I2a and before any C3a, C3b, AIR-614 or AIR-615 widening is activated.
7. **A1: activation of the stream:** only after AIR-607 and AIR-636 natural acceptance, **IH delivered**, **AIR-600 R1 (`operation_key`, migration `0039`) applied**, AIR-662 delivered, both schemas applied and dormant/old-version compatibility validated, measured capacity, the origin audit closed, and the trigger and schedule approval; owner GO, readback, natural acceptance in `Верификация`.
8. **HA: historical disposition planning (L0, near-term, concrete):** see decision 8.

No temporary flag, schedule or Task is introduced without its own gate.

### 8. History: a concrete planning deliverable, and one trade-off for the owner

Historical payloads are not observations (decision 1), so under the accepted ADR 0214 they cannot become `automatic` provenance. The recommended direction therefore writes **only Films that have a stored observation**: the stream, and any historic Film whose detail Discovery verifies again.

**HA is a planning deliverable, not an optional future action.** An L0 card, started once A1's design is accepted and runnable in parallel with I1/I2, produces:
- **measured eligible cohorts**, from **approved evidence, offline copies or a separately authorized bounded read only (no fetch, no write)**, bounded and indexed, by the classification of decision 3 (the Films with no observation, class 5, are censused here, not through the cursor) and by missing field and part (core fields, credits, Russian title), excluding `held_unowned`, `unresolved`, `superseded` and rated/Watchlist Films, with their overlaps;
- **acquisition alternatives** with cost and gates: Discovery re-verification through its existing detail path and budget; a C1 pass; a localization-only pass; **one shared detail fetch whose single response feeds both the observation (HA) and the Russian-title selection (H3)**, so no Film is fetched twice;
- a recommendation on T1 below and the gates for any historical write.

HA writes nothing and fetches nothing. H3 (historical Russian localization) is part of HA's alternatives, not a separate silent decision, and 2A alone does not solve history.

**Trade-off for the owner (T1), presented once, after the contract above:**
- **T1-a (recommended): defer.** This record decides nothing about legacy adoption; history waits for observations (the stream, natural re-verification) or for the plan HA produces.
- **T1-b: decide a bounded legacy adoption now.** Fill **blank** fields only, from payload values TMDB-derived by construction (`runtime`, `genres`, `url`), as `unknown`-confidence values without a field row and without a time claim, never replacing. It is a real additional policy decision, not part of 3A and not a bypass of ADR 0214, and **this record authorizes no writer for it**: choosing T1-b here would only record the owner's wish for a separate record. **Credits are outside T1-b's scope**: a credit needs the namespace rule, a Person unit and attribution from an immutable intent (decision 4), none of which a legacy payload value without an observation can provide, and projector-era Films already have credits. T1-b **cannot make history complete**: no `year`, `synopsis`, `poster`, Russian title or credits. It needs its own record.

Choice 3B ("everything at activation") is **not deliverable**: it requires a separately accepted historical plan (HA), and T1-b alone does not provide one.

### 9. Documentation and dependencies

Implementation cards update: the Discovery observation and authority contracts (`docs/architecture/discovery-and-resolution.md`), `docs/architecture/film-person-lifecycle.md`, `docs/reference/domain/film-person.md`, `docs/reference/data/d1-schema.md` and the migration registry, the producer, receipt and state contracts, the provenance reference, `docs/architecture/scheduling-and-orchestration.md` or the Scheduled Task contract (the trigger), and the Discovery and producer runbooks. The stale statements found by AIR-627 (`film-person-lifecycle.md` on `writeFilmFacts` writing dimensions from wired producers; `film-person.md` on Discovery metadata) are corrected in I2a. No Mermaid change is made by this record. ADR 0218's control and lock state are preserved.

## Open choices

### Choice 1. Who fills canonical metadata and credits of a Discovery-only Film

| Option | What it means | Benefits | Drawbacks |
| --- | --- | --- | --- |
| **1A** Retain minimal + payload serving | No canonical write; readers add a Discovery section | zero writes and no new producer | canonical stays incomplete; every non-Discovery reader depends on Discovery; a superseded admission loses its data; no refresh owner; contradicts "canonical is the authority" |
| **1B** Extend C1 (ADR 0211) to Discovery admissions | C1 fetches TMDB (and Letterboxd when anchored) per Film | one producer; fresh data; full ADR 0211/0214 contracts | at C1's bound (2 Films per hourly tick) a stream of about 280 per day never drains; raising the bound is its own decision and adds TMDB pressure for data Discovery already fetched |
| **1C** Discovery publishes a versioned observation; a bounded intake applies it (recommended) | decisions 1 to 9 | no upstream request; reuses every accepted writer protection; explicit scopes and persisted dispositions; capacity measurable while dormant | a second automatic filler of `film_metadata`, kept disjoint from C1; Discovery publishes on every verified detail; new tables and a measured capacity gate; the `origin` audit may require a PV1 change; history is not covered without HA |
| **1D** Widen `film_mutation` itself | write metadata and credits inside the admission batch | no second unit | breaks ADR 0134 decision 5 and the admission budget; one failure mode for admission and enrichment |

**Recommendation: 1C.** The data are already acquired under a verified identity; 1A leaves the authority empty and 1B re-fetches. The recommendation does not rest on a drain-rate claim.

### Choice 2. Russian localization

| Option | What it means | Benefits | Drawbacks |
| --- | --- | --- | --- |
| **2A** Typed selection in the observation (recommended) | the deterministic `ru` translation selection of decision 1, written as the `tmdb` source row through the AIR-662 operation | no extra request; exact; ambiguous or missing writes nothing | history has no observation, so no Russian title until HA's plan |
| **2B** C1 fetches translations for every Discovery Film | one TMDB request per Film | covers history | the 1B capacity problem for localization alone, and a duplicate of Discovery's own response |
| **2C** Leave localization missing | — | nothing to build | the gap stays |

**Recommendation: 2A.** No title is derived from `movieTitles`, `aliases` or the response `title`.

### Choice 3. Cohorts and cutoff

| Option | What it means |
| --- | --- |
| **3A** Stream first (recommended) | intake applies every observation above `floor_seq`; history without an observation is decided by HA's plan, never written from legacy payloads |
| **3B** Everything at activation | not deliverable: it needs a separately accepted historical plan (decision 8); listed for completeness and recommended against |
| **3C** Future only | class 5 (`no_observation`) stays on payload serving; HA's plan is not pursued |

**Recommendation: 3A**, which separates the first natural acceptance of a new writer from any historical write, as ADR 0211 C3a/C3b and ADR 0214 PVE do.

### Choice 4. Refresh policy

| Option | What it means |
| --- | --- |
| **4A** Event-driven through ADR 0214 (recommended) | work reopens on the triggers of decision 3 (a new occurrence, an anchor change, a lock release, an owner action, a bounded D1 recheck); the ADR 0214 rank decides; C1's own triggers stay the only fetch-based refresh |
| **4B** Fill-only forever | intake fills blanks and never replaces |
| **4C** Periodic refresh | a window and sweep; the ADR 0214 PVT question, which this would pre-empt |

**Recommendation: 4A.**

### T1 (decision 8)

A trade-off outside choices 1 to 4: **T1-a (recommended)** defer legacy adoption to HA, or **T1-b** decide a bounded legacy adoption now.

## Field, source, reader and writer matrix (recommended direction)

| Field | Source (observation) | Canonical target | Writer | Reader after intake | Rule |
| --- | --- | --- | --- | --- | --- |
| year, runtime, synopsis, poster, url, genres | core section (never EPG or retained values) | `film_metadata` + `film_metadata_field` | `writeFilmFacts` (intake) | ADR 0216 display section, fallback, `/api/d1/films` | fill, adopt, replace or keep by the ADR 0214 rank; `absent` and `unreadable` write nothing |
| directors, actors | credits section, ≤ 20 and ≤ 10, valid ids | `person`, `film_person_credit`, `discovery_intake_credit` | Person and credit units | `PAGE_CREDIT_SQL`, fallback | add-only within one namespace; attribution kept; `superseded_credits` on correction |
| Russian title | translation selection | `film_localization_source` (`tmdb`) + effective projection | AIR-662 operation | effective localization (ADR 0218 decision 3) | existing resolver; ambiguous writes nothing |
| `title`, `original`, `aliases`, `movieTitles`, `shows` | — | not written | — | Discovery only | `original_title` stays ADR 0120 |
| `canonical_identity`, claims, aliases | — | not written | — | — | identity stays claim-based |
| processing dimensions, `metadata_at` | — | not written | — | — | ADR 0218; ADR 0211 clocks |

## Alternatives considered

Listed per choice above, and in decision 8 (T1-a, T1-b). Not offered:
- **Payload intake inside C1:** C1's per-tick bound and lease are sized for upstream fetches; it would keep the capacity problem or need two C1 modes.
- **Parsing a Russian title from `movieTitles`:** rejected; the languages share a script and the card forbids title guessing.
- **A new `origin` value now:** deferred to the I2a audit and PV1 (decision 5).

## Examples

- **Stream Film.** `tmdb_123` is admitted with an observation (`seq` 4001, year 2004, runtime 101, six core fields, 2 directors, 10 actors, translation `ru` "Пример"). Its disposition is `intake`. Intake writes six fields (`origin='catalog_enrichment'`, `write_key` `intake:…`, `observed_at` the observation's), the missing Persons and credits (attributed in `discovery_intake_credit`) and one `tmdb` localization source through the AIR-662 operation.
- **Same data seen later.** A revalidation verifies the detail again with an identical digest: `observed_at` and `seq` move; the item rechecks; a field whose row is already at least as recent is a no-op (no receipt); a field whose row an intervening automatic value of the same rank displaced is re-adopted.
- **Poster-only change.** `POSTER_UPDATE_SQL` fills a poster: the payload changes, no observation is published, nothing reopens.
- **EPG touch.** An airing adds an alias: the payload changes, no observation, nothing reopens.
- **A Film that gets rated.** A `film_rated_admission` row appears: the next batch fails its disposition guard; the item is `held_unowned` (`rated_outside_c1_scope`) unless C1's activated scope proves it `owned_by_c1`; intake never writes it again, and the held Film is counted.
- **Identity correction.** The trusted claim moves from `tmdb:5` to `tmdb:6`: the anchor digest and `plan_epoch` change, the credits intake added under `tmdb:5` are held as `superseded_credits` from `discovery_intake_credit`, and the unit applies only an observation of `tmdb:6`.
- **Observation before the Film exists.** An observation arrives for a `tmdb_id` with no canonical Film: the cursor advances with an `unresolved` item; the recheck resolves it once `film_mutation` has admitted the Film.

## Synthetic test plan (for I1a and I2a, on the real migrated schema)

- **Observation:** source contamination (EPG fallbacks, retained poster, `POSTER_UPDATE_SQL`, alias and availability changes never enter); digest stability across `observed_at`; same digest later moves `seq` and `observed_at`; translation selection (single, several with `RU`, ambiguous, absent, unreadable); credits bounds (20/10, truncation gap, invalid ids); publication only after a verified detail, never on failure; no extra request; `seq` monotonic across deletion and across a missing high-water row (`seq_regressed`); the transfer `loading` state refuses publication; ambiguous or non-unique current admission is `unresolved`.
- **Cutover:** observations between I1c and A1 are applied; a same-digest re-observation after A1 is a new `seq`; a Film verified only by an old version is class 5 (`no_observation`).
- **Old payload:** no observation; `discoveredAt` is never an observation time.
- **Dispositions:** C1 due, failed, disagreeing, paused and newly eligible Films are excluded; a missing `watchlist_film` projection is not a negative; rated outside C1's scope is `held_unowned`, not `owned_by_c1`; persisted exclusion survives a live predicate that flips back; re-entry only by owner `reopen`; handoff carries attribution and a `superseded_credits` hold both ways.
- **Agreement and rank:** a Letterboxd anchor added between plan and commit; the fallback never grants intake; confidence before source; only `confirmed` replaces a different value; `hold` fills only; owner pin, dimension lock and reviewed localization untouched; no clear; fill, adopt, replace, keep and no-op each, with no receipt for a no-op.
- **Credits:** one namespace, both namespaces, existing EPG or C1 credits, missing Persons, concurrent cross-origin Person creation (absent-target), `superseded_credits`, a stale plan refused at the Person unit.
- **Reopen:** a previously unresolved identity; a mapping that changes (epoch and invalidation); an anchor change with an unchanged digest; a lock release; an owner action setting `recheck_at`; a C1 domain transition; the cursor advances only with durable items; no scan per tick.
- **Receipts:** a moved observation with a pending receipt of the previous one (reconciled under the stable key); pause and takeover; a replaced intent; a post-commit crash and lost response settled by readback; the 100-receipt cap is visible and not a strike; deadline, lease and marker movement are not strikes.
- **Coverage:** the seven classes are exhaustive and disjoint; `processed` is not coverage; `canonical_present` preserves an existing value on a blank observation; `observed_absent` versus `unknown`; an alias-only Film; partial metadata; gaps and blocks reported per part.
- **Localization:** the AIR-662 receipt and owner-review fence; `ambiguous` writes nothing; the effective projection equals the resolver output on the rows read back.
- **Fences (executable):** takeover with an unchanged observation (a stale batch fails on lease, `plan_epoch` and attempt); a C1, EPG, rated, retention or Watchlist signal added **before** the canonical commit (the live exclusion predicates fail the batch and the exclusion is persisted); a **stale Person commit** (a Person batch fails on mapping, anchor set, epoch, lease and control like a Film batch); the **first unresolved insert** (insert-only, no `disposition='intake'` required) and a **held transition** persisted without granting a write; an unknown-coverage source yields `held_unowned` (`coverage_unknown`), never eligible; an excluded Film is never written by any unit; `reopen` refuses with an unsettled attempt, `attribution_owed` or a hold.
- **Remap and attribution:** a **mapping change with a pending old-key receipt** (the old intent and receipt, including a Person key, are reconciled under their stored keys before any replan); a **crash after a credit commit but before attribution**, then an anchor correction and then a handoff (the atomic path never leaves it; on the recoverable path `attribution_owed` blocks the correction, any new cast and the handoff until completed from the immutable intent and the terminal receipt); the **same survivor reached through another `tmdb_id`** (it shares the Film row exclusion and hold and cannot bypass owner `reopen` or the credit hold); an **existing credit** is a no-op that is never attributed from `content_present`; a settle after the Film was excluded, paused or its observation moved records exactly the applied subset; a redirect merges Film rows monotonically.
- **Publication:** out-of-order completion of two details of one movie keeps the later response and does not move the token; the publication batch asserts observation-control mode and revision and the source authority; the bump and the observation write are atomic; a restored lower `high_water` without a raised `seq_epoch` is refused and with one never reissues a published token, even with a lagging cursor.
- **Recheck and budget:** worst-case full-cycle latency equals `ceil(P / M) × T` in fixtures with `P` items; due parts are read through their own index; the per-tick total is bounded; Films with no observation are not on the cursor path; repeated adoptions consume the 100-receipt budget, no-ops consume none, and the cap yields `needs_attention` counted as `history_exhausted`, never as processed.
- **Capacity:** the dormant fixtures record statements, batches, rows and time per unit for all 30 Persons, reconciliation, intent, state and guards.

## Consequences

- Fields present in an observation become present in canonical D1 for in-scope Discovery Films, with no new upstream load; fields absent from an observation, held and unresolved Films stay unknown or gapped and are reported as such. This does not make canonical D1 complete.
- Discovery gains an observation table, a high-water row, a control row and a publish on every verified detail; two new schemas (I1, I2) with two owner apply operations and a producer enablement.
- One more automatic writer of `film_metadata`, kept disjoint from C1 by persisted dispositions and fenced in every batch.
- History is not covered by this record; HA plans it, and T1 is the owner's trade-off.
- Capacity and the `origin` question are explicit gates, not claims.

## Recovery and migration boundary

This record authorizes nothing: no migration apply, no producer enablement, no control row change, no scope, no schedule, no shadow run, no production write, no Discovery, TMDB or sync run. Each step of the delivery graph has its own gate. Code rollback does not remove stored observations or written values; correction is through the ADR 0214 owner route or a forward write. Old code ignores the new tables.

## Evidence

- **Original decision:** pending owner selections on [AIR-655](https://trello.com/c/YIPK38Tg).
- **Implementation:** none.
- **Dated verification:** the AIR-627 census of 25 Nov 2026 (L0, `rows_written=0`), linked in Context; the code references (`src/discovery.js`, `src/discovery-authority.js`, `src/canonical-receipts.js`, migrations `0039`) were read statically on `main` `7d8d4b3`.
- **Uncertainty:** the eligible historical counts per field and part; the admission rate (a dated estimate); the share of TMDB entries with a `ru` translation or more credits than the caps; per-batch statements, rows and time (to be measured); whether a reader classifies by `origin` or the `write_key` prefix; the applied state of migration `0039`; how many historic Films Discovery will re-verify.

## Follow-ups

I1a, I1b, I1c, I2a, I2b, A1 and HA as in decision 7, each its own card; any historical write is decided after HA.
