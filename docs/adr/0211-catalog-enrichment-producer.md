# ADR 0211: Admitted Films are enriched by a canonical catalog-enrichment producer, independent of EPG airing

**Status:** Proposed (no owner decision on this record; every choice below awaits review and an explicit, ADR-specific Product Owner decision)  
**Original decision date:** not decided  
**Recorded at:** 2026-11-24  
**Approval source:** not decided. Requested as the companion of [ADR 0207](0207-letterboxd-admissions-coordinated-in-d1-only.md) by the owner's disposition 6C on [PR #975](https://github.com/vladimino/iptv-watchlist/pull/975#issuecomment-7131137347): "не вижу смысла упускать возможность сразу начать подготовку к глобальному каталогу, даже если миграция из-за этого займет больше времени". That chose the direction (redirect rated enrichment to the canonical D1 writer); it does not accept this design.  
**Related work:**
- [AIR-555](https://trello.com/c/JPgjoBzK), under [AIR-275](https://trello.com/c/4x7hH0gI).
- [ADR 0207](0207-letterboxd-admissions-coordinated-in-d1-only.md) retires the R2 enrichment and depends on this record for its replacement.
- [ADR 0210](0210-film-identity-evidence-ledger.md) (Proposed) is a sibling record.

**Supersedes (only on acceptance):** In part [ADR 0087](0087-rated-archive-film-admission.md) decision 4: "Synopsis and credits stored later on the admission", i.e. metadata written onto the R2 admission entry.  
**Superseded by:** None

## Context

### What exists (main, 24 Nov 2026)

**The canonical writer.** `writeFilmFacts` (`src/canonical-film-writers.js`) has no EPG or airing condition. It applies the accepted precedence (ADR 0099, 0120 R3 and R5-sync), and the owner accepted the matching differential exceptions on 13 Nov 2026:
- owner and reviewed values are never replaced;
- a blank never overwrites;
- an automatic localization source never outranks owner or dictionary values (`src/localization-sources.js`);
- a newer observation wins.

It writes `film_metadata`, `film_sync_state`, localization sources, the `film_dimension` lifecycle rows and membership, all in one fenced batch.

**The two receipted metadata producers only see EPG-listed Films:**
- `metadata_sync` runs inside the EPG run's metadata stage, on Watchlist members keyed by lid.
- the `epg` `film_facts` units come from the sealed generation and target listed Watchlist ids only.

Credits and Persons are written only by the EPG chain (`person_mutation`, `film_credits`).

**With the Watchlist marker at `d1`** (production, generation 3, read on 24 Nov 2026 12:21 UTC), a pinned EPG run gets `pending = []` (`src/worker.js:1315`), so the metadata stage fetches nothing. ADR 0186 moved Watchlist admission to the Letterboxd Sync, and the Sync has no metadata phase.

**Observed coverage.** 714 of 714 `film_rated_admission` Films have **no** `film_metadata` row and **no** `film_sync_state.metadata_at` (L0 read, 24 Nov 2026). The catalog reads year, runtime, poster, url and genres from `film_metadata`, so every admitted Film is thin.

**The retired path.** The R2 enrichment of rated archive Films (W5/W6 of the AIR-555 audit) wrote synopsis, credits, genres, runtime, poster, url and a provisional Russian title onto the R2 admission entry. No serving reader reads them at Film/Person `open`. At the audit 0 entries carried them.

## Decision (proposed)

### 1. A dedicated producer origin, `catalog_enrichment`, using existing writers only

- **Origin.** A new receipted origin `catalog_enrichment`. It reuses the existing operation kinds and writers:
  - `film_metadata`, `film_sync_state` and the `film_dimension` `metadata` lifecycle row (attempts, `retry_at`, `last_error`, `next_action`) through `writeFilmFacts`;
  - `localization_source` with the automatic sources `tmdb`, `letterboxd` and `wikidata`;
  - the existing `person_mutation`, `person_state` and `film_credits` units for credits.
- **No new authority.** It is not a new metadata authority and has no new tables: D1 Film/Person stays the only authority, and this is one more writer under the same precedence and the same receipts.
- **Request ids.** Event `enrich:<film>:<source>:<sourceVersion>`, and the digest is the fetched content without clocks. Retries reuse the receipt, and the origin reconciles only its own receipts (ADR 0119, 0123).

### 2. Eligibility, independent of EPG airing

A Film is due when:
- it exists, is not redirected and holds one trusted `tmdb` claim;
- it falls inside the scope chosen in decision 6;
- its metadata is missing or older than the existing 30-day freshness (`METADATA_FRESH_MS`);
- its `metadata` lifecycle row is not owner- or reviewed-locked;
- its `retry_at` has passed.

Due Films are ordered by the oldest `retry_at`, then by the newest admission.

### 3. Sources and fetch bounds

- **TMDB movie detail is the primary source** (`movie/<id>`, with credits and translations). The movie id is the canonical identity, so no Letterboxd id is needed. It reuses the existing request policy: 200 ms spacing, 12 s timeout, 429 with Retry-After clamped to 30-3,600 s.
- **The Letterboxd film page is a secondary source**, through the existing `parseFilm` (25 s, 3 MB). It is used only when the Film has a trusted `letterboxd` claim or a known page URL, so that genres and people use the same representation as EPG-sourced Films.
- **Russian titles and names** come through the existing Wikidata localizers as automatic sources.
- **A failed or partial fetch:**
  - writes nothing but the lifecycle row (`attempts + 1`, `last_error`, `retry_at` with a doubling backoff like the Diary step (at most 6 attempts));
  - after the last attempt the row stays visible with `next_action: needs_attention` and is no longer selected;
  - a 403, 429 or challenge stops the tick.

### 4. Trigger and bound

- **Trigger.** One bounded step on the existing hourly Worker tick (`CatalogEnrichment.ensure`). It has its own D1 lease, so two ticks never overlap.
- **Bound.** At most 6 Films and one fetch concurrency per tick (≤ 144 Films per day). The implementation card measures the tick cost against the hourly tick budget. It does not wait for, block or share budget with the EPG run, the Letterboxd Sync or Discovery.
- **Not chosen:**
  - a phase of the Letterboxd Sync (it couples metadata to four slots a day and the Sync's deadline);
  - a slice of the Producer chain (heavier, and keyed to sealed generations).

### 5. Coexistence with the EPG producers

- **Same writer and rules.** A published Film can also receive `film_facts` from the EPG chain. Both go through the same writer and precedence. The newer observation wins field by field, a blank never overwrites, and owner and reviewed values stay.
- **Skip rule.** The producer skips a Film whose metadata is fresh, whoever wrote it.
- **No contest.** There is no lease or authority contest, because neither writer can replace what the other's precedence protects.

### 6. Scope and existing thin Films (owner choices)

- **Scope.** Recommended: Films with a `film_rated_admission` row (rated archive, Diary, Watchlist admission, inferred import).
  - Optional: current Watchlist members. This closes the pinned-run gap of the Context, but it changes the Watchlist metadata path, so it is a separate owner choice.
  - Discovery-admitted Films are not in scope: they are enriched through Discovery and the EPG chain.
- **Existing thin Films.** The 714 admitted Films need no separate import. Admitting them into eligibility is itself the backfill, drained at the bound of decision 4 (about five days).
  - Recommended: activate first for Films admitted **after** activation.
  - Then widen eligibility to the existing 714 by a separate owner decision, once the first results are reviewed.

### 7. Activation and rollback

- **Dormant delivery.** The implementation is delivered dormant: an in-code activation constant `false`, the same precedent as `LETTERBOXD_CLAIM_ACTIVATED`. Its merge and auto-deploy write nothing.
- **Activation.** A reviewed one-line change, made under an owner GO.
- **Rollback.** Revert the activation line. Metadata already written stays valid canonical data under the same precedence: it is not rolled back, and it can be corrected by the owner and review routes.
- **No flags.** No flag, Task, Access or schema change is required.

## Alternatives considered

- **Reuse the `metadata_sync` origin with a second eligibility source.**
  - For: an existing origin.
  - Against: it is bound to the EPG run document (`sync.json` intent carry), keyed by lid through `metadata_cache`, and stops when the Watchlist is pinned. It would mix two lifecycles in one origin.
- **Keep the rated enrichment on the R2 entry** (ADR 0207 option A or G3-a).
  - Against: no reader at `open`, and it leaves admitted Films thin.
- **Retire it and accept thin metadata** (the previous ADR 0207 decision 6). It is rejected by the owner's 6C.
- **A Letterboxd-page-only source.**
  - Against: it needs a Letterboxd id or path, which inferred and short-code Films may lack. TMDB has the canonical id for every admitted Film.

## Consequences

- **Admitted Films stop being thin.** For the global catalog, every Film entering through any route gets canonical metadata from the same writer, without depending on EPG airing.
- **New moving parts.** One origin, one bounded tick step, and one lease row in an existing lease store (the implementation card names it). Fetch cost stays bounded.
- **Two automatic producers can write the same Film.** Precedence makes the order of their writes irrelevant to owner and reviewed values, but automatic values follow the newest observation.

## Recovery and migration boundary

- No schema migration is expected. If the lease needs a new row or table, the implementation card states it.
- Activation is reversible by reverting a code constant. Written metadata is kept.
- Widening the scope to existing Films is a separate owner decision.
- This ADR, even when Accepted, authorizes no activation, fetch or write.

## Evidence

- The survey of the canonical metadata writers made for this record (24 Nov 2026), summarized in the Context.
- Production L0 read, 24 Nov 2026 12:21 UTC: Watchlist marker `d1` generation 3; 714 of 714 admitted Films without `film_metadata` and without `film_sync_state.metadata_at`.

## Follow-ups

On acceptance: the dormant implementation and the activation cards of the ADR 0207 delivery graph, and the separate scope widening.
