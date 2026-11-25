# ADR 0219: Discovery-only Films get canonical metadata, credits and localization through one bounded intake of the Discovery TMDB observation, refreshed only by the accepted ADR 0214 triggers

**Status:** Proposed  
**Original decision date:** not decided  
**Recorded at:** 2026-11-25, from `main` `d3e1a4d`  
**Approval source:** not documented (awaiting an ADR-specific Product Owner decision on each open choice below)  
**Related work:** [AIR-655](https://trello.com/c/YIPK38Tg). Native prerequisite [AIR-644](https://trello.com/c/nFBGvvnU) ([ADR 0218](0218-film-lifecycle-dimensions-revision.md), Accepted). Builds on Accepted [ADR 0134](0134-discovery-admission-producer-wiring.md), [ADR 0155](0155-retire-enrichment-projector-cron.md), [ADR 0211](0211-catalog-enrichment-producer.md), [ADR 0214](0214-film-metadata-per-field-provenance.md), [ADR 0216](0216-canonical-film-lifecycle-and-unified-read-contract.md) and [ADR 0218](0218-film-lifecycle-dimensions-revision.md). Evidence: the [AIR-627 census continuation](https://trello.com/c/IOERZ9GI#comment-6b06a0deb3fbeaeb5f93f8b2) and its [disposition](https://trello.com/c/IOERZ9GI#comment-6b06d8c178a1d27ed10c4e8f). Coordinated with, and not extending, [AIR-614](https://trello.com/c/wUHl13Yw), [AIR-615](https://trello.com/c/fCXSmk7K) and the Proposed source-independent admission record of [AIR-643](https://trello.com/c/e1Q9H1bG) (ADR 0217, [PR #996](https://github.com/vladimino/iptv-watchlist/pull/996)).  
**Supersedes:** None  
**Superseded by:** None

## Context

### What exists (main `d3e1a4d`, 25 Nov 2026)

- **The only canonical writer for a Discovery Film is minimal by design.** Since the projector was retired ([ADR 0155](0155-retire-enrichment-projector-cron.md), AIR-537), a Discovery admission reaches canonical state only through the `film_mutation` unit of [ADR 0134](0134-discovery-admission-producer-wiring.md) decision 5 (`src/canonical-discovery-admission-producer.js`): the Film, the trusted `tmdb` claim and a title written only when blank. It never writes `film_metadata`, credits, Persons, aliases, localization or `canonical_identity`.
- **Every richer writer is bounded to another cohort.** EPG `film_facts` and credits target Watchlist Films only (`src/canonical-producer-workflow.js`, "programme-only films never become a target"); `metadata_sync` is Watchlist only; the dictionary covers dictionary entries; the ADR 0211 catalog-enrichment producer (C1, not yet delivered) is scoped to `film_rated_admission.verified_at >= cutoff_at` (ADR 0211 decision 4). AIR-614 and AIR-615 widen C1 to rated and Watchlist cohorts, not to Discovery-only Films.
- **The Discovery payload is a full TMDB observation.** `discovery_admission.payload_json` is built from `movie/<id>?language=ru-RU&append_to_response=credits,translations,alternative_titles` after a verified TMDB detail (`src/discovery.js`, `canonicalIdentity = 'tmdb:<id>'`). It carries `year`, `runtime`, `synopsis` (the ru-RU overview), `poster`, `url`, `genres` (ru-RU names), up to ten `directors` and ten `actors` with TMDB person ids (`tmdb_director/<id>`, `tmdb_actor/<id>`), `title`/`original`, `movieTitles` (TMDB authority titles in ru, uk, en and RU/UA/US/GB alternatives, **untyped by language**) and `aliases` (authority titles **plus** EPG titles). It has `discoveredAt` but **no observation time of the TMDB response**; a reconfirmation (`src/discovery.js`, re-fetch of `previous.tmdbId`) rewrites the body and keeps `discoveredAt`.
- **Serving already uses the payload.** The Film page and Finds read title, year, runtime, genres, poster and credits from the Discovery record (`src/worker.js`, poster source `catalog`). Data are lost only on the canonical fallback (`catalogCanonicalFilmFromD1`, when Discovery holds no record), in `/api/d1/films`, and in any future global catalog reader that reads canonical state (ADR 0216).
- **Russian localization is missing for every Discovery Film**, minimal or not: no `film_localization_source` row is written from Discovery, and the payload does not keep which title is the Russian translation.

### Census (AIR-627, L0, dated 25 Nov 2026, main `681b5c1`, Film/Person g2, EPG P519)

These are dated aggregates, not live counts. Implementation cards re-measure them with bounded predicates.

| Cohort | Size | Canonical state | Payload coverage |
| --- | --- | --- | --- |
| Minimal Discovery Films (admitted since 16 Nov by `film_mutation`) | 2 525, about half of new admissions, 1 213 airing in P519 | no `film_metadata`, credits, aliases, dimensions; `canonical_identity` NULL | year/runtime/aliases/`canonicalIdentity` 2 525, synopsis 2 524, genres 2 524, actors 2 523, directors 2 519, poster 2 517 |
| Projector-era Discovery Films | 9 730 | credits and aliases from the projector; `film_dimension` rows (metadata `fresh` for most) but **no `film_metadata` row** for 8 216 of the 8 620 `fresh`; no refresh owner | about 99.5 % |
| Future Discovery admissions | 2 525 in about 9 days, so roughly 280 per day | as the minimal cohort | as above |
| Rated (714, of which 473 with metadata missing) and Watchlist (391) | — | owned by C1 / AIR-614 / AIR-615 | out of scope here |

The 2 525 have no rated, retention or Watchlist overlap at census time. `canonical_identity` NULL is not a proof of missing identity: every one of these Films holds a trusted, non-conflicting `tmdb` claim.

### The problem

Canonical Film/Person D1 is the authority (ADR 0216), but for about 12 000 Discovery Films it holds only an id, a claim and a title. Readers that do not go through Discovery lose year, runtime, synopsis, poster, genres, credits and every Russian title. Nobody owns refresh of these Films, so even the projector-era credits age without a rule. The data already exist in the Discovery domain, so the gap is ownership, not acquisition.

### Settled decisions this record keeps

- The `film_mutation` unit stays minimal (ADR 0134 decision 5). This record adds a separate unit; it does not widen that one.
- The Discovery payload is **not** a Film authority (card scope). After intake the canonical row is the authority; the payload stays Discovery's own observation and its serving source.
- `film_dimension` rows are not processing state (ADR 0218 decision 1). A projector-era `metadata` row is a **copy**, never read for a decision; its lock predicate (`status='reviewed' OR authority='owner'`) stays control. No dimension is written by this design.
- `writeFilmFacts` is the single metadata writer and the ADR 0214 rule (decisions 4–5) applies to every caller, including this one. Owner pins and the dimension lock are never touched.
- Identity is never inferred from a title or a year. Nothing here creates, merges, redirects or retires a Film or writes a claim.
- Mass enrichment waits for the delivered and naturally accepted C1 ([AIR-607](https://trello.com/c/Daq02gYy)) and ADR 0214 `enforce` ([AIR-636](https://trello.com/c/0jJADYxg)). These gate implementation activation, not this design.

## Decision

Below, each material choice has stable labels and a recommendation; the Product Owner selects per choice. Sections marked *engineering detail* follow from the recommended options and change if another option is chosen.

### Choice 1. Who fills canonical metadata and credits of a Discovery-only Film

| Option | What it means | Benefits | Drawbacks |
| --- | --- | --- | --- |
| **1A** Retain minimal + explicit payload serving | No canonical write. The ADR 0216 aggregate and the canonical fallback read the Discovery section for these Films | zero writes, zero upstream; no new producer | canonical stays incomplete for about 12 000 Films; every non-Discovery reader needs a Discovery dependency; a superseded admission loses its data from all readers; no refresh owner; contradicts "canonical Film D1 is the authority" |
| **1B** Extend C1 (ADR 0211) scope to Discovery admissions | C1 fetches TMDB (and Letterboxd when an anchor exists) for each Film | one producer owns everything; fresh data; full ADR 0211/0214 contracts | at C1's accepted bound (2 Films per hourly tick, about 48 per day) future admissions alone (about 280 per day) never drain, and the 12 000 backlog takes years; raising the bound six-fold or more is its own decision and doubles TMDB pressure the payload already paid for |
| **1C** Bounded **Discovery intake** of the existing payload through the single writer (recommended) | A new producer unit copies the payload's core fields and credits into canonical state as a typed `tmdb` observation, D1 only, under ADR 0211 fill-only and ADR 0214 rank rules. C1 stays the only **fetcher** and refreshes through its existing triggers | no upstream request; drains about 280 per day in a few minutes of D1 work; data already ~99.5 % complete; reuses every accepted writer protection | a second automatic filler of `film_metadata` (one owner per Film at a time, see decision 4); needs one ADR 0214 enum extension (`origin = 'discovery_intake'`); payload has no observation time (decision 5 rule) |
| **1D** A new writer path widening `film_mutation` itself | Write metadata and credits inside the admission batch | no second unit | breaks ADR 0134 decision 5 and the chunk budget of the Discovery admission; one failure mode for admission and enrichment; rejected by the card's constraints |

**Recommendation: 1C.** The data exist and are verified under the same TMDB identity the Film holds; re-fetching them (1B) spends the shared TMDB budget for nothing, and 1A leaves the authority empty. 1C keeps one writer, one rule set and one fetcher.

### Choice 2. Russian localization

The payload keeps Russian, Ukrainian and English translations and alternatives mixed in `movieTitles`, and `title` is TMDB's ru-RU title **or** its fallback when no ru translation exists. Picking a Russian title from it would be guessing.

| Option | What it means | Benefits | Drawbacks |
| --- | --- | --- | --- |
| **2A** Typed translation in future payloads (recommended) | Discovery already requests `translations`; it adds one typed field, `ruTitle` (the `iso_639_1 = 'ru'` translation title, or explicit null when TMDB has none), to new and reconfirmed payloads. The intake writes it as the `tmdb` `film_localization_source` row; the existing resolver (ADR 0218 decision 3) decides the effective title | zero extra requests; exact, typed, no guessing; owner and reviewed rows keep their precedence | historical payloads have no typed field: those Films get a Russian title only from a later reconfirmation or from C1, per choice 3 |
| **2B** C1 fetches translations for every Discovery Film | one TMDB request per Film | covers history at once | the 1B capacity problem for localization alone |
| **2C** Leave localization missing for Discovery Films | — | nothing to build | the Russian-title gap stays for all about 12 000 Films |

**Recommendation: 2A**, with history handled by choice 3. No title is ever derived from `movieTitles`, `aliases` or `title` alone.

### Choice 3. Cohorts and cutoff

| Option | What it means |
| --- | --- |
| **3A** Future first, history in separate gated scopes (recommended) | Activation sets `cutoff_at`; admissions whose current payload is written at or after it are due. History enters as two separately approved backfill scopes, each with its own owner GO, dry-run count and cap: **H1** the minimal cohort, then **H2** the projector-era cohort. Historical localization (no typed `ruTitle`) is a third optional scope **H3**: either a bounded reconfirmation of the payload by Discovery, or a C1 localization-only pass, decided when H3 is proposed |
| **3B** Everything at activation | one scope of about 12 000 Films plus the stream |
| **3C** Future only; history stays on payload serving | no backfill ever |

**Recommendation: 3A.** It separates a new writer's first natural acceptance from a bulk historical write, as every recent producer has (ADR 0211 C3a/C3b, ADR 0214 PVE).

**Exact cohort rules** (engineering detail, re-measured by each implementation card):
- A Film is **in the intake domain** when: it exists and is not redirected; it holds exactly one trusted, non-conflicting `tmdb` claim `<n>`, not retired (`tmdb_retirement_decision`); one `discovery_admission` row is `state='current'`, `media_kind='movie'`, `tmdb_id=<n>`, and its payload parses with `canonicalIdentity === 'tmdb:<n>'` and `tmdbId === '<n>'`. Anything else is `not_applicable` with a typed reason (`no_current_admission`, `identity_mismatch`, `claim_conflicting`, `claim_retired`, `payload_unparsable`), never a guess.
- **Minimal (H1):** in the intake domain, no `film_metadata` row and no `film_person_credit` row.
- **Projector-era (H2):** in the intake domain, has projector credits or aliases, and at least one ADR 0214 core field is blank or unknown. Its `film_dimension` rows are copies and are not read; they are neither cleared nor rewritten (ADR 0218 decisions 1 and 7 own their retirement).
- **No double counting:** H1 and H2 are disjoint by the credit predicate; the stream and H1/H2 are disjoint by `cutoff_at`. A Film also in the rated or Watchlist cohort is due in both domains, and decision 4 settles which unit acts.

### Choice 4. Refresh policy

| Option | What it means |
| --- | --- |
| **4A** Event-driven only, through ADR 0214 (recommended) | No time-based refresh. The intake re-runs for a Film only when its current Discovery payload changes digest (a reconfirmation or re-admission). The single writer then applies the ADR 0214 rank: a newer `tmdb` observation replaces an older automatic `tmdb` value; it never replaces a `letterboxd` value, an owner value or a locked Film. C1's own triggers (ADR 0214 decision 10) remain the only fetch-based refresh |
| **4B** Fill-only forever | the intake fills blanks and never replaces; stale values wait for C1 or the owner |
| **4C** Periodic refresh | a time window and sweep; this is exactly the ADR 0214 PVT question, and deciding it here would pre-empt that card |

**Recommendation: 4A.** It reuses the accepted rank and costs nothing when nothing changes. Before ADR 0214 is in `enforce`, 4A degrades to 4B automatically (ADR 0211 fill-only), which is safe.

### 5. The intake unit (engineering detail for 1C, 2A, 3A, 4A)

**Writer.** `writeFilmFacts` with `requireExisting: true`, the stored `contractVersion`, the snapshot `expectedRevision`, and only `metadata`, `sync` and `localization.sources`; Persons and credits through the existing add-only Person and credit units of ADR 0211 decision 3. Never `dimensions.*`, never a claim, alias, `canonical_identity` or `original_title` (title ranking stays ADR 0120). Credits: only entries with a TMDB person id; name-only credits are not written (ADR 0211).

**Provenance (requires one ADR 0214 enum extension, delivered by PV1 or a follow-up migration).** Each written field row is `tier='automatic'`, `source='tmdb'`, `origin='discovery_intake'`, anchor `tmdb=<n>`, `anchor_digest` the Film's current digest, `agreement` derived by the writer (so `unconfirmed` when the Film also holds a Letterboxd anchor without a C1 agreement, which ranks below `confirmed`). `observed_at` is the payload's new `observedAt` (the TMDB response time, added to new payloads with `ruTitle`); for a historical payload without it, the conservative lower bound `discoveredAt`, so any real fetch outranks it.

**Fences in the batch.** The Film revision CAS; the Film/Person marker; the anchor assertion of ADR 0214 decision 4; and a **Discovery source fence**: the admission row's `(film_id, generation)` and the payload digest the plan read, asserted with a `SELECT ... WHERE` guard. A moved admission (new generation, superseded, changed digest) refuses the batch and the unit replans; a superseded admission is a terminal `source_moved`, never a write from old content.

**Ownership between producers (choice-1 consequence).** A Film is due for the intake only while C1 has no `core` part for it that is `complete`, `complete_with_gaps` or in progress. Once C1 owns the Film, the intake records `deferred_to_catalog_enrichment` and stops. This never splits one field between two concurrent automatic writers; the ADR 0214 rank would settle it anyway.

**Bounds.** A separate step after the paged Discovery chunk's checkpoint (not inside `upsertAdmissions`), never throwing: at most 20 Films per call, oldest `due_since` first, only with time left before the caller's deadline and the ADR 0094 statement totals; D1 only, no upstream request. A shared tick of the hourly cron drains the rest. Each tick records Films, units and D1 statements for measurement; caps rise only by owner decision after measurement.

**State and coverage.** Progress is a small per-Film state row in a new `discovery_intake_state` table (`film_id`, `payload_digest`, `state` in `due`/`done`/`deferred_to_catalog_enrichment`/`not_applicable`/`failed`, `reason`, `attempts`, `retry_at`, `due_since`, `updated_at`), never a `film_dimension`. Monitor/Health report counts per state and the oldest `due_since`; three strikes of the same unit and digest end in `failed` (`needs_attention`), visible, never silently retried (ADR 0128 classes).

**Control.** One control row with `mode` in `off`/`on`/`paused`, `cutoff_at` and `scopes` (`stream`, `H1`, `H2`, `H3`), created `off`. Each transition and each scope widening is an owner production operation with readback. Activation is not reachable from `/admin/settings`.

**Rollback.** `paused` stops new units at once without a code revert. Written values stay; there is no bulk delete. A wrong value is corrected by the owner route of ADR 0214 decision 9, or replaced by a later, higher-ranked observation. A code revert past the enum extension is an owner L3 operation.

### 6. Field, source, reader and writer matrix

| Field | Source in payload | Canonical target | Writer | Reader after intake | Rule |
| --- | --- | --- | --- | --- | --- |
| year, runtime | `year`, `runtime` | `film_metadata` | intake → `writeFilmFacts` | ADR 0216 display section, fallback, `/api/d1/films` | fill, then ADR 0214 rank |
| synopsis, genres | ru-RU `synopsis`, `genres` | `film_metadata` | same | same | same; language is the TMDB ru-RU response, as C1's TMDB source |
| poster, url | `poster` (TMDB w342), `url` | `film_metadata` | same | same | same; the Discovery poster write rule (keep an existing https poster) stays Discovery's |
| directors, actors | `directors`, `actors` with TMDB person ids | `person`, `film_person_credit` | Person and credit units | `PAGE_CREDIT_SQL`, fallback | add-only; ordinals kept (`credit_ordinals_kept`); name-only skipped |
| Russian title | `ruTitle` (new, typed) | `film_localization_source` (`tmdb`) | intake → `writeFilmFacts` | effective localization (ADR 0218 decision 3) | existing resolver; owner/reviewed on top |
| `title`, `original`, `movieTitles`, `aliases` | — | not written | — | Discovery only | aliases mix EPG titles; `original_title` stays ADR 0120 |
| `canonical_identity` | `canonicalIdentity` | not written | — | — | identity stays claim-based (ADR 0216 §3) |
| dimensions | — | not written | — | — | ADR 0218 |

## Alternatives considered

Listed per choice above (1A, 1B, 1D, 2B, 2C, 3B, 3C, 4B, 4C). Two further variants were weighed and not offered:
- **Payload intake inside C1** (C1 reads the payload instead of fetching TMDB for Discovery Films). One producer, but C1's per-tick bound of 2 Films and its lease are sized for upstream fetches, not for D1-only copies; it would either keep the capacity problem or need two C1 modes.
- **Parsing a Russian title from `movieTitles` by script detection.** Rejected: Ukrainian and Russian share the script, and the card forbids title guessing.

## Examples

- **Minimal Film, stream.** Admission of `tmdb_123` at 10:00 after activation; the payload has year 2004, runtime 101, ru synopsis, poster, 4 genres, 2 directors, 10 actors, `ruTitle` "Пример". The next intake step writes six fields (`origin='discovery_intake'`, `observed_at` 10:00), 12 Persons/credits and one `tmdb` localization source; the resolver makes "Пример" provisional unless a reviewed title exists.
- **Owner-locked Film.** The Film's `metadata` dimension is reviewed: the writer refuses every field (ADR 0214 P1); the intake records `done` with `locked` fields listed, and credits and localization still apply under their own rules.
- **Reconfirmation.** Discovery re-fetches `tmdb_123` and the runtime changes to 103: the payload digest moves, the Film is due again, and the newer `tmdb` observation replaces 101 with a `replaced` history row. If C1 had written runtime from Letterboxd, the intake value ranks lower and is not written.
- **Identity mismatch.** A current admission names `tmdb_5`, but the Film's trusted claim is `tmdb_6` after a correction: `not_applicable` (`identity_mismatch`), nothing written.

## Synthetic test plan (for the implementation card)

- **Future:** an admission after `cutoff_at` is due and filled; before it, not due.
- **Minimal (H1) and projector-era (H2):** disjoint predicates; H2 fills only blank or unknown fields and never touches its `film_dimension` rows.
- **Overlap:** a Discovery Film later rated: C1 owns it, intake defers; a Film rated first and discovered later: never due for intake while C1 owns it.
- **Owner locks:** dimension lock, field pin, reviewed localization, each untouched.
- **Partial payload:** missing synopsis or directors: written fields only, the rest stay unknown (never explicit null from absence of a key).
- **Conflicting identity:** claim mismatch, conflicting claim, retired id, redirected Film, unparsable payload: typed `not_applicable`, no receipt.
- **Generation change:** admission moves between plan and commit: batch refused, replanned; superseded admission: `source_moved`.
- **Before `enforce`:** fill-only, no field rows; after `enforce`: field rows with `origin='discovery_intake'`.
- **Rank:** intake vs C1 Letterboxd and TMDB in both orders; historical `discoveredAt` observation loses to any fetch.
- **Bounds:** deadline mid-Film resumes from canonical state; statement totals respected; `paused` stops new units.
- **Localization:** `ruTitle` null writes nothing; a payload without the field never produces a title.

## Cost

D1 only. Per Film: about 6 reads for the plan, one `writeFilmFacts` batch, one localization unit, up to 20 Person units (most Persons already exist: 53 777 Persons for 116 114 credits) and one credit unit, so roughly 10–25 statements. Stream: about 280 Films per day, a few thousand statements per day. H1: about 2 525 Films, H2: up to 9 730, each run under its own cap over days. No TMDB, Letterboxd or Wikidata request. The Workers Paid baseline applies; these are measurements, not gates.

## Delivery graph (no card is created by this ADR)

1. **I1 Payload typing (offline):** Discovery stores `observedAt` and `ruTitle`. Small, independent.
2. **I2 Intake unit and state (offline, dormant):** migration for `discovery_intake_state` and control, the unit, the ADR 0214 enum extension (coordinated with PV1, AIR-631), tests above, docs.
3. **A1 Activation (stream):** after AIR-607 and AIR-636 natural acceptance; owner GO, readback, natural acceptance in `Верификация`.
4. **H1, H2, H3 backfill scopes:** each its own card and owner GO, after A1 acceptance.

Documentation in I2: `docs/architecture/film-person-lifecycle.md`, `docs/architecture/discovery-and-resolution.md`, `docs/reference/domain/film-person.md`, `docs/reference/data/d1-schema.md`, the Discovery and producer runbooks. The stale statements found by AIR-627 (`film-person-lifecycle.md` on `writeFilmFacts` writing dimensions from wired producers; `film-person.md` on Discovery metadata) are corrected there.

## Consequences

- Canonical D1 becomes complete for Discovery Films without new upstream load; the ADR 0216 aggregate and fallback stop losing data.
- One more automatic writer of `film_metadata`; protected by the single writer, fences and rank, and observable per state.
- The payload gains two typed fields; old payloads stay readable.
- Projector-era dimensions are left to ADR 0218; nothing here reads them.

## Recovery and migration boundary

This record authorizes nothing: no migration apply, no control row change, no scope, no production write, no Discovery, TMDB or sync run. Each step of the delivery graph has its own gate. Code rollback does not remove written values; correction is through the ADR 0214 owner route or a forward write.

## Evidence

- **Original decision:** pending owner selections on [AIR-655](https://trello.com/c/YIPK38Tg).
- **Implementation:** none.
- **Dated verification:** AIR-627 census of 25 Nov 2026 (L0, `rows_written=0`), linked in Context.
- **Uncertainty:** admission rate is derived from 2 525 in about 9 days; H2 blank-field counts are not measured; the share of TMDB entries with a ru translation is unknown; per-Film statement counts are estimates.

## Open choices for the Product Owner

| Choice | Options | Recommendation |
| --- | --- | --- |
| 1 Owner of canonical metadata and credits | 1A / 1B / 1C / 1D | 1C |
| 2 Russian localization | 2A / 2B / 2C | 2A |
| 3 Cohorts and cutoff | 3A / 3B / 3C | 3A |
| 4 Refresh policy | 4A / 4B / 4C | 4A |
