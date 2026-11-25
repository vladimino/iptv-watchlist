# ADR 0217: A verified Letterboxd film with no TMDB movie may be admitted as a canonical Film through the D1 admission coordinator, with a proof rule that does not need TMDB

**Status:** Proposed  
**Original decision date:** not decided  
**Recorded at:** 2026-11-25, from `main` `961c045`. That commit includes the Accepted [ADR 0216](0216-canonical-film-lifecycle-and-unified-read-contract.md) (merged in [PR #991](https://github.com/vladimino/iptv-watchlist/pull/991)) and the dormant receipt operation key of AIR-600 (migration `0039`). Revised the same day after the [independent review](https://github.com/vladimino/iptv-watchlist/pull/996#issuecomment-7162637094) of `0e4682ee`.  
**Approval source:** not documented. There is no owner decision yet, and choices H to M below are open.  
**Related work:** [AIR-643](https://trello.com/c/e1Q9H1bG), which is ADR 0216 choice A2 and delivery step 9. Builds on [ADR 0207](0207-letterboxd-admissions-coordinated-in-d1-only.md), [ADR 0211](0211-catalog-enrichment-producer.md), [ADR 0213](0213-film-identity-evidence-ledger.md) and [ADR 0215](0215-identity-evidence-full-model.md). The production census is [AIR-627](https://trello.com/c/IOERZ9GI)'s and is not repeated here. Proposed [ADR 0218](https://github.com/vladimino/iptv-watchlist/pull/997) (lifecycle dimensions) is independent of this record.  
**Supersedes:** None. If accepted with the recommended options, it amends ADR 0207 decisions 2, 3 and 4 (one more admission kind and one attach kind) and ADR 0215 decision 3 (one more minting id). Choice K1 would also amend ADR 0215 decision 2; the recommended K2 does not. Choice M and the enrichment scope are left to later decisions; nothing in ADR 0211, ADR 0154 or AIR-387 changes here.  
**Superseded by:** None

## Context

### What this record does not reopen

| Concern | Accepted source |
| --- | --- |
| Typed stable Film identity; a `film:` id is not an observation key | [ADR 0009](0009-canonical-film-person-identity.md) |
| Film/Person D1 authority: per-Film `canonical_revision`, redirects, retirement decisions (TMDB movie ids only) | [ADR 0099](0099-canonical-film-person-d1-authority.md) |
| A Film outlives the EPG and the Watchlist. `retainFilm` keeps a Film and never creates one (`src/film-admission.js:120`) | [ADR 0086](0086-durable-watchlist-film-retention.md) |
| A rated archive short code is a candidate, not a Film | [ADR 0087](0087-rated-archive-film-admission.md), [ADR 0090](0090-rated-identity-redirect-proof-and-retry.md) |
| The Diary page check and its bounded fetches | [ADR 0166](0166-diary-rated-only-identity-bridge.md) |
| A trusted `letterboxd` claim on an existing Film needs the full Ratings-link proof | [ADR 0184](0184-ratings-confirmed-letterboxd-claim-on-existing-film.md) |
| D1 is the only admission coordinator: marker `letterboxd_admission_authority`, keep-first rows, operation key K2, reconcile-then-reserve | [ADR 0207](0207-letterboxd-admissions-coordinated-in-d1-only.md); key column delivered dormant by AIR-600 |
| Enrichment scope: initially `film_rated_admission.verified_at` at or after the control's cutoff | [ADR 0211](0211-catalog-enrichment-producer.md) decision 4 |
| Evidence ledger: `exists` reserved and unused; minting ids carry no row; a non-minting id needs evidence; readers only through E4 | [ADR 0213](0213-film-identity-evidence-ledger.md); [ADR 0215](0215-identity-evidence-full-model.md) decisions 2, 3, 4 and 8 |
| Existence separate from facts, typed input grammar, unified read, candidate coverage, availability alias set | [ADR 0216](0216-canonical-film-lifecycle-and-unified-read-contract.md) |
| Prediction eligibility is decided by the prediction domain | [ADR 0154](0154-prediction-eligibility-independent-of-epg.md) |
| Public permalink `/film/tmdb_<n>` for a trusted movie; `/film/<lid>` is the alias and fallback | AIR-387, [UI read models](../architecture/ui-and-read-models.md#one-permanent-film-url-air-387) |

### Source, proof and authority matrix (code at `main` `961c045`)

Every live path that creates a Film requires a TMDB movie id.

| Entry point | Writer and receipt origin | Proof today | Creates | Fence | Domain settlement after the canonical batch |
| --- | --- | --- | --- | --- | --- |
| Watchlist sync admission (ADR 0186) | `letterboxd-sync-admission.js` → `LetterboxdDiaryIdentity.resolve` → `admitRatedFilm`; origin `rated_admission_retention` | page check, **plus** exactly one movie `data-tmdb-id` and an agreeing TMDB document | `film:tmdb:<n>` | Film/Person marker and generation, revision CAS, Sync epoch | `watchlist_admission_pending`. It resolves only on a returned label or a TMDB Diary link (`letterboxd-sync-admission.js:51-68`) |
| Ratings Diary bridge (ADR 0166) | `letterboxd-diary-identity.js:200` → `admitDiaryFilm` → `admitRatedFilm`; same origin | the same page check | `film:tmdb:<n>` | as above, plus the ratings epoch fence | `diary-identity.json`: the `linking` intent carries the movie id, then the Ratings alias link `letterboxd:<lid>` ↔ `tmdb:<n>` |
| Rated archive identity step (ADR 0087/0090) | `commitVerified` → `applyCanonicalRatedAdmission`; same origin | short code → `boxd.it` → page → movie id → TMDB document | `film:tmdb:<n>` | as above | the `admitting` candidate row, then the rating |
| Inferred baseline import | `admitInferredFilm` (`letterboxd-facts.js:575`); same origin | title and year search, marked `inferred` (never proof) | `film:tmdb:<n>` | as above, plus the chunk intent | the chunk receipt |
| Discovery (EPG) | `admitDiscoveryFilms` (`canonical-discovery-admission-producer.js:166`) | a verified Discovery key `tmdb_<n>`; resolves the trusted owner first | `film:tmdb:<n>` | Discovery route gate, Film/Person fence | Discovery decision |
| Producer Workflow `film_facts` | `writeFilmFacts` (`canonical-film-writers.js:254`) | a prefixed id is taken **directly**, so `tmdb_<n>` becomes `film:tmdb:<n>` with **no owner lookup**; a bare lid needs an existing claim or `film:<lid>` | `film:tmdb:<n>` | receipted, fenced | — |
| Owner actions, prediction recovery (ADR 0201) | — | — | nothing | — | — |
| Metadata, dictionary, persons, external ids, the ADR 0184 claim | `requireExisting: true` | — | nothing | — | — |
| Historical import and backfill | `scripts/d1-backfill.mjs`, `scripts/offline-import.mjs` | the R2 lifecycle record | including `film:<lid>` | import receipts; not a live writer | — |
| Merge | `mergeFilms` (`canonical-mutations.js:184`). It moves `film_rated_admission` and `film_retention` (`:227-240`) | — | `film_redirect` | bundled, **no caller** | — |
| Retirement | `recordRetirementDecision`, for TMDB movie ids only | — | — | **not bundled** | — |

Facts that shape the design:

- **`film:<lid>` is a historical minting id.** `localFilmId()` (`src/domain/film-person.js:40`) mints it. The historical import created 406 such Films, and every one of them now also carries a trusted TMDB movie or TV identity (AIR-627 first census, quoted in ADR 0216). No live writer mints it. `canonicalFilmId()` also maps a stored **slug** to `film:<slug>`, so readers share the bare `film:<x>` namespace between lids and slugs.
- **The only lid proof needs TMDB.** `verifyPage` (`src/letterboxd-diary-identity.js:23`) requires all of the following, then an agreeing TMDB document:
  - the `boxd.it/<lid>` redirect reaches `/film/<slug>/`;
  - the page shortlink equals the lid;
  - the canonical path agrees;
  - the page has a title and exactly one year;
  - the page carries exactly one `data-tmdb-id` of type `movie`.

  The challenge detector (`src/letterboxd-identity.js:73-84`) already stops on bot-protection pages.
- **TMDB outcomes are not fully typed.** `movieDetail` (`src/letterboxd-rated-candidates.js:216`) separates transport stops but folds a `404` into `tmdb_fetch_failed` together with every other non-200.
- **The settlement paths assume a movie.** The Watchlist ledger, the Diary `linking` intent and the rated candidate row all carry a movie id. The ADR 0211 enrichment scope is keyed on `film_rated_admission`.
- **Late identity is not executable today.** The `film_external_ids` unit never writes `canonical_identity` or the title (`canonical-film-external-ids-producer.js:18`). Only that unit adds a claim to an existing Film.

### Why the gap matters, and why it is not a defect

The AIR-627 census found **no** pure lid-only Film. Letterboxd lists films that TMDB does not hold, such as shorts, festival titles and regional releases. A Watchlist or Diary entry for such a film stays pending in its domain forever: no Film, permalink, metadata or prediction, and no place in a global catalog. This is a future capability, and every rule below keeps the TMDB-proved path byte-identical.

## Decision (proposed)

### 1. What a lid-only Film is, and where it may come from

A **lid-only Film** is a canonical Film admitted on the proof of one verified Letterboxd film id, with no trusted `tmdb` claim at admission. In every other respect it is an ordinary Film: a permanent id, retention, the unified read (ADR 0216), and never deleted for lacking TMDB.

**Eligible entry points.** Only the three that already verify a lid on Letterboxd itself:

- the Watchlist sync admission (`watchlist_admission`);
- the Ratings Diary bridge (`ratings_diary`);
- the rated archive identity step (`letterboxd_rated_archive`), once its short code has been resolved to a lid through `boxd.it`.

**Never eligible:**

- the inferred import (title and year search);
- Discovery (an EPG title is never proof of a Letterboxd id);
- the producer Workflow;
- owner routes;
- any read;
- any bare sighting. ADR 0215 decision 2 is unchanged.

### 2. Proof without TMDB (choice H)

The writer performs the proof at write time, and a caller never supplies it. The recommended rule, H1, is a **complete, validated film page with a positively absent TMDB relation**. The page passes only if every check below holds:

1. `GET boxd.it/<lid>` redirects to `https://letterboxd.com/film/<slug>/` within the ADR 0166 limits.
2. The film page answers `200`, with a **complete** body under the existing byte cap: no truncation, no abort, no timeout.
3. The page is not a challenge page by the existing detector.
4. The page's own shortlink equals the lid, and its canonical path equals the redirect target.
5. The page's film type marker is present and readable, and the title is not empty.
6. The block where Letterboxd carries external ids is present and parsed, and it holds **no** TMDB id of any type. A page whose block is missing or unreadable is `tmdb_unreadable`, never "no TMDB".

**The evidence digest** is the existing deterministic `sha256(lid, slug, path, tmdb, title, year, source)`, with `tmdb` empty.

**The year is optional for a lid-only admission only.** A page without exactly one year is admitted with `year` unknown. The existing movie path keeps its one-year requirement unchanged.

**Never proof, alone or together:**

- a slug;
- a short code not resolved through `boxd.it`;
- a title, a year, or a title-and-year match;
- an inferred link;
- a Watchlist listing;
- an `exists` sighting.

### 3. Typed TMDB states: only `tmdb_none` admits

| State | Observed | Outcome |
| --- | --- | --- |
| `tmdb_movie` | exactly one movie id, and the TMDB document agrees | the existing path to `film:tmdb:<n>`, unchanged |
| `tmdb_disagrees` | one movie id, and the TMDB document disagrees | the existing review outcome; never lid-only |
| `tmdb_none` | a complete validated page with a positively absent TMDB relation (H1) | **lid-only admission** |
| `tmdb_tv` | the page names a TMDB TV id | not admitted; pending `tmdb_not_movie` until a separate TV decision |
| `tmdb_missing` | a movie id that TMDB answers `404` for | pending `tmdb_contradiction`, for owner review |
| `tmdb_unavailable` | transport failure, rate limit, challenge, missing token, timeout | non-terminal; no attempt spent (ADR 0207 decision 4b) |
| `tmdb_failed` | any other non-200, or an unparseable document | pending `tmdb_fetch_failed`, one attempt counted |
| `tmdb_unreadable` | truncated or malformed HTML, an unreadable type marker or id block, several ids | pending `page_unreadable`, one attempt counted |

No state is ever downgraded to `tmdb_none`. Delivering this table needs `movieDetail` to return a `404` as its own state.

### 4. Stable id and uniqueness (choice I)

The recommended option, I1, mints **`film:lb:<lid>`**.

- It is a minting id (ADR 0215 decision 3 is extended to it): no `film_has_id` row, and readers never require one.
- The same batch writes the trusted, non-conflicting claim `film_external_id ('letterboxd', <lid>)`. The existing partial unique index `film_external_id_one_trusted` makes "one trusted owner per lid" a database invariant. That index is the proof of uniqueness, not the spelling of the id.
- `canonical_identity` stays null until a TMDB attach (decision 8).
- **Why not `film:<lid>`.** That namespace is shared with slugs in `canonicalFilmId()`, and all 406 historical `film:<lid>` Films hold a TMDB identity. `film:lb:` cannot collide with `film:tmdb:` or `film:conflict:`, because a lid has no colon. It needs no schema change, because `film.id` only checks `LIKE 'film:%'`.

### 5. Writer: the ADR 0207 coordinator, one per-lid key across kinds (choice J)

The recommended option, J1, adds **no parallel writer**. Lid-only admission and the later TMDB attach are two new kinds of the ADR 0207 coordinator. They run only at `letterboxd_admission_authority = d1`, and under `r2` and `closed` they are refused before their first effect.

**Origin and key.**

- Every receipt of this record uses the existing origin `rated_admission_retention` (`RATED_ADMISSION_ORIGIN`). Receipt uniqueness and the history fingerprint are scoped to `(origin, operation_key)`, so one origin keeps one history per lid.
- The key is the **same** `admission:lid:<lid>` that ADR 0207 already gives the TMDB-proved Diary and Watchlist admission of that lid. All three kinds share it: `lid` (TMDB-proved), `lid_only` and `lid_tmdb_attach`. The kind is part of the receipt's content digest, not of the key, so a lid has **at most one unresolved attempt across all its outcomes**, and the partial unique index enforces it.

**How the other kinds and routes correlate.**

| Other key | Relation to `admission:lid:<lid>` |
| --- | --- |
| `admission:short_code:<code>` (rated archive) | The rated step resolves the code to a lid **before** reserving. It then reads both histories and asserts **both** fingerprints in the reserve batch, so a concurrent short-code attempt on the same work loses and replans. A code that does not resolve to a lid never reaches lid-only. |
| `admission:inferred_import:<code>` | The inferred import never takes the lid-only path. It admits `film:tmdb:<n>` and leaves an inferred Ratings link. A lid-only attempt therefore checks the Ratings link index under the ratings epoch fence: when `letterboxd:<lid>` shares a fact key with any `tmdb:<n>` alias, it does not mint and records pending `ratings_tmdb_link`, so the TMDB path or the owner decides. |
| Discovery | Never touches a lid. It meets this record only through the trusted `tmdb` owner at attach time (decision 8). |

**Durable writer record before the first effect.** The domain record states the intended outcome before any canonical effect:

- the Diary and Watchlist `linking` intent gains `kind: lid_only` and the evidence digest, with `tmdb: null`;
- the rated step stores `intendedTmdb: null` and `kind: lid_only` on its `admitting` row.

Reconcile-then-reserve (ADR 0207 decision 3) compares that intent with every applied receipt of the key.

**The canonical batch** is one `mutateFilm` call. It contains:

1. the guards: Film/Person marker generation, admission marker mode `d1` and its generation, and the key's history fingerprint;
2. the **absence predicates**: no `film` row with the id, no `film_redirect` from it, no `letterboxd` claim of **any** trust for the lid on any Film, no `film_lid_admission` row for the lid;
3. the inserts: the `film` row, the trusted `letterboxd` claim (provenance `{source: <route>, adr: 0217, evidence: <digest>}`, naming no TMDB id), the `film_lid_admission` row, and the applied receipt tail.

That is 10 to 12 statements, within `STATEMENT_CAP` 40.

**`film_lid_admission`** is a new additive table:

- columns: `lid` (primary key), `film_id`, `route`, `admitted_at`, `receipt_key`, and the page-check evidence columns of decision 7;
- **keep-first and immutable:** triggers refuse `UPDATE` of every column except `film_id`, and refuse `DELETE`;
- no foreign key, like the other canonical side tables. Readers resolve `film_id` through `film_redirect`.

A keep-first row means "admitted lid-only". It **never short-circuits a later attach**. A re-check that finds `tmdb_movie` continues to decision 8 instead of answering `present`.

**Settlement after the canonical batch.** The domain settles in its own batch under its own fence (the ratings epoch for Diary and Watchlist, the candidate document for the rated step), as ADR 0207 already does. A crash between the two batches is recovered from durable state: the retry finds the applied `lid_only` receipt for the same lid and the same intent, answers `present`, and settles. It fetches nothing and writes no evidence.

**Merge and retirement.**

- `mergeFilms` must move `film_lid_admission.film_id` exactly as it moves `film_rated_admission`: the row moves when only the retired Film holds one, and two different rows are a merge conflict. Until that is delivered, a merge involving a lid-only Film is refused `film_lid_admission_unmerged`.
- There is **no live lid retirement path**. The retirement ledger knows TMDB movie ids only. A wrongly admitted lid-only Film is corrected by an owner action under a later decision, never by a delete.

### 6. Outcomes for each case

| Case | Durable state seen | Outcome |
| --- | --- | --- |
| 1. Valid lid-only | no row, no claim, `tmdb_none`, no Ratings TMDB link | `admitted_lid_only`; Film `film:lb:<lid>` |
| 2. Unverified slug or short code | the input is not a resolved lid | refused before any write: `lid_unverified` |
| 3. Upstream unavailable | Letterboxd or TMDB transport failure | pending `source_unavailable` or `deferred`; non-terminal |
| 4. Duplicate or replay | an applied `lid_only` receipt of the key with the same intent, or a `film_lid_admission` row | `present_lid_only`; settle only; no fetch, no evidence |
| 4b. Lid already held trusted by a TMDB Film | a trusted `letterboxd` claim of the lid on `film:tmdb:<n>` | `present`: an existing Film. Not a conflict and not lid-only |
| 5. Concurrent lid-only and TMDB-proved attempts on the lid | one shared key | one unresolved attempt; the loser fails its fingerprint and replans |
| 5b. Concurrent Discovery admission of the movie | `film:tmdb:<n>` minted meanwhile | no effect on lid-only; at attach time, case 7 |
| 5c. Two lids of one work | two `film:lb:` Films | allowed; two Films until a proved, owner-confirmed merge. No title matching |
| 6. Late TMDB claim | a re-check finds `tmdb_movie` | decision 8 |
| 7. Competing claim | an untrusted or conflicting claim of the lid; or the movie held by another Film at attach | `admission_conflict` or `tmdb_on_other_film`; owner review |
| 8. Retirement or TV | `tmdb_tv`; the movie retired at attach | not admitted; attach refused `tmdb_retired` |
| 9. Merge, redirect, history | the target is a redirect source | `film_person_redirect`, non-terminal; the readback follows the redirect |
| 9b. Replay after attach or merge | an applied receipt whose target is now redirected or attached | the readback follows the redirect; an applied `lid_only` receipt is historical, and current state decides |
| 10. Leaving the Watchlist | the lid is removed from the list | the Film stays (ADR 0086); membership follows ADR 0216 |
| 11. Missing optional metadata | no year, no synopsis | admitted; the fields are `unknown`, never invented |

### 7. Page-check evidence (choice K)

The recommended option, **K2**, adds no ledger row for the admission.

- The proof is stored durably on the immutable `film_lid_admission` row: the evidence digest, and every input it binds (`lid`, `slug`, `path`, `title`, `year`, the TMDB state `none`), plus `route`, the final URL, the HTTP status and `checked_at`. The row is kept forever.
- A verifier can recompute the digest from the stored inputs. The digest equals the `source_root` that a future ledger row would use, so a later ledger import maps it record by record (ADR 0215 decision 7).

The alternative **K1** writes `asserts exists(letterboxd_lid <lid>)`, method `page_check`, in the admission batch. That **amends ADR 0215 decision 2**: its revisit trigger is a cross-domain reader of sightings of entities not yet admitted, which an admitted Film is not. K1 would need all of the following, and it brings no proof that K2 lacks:

- its evidence key;
- a writer control row `lid_only_admission` with coverage under ADR 0215 decision 4;
- the semantic-identity assertion;
- the causal root (the digest);
- schema E1 delivered;
- its own activation.

**The later TMDB attach is non-minting**, so it always needs evidence (ADR 0215 decision 3): `asserts film_has_id(film:lb:<lid>, tmdb_movie <n>)`, method `page_check`, with the attach's route and the digest of the re-check as its root, in the attach batch. That makes ledger E1 and a writer control row `lid_tmdb_attach` prerequisites of the attach card.

No reader uses any of this to decide anything without its E4 amendment.

### 8. A later verified TMDB movie (choice L)

The local id never changes. The attach is **one** fenced, receipted batch of a new kind, `lid_tmdb_attach`, under the shared key. It is not the `film_external_ids` unit followed by a second commit.

**Proof.** A fresh page check in state `tmdb_movie`, with an agreeing TMDB document.

**In-batch assertions:**

- marker generations (Film/Person and admission);
- the Film revision (CAS);
- the Film exists and is not redirected;
- no `tmdb` claim of **any** trust for that movie on any Film;
- no other `tmdb` claim on this Film;
- `canonical_identity` is null;
- no non-superseded retirement decision for the movie;
- no owner identity authority on the Film's identity dimension (the `strong()` rule), else `owner_kept`;
- the evidence assertion of decision 7.

**Writes:**

- the trusted `tmdb` claim, with provenance `{source: <route>, adr: 0217, evidence: <digest>}`;
- `canonical_identity = 'tmdb:<n>'`;
- the evidence row;
- the receipt tail.

The title, owner or reviewed fields, and every historical storage key (ratings, Diary, predictions under the lid) are untouched.

**Readback.** Success is reported only when a fresh read finds both the claim and `canonical_identity`. An applied receipt without them is `unknown`.

**Every writer that spells `film:tmdb:<n>` must resolve the trusted owner first.**

- `resolveAdmissionFilm` and Discovery's `planAdmissionFilm` already do.
- `writeFilmFacts` takes a `tmdb_<n>` source id directly. The attach card must change it to resolve the trusted owner first, and to refuse minting `film:tmdb:<n>` when any claim of that movie exists. Without this, a sealed programme could create a duplicate Film.

**Permalinks.** After the attach, `/film/tmdb_<n>` is canonical by the AIR-387 rule, and `/film/<lid>` keeps working as its alias.

**Movie already held by another Film.** The recommended option, L1, is a typed conflict `tmdb_on_other_film` recorded for owner review, with no automatic merge. No merge writer is live, and a future merge must also move `film_lid_admission` (decision 5). The alternative, L2, merges automatically when both proofs pass; it is not recommended while no merge writer and rollback exist.

### 9. Consumers and settlement

Activation (delivery step 8) needs **every** row of this table delivered, not only the aggregate route.

| Consumer | Behaviour for a lid-only Film |
| --- | --- |
| Watchlist admission ledger | A new typed success, `resolvedBy: 'identity:lid_only'`. `resolve` returns a label with `tmdb: null`, and the settlement accepts it in addition to "label or TMDB link". A pending lid-only attempt keeps its row due; a terminal outcome keeps its reason. |
| Ratings Diary | The Diary entry stays on the existing `lb-<lid>` fact key. **No `tmdb:` alias is invented.** The `linking` intent is cleared with outcome `lid_only`. |
| Rated archive candidate | State `admitted` with `tmdb: null`; the rating is written under the lid's fact key. |
| Watchlist membership projection (ADR 0203) | Keyed on the Film through the trusted `letterboxd` claim; the card verifies that the projection accepts `film:lb:`. |
| Unified read (ADR 0216) | Typed ids `film:lb:<lid>` and the bare lid; `tmdb_<n>` answers `absent`. Availability follows ADR 0216 exactly: a published generation **may** name the lid, so "no TMDB claim" is never proof of "no shows". |
| Permalink serving | `/film/<lid>` is served through the lid's trusted claim. No `tmdb_` permalink is invented. |
| `GET /api/catalog/film/<tmdbId>` | Not reachable (movie id only); unchanged. |
| Enrichment (ADR 0211) | **Not eligible.** The ADR 0211 scope is `film_rated_admission.verified_at` at or after the cutoff, and `film_lid_admission` is not in it. Extending the scope is a separate decision and activation. |
| Predictions (choice M) | M1 is recommended: prediction eligibility (ADR 0154) excludes a Film with no trusted `tmdb` claim until a separate decision. Historical predictions under the lid stay stored and readable. The aggregate reports `predictions` as `partial` with reason `not_eligible_lid_only`, never `none`. M2: eligible with partial features. |
| Prediction recovery (ADR 0201) | Unchanged; it keeps its strict TMDB bridge. |

### 10. Target structure (text; no diagram until the owner chooses)

```
Letterboxd page check (H1) ─ tmdb_none ─► coordinator kind lid_only
   key admission:lid:<lid>, origin rated_admission_retention
   one batch: film film:lb:<lid> + trusted letterboxd claim
              + film_lid_admission (immutable proof) + receipt
        └─ domain settlement (Watchlist ledger / Diary intent / rated row)
later page check ─ tmdb_movie ─► kind lid_tmdb_attach, same key
   one batch: trusted tmdb claim + canonical_identity
              + film_has_id evidence + receipt
   movie held elsewhere ─► tmdb_on_other_film (owner review)
```

A Mermaid diagram for [Film/Person lifecycle](../architecture/film-person-lifecycle.md) is added with the implementation card, once the options are chosen, so that rendered QA reviews the selected design and not the alternatives.

## Alternatives considered (open owner choices)

| Choice | Recommended | Alternatives |
| --- | --- | --- |
| H. Proof | **H1**: a complete validated page with a positively absent TMDB relation | H2: H1 plus a second independent root (a Ratings fact record of the lid). H3: owner statement only |
| I. Stable id | **I1**: `film:lb:<lid>` | I2: reuse historical `film:<lid>` (slug namespace, indistinguishable from imported Films). I3: opaque random id (no deterministic replay) |
| J. Writer | **J1**: kinds of the ADR 0207 coordinator, one origin, one key per lid, immutable `film_lid_admission` | J2: relax `film_rated_admission.tmdb` to nullable (rewrites a mandatory column and the scope ADR 0211 reads). J3: a separate writer (excluded by the card) |
| K. Admission evidence | **K2**: durable recomputable proof on `film_lid_admission`; the attach always writes `film_has_id` | K1: an `exists` row, as an explicit amendment of ADR 0215 decision 2 with its own writer control |
| L. Late TMDB on another Film | **L1**: typed conflict, owner review | L2: automatic merge |
| M. Predictions | **M1**: not eligible until its own decision | M2: eligible with partial features |

Rejected without a choice:

- title, year or slug matching as proof;
- admitting from Discovery or from a bare sighting;
- downgrading any TMDB state to `tmdb_none`;
- attaching TMDB through two separate commits.

## Consequences

- A Letterboxd film without TMDB gets a permanent Film, retention, a permalink and the unified read, and the TMDB-proved path is unchanged.
- Added to maintain: two coordinator kinds, one table, one typed TMDB state, one minting namespace, and a change in `writeFilmFacts` owner resolution. Readers that parse `film:` ids must accept `film:lb:`.
- Two lid-only Films of one work may coexist until a proved merge. This is visible, not silent.
- Enrichment and predictions stay off for these Films until their own decisions.

## Synthetic test plan

Synthetic fixtures only. Every refusal asserts that nothing was written.

1. **Valid page.** One Film `film:lb:<lid>`, one trusted claim, one immutable `film_lid_admission` row whose digest recomputes from its columns, one receipt, revision 1.
2. **Unproved input.** A slug, an unresolved short code, or a title or year input is refused.
3. **TMDB states.** Every non-admitting state of decision 3 gives its outcome. A `404` is distinct from other non-200 answers. Truncated, challenge, unreadable-marker and missing-id-block pages are `tmdb_unreadable`. A lid-only page without a year is admitted, while a movie page without one year is still refused.
4. **Replay and crash.** A replay, a lost response, or a crash between the canonical batch and the settlement gives `present_lid_only`: settled, with no second row and no fetch.
5. **Lid held by a TMDB Film.** `present`.
6. **Concurrency on one key.** Concurrent `lid_only` and `lid` attempts on one lid hold one unresolved receipt; the loser replans. A concurrent short-code attempt on the same work loses through the double fingerprint.
7. **Inferred Ratings link.** A link `letterboxd:<lid>` ↔ `tmdb:<n>` gives pending `ratings_tmdb_link`, and no Film is minted.
8. **Attach to a free movie.** One batch writes the claim, `canonical_identity` and evidence; the id is unchanged; both permalinks resolve; no key is renamed. A lost response followed by a readback: success only when the readback finds both.
9. **Attach races.** An attach concurrent with a Discovery admission of the movie gives exactly one trusted owner and either `tmdb_on_other_film` or a successful attach that Discovery then resolves. Movie retired, owner identity authority present, or another `tmdb` claim on the Film: refused.
10. **`writeFilmFacts` duplicate.** A `tmdb_<n>` source id of an attached movie resolves the lid-only Film and never mints `film:tmdb:<n>`.
11. **Merge.** A merge moves `film_lid_admission`; before that delivery it is refused.
12. **Admission marker.** At `r2` or `closed` both kinds are refused before the first effect, and legacy behaviour is byte-identical.
13. **Settlement per entry point.** The Watchlist ledger resolves `identity:lid_only`; the Diary entry stays on `lb-<lid>` with no TMDB alias; the rated candidate is `admitted` with `tmdb: null`.
14. **Consumers.** The unified read finds the Film by `film:lb:<lid>` and by the lid; `tmdb_<n>` is `absent`. Availability uses the ADR 0216 alias set. Enrichment does not select the Film. `predictions` is `partial` `not_eligible_lid_only`, never `none`.
15. **Statement count.** Every batch, at its largest, stays within `STATEMENT_CAP`.

## Cost

- One additive migration (`film_lid_admission` and its triggers), with no data migration.
- 10 to 12 statements per admission and about 12 per attach.
- No extra fetch: the existing check already loads the page.
- Volume is low and event-driven. The census found no current lid-only Film.

## Recovery and migration boundary

This record authorizes no migration, flag, Task, Letterboxd or TMDB production call, D1 or R2 write, or activation.

**Prerequisites of activation:**

- ADR 0207 activated (`d1`);
- the migration applied under its own approval;
- every consumer of decision 9 delivered;
- for the attach, ledger E1 and the `lid_tmdb_attach` writer control;
- a separate owner L3 GO with a rollback plan.

**Rollback.** Before the first lid-only Film exists, a code revert is an ordinary rollback. After that, a revert does not remove the Film, its claim or its proof row, so readers must keep accepting `film:lb:`. Correction is an owner action, never a delete.

## Delivery graph (no card is created by this record)

| Step | Kind | Content | Schema / API impact | Depends on | Gate |
| --- | --- | --- | --- | --- | --- |
| 1 | offline code | Typed TMDB states (`tmdb_missing`, `tmdb_unreadable`) on the existing path; nothing new admits | none | accepted ADR | review, CI |
| 2 | offline code | `writeFilmFacts` resolves the trusted `tmdb` owner first (test 10) | none | accepted ADR | review, CI |
| 3 | offline code and schema | Page check H1, `film:lb:` minting, the `lid_only` kind, the double-fingerprint short-code correlation, migration file `film_lid_admission`, K2 proof columns; tests 1–7, 12, 15 | new table; `canonical_write_receipt` reused | 1; ADR 0207 cards | review, CI, dormant deploy |
| 4 | offline code | Settlement of the three entry points; membership projection and permalink acceptance of `film:lb:`; unified-read cases (tests 13–14) | Watchlist ledger `resolvedBy` value; [film-person reference](../reference/domain/film-person.md), [catalog API](../reference/api/catalog.md) | 3; ADR 0216 step 3 | review, CI |
| 5 | offline code | `mergeFilms` moves `film_lid_admission` (test 11) | none | 3 | review, CI |
| 6 | offline code | The `lid_tmdb_attach` kind (tests 8–9) | [D1 schema](../reference/data/d1-schema.md) contract notes | 2, 3; ledger E1 and its writer control | review, CI |
| 7 | separate apply | Apply the migration | D1 schema version | 3 | owner-approved apply |
| 8 | separate activation | Enable lid-only admission, then the attach | — | 4–7; ADR 0207 activated | owner L3 GO and rollback plan |
| 9 | future decisions | Enrichment scope for `film_lid_admission`, prediction eligibility (M2), TV Films, a merge writer, lid retirement | — | — | owner decisions |

## Evidence

- **Original decision:** not yet; this record is Proposed.
- **Implementation:** none.
- **Dated verification:** code reading at `main` `961c045` on 2026-11-25. No production read.
- **Uncertainty:**
  - The number of pending Watchlist or Diary items in state `tmdb_none` is not measured here; that is AIR-627's census.
  - Whether Letterboxd pages without TMDB keep a stable, parseable external-id block must be shown on synthetic captures in step 3.

## Follow-ups

The next steps, in order: independent re-review of this revision; then owner choices H to M under the facilitation protocol; then the owner disposition; then implementation cards only.
