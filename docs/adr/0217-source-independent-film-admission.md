# ADR 0217: A verified Letterboxd film with no TMDB movie may be admitted as a canonical Film through the D1 admission coordinator, with a proof rule that does not need TMDB

**Status:** Proposed  
**Original decision date:** not decided  
**Recorded at:** 2026-11-25, from `main` `7d8d4b3`. That commit includes the Accepted [ADR 0216](0216-canonical-film-lifecycle-and-unified-read-contract.md), the Accepted [ADR 0218](0218-film-lifecycle-dimensions-revision.md), the dormant receipt operation key of AIR-600 (migration `0039`) and the dormant evidence ledger initial slice of AIR-601 (migration `0041`, in the repository and not applied). Revised the same day after the [first](https://github.com/vladimino/iptv-watchlist/pull/996#issuecomment-7162637094), [second](https://github.com/vladimino/iptv-watchlist/pull/996#issuecomment-7164448376), [third](https://github.com/vladimino/iptv-watchlist/pull/996#issuecomment-7164848093) and [fourth](https://github.com/vladimino/iptv-watchlist/pull/996#issuecomment-7165258173) independent reviews, and consolidated with the owner's selections below.  
**Approval source:** owner selections only, not a disposition. The Product Owner selected H1, I1, J1, K2, L1 and M1 on 25 November 2026, 17:55 Europe/Madrid, as transcribed in the [consolidated owner-choice handoff](https://github.com/vladimino/iptv-watchlist/pull/996#issuecomment-7168734400), with a clarification requested for I1 (answered in decision 4) and a qualification for M1 (recorded in decision 9). This is **not** the final ADR disposition and not an implementation or production authorization. There is no `Accepted` record yet.  
**Related work:** [AIR-643](https://trello.com/c/e1Q9H1bG), which is ADR 0216 choice A2 and delivery step 9. Builds on [ADR 0207](0207-letterboxd-admissions-coordinated-in-d1-only.md), [ADR 0211](0211-catalog-enrichment-producer.md), [ADR 0213](0213-film-identity-evidence-ledger.md) and [ADR 0215](0215-identity-evidence-full-model.md). The production census is [AIR-627](https://trello.com/c/IOERZ9GI)'s and is not repeated here. Accepted [ADR 0218](0218-film-lifecycle-dimensions-revision.md) (lifecycle dimensions, AIR-644) is independent of this record: its recommended options keep the identity dimension row as the carrier of `titleSource` and owner identity authority, which is the `strong()` rule that decision 8b relies on. AIR-275 is unchanged and this record is not its prerequisite.  
**Supersedes:** None. If accepted as selected, it **amends** [ADR 0207](0207-letterboxd-admissions-coordinated-in-d1-only.md) decisions 2, 3 and 4 (two more kinds of the coordinator, and one common operation key for every attempt whose lid is known), [ADR 0215](0215-identity-evidence-full-model.md) decision 3 (one more minting id), and **extends** [ADR 0154](0154-prediction-eligibility-independent-of-epg.md) decision 1 with one temporary exclusion (M1). K2 leaves ADR 0215 decision 2 alone. The enrichment scope of ADR 0211 and the AIR-387 permalink rules do not change. On acceptance, the registry rows of ADR 0207, 0215 and 0154 get an amendment note (delivery step 0).  
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

## Decision (proposed, with the owner's selections)

The owner selected H1, I1, J1, K2, L1 and M1 ([record](https://github.com/vladimino/iptv-watchlist/pull/996#issuecomment-7168734400)). This text states the selected design as normative **proposed** design. The other options stay in "Alternatives considered" only.

| Choice | Selected | Owner qualification |
| --- | --- | --- |
| H. Proof | **H1** | none; the real-capture gate stays |
| I. Stable id | **I1** | clarify that the id is a stable entity key, not a current identity (decision 4) |
| J. Writer | **J1** | none |
| K. Admission evidence | **K2** | none |
| L. Late TMDB | **L1** | none |
| M. Predictions | **M1** | planning prediction support for lid-only Films is a **near-term planned follow-up**, not an indefinite deferral (decision 9) |

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

The writer performs the proof at write time, and a caller never supplies it. The selected rule, H1, is a **complete, validated film page with a positively absent TMDB relation**. The page passes only if every check below holds:

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

The selected option, I1, mints **`film:lb:<lid>`**.

- It is a minting id (ADR 0215 decision 3 is extended to it): no `film_has_id` row, and readers never require one.
- The same batch writes the trusted, non-conflicting claim `film_external_id ('letterboxd', <lid>)`. The existing partial unique index `film_external_id_one_trusted` makes "one trusted owner per lid" a database invariant. That index is the proof of uniqueness, not the spelling of the id.
- `canonical_identity` stays null until a TMDB attach (decision 8).
- **Why not `film:<lid>`.** That namespace is shared with slugs in `canonicalFilmId()`, and all 406 historical `film:<lid>` Films hold a TMDB identity. `film:lb:` cannot collide with `film:tmdb:` or `film:conflict:`, because a lid has no colon. It needs no schema change, because `film.id` only checks `LIKE 'film:%'`.

**The id is a stable entity key, not a current identity (the owner's question on I1).** The owner asked whether "the internal id does not change when a TMDB id appears" means that some Films are identified by the lid and others by the TMDB id. It does not:

- `film.id` is **one common stable key** for every Film. The minting namespace (`film:tmdb:`, `film:lb:`, the historical `film:<lid>`) records only **how the Film was first created**. It records no current identity, no source priority and no readiness.
- A Film minted as `film:lb:<lid>` **keeps** that id after a verified TMDB attach. The existing cohort minted from a movie keeps `film:tmdb:<n>`. Neither group is renamed, and both gain further claims as proofs arrive.
- **Internal relationships** (redirects, retention, admission rows, evidence subjects, membership) use the stable Film key.
- **Current identity and permitted external lookups** come from the verified claims (`film_external_id`, trusted and non-conflicting) and the resolver of ADR 0216: the typed input grammar `film`, `tmdb_movie`, `tmdb_tv` and `letterboxd_lid`. A reader never parses a minting id as a current claim: `film:tmdb:<n>` does not prove that the Film still owns movie `n`, and `film:lb:<lid>` does not prove that it still owns the lid. The delivery card inventories every reader that derives a claim from the spelling of a film id (for example the `film:<lid>` spelling in `tmdb-retirement-decisions.js` and `canonicalFilmId()`), and either shows that it only handles the historical cohort or makes it resolve through claims.
- **Unchanged:** the accepted redirect behaviour (a merge leaves a `film_redirect`), the public permalink rule of AIR-387 (`/film/tmdb_<n>` for a trusted movie, `/film/<lid>` as alias and fallback), and every historical storage key (ratings, Diary, predictions stay under their keys and are never renamed).

This explains I1. It does not change the selection.

### 5. Writer: the ADR 0207 coordinator, with one per-lid guard shared by every path that knows the lid (choice J)

The selected option, J1, adds **no parallel writer**. Lid-only admission (`lid_only`) and the later TMDB attach (`lid_tmdb_attach`, decision 8) are new kinds of the ADR 0207 coordinator. They run only at `letterboxd_admission_authority = d1` and are refused before their first effect under `r2` and `closed`. Every refusal and recovery outcome of ADR 0207 decision 3 is kept, including `refused_after_link`.

#### 5a. Origin and one common key per lid (no dual reservation)

- Every receipt uses the existing origin `rated_admission_retention` (`RATED_ADMISSION_ORIGIN`). Uniqueness, the partial unique index and the history fingerprint are all scoped to `(origin, operation_key)`.
- **Single-key rule.** Every attempt of any path that knows the lid uses exactly **one** operation key, `admission:lid:<lid>`:
  - the TMDB-proved Diary and Watchlist admission (kind `lid`, as in ADR 0207);
  - `lid_only` and `lid_tmdb_attach`;
  - the rated archive step, once its short code has resolved to a lid;
  - the inferred import, for an item whose code is a lid.

  This **amends ADR 0207 decision 3**. Today the rated step uses `admission:short_code:<code>` and the inferred import uses `admission:inferred_import:<code>`. Under this record, an attempt whose lid is known takes the lid key instead. An attempt that never resolves a lid keeps its ADR 0207 key and never takes the lid-only path.
- **The receipt protocol is used verbatim.** One `request_id` has one immutable `operation_key`, and no schema or API change of the AIR-600 receipt is needed:
  - the reservation asserts the lid key's fingerprint and the free-key predicate (`operationHistoryCondition`);
  - the canonical tail settles exactly that one owned `pending` receipt (`canonical-mutations.js:22-38`).

  There is no second guard receipt, and no applied receipt without a canonical effect. A lid has **at most one unresolved attempt across all paths and kinds**.
- **Order.** The reservation precedes the first effect of any stage. For the inferred import, that means before its Ratings link (`letterboxd-facts.js:718-747`).
- **Historical keys: read-only reconciliation, then one reservation.** Before reserving the lid key, a path whose code resolves to the lid reads the history of its **older** key (`admission:short_code:<code>` or `admission:inferred_import:<code>`):
  - a `pending` receipt inside its window: **wait** (non-terminal);
  - any other unresolved receipt: abandoned by ADR 0207 step 2;
  - an applied receipt: validated against current state.

  Only then is the lid key reserved. The older key is never reserved again for that code. The resolved lid is stored on the writer's durable record (the `admitting` row or the chunk intent), so a retry goes straight to the lid key.
- **Receipts without a key** (from before the ADR 0207 flip) are excluded by the ADR 0207 parity pin: there are 0 open admission receipts at the flip.

#### 5a-2. Key transition and old-key cutover

The single key changes the key of the rated step and the inferred import for items whose lid is known. This section states when that is safe.

- **No old-key reservation can exist before the ADR 0207 flip.** At `r2` and `closed`, writers stay byte-identical to the legacy code, which writes no operation key and no new receipt shape (ADR 0207 decision 1). The operation key is dormant (AIR-600). So the key of these two paths is fixed in code **before** the keyed protocol is ever live. A single key-derivation function takes the resolved lid and returns `admission:lid:<lid>`; no caller builds the older key for a lid-resolved item.
- **Preferred ordering.** The ADR 0207 cards for the rated step and the inferred import are delivered with this key rule. If one of them has already been delivered with an older key, the switch is its own card with the gates below.
- **Gates before any lid-knowing caller switches, when an older key could exist:**
  - drain evidence that no Worker version, Workflow instance or owner request of a version that reserves the older key is still running (the ADR 0207 decision 1 drain pattern, from Worker version and invocation logs and the Workflow instance listing);
  - a reconciliation pass that settles or bounds every unresolved receipt under the older keys;
  - a reconciling read before every lid-key reservation (below), so safety does not depend on prevention alone.
- **Unknown reverse mapping: hold, never assume absence.** The lid-only reservation reads the older-key history of every code that maps to the lid. Where the mapping is not known (for example a candidate whose short code has not resolved, or an alias without a reverse entry), the attempt is **held**: non-terminal `deferred` with reason `older_key_unknown`. It never proceeds on an assumed absence.
- **After the switch,** the older key is not reserved again for a lid-resolved item. A stale old version that does reserve one is found by the reconciling read of the lid key reservation and settled by the ADR 0207 protocol. The fixtures of test 5c cover it.
- **Terminal receipts and request ids.** Receipts are append-only and terminal receipts are preserved. The `operation_key` of a receipt is immutable, so a retry whose resolved lid changes the key gets a **new** `request_id` (the key is part of the id derivation for keyed kinds, a requirement on the producer request id), and the old receipt is settled by the older-key reconciliation. A `request_id` is never reused with a different key.
- **Rollback.** Disabling the kinds does not revert receipts. A lid-key receipt stays readable under the same key whichever code runs next, and the older-key reconciliation stays in the reservation path.

#### 5b. Symmetric predicates in every canonical batch that touches a lid

The reservation serializes attempts. These predicates decide outcomes from durable state, inside the canonical batch, on **both** sides.

**The `lid_only` canonical batch asserts:**

- marker generations: Film/Person, admission marker mode `d1` and its generation;
- the **Sync epoch or ratings epoch fence** of the calling domain (`epochFence`, `ratings-d1.js:196`), as every Diary and Watchlist batch already carries;
- the owned-attempt tail on the lid key: the receipt is `pending` with this `request_id`, this attempt number, this planned revision and this generation;
- no `film` row with id `film:lb:<lid>` and no `film_redirect` from it;
- no `film_external_id ('letterboxd', <lid>)` of **any** trust on any Film;
- no `film_lid_admission` row for the lid;
- no `film_rated_admission` row with `source_code = <lid>`;
- **the Ratings link document itself.** The parts of `letterboxd/facts/links.json` that were read must still match in `ratings_document`: each `etag`, and the part count. The epoch alone is a lease fence, not a version of this document. The read found no `tmdb:` alias on the lid's fact key; if it had, the attempt would already have stopped at pending `ratings_tmdb_link`.

**The inferred import's pre-canonical Ratings link effect** (`letterboxd-facts.js:718-747`: admission, link, then canonical stage) must assert the **exact owned pending attempt** of the lid key in the link batch itself, in addition to its document and epoch fences: the receipt is `pending` with this `request_id` and this attempt number. The Ratings tables and the receipts live in the one D1 database, so the assertion is a statement of the same batch. An expired or abandoned attempt (ADR 0207 step 2) therefore cannot land a late link.

**The TMDB-proved and inferred canonical batches** (`admitRatedFilm` for a lid) add one predicate: **no `film_lid_admission` row for the lid**. When one exists:

| Moment it is seen | Outcome |
| --- | --- |
| by the planner, before any link | Diary and Watchlist: `present_lid_only` when the lid is the same, otherwise `needs_review lid_only_present`. Natural sync **never attaches**; only the owner re-check of decision 8 does. Rated step: `needs_review lid_only_present`. Inferred import: `conflict`, with no link and no fact |
| only by the batch, after the inferred link | `refused_after_link`, exactly as ADR 0207 defines it. The inferred-marked link stays and is never claim proof; owner repair |

**The interval after the canonical batch and before settlement.** The canonical tail applies the receipt, so the lid key is **free** again before the domain settles, and no guard spans settlement. Safety comes from current state instead:
- a fresh attempt on the lid meets the durable canonical rows through the predicates above, so it cannot mint a second Film;
- the settlement batch binds to the **exact current intent**, under the domain fence (ratings or Sync epoch), and it distinguishes two cases:
  - **A new applied admission by this attempt.** It asserts that the domain record still names this intent (its `request_id` and intent digest) and that this intent's own receipt is `applied`.
  - **Already present, with no receipt of this attempt** (an earlier attempt admitted the Film, or the lid is held by a TMDB Film). It asserts **no receipt**. It validates the durable existing identity instead: complete, non-conflicting ownership, below. A fabricated applied receipt is never demanded or written.
- **Complete, non-conflicting ownership** is required in both cases, not merely one trusted claim: exactly one trusted, non-conflicting `letterboxd` claim of the lid on one Film; no other `letterboxd` row of the lid, of any trust, on any Film; no redirect from that Film; and, for a lid-only Film, `film_lid_admission.film_id` resolving to it.

  If any of these fails, the settlement writes nothing and replans from current state. A changed fingerprint rejects only a stale observer; the current-state predicates are what stop a stale settlement.

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
| 5. Concurrent attempts on the lid, any paths | the lid key | one unresolved attempt (partial unique index); the loser replans. A failure after the reservation and before the canonical batch leaves one `pending` receipt, which is waited on inside its window and abandoned after it (ADR 0207 step 2) |
| 5a. TMDB-proved or inferred path meets an existing lid-only Film | `film_lid_admission` for the lid | 5b table: `present_lid_only`, `needs_review`, `conflict` or `refused_after_link`; never a second Film and never an automatic attach |
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

The selected option, **K2**, keeps the proof on the immutable `film_lid_admission` row and writes no ledger row for the admission.

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

**The attach is non-minting, so it always needs evidence** (ADR 0215 decision 3), whatever K says. It writes `asserts film_has_id(film:lb:<lid>, tmdb_movie <n>)`, method `page_check`, route `owner_action`, with **`attach_root`** as root (8b), in the attach batch. The lid-only `proof_digest` proves the **absence** of a TMDB relation and is never used as the root of a movie claim. Its prerequisites:
- **the ledger table applied.** The ledger initial slice (AIR-601, migration `0041`) is in the repository, inert and **not applied**; applying it is its own owner GO (card M1 of ADR 0207);
- **the writer control of ADR 0215 decision 4,** which is **not delivered** (neither the control table nor a writer helper that reads it exists on `main`), with the writer `lid_tmdb_attach` **in state `on`**. The attach batch asserts that state and its generation (ADR 0215 decision 4 fence).

In `off`, `pending` or when the control is absent, the attach is refused `evidence_writer_inactive`. There is never an attach without evidence. Rollback of the writer follows ADR 0215 decision 4: a recorded break, and coverage claimed only for the drained interval.

No reader uses any of this to decide anything without its E4 amendment.

### 8. A later verified TMDB movie (choice L)

#### 8a. Trigger, intent, attempts and result

- **Entry point.** A new verification has its own owner-only request, `POST /api/admin/letterboxd/lid-recheck {lid, requestId}`: one lid per request, behind the existing owner authentication. Natural sync never attaches, and no automatic or periodic re-check is authorized.
- **The intent row** is a new table `lid_recheck_intent`, delivered by the attach card's migration. It holds:
  - `request_id` (primary key) and `lid`, bound for life: the same `requestId` with another lid is refused `request_conflict`;
  - `state`: `open` or `settled`, with `outcome`;
  - `revision` (an integer for compare-and-swap) and `attempt_request_id`, the receipt of the attempt that currently owns the intent, if any;
  - the observed proof inputs and `attach_root` (8b);
  - the movie id and `link_state` (`owed`, `linked`, `alias_conflict`, `link_blocked`), which make the Ratings handoff recoverable.
- **A repeat of the request:**
  - **settled:** answered by readback only, with no fetch;
  - **open:** reconciled with the lid key protocol (ADR 0207 decision 3). A `pending` attempt inside its window is waited on; any other unresolved attempt is abandoned; an applied attach is validated against current state. Only when **no canonical effect is settled and no attempt can still land** does the request reacquire a bounded page and TMDB check, as a new attempt.
  - So the owner retries a transport failure with the **same** `requestId`, and it makes progress.
- **Intent CAS and attempt association.**
  - **At reserve,** the receipt reservation and the intent update are **one batch**: the intent `UPDATE` sets `attempt_request_id` and raises `revision`, and it matches `state = 'open'` and the `revision` that was read. A batch whose intent update matches nothing fails as a whole. Two concurrent requests with one `requestId` therefore cannot both own the intent.
  - **In the attach batch,** the intent is asserted `open` with `attempt_request_id` equal to this attempt and the `revision` that was read, and the same batch moves it to `outcome = attached`, `link_state = owed` and raises `revision`.
  - An attempt that lost the intent (another `attempt_request_id`) writes nothing and replans.
- **A changed source.** A reacquired page naming another movie, or with another `attach_root`, than an earlier attempt of the same open intent that did not land: the old receipt is abandoned and the new root is recorded. If an earlier attempt **did** land, that is `source_changed` for owner review, never a second attach.
- **Terminal outcomes** settle the intent:
  - `attached` (then `link_state` decides when the intent is fully settled, 8c);
  - `still_none` (nothing canonical written);
  - `tmdb_on_other_film`;
  - `owner_kept`;
  - `tmdb_retired`;
  - `admission_conflict`;
  - `evidence_writer_inactive`;
  - `source_changed`;
  - any terminal non-admitting state of decision 3.

  Transport and `tmdb_unavailable` are non-terminal and count no attempt. A **transient** fence failure (an epoch or document `etag` moved) is also non-terminal and retryable with the same `requestId`. Only a **proved** conflict or correction is terminal and goes to owner review.

#### 8b. The attach batch and its causal root

**Proof.** A fresh page check in state `tmdb_movie`, with an agreeing TMDB document, by the **accepted verified movie check** (`verifyPage` and `movieDetailAgrees`). No new proof semantics.

**The attach root** is the existing deterministic page-check evidence digest of ADR 0207 decision 3, `sha256(lid, slug, path, tmdb, title, year, source)`. It is extended with:
- `proof_version`;
- the TMDB type (`movie`);
- the digest of the TMDB document fields that the agreement check compares (id, title, year).

The same page checked by the Diary, the Watchlist or the owner route gives **the same root**, so a different caller never manufactures independent corroboration (ADR 0213: independence counts distinct roots). To make this hold:
- **`proof_version` is route-independent.** It names the check rules and the normalization below, never a route.
- **`source` in the root is the normalized final film page URL**, never a route name: `https`, lowercase host, no query and no fragment, one trailing slash. The route stays in the observation metadata (decision 7).
- **The agreement inputs** (TMDB id, title, year) are hashed in the normalized form that the accepted agreement check already compares, with no new normalization rule.
- Every input is stored on the intent row, so the root can be recomputed. No raw HTML is archived. Nothing is fabricated: a failed agreement check writes no root.

**The receipt content digest** is `{kind: lid_tmdb_attach, lid, tmdb, attach_root}`.

**In-batch identity fence.** A revision CAS alone is not enough. The batch asserts:
- Film/Person generation; admission marker `d1` and its generation;
- the owned-attempt tail on the lid key;
- the evidence writer state `on` and its generation;
- the intent `open`, with this attempt and the revision read (8a);
- the Film revision;
- the target Film exists and is not a redirect source;
- the requested lid **still uniquely belongs to that survivor**: a trusted, non-conflicting `letterboxd` claim of the lid on the Film, no other `letterboxd` row of the lid (any trust) on any Film, and `film_lid_admission.film_id` resolving to the Film;
- no `tmdb` claim of the movie, of any trust, on any Film;
- no other `tmdb` claim on this Film, and `canonical_identity` null;
- no non-superseded retirement decision for the movie;
- the identity dimension is neither `reviewed` nor `owner` (`strong()`), otherwise `owner_kept`.

**Writes:**
- the trusted `tmdb` claim, with provenance `{source: owner_action, adr: 0217, evidence: <attach_root>}`;
- `canonical_identity = 'tmdb:<n>'`;
- the evidence row `film_has_id`, whose root is `attach_root` (decision 7) and whose **subject is the actual survivor Film id that this batch writes** (the Film resolved through an authorized redirect), not the spelling `film:lb:<lid>` taken blindly;
- the receipt tail;
- the intent's `outcome = attached` and `link_state = owed`, in the same batch.

**Readback.** Success is reported only when a fresh read finds the claim and `canonical_identity`. An applied receipt is terminal and never rewritten; current state decides what is usable.

#### 8c. Ratings settlement after the attach

- **The attach does not create the Ratings link.** A trusted claim is not a Ratings fact alias. The intent owes the link (`link_state = owed`).
- **Before the link,** the link step re-reads current state:
  - the trusted `letterboxd` claim of the lid and the trusted `tmdb` claim of the movie are on the same survivor;
  - no redirect;
  - no retirement of the movie.

  It then runs the **existing** Ratings alias protocol (the ADR 0166 link step, `linkOrNote`).
- **The link batch** asserts:
  - the ratings epoch fence;
  - the `etag` and part count of the `links.json` parts it read;
  - those canonical facts, as predicates of the same D1 batch;
  - the intent `open` with `link_state = owed` and the `revision` read.
- **Atomic settlement.**
  - **Primary.** Where the ratings domain is `d1` and `open`, the link write is a D1 batch. It carries the intent update (`link_state = linked`, `revision + 1`) **in the same batch**, so the alias and the intent cannot disagree. The card verifies that the ratings writer can carry one extra statement.
  - **Fallback, exact lost-response reconciliation.** If the writer cannot carry it, a repeat of the same `requestId` with `link_state = owed` first reads `links.json`. When `letterboxd:<lid>` and `tmdb:<n>` already map to one fact key and the canonical facts still hold, it sets `linked` in a guarded update (the intent matches `owed` and its `revision`). Otherwise it retries the link step.
- **Transient is retryable; only a proved conflict or correction is terminal.**
  - A transport failure, a moved epoch or a changed `etag` leaves `link_state = owed`. The same `requestId` retries.
  - A **proved** `alias_conflict` (the lid or the movie is linked to another fact key) or a **proved** correction (the claim was reassigned, a redirect or a retirement now applies) becomes `link_blocked`, for owner review.
- **An applied attach receipt alone never authorizes the alias.** After a correction or merge, the current-state predicates block a stale link.
- **Retry.** The same `requestId` resumes the link step only, and never re-attaches. The outcomes are `linked`, `alias_conflict` and `link_blocked`. The `lb-<lid>` fact key gains the movie alias as a Diary-first link does, and no key is renamed.
- **No `film_rated_admission` row.** The Film stays outside the ADR 0211 enrichment scope until that scope is amended. A replay can neither grant nor lose eligibility.

#### 8d. No duplicate `film:tmdb:<n>` from any writer

Every writer that spells `film:tmdb:<n>` must resolve the trusted owner first.

- `resolveAdmissionFilm` and Discovery's `planAdmissionFilm` already do this.
- **`writeFilmFacts` must change on both sides of the receipt:**
  - **at planning,** the producer resolves `tmdb_<n>` to the trusted owner (any claim of the movie: owner, or refuse as held), and binds that id as the receipt target;
  - **inside the batch,** when it would create a Film, it asserts that no `film_external_id ('tmdb', <n>)` of any trust exists. A plan made before an attach therefore fails, instead of minting a duplicate. The writer receives an id, revision and receipt tail that are already bound (`canonical-film-writers.js:254-258`), so the predicate has to be inside the batch.

**Old code.** Before the first attach is activated, drain evidence must show that no Worker version older than that change serves traffic and no Workflow instance of such a version is running (the ADR 0207 decision 1 drain pattern). An older version could still mint the duplicate, so missing evidence stops the activation.

**Permalinks.** `/film/tmdb_<n>` becomes canonical after the attach (AIR-387), and `/film/<lid>` keeps working.

**Movie held by another Film.**
- The selected option, **L1**, records a typed `tmdb_on_other_film` for owner review, with no automatic merge.
- **L2**, an automatic merge, is not deliverable under this record. It would first need its own approved merge-writer contract (including moving `film_lid_admission`) and its own ADR.

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

- **M1 (selected): a temporary, explicit exclusion.** This **extends** the ADR 0154 policy with one exclusion: a Film with no trusted `tmdb` claim **and** a `film_lid_admission` row is not admitted to the prediction queue. The exclusion is enforced:
  - at the queue rebuild's Film admission;
  - at the manifest build;
  - by the per-film `submit` guard;

  so a stale queue cannot submit it. No model is invoked for it.

  **Cohort boundary.** The exclusion applies only while the Film has no trusted `tmdb` claim. After a successful attach it **ends**, and the ordinary ADR 0154 gates (identity, lane membership, profile, fingerprint and prompt compatibility) apply. Enrichment stays out of scope (8c).
- **The owner's qualification on M1.** The owner selected M1 **with** the requirement that planning prediction support for lid-only Films in the **near future** is explicitly recorded here. So this exclusion is a **temporary** boundary and a **near-term planned follow-up**, not an indefinite deferral and not an optional future possibility. The planning intent is the owner's; this record states **no date and no implementation commitment** beyond it.
  - The temporary exclusion and the truthful reads stay normative until a **separately accepted design and a separately gated activation** replace them.
  - Planning M2 is **not a prerequisite of lid-only admission**, and nothing here authorizes scoring, a model call or a prompt change.
- **Reads stay truthful and separate from eligibility.** The aggregate keeps ADR 0216 sections 5 and 6b unchanged: known historical values and conflicts under authorized aliases are reported as read; `none` is returned only under full negative proof; coverage is what it is. Eligibility is a **separate** field, `predictions.eligibility: {status: "not_eligible", reason: "lid_only_deferred"}`. It never turns a present or conflicting value into `partial`, and it never invents incompleteness.
- **M2 planning work item (an explicit item of the post-acceptance breakdown).** An architecture and planning card, separate from the admission cards, that scopes:
  - the feature and metadata contract for a Film **without TMDB** (which inputs exist, which are absent, and how absence is represented);
  - the fingerprint inputs and the compatibility rule for such a fingerprint;
  - how the prompt and model input handles the missing fields;
  - eligibility, queue, manifest and `submit` behaviour, replacing the M1 exclusion;
  - coverage of historical predictions stored under the lid (ADR 0216 sections 5 and 6b, ADR 0201);
  - quality and cost validation before any scoring;
  - a separately gated activation, with its own owner GO.

  Its real prerequisites and coordination points: the unified read and candidate coverage of ADR 0216 (delivered), the enrichment scope decision for `film_lid_admission` (a separate decision, because without metadata a lid-only Film has little to fingerprint), and the prediction domain's own contracts. M2 does not widen the enrichment scope implicitly, and it does not need lid-only admission to be activated to be planned.

### 10. Target structure (text; no diagram until the owner chooses)

```
paths that know a lid ──reserve── admission:lid:<lid>  (origin rated_admission_retention)
  Diary / Watchlist / rated (resolved) / inferred (lid)        one unresolved attempt per lid
page check H1 ─ tmdb_none ─► lid_only batch
   predicates: absences, links.json etags, epoch, fingerprints, markers
   writes: film film:lb:<lid> + trusted letterboxd claim + film_lid_admission + receipt
        └─ domain settlement (ledger / Diary intent / rated row)
TMDB-proved or inferred path meeting film_lid_admission ─► present_lid_only / needs_review / conflict / refused_after_link
                                                              (never an automatic attach)
owner lid-recheck ─ intent CAS ─ tmdb_movie ─► lid_tmdb_attach batch (evidence writer on)
   writes: tmdb claim + canonical_identity + film_has_id evidence (survivor subject)
           + intent attached/owed + receipt
        └─ Ratings alias link batch (intent linked in the same batch; lost response reconciled)
```

The Mermaid change to [Film/Person lifecycle](../architecture/film-person-lifecycle.md) comes with the implementation card, for the selected design, with rendered QA.

## Alternatives considered (owner choices selected on 25 November 2026)

| Choice | Selected | Alternatives not selected |
| --- | --- | --- |
| H. Proof | **H1**: a complete validated page with a positively absent TMDB relation | H2: H1 plus a second independent root (a Ratings fact record of the lid). H3: owner statement only |
| I. Stable id | **I1**: `film:lb:<lid>` | I2: reuse historical `film:<lid>` (slug namespace, indistinguishable from imported Films). I3: opaque random id (no deterministic replay) |
| J. Writer | **J1**: kinds of the ADR 0207 coordinator; one origin; one key `admission:lid:<lid>` for every lid-knowing attempt (verbatim receipt protocol); symmetric predicates; settlement bound to the current intent; immutable `film_lid_admission` | J2: relax `film_rated_admission.tmdb` to nullable (rewrites a mandatory column and the scope ADR 0211 reads). J3: a separate writer (excluded by the card) |
| K. Admission evidence | **K2**: durable recomputable proof on `film_lid_admission`; the attach always writes `film_has_id` | K1: an `exists` row, as an explicit amendment of ADR 0215 decision 2 with its own writer control |
| L. Late TMDB | **L1**: owner-requested re-check; one-batch attach with an identity fence; typed conflict when the movie is held elsewhere | L2: automatic merge |
| M. Predictions | **M1**: an explicit, temporary ADR 0154 extension excluding the new cohort at queue, manifest and `submit`; reads stay truthful, with eligibility as a separate field; **prediction support is a near-term planned follow-up (M2 planning item)** | M2 now: eligibility with partial features, which needs a separately designed feature contract and its own activation |

Rejected without a choice:

- title, year or slug matching as proof;
- admitting from Discovery or from a bare sighting;
- downgrading any TMDB state to `tmdb_none`;
- attaching TMDB through two separate commits.

## Consequences

- A Letterboxd film without TMDB gets a permanent Film, retention, a permalink and the unified read, and the TMDB-proved path is unchanged.
- Added to maintain: two coordinator kinds, **two tables** (`film_lid_admission` and `lid_recheck_intent`), one owner-only route, one typed TMDB state, one minting namespace, one common operation key, and a change in `writeFilmFacts` owner resolution. Readers must not derive a current claim from the spelling of a film id, and must accept `film:lb:` (decision 4).
- Two lid-only Films of one work may coexist until a proved merge. This is visible, not silent.
- Enrichment stays off for these Films until its own decision. Predictions stay off through the temporary M1 exclusion, with the planning of their support a near-term follow-up (decision 9).
- The owner re-check is the only way a lid-only Film gets a TMDB claim; natural sync never attaches. A Film whose TMDB movie appears but is never re-checked stays lid-only, visibly.

## Synthetic test plan

Synthetic fixtures only. "No canonical write" means no `film`, claim, `film_lid_admission` or evidence row. A domain pending, review or terminal entry, and a settled receipt, are allowed.

1. **Valid page.** One `film:lb:<lid>`, one trusted claim, one immutable `film_lid_admission` whose `proof_digest` recomputes from its columns, one receipt.
2. **Unproved input.** A slug, an unresolved short code, a title or year input: refused before reservation; no canonical write.
3. **TMDB states.** Every non-admitting state of decision 3 gives its outcome and no canonical write. A `404` is distinct from other non-200 answers. A truncated page, a challenge page, an unreadable marker or a missing id block gives `tmdb_unreadable`. A lid-only page without a year is admitted; a movie page without exactly one year is still refused.
4. **Replay, lost response, crash before settlement.** `present_lid_only`, settled, with no fetch and no second row.
5. **Lid already trusted on a TMDB Film.** `present`.
5b. **Receipt transitions as executable SQL fixtures.**
   - The reservation on a free lid key succeeds, and a second reservation fails the partial unique index.
   - A failure after the reservation and before the canonical batch: the receipt is `pending`, waited on inside its window and abandoned after it, and the next attempt reserves.
   - A failure after the canonical batch and before settlement: the key is free; a fresh `lid_only` attempt is refused by the predicates; the settlement replays bound to its intent.
   - A stale settlement whose intent was replaced or whose Film moved writes nothing.
   - An unresolved receipt under the older short-code key is reconciled before the lid key is reserved.
5c. **Key transition, executable fixtures.**
   - An unresolved receipt under an older key (`admission:short_code:<code>` or `admission:inferred_import:<code>`) for a lid-resolved item is reconciled before the lid key is reserved; no later reservation uses the older key.
   - A candidate with an unknown reverse mapping is **held** (`older_key_unknown`), never admitted on an assumed absence.
   - A retry whose resolved lid changes the key gets a new `request_id`; the old receipt keeps its key and terminal state; no `request_id` is reused with another key.
   - The inferred Ratings link batch of an **expired or abandoned** attempt fails on the owned-attempt assertion and lands no link.
   - A settlement after an admission by another attempt, with no receipt of its own, validates the durable rows and writes no receipt; it refuses when ownership is incomplete (a second `letterboxd` row of the lid of any trust, a redirect, or a missing `film_lid_admission`).
   - A failure after reserving and a failure after the canonical commit both recover from durable state.
6. **Races on one lid, in both orders,** each of `lid_only` against `lid`, against the rated step (resolved code) and against the inferred import:
   - before either reservation: one wins, the other replans;
   - between the inferred link and its canonical batch: the lid-only reservation fails and replans; seeing the link, it stops at `ratings_tmdb_link`;
   - after a canonical commit and before its settlement: the other side sees the predicates (`present_lid_only`, `needs_review`, `conflict` or `refused_after_link`; never an automatic attach);
   - never two Films for one lid.
7. **Ratings link fence.** A `links.json` part changes between the read and the batch: the batch fails on its `etag` predicate, with no canonical write.
8. **Historical keys.** An unresolved receipt under `admission:short_code:<code>` or `admission:inferred_import:<code>` for the same lid is settled first.
9. **Attach to a free movie (owner re-check).** One batch writes the claim, `canonical_identity`, the evidence row (root `attach_root`) and the intent's `attached`/`owed`; the id is unchanged; both permalinks resolve.
   - A settled `requestId` replays by readback without a fetch.
   - A transport failure followed by a retry with the **same** `requestId` reconciles, then refetches and makes progress.
   - The same `requestId` with another lid gives `request_conflict`.
   - An open intent whose page now names another movie: abandon and record the new root; if an attempt had landed, `source_changed`.
   - A lost response followed by a merge or correction: the receipt stays `applied`, and current readback decides.
   - A correction or merge between the attach and the Ratings link: `link_blocked`, and no alias is written.
   - The same page checked by the Diary route and by the owner route gives the same `attach_root`, whatever the route name; the `source` input is the normalized page URL.
   - Two concurrent requests with one `requestId`: one owns the intent through the reserve-time CAS; the other writes nothing. An attach batch whose intent names another attempt or another `revision` fails as a whole.
   - After an authorized redirect, the evidence subject is the survivor Film id.
   - The Ratings link batch settles the intent in the same batch; with the fallback writer, a lost response is reconciled from `links.json`.
   - A transient fence or transport failure leaves `link_state = owed` and is retried; a proved `alias_conflict` or correction is `link_blocked`.
10. **Attach refusals.** The lid has been reassigned or has gained a competing row; the movie is retired; the identity dimension is reviewed or owner; another `tmdb` claim exists; the evidence writer is `off` or `pending`. Each is refused with no canonical write.
11. **Attach races.** Concurrent with a Discovery admission of the movie, or with a `writeFilmFacts` plan for `tmdb_<n>`: exactly one trusted owner. The stale facts plan fails its in-batch predicate and never mints.
12. **Merge.** A merge moves `film_lid_admission`; before that delivery it is refused.
13. **Admission marker.** At `r2` or `closed` every kind is refused before the first effect, and legacy behaviour is byte-identical.
14. **Settlement per entry point.** Watchlist `identity:lid_only`; Diary on `lb-<lid>` with no TMDB alias; rated `admitted` with `tmdb: null`.
15. **Consumers.**
    - Unified read by `film:lb:<lid>` and by the lid.
    - Enrichment does not select the Film, before or after an attach.
    - The queue, the manifest and `submit` exclude it under M1, and stop excluding it after an attach.
    - A Film minted `film:lb:<lid>` keeps its id after an attach and is found by the lid and by the movie; no reader derives a claim from the id spelling.
    - The `predictions` section reports known historical values and conflicts as read, and `eligibility` separately.
    - `none` appears only under full negative proof.
16. **Statement count.** Every batch at its largest stays within `STATEMENT_CAP`.

## Cost

- **Two** additive migrations, each its own file and its own apply: `film_lid_admission` (with its triggers) and `lid_recheck_intent`. No data migration. The numbers are the next free ones at merge.
- **Lid-only admission:** about 12 to 15 statements per canonical batch, within `STATEMENT_CAP` 40.
- **Attach:** the reserve batch adds the intent CAS (one statement). The attach batch carries the guards, the owned-attempt tail, the absence and ownership predicates, the writes, the evidence insert and its assertion, the intent update and the receipt tail: about 18 to 24 statements. The Ratings link batch adds one statement for the intent. The cards measure the exact counts against the cap.
- No extra fetch for admission. One owner-requested fetch per attach attempt.
- Low, event-driven volume: the census found no current lid-only Film.

## Recovery and migration boundary

This record authorizes no migration, flag, Task, Letterboxd or TMDB production call, D1 or R2 write, or activation. The stages are separate:

| Stage | Prerequisite | Rollback |
| --- | --- | --- |
| Dormant code | review, CI; deployed with the admission marker at `r2` or `closed`, or the kind not enabled | ordinary code revert |
| Schema apply: `film_lid_admission` | its own owner approval | additive table; dropping it is possible only while it is empty |
| Schema apply: `lid_recheck_intent` | its own owner approval, **before the attach activation**; it is not needed for admission | additive table; dropping it is possible only while it is empty |
| Old-key cutover (decision 5a-2) | drain evidence for any version that reserves an older key, a reconciliation pass over older-key receipts, the reconciling read in the reservation path; a no-op when no older key was ever delivered | the older-key reconciliation stays in the reservation path; receipts are terminal and never rewritten |
| H1 enablement precondition | the absence marker is shown parseable on **permitted existing captures** of real no-TMDB pages (synthetic fixtures alone do not establish upstream markup), with no new production fetch | — |
| Admission activation | ADR 0207 at `d1`; schema applied; every decision 9 consumer delivered; drain evidence that no older version serves traffic; owner L3 GO and rollback plan | disable the kind (refused before the first effect); existing lid-only Films stay, and readers must keep accepting `film:lb:` |
| Attach activation | the ledger table (`0041`) applied; the ADR 0215 writer control delivered and `lid_tmdb_attach` `on`; `lid_recheck_intent` applied; the `writeFilmFacts` change deployed and drained (decision 8d); owner L3 GO | disable the route; applied attaches stay; the writer break is recorded (ADR 0215 decision 4) |

**Stop rule.** Missing drain evidence for any older version that could mint `film:tmdb:<n>` directly stops the attach activation. A wrongly admitted Film is corrected by an owner action under a later decision, never by a delete.

## Delivery graph (no card is created by this record)

Steps 1 to 6 are dormant code under ordinary review; steps 7 and 10 to 13 are separate, owner-gated operations. No step is authorized by this record, which is Proposed.

| Step | Kind | Content | Schema / API impact | Depends on | Gate |
| --- | --- | --- | --- | --- | --- |
| 0 | documentation | On acceptance: amendment notes on the registry rows of ADR 0207, 0215 and 0154; contract updates named in "Affected contracts" | ADR registry | accepted ADR | ordinary review |
| 1 | offline code | Typed TMDB states (`tmdb_missing`, `tmdb_unreadable`) on the existing path | none | accepted ADR | review, CI |
| 2 | offline code | `writeFilmFacts` owner resolution at planning and the in-batch predicate (test 11) | none | accepted ADR | review, CI |
| 3 | offline code and schema | H1, `film:lb:` minting, the `lid_only` kind, the single lid key and its derivation function, read-only reconciliation of older keys, the owned-attempt assertion in the inferred link batch, the symmetric predicates, the `links.json` etag fence, the migration file of `film_lid_admission`, K2 proof columns; tests 1–8, 13, 16 and 5c | new table; [D1 schema](../reference/data/d1-schema.md) | 1; ADR 0207 cards | review, CI, dormant deploy |
| 4 | offline code | Settlement of the three entry points; projection and permalink acceptance of `film:lb:`; the inventory of readers that derive a claim from an id spelling; M1 exclusion in queue, manifest and `submit`; separate `eligibility` field (tests 14–15) | ledger `resolvedBy`; [film-person reference](../reference/domain/film-person.md), [catalog API](../reference/api/catalog.md), [film history and aggregate contract](../reference/api/film-history.md) | 3; ADR 0216 step 3 | review, CI |
| 5 | offline code | `mergeFilms` moves `film_lid_admission` (test 12) | none | 3 | review, CI |
| 6 | offline code and schema | Owner re-check route, the migration file of `lid_recheck_intent`, intent CAS, `lid_tmdb_attach`, the fenced Ratings link handoff (tests 9–11) | second new table; new owner admin route; admin API reference | 2, 3; the ADR 0215 writer control | review, CI, dormant |
| 7a | separate apply | Apply the `film_lid_admission` migration | D1 schema version | 3 | owner-approved apply |
| 7b | separate apply | Apply the `lid_recheck_intent` migration | D1 schema version | 6 | owner-approved apply |
| 8 | separate check | H1 markup on permitted existing captures | evidence document | 3 | read-only; no new production fetch |
| 9 | separate activation | Lid-only admission | — | 4, 5, 7a, 8; ADR 0207 `d1`; the old-key gates when an older key exists; drain | owner L3 GO |
| 10 | separate apply | Apply the ledger migration `0041` (card M1 of ADR 0207) | D1 schema version | — | owner-approved apply |
| 11 | separate activation | Attach | — | 6, 7b, 9, 10; the writer control `on`; drain of step 2 | owner L3 GO |
| 12 | planning | **M2 planning item:** the prediction support design for lid-only Films (decision 9) | design only | accepted ADR; **not** a prerequisite of steps 1–11 | owner decision; its own activation |
| 13 | future decisions | Enrichment scope for `film_lid_admission`, automatic re-check, TV Films, a merge writer, lid retirement | — | — | owner decisions |

### Affected contracts (to update with the cards that deliver them, not now)

- [Film/Person lifecycle](../architecture/film-person-lifecycle.md): one Mermaid diagram of the selected design, with rendered QA, with step 3.
- [Film/Person domain reference](../reference/domain/film-person.md): the `film:lb:` minting id and the rule that a minting id is not a current claim.
- [D1 schema](../reference/data/d1-schema.md): the two tables, with the migration registry in `migrations/README.md`.
- Receipt and admission contract of ADR 0207 (and the receipt reference): the common lid key and the new kinds.
- [Catalog API](../reference/api/catalog.md), [film history](../reference/api/film-history.md) and the admin API reference: the aggregate by `film:lb:<lid>`, the `eligibility` field and the owner re-check route.
- The Ratings and prediction references: the lid-only settlement and the M1 exclusion.
- ADR 0207, 0215 and 0154: amendment notes in the registry.

## Evidence

- **Owner selections:** H1, I1, J1, K2, L1 and M1, 25 November 2026, 17:55 Europe/Madrid, in the [consolidated owner-choice handoff](https://github.com/vladimino/iptv-watchlist/pull/996#issuecomment-7168734400), with the I1 clarification and the M1 qualification recorded above. **Not** the final disposition: this record is Proposed.
- **Implementation:** none.
- **Dated verification:** code reading at `main` `961c045` on 2026-11-25, refreshed against `main` `7d8d4b3` for the ledger migration `0041` and the Accepted ADR 0218. No production read.
- **Uncertainty:**
  - The number of pending Watchlist or Diary items in state `tmdb_none` is not measured here; that is AIR-627's census.
  - Whether Letterboxd pages without TMDB keep a stable, parseable external-id block is not established. It must be shown on permitted existing captures of real pages (delivery step 8) before H1 is enabled; synthetic fixtures cannot establish it.

## Follow-ups

The next steps, in order: independent review of this consolidated revision; then the owner's final disposition (`Accepted` or `Rejected`) with a direct approval link in this record and the registry, under the ADR merge gate; then the post-acceptance breakdown into cards (including the M2 planning item) and only then implementation work, each with its own gate.
