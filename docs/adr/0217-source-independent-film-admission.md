# ADR 0217: A verified Letterboxd film with no TMDB movie may be admitted as a canonical Film through the D1 admission coordinator, with a proof rule that does not need TMDB

**Status:** Proposed  
**Original decision date:** not decided  
**Recorded at:** 2026-11-25, from `main` `6123890` and the Accepted text of [ADR 0216](0216-canonical-film-lifecycle-and-unified-read-contract.md) at the head of [PR #991](https://github.com/vladimino/iptv-watchlist/pull/991) (not yet merged when this record was written)  
**Approval source:** not documented. No owner decision exists yet. Choices H to M below are open.  
**Related work:** [AIR-643](https://trello.com/c/e1Q9H1bG). This is the follow-up that ADR 0216 records as choice A2 and delivery step 9. Builds on [ADR 0207](0207-letterboxd-admissions-coordinated-in-d1-only.md), [ADR 0213](0213-film-identity-evidence-ledger.md) and [ADR 0215](0215-identity-evidence-full-model.md). The production census belongs to [AIR-627](https://trello.com/c/IOERZ9GI) and is not repeated here.  
**Supersedes:** None. If accepted, it amends ADR 0207 decisions 2 and 3 (adding one admission kind) and ADR 0215 decision 3 (adding one minting id). It amends nothing else.  
**Superseded by:** None

## Context

### What this record does not reopen

| Concern | Accepted source |
| --- | --- |
| Typed stable Film identity; `film:` ids are not observation keys | [ADR 0009](0009-canonical-film-person-identity.md) |
| Film/Person D1 authority, per-Film `canonical_revision`, redirects, retirement decisions | [ADR 0099](0099-canonical-film-person-d1-authority.md) |
| A Film outlives the EPG and the Watchlist; `retainFilm` keeps a Film and never creates one | [ADR 0086](0086-durable-watchlist-film-retention.md), `src/film-admission.js:120` |
| A rated archive short code is a candidate, not a Film; only a verified movie admits | [ADR 0087](0087-rated-archive-film-admission.md) |
| The Diary page check and its bounded fetches | [ADR 0166](0166-diary-rated-only-identity-bridge.md) |
| A trusted `letterboxd` claim on an existing Film needs the full Ratings-link proof | [ADR 0184](0184-ratings-confirmed-letterboxd-claim-on-existing-film.md) |
| D1 is the only admission coordinator (marker `letterboxd_admission_authority`, keep-first, operation key K2, reconcile-then-reserve) | [ADR 0207](0207-letterboxd-admissions-coordinated-in-d1-only.md) |
| Catalog enrichment producer; a Letterboxd source needs no TMDB claim | [ADR 0211](0211-catalog-enrichment-producer.md) |
| Evidence ledger; `exists` reserved and unused; minting ids carry no evidence row; reader amendments E4 | [ADR 0213](0213-film-identity-evidence-ledger.md), [ADR 0215](0215-identity-evidence-full-model.md) decisions 2, 3 and 8 |
| Lifecycle (existence separate from facts), typed input grammar, unified read contract, candidate coverage | [ADR 0216](0216-canonical-film-lifecycle-and-unified-read-contract.md) |
| Public permalink `/film/tmdb_<n>` for a trusted movie, `/film/<lid>` as alias and fallback | AIR-387, [UI read models](../architecture/ui-and-read-models.md#one-permanent-film-url-air-387) |

### Source, proof and authority matrix (code at `main` `6123890`)

Every live path that creates a Film needs a TMDB movie id. No path admits a Film from a Letterboxd id alone.

| Entry point | Writer | Proof today | Creates a Film? | Fence |
| --- | --- | --- | --- | --- |
| Watchlist sync admission (ADR 0186) | `src/letterboxd-sync-admission.js` → `LetterboxdDiaryIdentity.resolve` → `admitRatedFilm` | page check of `boxd.it/<lid>` **plus** exactly one movie `data-tmdb-id` on the page and an agreeing TMDB movie document | yes, `film:tmdb:<n>` | Film/Person marker and generation, revision CAS; ledger `watchlist_admission_pending` |
| Ratings Diary bridge (ADR 0166) | `src/letterboxd-diary-identity.js:200` → `admitDiaryFilm` → `admitRatedFilm` | the same page check | yes, `film:tmdb:<n>` | as above; ratings epoch fence |
| Rated archive identity step (ADR 0087/0090) | `commitVerified` → `applyCanonicalRatedAdmission` | short code → page → movie id → TMDB document | yes, `film:tmdb:<n>` | as above; `admitting` candidate row |
| Inferred baseline import | `admitInferredFilm` (`src/letterboxd-facts.js:575`) | title and year search, marked `inferred` (never claim proof, ADR 0184) | yes, `film:tmdb:<n>` | as above; chunk intent |
| Discovery (EPG) | `admitDiscoveryFilms` (`src/canonical-discovery-admission-producer.js:166`) | a verified Discovery key `tmdb_<n>` | yes, `film:tmdb:<n>` | Discovery route gate, Film/Person fence |
| Producer Workflow `film_facts` | `writeFilmFacts` (`src/canonical-film-writers.js:254`) | a direct `film:`/`tmdb_` id; a bare lid only through an existing trusted claim or an existing `film:<lid>`, otherwise `producer_identity_unresolved` | only for a `tmdb_<n>` source id | receipted, fenced |
| Owner actions, prediction recovery (ADR 0201) | — | — | no | — |
| Metadata, dictionary, persons, external ids, ADR 0184 claim | `requireExisting: true` | — | no | — |
| Historical import and backfill | `scripts/d1-backfill.mjs`, `scripts/offline-import.mjs` | the R2 lifecycle record | yes, including `film:<lid>` | import receipts; not a live writer |
| Merge | `mergeFilms` (`src/canonical-mutations.js:184`) | — | no; writes `film_redirect` | bundled, **no caller** |
| Retirement | `recordRetirementDecision` | — | no | **not bundled** |

Three facts shape the design:

- **`film:<lid>` is a historical minting id.** `localFilmId()` (`src/domain/film-person.js:40`) mints `film:<lid>` from a Letterboxd id. The historical import created 406 such Films. Every one of them now also carries a trusted TMDB movie or TV identity (AIR-627 first census, quoted in ADR 0216 Context). No live writer mints it any more. `canonicalFilmId()` also maps a stored **slug** to `film:<slug>`, so the bare `film:<x>` namespace is shared between lids and slugs in readers.
- **The only lid proof machinery needs TMDB.** The page check (`verifyPage`, `src/letterboxd-diary-identity.js:23`) requires the `boxd.it/<lid>` redirect to reach `/film/<slug>/`, the page shortlink to equal the lid, an agreeing canonical path, a title, one year, **and** exactly one `data-tmdb-id` of type `movie`, then an agreeing TMDB document. A page with no TMDB id or a TV id ends as pending or unresolved.
- **TMDB outcomes are not fully typed.** `movieDetail` (`src/letterboxd-rated-candidates.js:216`) separates transport stops (`tmdb_unavailable`, rate limit, challenge: non-terminal, no attempt spent) from everything else, but a TMDB `404` and any other non-200 share `review: tmdb_fetch_failed`. "TMDB says this movie does not exist" cannot be told apart from "TMDB failed".

### Why the gap matters now, and why it is not a defect

The AIR-627 census found **no** pure lid-only Film today. Letterboxd lists films that TMDB does not hold (shorts, festival titles, regional releases) or holds only under another type. A Watchlist or Diary entry for such a film stays a pending item in its domain forever; it never gets a Film, a permalink, metadata or a prediction. A global catalog cannot list it. This is a future capability, and every rule below must keep the existing TMDB-proved path unchanged.

## Decision (proposed)

### 1. What a lid-only Film is

A **lid-only Film** is a canonical Film admitted on the proof of one verified Letterboxd film id, with no trusted `tmdb` claim at admission. It is an ordinary Film in every other respect: permanent id, five lifecycle dimensions, retention, redirect and retirement rules, unified read contract (ADR 0216). It is not a provisional record and it is never deleted for lacking TMDB.

- Admission still happens **only** through an existing admission entry point that already verifies a lid: the Watchlist sync admission step, the Ratings Diary bridge and the rated archive identity step (whose short code resolves to a lid through `boxd.it`). These are the routes `watchlist_admission`, `ratings_diary` and `letterboxd_rated_archive`.
- **Not eligible:** the inferred import (title and year search is never proof), Discovery (an EPG title is never proof of a Letterboxd id), the producer Workflow, owner routes and any read. A bare sighting (`exists`) never admits (ADR 0215 decision 2 is unchanged).

### 2. Proof: what makes a lid verified without TMDB (choice H)

The proof is a **Letterboxd page check without the TMDB requirement**, performed by the writer at write time, never supplied by a caller. Proposed rule (H1):

1. `GET boxd.it/<lid>` redirects, within the ADR 0166 limits, to `https://letterboxd.com/film/<slug>/`;
2. the page's own shortlink equals the requested lid, and its canonical path equals the redirect target;
3. the page is a film page (`og:type` or the page's own type marker), with a non-empty title;
4. the page carries **no** `data-tmdb-id` at all. A page that names a TMDB movie goes through the existing TMDB-proved path, whatever the TMDB outcome (decision 3);
5. the evidence digest is the existing deterministic `sha256(lid, slug, path, tmdb, title, year, source)` with `tmdb` empty.

What is never proof, alone or together: a slug, a short code that has not been resolved through `boxd.it`, a title, a year, a title and year match, an inferred link, a Ratings link index entry, a Watchlist listing, an `exists` sighting.

The year is **optional**: a page without exactly one year is admitted with `year` unknown, not refused (missing optional metadata, case 11).

### 3. TMDB states are typed, and only one of them admits a lid-only Film

The page check classifies the TMDB relation before any admission:

| State | Observed | Outcome |
| --- | --- | --- |
| `tmdb_movie` | exactly one `data-tmdb-id` of type `movie`, TMDB document agrees | existing path, `film:tmdb:<n>`; unchanged |
| `tmdb_none` | the page carries no TMDB id | **lid-only admission** (this ADR) |
| `tmdb_tv` | the page names a TMDB TV id | **not admitted** as a lid-only movie Film. Stays pending `tmdb_not_movie` until a separate TV decision; never stored as a `tmdb` movie key |
| `tmdb_missing` | the page names a movie id and TMDB answers `404` for it | contradiction: pending `tmdb_contradiction`, owner review. Never downgraded to `tmdb_none` |
| `tmdb_unavailable` | transport failure, rate limit, challenge, no token, timeout | non-terminal; no attempt spent (ADR 0207 decision 4b); never downgraded to `tmdb_none` |
| `tmdb_failed` | other non-200 or an unparseable document | pending `tmdb_fetch_failed`, counted attempt; never downgraded to `tmdb_none` |
| `tmdb_ambiguous` | more than one TMDB id, or a type marker missing | pending `tmdb_type_missing`; never downgraded |

This needs one code change on the existing path: `movieDetail` must return `404` as its own state (`tmdb_missing`) instead of folding it into `tmdb_fetch_failed`. That change alone admits nothing.

**Retirement.** A lid-only Film has no movie claim to retire. Its lid is retired only by the owner retirement path of ADR 0099 once a live writer exists (ADR 0215 decision 5, parked). A page that later disappears (`404` on `boxd.it`) changes no Film: it is a failed re-check, not a retirement.

### 4. Stable id and uniqueness (choice I)

Proposed (I1): mint **`film:lb:<lid>`**, a new namespaced minting id.

- It is the Film's definition, as `film:tmdb:<n>` is (ADR 0215 decision 3): **no `film_has_id` evidence row** for it, and readers never require one.
- The same batch writes the trusted, non-conflicting claim `film_external_id (scheme 'letterboxd', value <lid>)`. The existing partial unique index `film_external_id_one_trusted` on `(scheme, value) WHERE trusted=1 AND conflicting=0` then makes **one trusted owner per lid** a database invariant. That index, not the id spelling, is the uniqueness proof.
- `canonical_identity` stays null (no trusted `tmdb`), exactly as `writeFilmFacts` already does without one.
- Why not reuse `film:<lid>`: that namespace is shared with stored slugs in `canonicalFilmId()`, and every historical `film:<lid>` Film already holds a TMDB identity. Reusing it would make a new lid-only Film indistinguishable from an imported one. `film:lb:` is readable, cannot collide with `film:tmdb:` or `film:conflict:` (a lid has no colon), and needs no migration because `film.id` only checks `LIKE 'film:%'`.

**Before minting, the writer asserts in the fenced batch:** no `film` row and no `film_redirect` from `film:lb:<lid>`; no `letterboxd` claim of any trust for the lid on any Film; no `film_lid_admission` row for the lid (decision 5). Any match is a typed outcome (decision 6), never an overwrite.

### 5. Writer: the ADR 0207 coordinator, one new admission kind (choice J)

Proposed (J1): **no new parallel writer.** Lid-only admission is a new admission kind `lid_only` of the ADR 0207 coordinator and runs only while `letterboxd_admission_authority` is `d1`. Under `r2` and `closed` it is refused before its first effect, like every other kind.

- **Record.** `film_rated_admission` cannot hold it: its `tmdb` is mandatory and its unique key is the short code. A new additive table **`film_lid_admission`** (`lid` primary key, `film_id`, `route`, `evidence_digest`, `title`, `year` nullable, `admitted_at`, `receipt_key`) is keep-first like decision 2 of ADR 0207: an existing row for the lid is a no-op whatever the new input.
- **Operation key.** `admission:lid_only:<lid>` under K2, so the reconcile-then-reserve protocol (ADR 0207 decision 3) settles every earlier attempt of the lid before a new one, including an earlier attempt of kind `lid` that might admit a TMDB movie for the same lid. Proposed: the two kinds share the key `admission:lid:<lid>`, so one lid has one unresolved attempt across both outcomes. The kind is part of the receipt content, not of the key.
- **One fenced batch** (`mutateFilm`): Film/Person marker generation, admission marker mode `d1` and generation, the absence assertions of decision 4, `film` insert, the trusted `letterboxd` claim, the `film_lid_admission` row, the applied receipt and, under K1, the evidence row of decision 7 (`same_work` does not fit: there is no second entity).
- **Statement budget:** 9 to 11 statements, within `STATEMENT_CAP` 40.
- **Digest** without clock or receipt key, as ADR 0207 decision 3: `{kind: lid_only, lid, evidence digest, title, year}`.

### 6. Outcomes for each case

| Case | D1 state seen | Outcome |
| --- | --- | --- |
| 1 valid lid-only | no row, no claim, page check `tmdb_none` | `admitted`, Film `film:lb:<lid>` |
| 2 unverified slug | caller has a slug or a short code that does not resolve | refused before any write: `lid_unverified`; nothing stored |
| 3 upstream unavailable | Letterboxd or TMDB transport failure | pending `deferred`/`source_unavailable`, non-terminal |
| 4 duplicate or replay | `film_lid_admission` row for the lid, same Film | `present`; no write, no evidence (no verification performed) |
| 5 concurrent lid-only and TMDB admission of the same lid | two attempts under one operation key | K2 allows one unresolved attempt; the loser replans from durable state |
| 5b concurrent admission of the same work through two lids | two `film:lb:` Films | allowed; they are two Films until a proved merge (decision 8). No title matching joins them |
| 6 late TMDB claim | the page later names a TMDB movie | decision 8 |
| 7 competing claim | another Film holds the lid trusted, untrusted or conflicting | `code_on_other_film` → pending `admission_conflict`, owner review |
| 8 retirement or TV | page names a TV id; lid retired | not admitted (decision 3); retired lid answers `retired` |
| 9 merge, redirect, history | target is a redirect source | `film_person_redirect`, non-terminal; the readback follows the redirect |
| 10 leaving the Watchlist | lid removed from the list | the Film stays (ADR 0086 retention); membership becomes `false` or `unknown` under ADR 0216 |
| 11 missing optional metadata | no year, no synopsis | admitted; fields `unknown`, never invented |

### 7. Evidence and provenance (ADR 0215 coordination)

- The minting id needs no evidence row (ADR 0215 decision 3, extended to `film:lb:`).
- The page check is still recorded, because it is the admission's justification. Proposed (choice K, K1): a **`film_has_id(film:lb:<lid>, letterboxd_lid <lid>)`** row is not written (minting), and instead the admission writes an `asserts exists(letterboxd_lid <lid>)` row, method `page_check`, its route, `source_root` = the evidence digest, in the same batch. This is the **first writer of the reserved `exists` relation**, and only on the canonical path inside an admission batch, never as a bare sighting. It is exactly the revisit trigger named by ADR 0215 decision 2 (a global catalog of entities with no TMDB). Alternative K2: write no evidence row and keep the proof only in `film_lid_admission.evidence_digest`.
- No reader uses that row to decide anything until its own E4 amendment.
- No invented provenance: the claim's `provenance_json` is `{source: <route>, adr: 0217, evidence: <digest>}` and names no TMDB id.

### 8. A later verified TMDB movie (choice L)

The local id never changes.

- **No Film holds the movie:** the TMDB movie is **attached** to the lid-only Film as a trusted `tmdb` claim by the existing `film_external_ids` unit in `addOnly` mode, on a fresh page check whose state is `tmdb_movie` with an agreeing TMDB document, in one fenced, receipted batch with the revision CAS. `canonical_identity` becomes `tmdb:<n>`. The Film keeps `film:lb:<lid>`; its public permalink becomes `/film/tmdb_<n>` by the existing AIR-387 rule. Historical storage keys (ratings, Diary, predictions under the lid) are not renamed or copied.
- **Another Film already holds the movie trusted** (`film:tmdb:<n>`): proposed (L1) a typed conflict `tmdb_on_other_film`, recorded for owner review, and **no automatic merge**. A merge needs a live merge writer, which does not exist (`mergeFilms` has no caller); when one is accepted, the owner-confirmed merge leaves a `film_redirect` and every fact stays readable through the survivor (ADR 0216 decision 1). Alternative L2: automatic merge when both Films' proofs pass; not recommended until a merge writer and its rollback exist.
- **The movie claim is untrusted, conflicting or retired:** `admission_identity_held`, non-terminal, owner review.

### 9. Consumer eligibility (choice M)

| Consumer | Lid-only Film |
| --- | --- |
| Unified read (ADR 0216) | eligible by `film:lb:<lid>` and by the lid; `tmdb_<n>` answers `absent` |
| Public permalink | `/film/<lid>`, the existing AIR-387 fallback; no `tmdb_` permalink is invented |
| `GET /api/catalog/film/<tmdbId>` | not reachable (movie id only); unchanged |
| Watchlist, ratings, Diary, retention | as any Film |
| Catalog enrichment (ADR 0211) | Letterboxd source only, per ADR 0211's existing rule; TMDB fields `unknown` |
| Discovery and EPG availability | none: a lid-only Film never matches an EPG title |
| Predictions | proposed M1: **not eligible** until a separate prediction decision says which features a Film without TMDB metadata may use. Alternative M2: eligible with partial features |

ADR 0211 and AIR-387 are not changed. Where a consumer needs a change, it is its own card.

## Alternatives considered (open owner choices)

| Choice | Proposed | Alternatives |
| --- | --- | --- |
| H. Proof | **H1** page check without TMDB, page carries no TMDB id | H2 H1 plus a second independent root (a Ratings fact record of the lid); H3 owner statement only (owner creates each lid-only Film) |
| I. Stable id | **I1** `film:lb:<lid>` | I2 reuse historical `film:<lid>` (slug namespace collision, indistinguishable from imported Films); I3 opaque random id (no deterministic replay) |
| J. Writer | **J1** new kind of the ADR 0207 coordinator, new keep-first table, shared operation key per lid | J2 relax `film_rated_admission.tmdb` to nullable (rewrites a mandatory column and its unique semantics); J3 separate writer (rejected by the card: a parallel writer) |
| K. Evidence | **K1** first canonical-path `exists` row in the admission batch | K2 no evidence row, digest on the admission record only |
| L. Late TMDB on another Film | **L1** typed conflict, owner review, no automatic merge | L2 automatic merge |
| M. Predictions | **M1** not eligible until its own decision | M2 eligible with partial features |

Rejected without a choice: title, year or slug matching as proof; admitting from Discovery; admitting from a bare sighting; downgrading an unavailable or contradictory TMDB result to `tmdb_none`.

## Consequences

- Letterboxd films without TMDB get a permanent Film, retention, a permalink and the unified read, without weakening the TMDB-proved path.
- One more admission kind, one table, one typed TMDB state and one minting namespace to maintain. Readers that parse `film:` ids must accept `film:lb:`.
- Two lid-only Films of the same work may coexist until a proved merge; this is visible, not silent.
- The first `exists` writer (K1) commits the ledger to that relation's semantics.

## Synthetic test plan

Every case uses synthetic fixtures only and asserts no write on refusal.

1. Valid lid-only page: one Film `film:lb:<lid>`, one trusted `letterboxd` claim, one `film_lid_admission` row, one receipt, revision 1; with K1 one evidence row.
2. Slug, unresolved short code, title or year input: refused, nothing written.
3. Each non-admitting TMDB state of decision 3 (`tmdb_tv`, `tmdb_missing`, `tmdb_unavailable`, `tmdb_failed`, `tmdb_ambiguous`): no Film, the listed pending outcome; `404` is distinct from other non-200.
4. Replay, lost response, crash after the batch: `present`, no second row, no evidence.
5. Concurrent lid-only and TMDB-path attempts on one lid: one unresolved receipt (partial unique index); the loser replans; the outcome is a function of durable state.
6. Two lids of one work: two Films, no merge.
7. Late TMDB movie, free: attached, id unchanged, permalink moves to `tmdb_<n>`, no key renamed. Held by another Film: `tmdb_on_other_film`, nothing changed.
8. Competing claim of any trust on the lid: conflict, nothing written.
9. Redirected target, retired lid, TV page.
10. Marker `r2` or `closed`: refused before the first effect; legacy behaviour byte-identical.
11. No year, no synopsis: admitted with `unknown` fields.
12. Unified read: `film:lb:<lid>` and the lid `found`, `tmdb_<n>` `absent`; leaving the Watchlist keeps the Film.
13. The statement count at the largest batch stays within `STATEMENT_CAP`.

## Cost

One additive migration (`film_lid_admission`, no data migration); about 9 to 11 statements per admission; one extra page fetch is not needed (the existing check already fetches the page). Expected volume is low: the census found no current lid-only Film, so writes follow natural Watchlist and Diary events only.

## Recovery and migration boundary

This record authorizes nothing: no migration, no flag, no Task, no Letterboxd or TMDB production call, no D1 or R2 write, no activation. The admission kind is live only after ADR 0207's own activation (`letterboxd_admission_authority` = `d1`) **and** a separate owner L3 GO for lid-only admission, with its own rollback plan. Before that GO, a code revert is an ordinary rollback. After the first lid-only Film exists, a code revert does **not** remove it: the Film, its claim and its admission row stay, and readers must keep accepting `film:lb:`. Removal of a wrongly admitted Film is an owner retirement or merge, never a delete.

## Delivery graph (no card is created by this record)

| Step | Kind | Content | Depends on | Gate |
| --- | --- | --- | --- | --- |
| 1 | offline code | Typed TMDB state `tmdb_missing` in `movieDetail`; no admission change | accepted ADR | review, CI |
| 2 | offline code and schema | Page check without TMDB (H), `film:lb:` minting (I), migration file for `film_lid_admission`, the `lid_only` kind behind the ADR 0207 marker (J), evidence (K); tests 1–11, 13 | 1; ADR 0207 cards delivered | review, CI, dormant deploy |
| 3 | separate apply | Apply the migration | 2 | owner-approved migration apply |
| 4 | offline code | Late TMDB attach and `tmdb_on_other_film` (L); test 7 | 2 | review, CI |
| 5 | offline code | Readers accept `film:lb:`; unified read case 12 | 2; ADR 0216 step 3 | review, CI |
| 6 | separate activation | Enable lid-only admission | 3, 4, 5; ADR 0207 activated | owner L3 GO and rollback plan |
| 7 | future decision | Prediction eligibility (M2), TV Films, merge writer | — | owner decision |

## Evidence

- **Original decision:** not yet; this record is Proposed.
- **Implementation:** none.
- **Dated verification:** code reading at `main` `6123890` on 2026-11-25; no production read.
- **Uncertainty:** how many current pending Watchlist or Diary items are `tmdb_none` is not measured here (AIR-627 owns the census); whether Letterboxd film pages without TMDB carry a stable type marker must be confirmed on synthetic captures in step 2.

## Follow-ups

Owner choices H to M; then an independent technical review of the revised text, the owner disposition, and only then the implementation cards of the delivery graph.
