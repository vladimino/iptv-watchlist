# ADR 0217: A verified Letterboxd film with no TMDB movie may be admitted as a canonical Film through the D1 admission coordinator, with a proof rule that does not need TMDB

**Status:** Proposed  
**Original decision date:** not decided  
**Recorded at:** 2026-11-25, from `main` `961c045`. That commit includes the Accepted [ADR 0216](0216-canonical-film-lifecycle-and-unified-read-contract.md) (merged in [PR #991](https://github.com/vladimino/iptv-watchlist/pull/991)) and the dormant receipt operation key of AIR-600 (migration `0039`). Revised the same day after the [first independent review](https://github.com/vladimino/iptv-watchlist/pull/996#issuecomment-7162637094) of `0e4682ee` and the [second review](https://github.com/vladimino/iptv-watchlist/pull/996#issuecomment-7164448376) of `db8e300b`.  
**Approval source:** not documented. There is no owner decision yet, and choices H to M below are open.  
**Related work:** [AIR-643](https://trello.com/c/e1Q9H1bG), which is ADR 0216 choice A2 and delivery step 9. Builds on [ADR 0207](0207-letterboxd-admissions-coordinated-in-d1-only.md), [ADR 0211](0211-catalog-enrichment-producer.md), [ADR 0213](0213-film-identity-evidence-ledger.md) and [ADR 0215](0215-identity-evidence-full-model.md). The production census is [AIR-627](https://trello.com/c/IOERZ9GI)'s and is not repeated here. Proposed [ADR 0218](https://github.com/vladimino/iptv-watchlist/pull/997) (lifecycle dimensions) is independent of this record.  
**Supersedes:** None. If accepted with the recommended options, it amends ADR 0207 decisions 2, 3 and 4 (one more admission kind and one attach kind) and ADR 0215 decision 3 (one more minting id). Choice K1 would also amend ADR 0215 decision 2; the recommended K2 does not. Recommended M1 explicitly extends ADR 0154 decision 1 with one exclusion (decision 9). The enrichment scope of ADR 0211 and the AIR-387 permalink rules do not change.  
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
| Prediction eligibility: trusted identity, lane membership, profile/fingerprint/prompt compatibility (no TMDB condition) | [ADR 0154](0154-prediction-eligibility-independent-of-epg.md) |
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

**The proof digest** is defined in decision 7 and binds the outcome of every check above. **H1 is fail-closed:** it may be enabled only after a parseable absence marker is shown on permitted existing captures of real no-TMDB pages (delivery step 8).

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

### 5. Writer: the ADR 0207 coordinator, with one per-lid guard shared by every path that knows the lid (choice J)

The recommended option, J1, adds **no parallel writer**. Lid-only admission (`lid_only`) and the later TMDB attach (`lid_tmdb_attach`, decision 8) are new kinds of the ADR 0207 coordinator. They run only at `letterboxd_admission_authority = d1` and are refused before their first effect under `r2` and `closed`. Every refusal and recovery outcome of ADR 0207 decision 3 is kept, including `refused_after_link`.

#### 5a. Origin and the per-lid key

- Every receipt uses the existing origin `rated_admission_retention` (`RATED_ADMISSION_ORIGIN`). Receipt uniqueness, the partial unique index and the history fingerprint are all scoped to `(origin, operation_key)`.
- **The lid key `admission:lid:<lid>` is the guard of the lid.** ADR 0207 already gives this key to the TMDB-proved Diary and Watchlist admission (kind `lid`). Under this record:
  - `lid_only` and `lid_tmdb_attach` use it as their only key;
  - **every other path that knows the lid** also reserves under the lid key, **in addition to** its own key:
    - the rated archive step, once its short code has resolved to a lid;
    - the inferred import, for an item whose code is a lid (kind `lid` in ADR 0207 terms).
- A lid therefore has **at most one unresolved attempt across all paths and kinds**, enforced by the partial unique index on the lid key.
- **Dual reservation.** A path holding two keys reads both histories. It reserves both in **one** batch that asserts both fingerprints. It **finalizes** (canonical batch, terminal outcome or settlement) with both fingerprints asserted again. A failed assertion makes the attempt the loser: it writes nothing and replans (ADR 0207 decision 3, step 5).
- **The reservation precedes the first effect of any stage.** For the inferred import, that means before its Ratings link (`letterboxd-facts.js:718-747`: admission, link, then canonical stage). A link can therefore not be committed for a lid while another path's attempt on that lid is unresolved.
- **Historical receipts.**
  - Receipts written before the ADR 0207 flip have no key. The ADR 0207 parity pin requires 0 open admission receipts at the flip, so none of them can still land.
  - After the flip, receipts under the older keys (`admission:short_code:<code>`, `admission:inferred_import:<code>`) are read as part of the history whenever their code resolves to the lid, and settled by the same protocol.

#### 5b. Symmetric predicates in every canonical batch that touches a lid

The reservation serializes attempts. These predicates decide outcomes from durable state, inside the canonical batch, on **both** sides.

**The `lid_only` canonical batch asserts:**

- marker generations: Film/Person, admission marker mode `d1` and its generation;
- the **Sync epoch or ratings epoch fence** of the calling domain (`epochFence`, `ratings-d1.js:196`), as every Diary and Watchlist batch already carries;
- the lid key's history fingerprint;
- no `film` row with id `film:lb:<lid>` and no `film_redirect` from it;
- no `film_external_id ('letterboxd', <lid>)` of **any** trust on any Film;
- no `film_lid_admission` row for the lid;
- no `film_rated_admission` row with `source_code = <lid>`;
- **the Ratings link document itself.** The parts of `letterboxd/facts/links.json` that were read must still match in `ratings_document`: each `etag`, and the part count. The epoch alone is a lease fence, not a version of this document. The read found no `tmdb:` alias on the lid's fact key; if it had, the attempt would already have stopped at pending `ratings_tmdb_link`.

**The TMDB-proved and inferred canonical batches** (`admitRatedFilm` for a lid) add one predicate: **no `film_lid_admission` row for the lid**. When one exists:

| Moment it is seen | Outcome |
| --- | --- |
| by the planner, before any link | Diary and Watchlist: route to the verified attach path (decision 8), and mint nothing. Rated step: `needs_review lid_only_present`. Inferred import: `conflict`, with no link and no fact |
| only by the batch, after the inferred link | `refused_after_link`, exactly as ADR 0207 defines it. The inferred-marked link stays and is never claim proof; owner repair |

**The interval after the canonical batch and before settlement.** The canonical rows, the receipt and the lid guard are durable from the moment the batch commits. Until the domain settles, any other attempt on the lid fails its reservation (the receipt is applied, the fingerprint has moved) or sees the predicates above. Settlement replays from durable state (decision 6, case 4).

**Residual, stated.** An inferred item keyed only by a short code that never resolves to a lid cannot reserve the lid. Inferred admission is never proof, and lid-only admission requires the page to show no TMDB relation. Both existing for one work is therefore a visible contradiction (two Films, one of them inferred), reported by the inventory. It is never silently merged.

#### 5c. Records, settlement, merge

**Durable writer record before the first effect.**
- The Diary and Watchlist `linking` intent carries `kind: lid_only`, the `proof_digest`, and `tmdb: null`.
- The rated step's `admitting` row carries `intendedTmdb: null` and `kind: lid_only`.

**The canonical batch** is one `mutateFilm` call. It writes:
- the `film` row;
- the trusted `letterboxd` claim, with provenance `{source: <route>, adr: 0217, evidence: <digest>}`;
- the `film_lid_admission` row (decision 7);
- the applied receipt tail.

With the predicates of 5b it is 12 to 15 statements, within `STATEMENT_CAP` 40; the card measures the exact count.

**`film_lid_admission`.**
- Primary key `lid`; columns `film_id`, `route`, `admitted_at`, `receipt_key`, and the proof columns of decision 7.
- Keep-first and immutable: triggers refuse `UPDATE` of every column except `film_id` (a merge), and refuse `DELETE`.
- No foreign key; readers resolve `film_id` through `film_redirect`.
- The row never short-circuits a verified attach.

**Settlement.** The domain settles in its own batch under its own fence (decision 9). A crash before settlement is recovered from durable state (case 4).

**Merge and retirement.**
- `mergeFilms` must move `film_lid_admission.film_id`, as it moves `film_rated_admission`. Until that is delivered, a merge involving a lid-only Film is refused `film_lid_admission_unmerged`.
- There is no live lid retirement path. The retirement ledger knows TMDB movie ids only.

### 6. Outcomes for each case

"Writes nothing canonical" means: no `film`, claim, `film_lid_admission` or evidence row. A pending, review or terminal entry in the writer's own domain record, and a settled receipt, are still allowed.

| Case | Durable state seen | Outcome |
| --- | --- | --- |
| 1. Valid lid-only | no row, no claim, `tmdb_none`, no Ratings TMDB alias, lid guard free | `admitted_lid_only`; Film `film:lb:<lid>` |
| 2. Unverified slug or short code | the input is not a resolved lid | refused before reservation: `lid_unverified`; nothing canonical |
| 3. Upstream unavailable | Letterboxd or TMDB transport failure | pending `source_unavailable` or `deferred`; non-terminal |
| 4. Replay or lost response | an applied `lid_only` receipt of the lid key with the same intent, or a `film_lid_admission` row naming this route's intent | `present_lid_only`; settle only. **Replay** never fetches and never writes evidence. A genuinely new verification is a separate request (decision 8) |
| 4b. Lid already trusted on a TMDB Film | a trusted `letterboxd` claim of the lid on `film:tmdb:<n>` | `present`: the existing Film. Neither a conflict nor lid-only |
| 5. Concurrent attempts on the lid, any paths | the lid key | one unresolved attempt; the loser fails its fingerprint and replans |
| 5a. TMDB-proved or inferred path meets an existing lid-only Film | `film_lid_admission` for the lid | 5b table: routed to attach, `needs_review`, `conflict` or `refused_after_link`; never a second Film |
| 5b. Concurrent Discovery admission of the movie | `film:tmdb:<n>` minted meanwhile | no effect on lid-only; at attach time, case 7 |
| 5c. Two lids of one work | two `film:lb:` Films | allowed; two Films until a proved, owner-confirmed merge |
| 6. Late TMDB movie | an owner-requested re-check finds `tmdb_movie` | decision 8 |
| 7. Competing claim | an untrusted or conflicting claim of the lid; or the movie held by another Film at attach | `admission_conflict` or `tmdb_on_other_film`; owner review |
| 8. Retirement or TV | `tmdb_tv`; the movie retired at attach | not admitted; attach refused `tmdb_retired` |
| 9. Merge, redirect, history | the target is a redirect source | `film_person_redirect`, non-terminal; readback follows the redirect |
| 9b. Replay after attach, merge or correction | an applied receipt whose target has since changed | the receipt stays `applied` and is never rewritten; current claims and `canonical_identity` decide current usability |
| 10. Leaving the Watchlist | the lid leaves the list | the Film stays (ADR 0086); membership follows ADR 0216 |
| 11. Missing optional metadata | no year, no synopsis | admitted; the fields are `unknown` |

### 7. Page-check proof (choice K)

The recommended option, **K2**, keeps the proof on the immutable `film_lid_admission` row and writes no ledger row for the admission.

**Causal source root.** This is the proof of the page itself, independent of who observed it (ADR 0213 decision 2). It is `proof_digest = sha256(proof_version, lid, final film URL, slug, canonical path, shortlink, type marker, id-block outcome, completeness outcome, title, year or null)`. Every input is stored in its own column, so the digest can be recomputed. `proof_version` starts at `1` and changes whenever a check rule changes.

**Route observation metadata,** kept apart from the root:
- `route`;
- `checked_at`;
- the HTTP status of each hop;
- the receipt key.

Two routes that check the same page share one root.

**The proof is normalized, not archived.** No HTML is stored. Re-verification means a new check, not replaying a stored page.

The digest equals the `source_root` that a future ledger import would use, so the row maps record by record (ADR 0215 decision 7).

**K1** writes an `asserts exists(letterboxd_lid <lid>)` row, method `page_check`, in the admission batch. It is an **explicit amendment of ADR 0215 decision 2**: that decision's revisit trigger is a reader of sightings of entities not yet admitted, which an admitted Film is not. K1 would need all of the following, and K2 needs none of it:
- the evidence key;
- a writer control `lid_only_admission`, with coverage under ADR 0215 decision 4;
- the semantic-identity assertion;
- the root above;
- E1 applied;
- its own activation.

**The attach is non-minting, so it always needs evidence** (ADR 0215 decision 3), whatever K says. It writes `asserts film_has_id(film:lb:<lid>, tmdb_movie <n>)`, method `page_check`, route `owner_action`, with the re-check's `proof_digest` as root, in the attach batch. Its prerequisites:
- **E1 applied**;
- the writer control `lid_tmdb_attach` **in state `on`**. The attach batch asserts that state and its generation (ADR 0215 decision 4 fence).

In `off` or `pending` the attach is refused `evidence_writer_inactive`. There is never an attach without evidence. Rollback of the writer follows ADR 0215 decision 4: a recorded break, and coverage claimed only for the drained interval.

No reader uses any of this to decide anything without its E4 amendment.

### 8. A later verified TMDB movie (choice L)

#### 8a. Trigger: explicit and bounded; no new periodic producer

- A settled lid-only admission clears its intent. Replay (case 4) never fetches. So **a new verification has its own entry point**: an owner-only request `POST /api/admin/letterboxd/lid-recheck` with `{lid, requestId}`. It is one lid per request, behind the existing owner authentication, and it checks one page.
- Its intent is an owner intent record keyed by `requestId` under the lid key.
- **Replay vs new verification.**
  - The same `requestId` is a replay. It is answered from the intent and the receipt by readback, with no fetch.
  - A new `requestId` is a new verification.
- **Outcomes:**
  - `attached`;
  - `still_none` (nothing written);
  - `tmdb_on_other_film`;
  - `owner_kept`;
  - `tmdb_retired`;
  - `evidence_writer_inactive`;
  - any non-admitting state of decision 3.
- Transport failures are non-terminal. The owner retries with the same `requestId`, and no attempt is counted.
- **No automatic re-check is authorized.** A natural re-check by the Diary or Watchlist step when the lid reappears, or a periodic sweep, would each be a separate decision and activation. The Diary and Watchlist admission steps route a lid that already has a `film_lid_admission` row to `present_lid_only`. They do not re-check it.

#### 8b. The attach batch

The attach is one fenced, receipted batch of kind `lid_tmdb_attach`, under the lid key. It does not use the `film_external_ids` unit, and it is never two commits.

**Proof:** the fresh page is in state `tmdb_movie`, with an agreeing TMDB document.

**In-batch identity fence.** A revision CAS alone is not enough. The batch asserts all of the following:
- Film/Person generation; admission marker `d1` and its generation;
- the lid key fingerprint;
- the evidence writer state `on` and its generation;
- the Film revision;
- the target Film exists and is not a redirect source;
- the requested lid **still uniquely belongs to that survivor**: a trusted, non-conflicting `letterboxd` claim of the lid on the Film, no other `letterboxd` row of the lid (any trust) on any Film, and `film_lid_admission.film_id` resolving to the Film;
- no `tmdb` claim of the movie, of any trust, on any Film;
- no other `tmdb` claim on this Film, and `canonical_identity` null;
- no non-superseded retirement decision for the movie;
- the identity dimension is neither `reviewed` nor `owner` (both protected by `strong()`), otherwise `owner_kept`.

**Writes:**
- the trusted `tmdb` claim, with provenance `{source: owner_action, adr: 0217, evidence: <proof_digest>}`;
- `canonical_identity = 'tmdb:<n>'`;
- the evidence row;
- the receipt tail.

The title, owner and reviewed fields, and every historical storage key, are untouched.

**Readback and receipts.** Success is reported only when a fresh read finds both the claim and `canonical_identity`. An applied receipt is terminal and never rewritten: after a later correction or merge it stays `applied`, and current state decides what is usable.

#### 8c. Settlement after the attach

- **The Ratings link is not created by the attach.** A trusted claim is not a Ratings fact alias. After the canonical batch, the same owner intent hands the verified pair `letterboxd:<lid>` ↔ `tmdb:<n>` to the **existing** Ratings alias protocol (the ADR 0166 link step, `linkOrNote`), under the ratings epoch fence. The `lb-<lid>` fact key gains the movie alias there, as a Diary-first link already does. No key is renamed.
- **Retry.** The intent stays open until the link step answers `linked` or `alias_conflict`. A conflict goes to owner review. A later request with the same `requestId` resumes the link step only; it never re-attaches.
- **No `film_rated_admission` row.** The attach does not write one, so the Film stays **outside** the ADR 0211 enrichment scope until that scope is amended. A replay cannot grant eligibility, and nothing that existed is lost.

#### 8d. No duplicate `film:tmdb:<n>` from any writer

Every writer that spells `film:tmdb:<n>` must resolve the trusted owner first.

- `resolveAdmissionFilm` and Discovery's `planAdmissionFilm` already do this.
- **`writeFilmFacts` must change on both sides of the receipt:**
  - **at planning,** the producer resolves `tmdb_<n>` to the trusted owner (any claim of the movie: owner, or refuse as held), and binds that id as the receipt target;
  - **inside the batch,** when it would create a Film, it asserts that no `film_external_id ('tmdb', <n>)` of any trust exists. A plan made before an attach therefore fails, instead of minting a duplicate. The writer receives an id, revision and receipt tail that are already bound (`canonical-film-writers.js:254-258`), so the predicate has to be inside the batch.

**Old code.** Before the first attach is activated, drain evidence must show that no Worker version older than that change serves traffic and no Workflow instance of such a version is running (the ADR 0207 decision 1 drain pattern). An older version could still mint the duplicate, so missing evidence stops the activation.

**Permalinks.** `/film/tmdb_<n>` becomes canonical after the attach (AIR-387), and `/film/<lid>` keeps working.

**Movie held by another Film.**
- The recommended option, **L1**, records a typed `tmdb_on_other_film` for owner review, with no automatic merge.
- **L2**, an automatic merge, is not recommended while no merge writer exists.

### 9. Consumers, settlement, eligibility

Activation needs **every** row of this table delivered, not only the aggregate route.

| Consumer | Lid-only Film |
| --- | --- |
| Watchlist admission ledger | Typed success `resolvedBy: 'identity:lid_only'`. `resolve` returns a label with `tmdb: null`, and settlement accepts it in addition to "label or TMDB link". Pending keeps the row due; terminal keeps its reason. |
| Ratings Diary | The entry stays on the existing `lb-<lid>` fact key, with no invented `tmdb:` alias. The `linking` intent is cleared with outcome `lid_only`. |
| Rated archive candidate | `admitted`, with `tmdb: null`. The rating is written under the lid's fact key. |
| Membership projection (ADR 0203) | Keyed on the Film through the trusted `letterboxd` claim. The card verifies that `film:lb:` is accepted. |
| Unified read (ADR 0216) | Typed ids `film:lb:<lid>` and the bare lid. `tmdb_<n>` answers `absent` until an attach. Availability follows the ADR 0216 alias set: a published generation may name the lid. |
| Permalink | `/film/<lid>`, through the lid's trusted claim. |
| `GET /api/catalog/film/<tmdbId>` | Movie id only; reachable only after an attach. |
| Enrichment (ADR 0211) | Not in the ADR 0211 decision 4 scope (`film_rated_admission.verified_at`), before or after an attach (8c). Extending it is a separate decision. |
| Prediction recovery (ADR 0201) | Unchanged; keeps its strict TMDB bridge. |

**Prediction eligibility (choice M).** ADR 0154 decision 1 conditions eligibility on a trusted Film identity, lane membership, and profile, fingerprint and prompt compatibility. It does **not** require a TMDB claim. A trusted `letterboxd` minting identity could therefore make a lid-only Film eligible under today's policy.

- **M1 (recommended): defer the new cohort explicitly.** This **extends** the ADR 0154 policy with one exclusion: a Film with no trusted `tmdb` claim **and** a `film_lid_admission` row is not admitted to the prediction queue. The exclusion is enforced:
  - at the queue rebuild's Film admission;
  - at the manifest build;
  - by the per-film `submit` guard;

  so a stale queue cannot submit it. No model is invoked for it. This exclusion ends only with M2.
- **Reads stay truthful and separate from eligibility.** The aggregate keeps ADR 0216 sections 5 and 6b unchanged: known historical values and conflicts under authorized aliases are reported as read; `none` is returned only under full negative proof; coverage is what it is. Eligibility is a **separate** field, `predictions.eligibility: {status: "not_eligible", reason: "lid_only_deferred"}`. It never turns a present or conflicting value into `partial`, and it never invents incompleteness.
- **M2: a separately designed activation.** It needs a defined feature contract for a Film without TMDB metadata (which fingerprint inputs are absent, and how the prompt contract treats them), its eligibility prerequisites, and its effect on the existing pipeline's budgets. It needs its own decision before any code.

### 10. Target structure (text; no diagram until the owner chooses)

```
paths that know a lid ──reserve── admission:lid:<lid>  (origin rated_admission_retention)
  Diary / Watchlist / rated (resolved) / inferred (lid)        one unresolved attempt per lid
page check H1 ─ tmdb_none ─► lid_only batch
   predicates: absences, links.json etags, epoch, fingerprints, markers
   writes: film film:lb:<lid> + trusted letterboxd claim + film_lid_admission + receipt
        └─ domain settlement (ledger / Diary intent / rated row)
TMDB-proved or inferred path meeting film_lid_admission ─► attach route / review / refused_after_link
owner lid-recheck ─ tmdb_movie ─► lid_tmdb_attach batch (evidence writer on)
   writes: tmdb claim + canonical_identity + film_has_id evidence + receipt
        └─ existing Ratings alias link step (retry via the intent)
```

The Mermaid change to [Film/Person lifecycle](../architecture/film-person-lifecycle.md) comes with the implementation card, for the selected design, with rendered QA.

## Alternatives considered (open owner choices)

| Choice | Recommended | Alternatives |
| --- | --- | --- |
| H. Proof | **H1**: a complete validated page with a positively absent TMDB relation | H2: H1 plus a second independent root (a Ratings fact record of the lid). H3: owner statement only |
| I. Stable id | **I1**: `film:lb:<lid>` | I2: reuse historical `film:<lid>` (slug namespace, indistinguishable from imported Films). I3: opaque random id (no deterministic replay) |
| J. Writer | **J1**: kinds of the ADR 0207 coordinator; one origin; the lid key as a guard reserved by every lid-knowing path; symmetric predicates; immutable `film_lid_admission` | J2: relax `film_rated_admission.tmdb` to nullable (rewrites a mandatory column and the scope ADR 0211 reads). J3: a separate writer (excluded by the card) |
| K. Admission evidence | **K2**: durable recomputable proof on `film_lid_admission`; the attach always writes `film_has_id` | K1: an `exists` row, as an explicit amendment of ADR 0215 decision 2 with its own writer control |
| L. Late TMDB | **L1**: owner-requested re-check; one-batch attach with an identity fence; typed conflict when the movie is held elsewhere | L2: automatic merge |
| M. Predictions | **M1**: an explicit ADR 0154 extension excluding the new cohort at queue, manifest and `submit`; reads stay truthful, with eligibility as a separate field | M2: a separately designed activation with its own feature contract |

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

Synthetic fixtures only. "No canonical write" means no `film`, claim, `film_lid_admission` or evidence row. A domain pending, review or terminal entry, and a settled receipt, are allowed.

1. **Valid page.** One `film:lb:<lid>`, one trusted claim, one immutable `film_lid_admission` whose `proof_digest` recomputes from its columns, one receipt.
2. **Unproved input.** A slug, an unresolved short code, a title or year input: refused before reservation; no canonical write.
3. **TMDB states.** Every non-admitting state of decision 3 gives its outcome and no canonical write. A `404` is distinct from other non-200 answers. A truncated page, a challenge page, an unreadable marker or a missing id block gives `tmdb_unreadable`. A lid-only page without a year is admitted; a movie page without exactly one year is still refused.
4. **Replay, lost response, crash before settlement.** `present_lid_only`, settled, with no fetch and no second row.
5. **Lid already trusted on a TMDB Film.** `present`.
6. **Races on one lid, in both orders,** each of `lid_only` against `lid`, against the rated step (resolved code) and against the inferred import:
   - before either reservation: one wins, the other replans;
   - between the inferred link and its canonical batch: the lid-only reservation fails and replans; seeing the link, it stops at `ratings_tmdb_link`;
   - after a canonical commit and before its settlement: the other side sees the predicates (route to attach, `needs_review`, `conflict` or `refused_after_link`);
   - never two Films for one lid.
7. **Ratings link fence.** A `links.json` part changes between the read and the batch: the batch fails on its `etag` predicate, with no canonical write.
8. **Historical keys.** An unresolved receipt under `admission:short_code:<code>` or `admission:inferred_import:<code>` for the same lid is settled first.
9. **Attach to a free movie (owner re-check).** One batch writes the claim, `canonical_identity` and evidence; the id is unchanged; both permalinks resolve; the Ratings link step runs afterwards and retries through the intent. The same `requestId` replays without a fetch. A lost response followed by a merge or correction: the receipt stays `applied`, and current readback decides.
10. **Attach refusals.** The lid has been reassigned or has gained a competing row; the movie is retired; the identity dimension is reviewed or owner; another `tmdb` claim exists; the evidence writer is `off` or `pending`. Each is refused with no canonical write.
11. **Attach races.** Concurrent with a Discovery admission of the movie, or with a `writeFilmFacts` plan for `tmdb_<n>`: exactly one trusted owner. The stale facts plan fails its in-batch predicate and never mints.
12. **Merge.** A merge moves `film_lid_admission`; before that delivery it is refused.
13. **Admission marker.** At `r2` or `closed` every kind is refused before the first effect, and legacy behaviour is byte-identical.
14. **Settlement per entry point.** Watchlist `identity:lid_only`; Diary on `lb-<lid>` with no TMDB alias; rated `admitted` with `tmdb: null`.
15. **Consumers.**
    - Unified read by `film:lb:<lid>` and by the lid.
    - Enrichment does not select the Film, before or after an attach.
    - The queue, the manifest and `submit` exclude it under M1.
    - The `predictions` section reports known historical values and conflicts as read, and `eligibility` separately.
    - `none` appears only under full negative proof.
16. **Statement count.** Every batch at its largest stays within `STATEMENT_CAP`.

## Cost

- One additive migration (`film_lid_admission` and its triggers), with no data migration.
- About 12 to 15 statements per admission and 15 per attach. The card measures the exact counts.
- No extra fetch for admission.
- One owner-requested fetch per attach.
- Low, event-driven volume.

## Recovery and migration boundary

This record authorizes no migration, flag, Task, Letterboxd or TMDB production call, D1 or R2 write, or activation. The stages are separate:

| Stage | Prerequisite | Rollback |
| --- | --- | --- |
| Dormant code | review, CI; deployed with the admission marker at `r2` or `closed`, or the kind not enabled | ordinary code revert |
| Schema apply | its own owner approval | additive table; dropping it is possible only while it is empty |
| H1 enablement precondition | the absence marker is shown parseable on **permitted existing captures** of real no-TMDB pages (synthetic fixtures alone do not establish upstream markup), with no new production fetch | — |
| Admission activation | ADR 0207 at `d1`; schema applied; every decision 9 consumer delivered; drain evidence that no older version serves traffic; owner L3 GO and rollback plan | disable the kind (refused before the first effect); existing lid-only Films stay, and readers must keep accepting `film:lb:` |
| Attach activation | E1 applied; writer control `lid_tmdb_attach` `on`; the `writeFilmFacts` change deployed and drained (decision 8d); owner L3 GO | disable the route; applied attaches stay; the writer break is recorded (ADR 0215 decision 4) |

**Stop rule.** Missing drain evidence for any older version that could mint `film:tmdb:<n>` directly stops the attach activation. A wrongly admitted Film is corrected by an owner action under a later decision, never by a delete.

## Delivery graph (no card is created by this record)

| Step | Kind | Content | Schema / API impact | Depends on | Gate |
| --- | --- | --- | --- | --- | --- |
| 1 | offline code | Typed TMDB states (`tmdb_missing`, `tmdb_unreadable`) on the existing path | none | accepted ADR | review, CI |
| 2 | offline code | `writeFilmFacts` owner resolution at planning and the in-batch predicate (test 11) | none | accepted ADR | review, CI |
| 3 | offline code and schema | H1, `film:lb:` minting, the `lid_only` kind, the lid guard and dual reservation for every lid-knowing path, the symmetric predicates, the `links.json` etag fence, the migration file, K2 proof columns; tests 1–8, 13, 16 | new table; [D1 schema](../reference/data/d1-schema.md) | 1; ADR 0207 cards | review, CI, dormant deploy |
| 4 | offline code | Settlement of the three entry points; projection and permalink acceptance of `film:lb:`; M1 exclusion in queue, manifest and `submit`; separate `eligibility` field (tests 14–15) | ledger `resolvedBy`; [film-person reference](../reference/domain/film-person.md), [catalog API](../reference/api/catalog.md), [film history and aggregate contract](../reference/api/film-history.md) | 3; ADR 0216 step 3 | review, CI |
| 5 | offline code | `mergeFilms` moves `film_lid_admission` (test 12) | none | 3 | review, CI |
| 6 | offline code | Owner re-check route, `lid_tmdb_attach`, Ratings link handoff (tests 9–11) | new owner admin route; admin API reference | 2, 3; ledger E1 | review, CI, dormant |
| 7 | separate apply | Apply the migration | D1 schema version | 3 | owner-approved apply |
| 8 | separate check | H1 markup on permitted existing captures | evidence document | 3 | read-only; no new production fetch |
| 9 | separate activation | Lid-only admission | — | 4, 5, 7, 8; ADR 0207 `d1`; drain | owner L3 GO |
| 10 | separate activation | Attach | — | 6, 9; E1 applied, writer `on`; drain of step 2 | owner L3 GO |
| 11 | future decisions | Enrichment scope, M2, automatic re-check, TV Films, merge writer, lid retirement | — | — | owner decisions |

## Evidence

- **Original decision:** not yet; this record is Proposed.
- **Implementation:** none.
- **Dated verification:** code reading at `main` `961c045` on 2026-11-25. No production read.
- **Uncertainty:**
  - The number of pending Watchlist or Diary items in state `tmdb_none` is not measured here; that is AIR-627's census.
  - Whether Letterboxd pages without TMDB keep a stable, parseable external-id block must be shown on synthetic captures in step 3.

## Follow-ups

The next steps, in order: independent re-review of this revision; then owner choices H to M under the facilitation protocol; then the owner disposition; then implementation cards only.
