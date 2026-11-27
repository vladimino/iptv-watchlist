# ADR 0216: Canonical Film lifecycle and the unified Film read contract

**Status:** Accepted  
**Original decision date:** 2026-11-25 ([owner disposition](https://github.com/vladimino/iptv-watchlist/pull/991#issuecomment-7161412265))  
**Recorded at:** 2026-11-25, from `main` `a537c9c7`. Revised the same day after the [independent technical review](https://github.com/vladimino/iptv-watchlist/pull/991#issuecomment-7156435200) of `bb1605aa` the [second review](https://github.com/vladimino/iptv-watchlist/pull/991#issuecomment-7156853568) of `cfc48c6d`, the [third review](https://github.com/vladimino/iptv-watchlist/pull/991#issuecomment-7156969487) of `c08984ee`, the [owner's instruction adding choice G](https://github.com/vladimino/iptv-watchlist/pull/991#issuecomment-7157683873) from the AIR-627 audit, the [fourth review](https://github.com/vladimino/iptv-watchlist/pull/991#issuecomment-7159940391) of `d7ec6d22`, and the [consolidated owner-choice handoff](https://github.com/vladimino/iptv-watchlist/pull/991#issuecomment-7161307943).  
**Approval source:** [Product Owner disposition of 25 Nov 2026](https://github.com/vladimino/iptv-watchlist/pull/991#issuecomment-7161412265), recorded verbatim by the Coordinator from the owner's conversation: «Давай принимать уже», accepting the design with the selections A2, B3, C2, D2, E1, F1, G1 ([exact choices](https://github.com/vladimino/iptv-watchlist/pull/991#issuecomment-7161307943)) as reviewed at `8d0715af` in the [final technical review](https://github.com/vladimino/iptv-watchlist/pull/991#pullrequestreview-6056975282). The later wording change `f9dc217e` only states that review's fail-closed coverage obligations in the contract. This is an architecture acceptance only, with no implementation, migration, promotion or production GO.  
**Related work:** [AIR-628](https://trello.com/c/zwJum962), companion audit [AIR-627](https://trello.com/c/IOERZ9GI). Coordinated with, and not extending, Accepted [ADR 0214](0214-film-metadata-per-field-provenance.md) (per-field metadata provenance, AIR-613) and Accepted [ADR 0215](0215-identity-evidence-full-model.md) (full identity evidence model, AIR-616).  
**Supersedes:** None. It amends no accepted decision.  
**Superseded by:** None for the ADR as a whole. Only the `GET /api/d1/films/<id>` row of decision 11 ("Stays an operator view") is superseded, by [ADR 0223](0223-retire-unused-d1-catalog-http-views.md); choice F1 is unchanged and F2 remains a rejected alternative. The text below is preserved as the historical decision.

## Context

### What is already decided and is not reopened here

| Concern | Accepted source |
| --- | --- |
| Typed stable Film identity, `film:` ids distinct from observation keys | [ADR 0009](0009-canonical-film-person-identity.md) |
| Film/Person D1 authority: one marker generation **and a per-entity revision** (`canonical_revision`), redirects, retirement decisions | [ADR 0099](0099-canonical-film-person-d1-authority.md), migration `0013` |
| Five independent lifecycle dimensions and derived readiness | AIR-42, [Film/Person reference](../reference/domain/film-person.md) |
| A Film survives leaving the EPG and the Watchlist; rated archive admission | [ADR 0086](0086-durable-watchlist-film-retention.md), [ADR 0087](0087-rated-archive-film-admission.md), AIR-475 |
| Public permalink `/film/tmdb_<n>` for a trusted TMDB movie, `/film/<lid>` as alias and fallback | AIR-387, AIR-409, AIR-475, [UI read models](../architecture/ui-and-read-models.md#one-permanent-film-url-air-387) |
| Historical prediction storage keys stay under the Letterboxd id | [ADR 0201](0201-recovery-admits-stored-letterboxd-id-via-catalog-film.md); it authorizes no ratings-only alias |
| A trusted `letterboxd` claim is materialized on an existing Film only with the full Ratings-link proof, single-lid | [ADR 0184](0184-ratings-confirmed-letterboxd-claim-on-existing-film.md), AIR-559 |
| Watchlist **source** authority (`watchlist_authority` `epg`/`d1`, `watchlist_current.snapshot_id`, `version`) | [ADR 0186](0186-letterboxd-sync-and-independent-watchlist-authority.md) |
| Watchlist **membership projection** writer switch (`watchlist_membership_authority` `producer`/`sync`, per-Film fence and handoff); several lids may name one Film | [ADR 0203](0203-watchlist-membership-letterboxd-single-writer-projection.md) |
| Letterboxd admissions coordinated in D1; admission is proved by a TMDB movie | [ADR 0207](0207-letterboxd-admissions-coordinated-in-d1-only.md) |
| Identity evidence ledger; `exists` reserved and unused; future proof policy is E4 | [ADR 0213](0213-film-identity-evidence-ledger.md), [ADR 0215](0215-identity-evidence-full-model.md) decision 2 |
| Owner-reviewed localization precedence (`owner_review_entry`) | [ADR 0081](0081-d1-authoritative-owner-reviews.md) |
| Dormant marker-gated bulk read model | AIR-372, `src/canonical-read-model.js` |

### The gap

Each domain has a safe reader of its own facts. No contract says how those facts form **one answer about one Film**:

- `GET /api/catalog/film/<tmdbId>` answers identity (`found`, `absent`, `retired`, `conflict`, `unavailable`) and the catalog body. It takes a TMDB movie id only.
- `GET /api/d1/films/<id>` ([D1 catalog views](../reference/api/d1-catalog.md)) reads schema v1 `actual_rating` and `prediction_current`. The authoritative personal facts are in the ratings domain (`ratings_view`, `ratings_document`), and the authoritative prediction pointer is `prediction_pointer`.
- `GET /api/enrichment/history?filmId=` ([film history](../reference/api/film-history.md)) bridges a `tmdb_<n>` permalink to the verified lid storage id through `catalogFilmIdentityBridge` (`src/canonical-catalog-reader.js`). That bridge rejects a redirect source, has no TV scheme and requires **at most one** trusted lid. ADR 0203 allows several lids for one Film. The history route also classifies several Diary lid candidates as `ambiguous`.
- `src/canonical-read-model.js` is not bundled and composes identity, titles and credits only.

**Historical prediction keys without a canonical claim.** The [AIR-627 audit](https://trello.com/c/IOERZ9GI#comment-6b06a0deb3fbeaeb5f93f8b2) found 15 `prediction_pointer` keys reachable only through the ratings link, not through a trusted canonical claim. Four Films have no other pointer. Eleven have a second pointer, five of them with a different current value. Pointer existence is established; the R2 bodies were not checked. A rule that reads only verified claims would answer `none` for the four and hide the five conflicts (choice G).

There is also **no admission policy** for a verified Letterboxd film with no TMDB movie. The AIR-627 first census found no pure lid-only Film among the lid-owned Films: 402 carry a trusted TMDB movie id and 4 a TMDB TV identity. This is a future capability, not a live defect.

## Decision

### 1. Lifecycle: existence is separate from facts

```
source observation / candidate        (its own domain; no Film exists)
        │ admission by an existing writer (today: TMDB movie proof, ADR 0207)
        ▼
canonical Film  (permanent film.id; never deleted for lack of a fact)
        │
        ├── identity claims, aliases, redirects, retirements
        ├── metadata, localization, credits        (PF, ADR 0214)
        ├── Watchlist membership                   (ADR 0186 source, ADR 0203 projection)
        ├── availability: shows of the published EPG generation
        ├── personal facts: watched, rating, Diary (ratings domain)
        └── prediction current + lineage           (prediction domain)
```

- An observation (an EPG title row, a Watchlist lid, an archive line) is **not** a Film. It stays in its domain until an existing admission writer admits it. This ADR adds no writer and changes no proof rule.
- `inWatchlist`, `available`, `watched`, `rated`, `predicted` and `metadataComplete` are **orthogonal facts or derived views**. None is a stage of existence. Losing one never removes the Film.
- A merge leaves a `film_redirect` and keeps every fact readable through the survivor. A retirement keeps the retired claim as evidence. Neither erases history.

### 2. Typed input grammar

The aggregate takes exactly one typed id `{scheme, value}`:

| Scheme | Value | Accepted spelling |
| --- | --- | --- |
| `film` | the D1 `film.id` | `film:<id>` |
| `tmdb_movie` | positive integer, at most 12 digits | `tmdb_<n>` (the public permalink spelling) |
| `tmdb_tv` | positive integer, at most 12 digits | `tmdb_tv:<n>` only; never a public permalink |
| `letterboxd_lid` | `^[A-Za-z0-9_-]{1,80}$` and **not** matching `^tmdb_[1-9]\d{0,11}$` | the bare lid |

- The `tmdb_` prefix is checked first, as in every existing reader. A string that matches neither row is `400 invalid`. A title, year, slug or `letterboxd_slug` alias is never an input.
- `tmdb_movie` and `tmdb_tv` are separate schemes. A TV number is **never** used to look up a movie claim or a `tmdb_<n>` storage key, and the reverse.
- The public permalink rules of AIR-387 are unchanged. The aggregate never issues a redirect; it reports `identity.permalink` as those rules compute it.

### 3. Identity resolution and the identity read-set

Resolution reads, in bounded queries:

0. for the `film` scheme only: the `film` row of that id, or a `film_redirect` row whose `from_id` is that id. A canonical id is not an external claim; it is `absent` only when neither row exists, whatever `film_external_id` holds;
1. for an external scheme: every `film_external_id` row for the requested `(scheme, value)`, including untrusted and conflicting rows and rows of other Films;
2. the redirect chain from the owner, at most `CANONICAL_REDIRECT_DEPTH` hops, with cycle detection;
3. the survivor's own claims of every scheme, and every row of any other Film that claims one of those values;
4. the latest non-superseded `tmdb_retirement_decision` of the requested or claimed movie ids;
5. the survivor's `canonical_revision`, and the revision of every Film met on the way.

Verdicts:

| Verdict | When | HTTP |
| --- | --- | --- |
| `found` | one trusted, non-conflicting owner; survivor reached; no competing claim on any alias the sections will use | 200 |
| `redirected` | as `found`, reached through `film_redirect` from the requested Film; `redirectedFrom` lists the chain | 200 |
| `absent` | no row of any trust for the typed value | 404 |
| `retired` | the requested **external claim** is retired by a non-superseded owner decision (ADR 0057/0099). A merged `film:` id is `redirected`, not `retired` | 410 |
| `conflict` | the requested value has a conflicting or competing trusted row, or the survivor holds an **unsettled** untrusted or conflicting claim on a scheme a section reads | 409 |
| `unverified` | only untrusted rows exist for the requested value | 409 |
| `cycle` | the redirect chain loops or exceeds the depth | 409 |
| `unavailable` | the Film/Person marker is not `open`, or a read failed | 503 |

- **A settled retirement is not a conflict.** A movie claim with a non-superseded owner retirement decision is historical evidence. It is removed from every alias set **before** conflict evaluation, it never vetoes the Film's other identities, and its `tmdb_<n>` key is never read by any section. It is reported in `identity.claims` with `retired: true`. Only an untrusted or conflicting claim that no owner decision settles is a conflict.
- An untrusted or conflicting claim of the survivor on a scheme **no section reads** (for example a `letterboxd_slug` alias) is reported in `identity.claims` and does not fail the request.
- The corrected TV Films: a TV identity `tmdb_tv 123`, a retired movie claim `tmdb 123` (or another number) and a verified lid on one Film. A request for `tmdb_tv:123` or for the lid answers `found`; the movie claim is excluded as above, so the sections read the lid and never the movie key. A request for `tmdb_<123>` answers `retired`. No lookup touches the other scheme.
- The resolver returns the survivor and its **verified storage-id set per domain** (decision 5).
- `catalogFilmIdentityBridge` is not reused unchanged. Its callers (history, `POST /api/started`, recovery) keep their strict single-lid semantics and their write authorization; the new resolver is a separate read-only function.

**The identity read-set** is the marker generation, the `canonical_revision` of every Film read in steps 0–5, a digest of every claim row read in steps 1 and 3 **including the row counts per queried `(scheme, value)`** (so a new competing claim or a vanished row changes it), the `film` and redirect rows read, and the retirement decision `seq` values read. It is captured before any section read.

**Coherent capture (mandatory invariant).** Statements of one D1 `batch` are bound before it runs, so a later statement cannot consume an earlier statement's result. Dependent discovery (owner, then redirect chain, then the survivor's claims, then competing claims of those values) is therefore expressed in one of two ways, and the implementation card must show which:

- **in bounded SQL inside one statement**, for example a recursive CTE over `film_redirect` limited to `CANONICAL_REDIRECT_DEPTH` joined to `film_external_id`, `canonical_revision` and `tmdb_retirement_decision`, with explicit count predicates for absent and competing rows; or
- **in bounded rounds**, followed by one final batch that re-reads **every** row and every absence predicate of the discovered read-set by key and compares the digest. Any difference is `identity_moved`.

The final capture always uses the second form over the complete read-set, so a capture made in rounds is fully revalidated before any answer.

### 4. Identity fence across the whole aggregate

The statements for the final capture are **reserved from the request budget before any section read** (decision 7). After **all** section reads, the resolver re-reads the identity read-set. If the marker generation, any revision, any claim row, any redirect or any retirement decision differs, the **whole aggregate** fails closed with `503 unavailable`, `reason: identity_moved`, and returns no section. If the final capture cannot run or cannot complete, the answer is the same `503` with no section; a partially fenced aggregate is never returned. This holds independently of the per-section fences (E1) and of any optional read failure. A lid that is revoked or reassigned while personal facts are being read therefore cannot attribute those facts to the wrong Film.

The display section also captures the owner-review authority token (the `owner_review_entry` rows read for the survivor and its redirect ancestors) and the localization source rows read. A change of either fails the display section with `generation_moved`, not the whole aggregate.

**Per-section fence (E1).** Every section captures its tokens **before** its reads and re-reads them **after**, in addition to the identity fence. Tokens include content, not only markers: document `etag`s, `content_sha256`, row versions and pointer versions. Any difference makes that section `unavailable` with `generation_moved`. A token returned in the answer is a statement of what was read, not by itself a fence.

### 5. Sections, their authority and their tokens

The aggregate is computed per request over the existing safe readers. It is not a new table, writer or authority (B3).

| Section | Alias set read | Authority | Token (required) | Negative proof |
| --- | --- | --- | --- | --- |
| `identity` | — | D1 Film/Person tables | identity read-set digest | verdict `absent` only from step 0 (no `film` or redirect row) or step 1 (no claim row of any trust) |
| `display` | survivor and redirect ancestors (owner entries) | `film_metadata` with per-field provenance (ADR 0214), localization sources, `owner_review_entry` (owner > reviewed > automatic) | metadata `content_sha256` or `updated_at`, owner-review token | a field is `absent` only when its provenance records an explicit null; otherwise `unknown` |
| `watchlist` | authorized `letterboxd_lid` claims of the survivor | source: `watchlist_authority` and `watchlist_current` (ADR 0186); projection: `watchlist_membership_authority` and `watchlist_film` (ADR 0203) | `watchlist_authority.generation`, `watchlist_current.version`, `snapshot_id`, membership authority mode and generation | see "Watchlist negative proof" below |
| `availability` | `tmdb_<n>` of the trusted movie claim, and each verified lid, as the published document names films | published EPG generation and its pin | `programmeRunId`, `generation` | empty `current` only from the pinned generation; past generations are out of scope |
| `personal` | authorized lids and `tmdb_<n>`, through the ratings link index; candidate coverage of decision 6b | ratings domain D1: `ratings_view`, `ratings_document` (fact records, Diary history and state) | ratings marker generation, each document `etag` read, coverage token | `watched:false` only from a `ratings_view` row with `watched=0` and complete coverage; a missing Diary entry is never "unwatched" |
| `predictions` | authorized storage ids (`tmdb_<n>` and each authorized lid); candidate coverage of decision 6b | prediction domain D1 `prediction_pointer`, `prediction_lineage`; bodies in immutable R2 objects | prediction marker generation, pointer rows digest, coverage token | `none` only when the pointer is absent for every **authorized** storage id **and** candidate coverage is complete (decision 6b); never from `prediction_current` |
| `history` | see decision 6a | the existing history route, unchanged, until the migration card | none in v1 (`token: null`, `tokenStatus: "unavailable"`) | never claimed |

**Watchlist negative proof.** `watchlist.source.member` means **membership of the survivor's verified aliases**, not proven real-world membership of the work. Its values:

- `true`: a verified lid is listed in the current source snapshot.
- `false` only when all of these hold: the alias set is not empty; the source authority is `d1` with a complete snapshot and every verified lid was checked against it; **no listed lid of that snapshot is unsettled**: no `watchlist_admission_pending` row in any state other than `resolved` or `superseded` (so `pending` in backoff or not yet due, and `terminal` unresolved, all count) and no `watchlist_membership_handoff` row of any due time or attempt count for any listed lid, because an unresolved listed lid might be this Film; when that coverage cannot be read or proved, the answer is `unknown`; the identity fence passed.
- `unknown` otherwise, with a reason: `no_verified_alias`, `source_epg_mode`, `unresolved_listed_ids`, `snapshot_incomplete`.

Under the projection writer mode `producer` the `projection` part reports the producer-written `watchlist_film` row and its mode; it never strengthens `source.member`.

Rules shared by every section:

- **Authorized alias set.** A storage id joins a section's alias set only through a trusted, non-conflicting claim of the survivor that survived the identity fence (decision 6b). The raw requested key is never read as a fallback when it is not in that set.
- **Field statuses.** The identity section carries a **verdict** (decision 3). Every other section and each field carries a **status**: `present`, `absent`, `unknown`, `unavailable`, `partial`, `conflict` or `limited` (`limited` is used only by `history`, decision 6a), plus `source` and the token above. A token that could not be read is `null` with `tokenStatus: "unavailable"`. A required token that cannot be read makes the section `unavailable`, never `present`; a coverage token that cannot be read makes coverage `incomplete`.
- **Coverage.** A section that read only part of its alias set, hit a budget (decision 7) or has incomplete candidate coverage (decision 6b) is `partial` and names what it skipped, unless a known conflict makes it `conflict`. It never reports a negative.
- **Projection lag.** `watchlist.projection` reports the membership the projection holds, separately from `watchlist.source`. A difference is reported as `lag`, including when effects are drained but the per-Film membership write is still owed.

### 6. Several aliases for one Film (selected C2)

Every section reads every **authorized** alias (decision 6b) and:

- **Deduplicates by stable event identity.** One ratings fact reachable through two aliases (the link index maps both to one `factKey`) is read and counted **once**. Two distinct events under two aliases stay two events, each with its `storageId`.
- **Reports conflicts.** When two aliases carry different current values (two current ratings, two current predictions, two Diary links), the field is `conflict` with each value and its `storageId`. No value is chosen and no storage key is renamed.
- **Never drops silently.** Diary entries of every authorized lid are included. A Diary lid candidate outside the authorized set stays excluded and is named in `notes`.
- **Fact redirects** of the ratings documents are followed once per alias, as the history route does, and deduplicated by the resulting `factKey`.

#### 6a. History before and after its migration

Until the multi-alias history migration (delivery graph step 6) is delivered, the aggregate does **not** advertise complete history:

- `history.status` is `limited` with `reason: history_migration_pending` when the survivor has exactly one authorized lid, candidate coverage (decision 6b) is `complete`, the requested id is `tmdb_<n>` or that lid, and the legacy route accepts it. `href` points to the legacy route, which answers under its own contract and its own completeness notes.
- In every other case (several authorized lids, incomplete candidate coverage, a `film:` or `tmdb_tv:` request, a bridge the legacy route rejects) `history.status` is `unavailable` with the same reason and **no `href`**, so no raw requested key is read as a fallback.
- `history.status` is never `present` in v1.

The migration must deliver, before `present` may be returned: acceptance of every typed id of decision 2; a cursor bound to the canonical survivor, the identity read-set digest, the candidate-coverage token of decision 6b and the source tokens of every source read; typed invalidation (`409 history_changed` with `reason` `identity_moved`, `alias_set_changed`, `coverage_changed` or `source_changed`); and stable event identities `<storageId>|<sourceEventId>` with the deduplication of decision 6.

The standalone history route keeps its contract until that migration changes it. Its strict bridge consumers keep their write authorization; nothing here broadens what `POST /api/started` or recovery may write.

#### 6b. Authorized aliases and candidate coverage (selected G1; mandatory runtime protection)

Every section that reads storage keys distinguishes two sets:

- **Authorized aliases:** the survivor's trusted, non-conflicting canonical claims that passed the identity fence. These are the **only** keys whose values the aggregate attributes to the Film. There is no read-time bridge and no ratings-only fallback.
- **Candidate aliases:** keys that might belong to the Film but have no canonical claim. They only affect coverage.

**Discovery.** Candidates are found from the ratings link index, never from titles and never by scanning `prediction_pointer`:

1. **Seeds** are the authorized aliases in link-index form: `letterboxd:<lid>` and `tmdb:<n>`.
2. The link index is the D1-owned ratings document `letterboxd/facts/links.json`, read once per request through the existing owned reader, only at ratings `d1`/`open`. Its `etag` and the ratings generation are recorded.
3. For each seed, the `factKey` it maps to is taken. A seed absent from the index is recorded as an **absence predicate** (`seed_absent`), not as proof that no candidate exists.
4. **Reverse traversal:** the in-memory index is walked once to collect every other alias that maps to one of those fact keys. Each fact record reached is read once, and a fact-record redirect is followed once; a mid-migration record counts both sides.
5. Every collected alias that is not an authorized alias is a candidate. A candidate is settled as belonging elsewhere only by another Film's trusted, non-conflicting claim, read with its competing and absence predicates and revalidated after the section's reads; otherwise it stays unresolved.

**Work bounds.** The traversal is bounded by what it reads, not only by what it returns:

| Bound | Value | On overflow |
| --- | --- | --- |
| link document size | at most 40 parts of `DOCUMENT_BYTES` (60 000 bytes), so 2.4 MB | coverage `incomplete`, `discovery_cap` |
| link index entries walked | 50 000 | coverage `incomplete`, `discovery_cap` |
| fact records read | 4 per request, one redirect hop each | coverage `incomplete`, `discovery_cap` |
| candidate keys kept | 8 | coverage `incomplete`, `discovery_cap` |

A separately delivered indexed reverse lookup may replace the walk only with proved parity against it; until then the walk is the only discovery.

**Coverage verdict.** `coverage.status` is `complete` only when: the ratings domain is `d1`/`open`; the link document was read within its bounds; the seed set is not empty and **every** seed was present in the index (a missing seed or an empty seed set is never proof of coverage); the document limits were checked **before** the index was materialized; the traversal finished; and every candidate is settled as belonging elsewhere by a canonical ownership proof (another Film's trusted, non-conflicting claim, with its competing and absence predicates) that is revalidated with the section's after-tokens. Otherwise it is `incomplete` with a reason: `ratings_evidence_unavailable` (held, unreadable or missing document), `seed_absent_unproved`, `discovery_cap` or `unresolved_candidate`.

**Effect on sections.** For `predictions` and `personal`:

- Values under authorized keys are returned as read. A **known conflict** between authorized keys stays `conflict` even when coverage is incomplete; incomplete coverage never erases it.
- With incomplete coverage and no known conflict, the section is `partial`. It never states `none`, never states that no conflict exists, and never presents a current value as the single current value.
- With complete coverage, the section follows decision 5 and choice C2.

**Tokens and fences.** The coverage token is the ratings generation, the link document `etag`, the fact record `etag`s read, the seed absence predicates and the candidate set digest. It joins the before/after fence of each section that uses it (E1). A change makes that section `unavailable` with `generation_moved`. Ratings evidence is **not** part of the identity read-set under G1, so a ratings change degrades only those sections. A change of canonical identity rows always fails the whole aggregate with `identity_moved`, whatever the ratings state.

**Promotion.** A candidate becomes authorized only when the existing [ADR 0184](0184-ratings-confirmed-letterboxd-claim-on-existing-film.md) writer materializes a trusted claim after its entire fresh proof at write time, never on `links.json` alone. That proof includes the projection check of ADR 0184 decision 2(b) (a `ratings_view` row carrying another key is a conflict) and allows a null or exactly matching `canonical_identity`. A candidate that fails the proof stays a candidate and coverage stays incomplete. Any production promotion needs its own owner L3 GO. This ADR widens neither ADR 0184, ADR 0201, ADR 0215 nor any write authorization.

### 7. Budgets and failure on overflow

Each limit is per request. Overflow never truncates to a negative.

| Limit | Value | On overflow |
| --- | --- | --- |
| identity rows read (steps 0–5) | 64 claim rows, 8 redirect hops, 16 Films | whole aggregate `409 conflict`, `reason: identity_fanout` |
| authorized aliases per scheme | 8 | affected sections `partial`, `budget_exceeded` |
| D1 statements per request | 40; the final identity capture is reserved first, then the coverage reads | sections not yet read are `unavailable`, `budget_exceeded`; the identity capture still runs |
| candidate discovery | see decision 6b | coverage `incomplete`, `discovery_cap` |
| current shows returned | 50 | `availability` `partial` |
| credits returned | 60 | `display.credits` `partial` |
| prediction lineage rows | current only; lineage via the history route | not read inline |
| other whole-document reads (fact records, Diary history) | only those the history route already reads, once per request, never per alias | section `unavailable` if a document is over its existing size cap |
| batch input | not offered in v1 | a list or search projection is a separate future ADR (B3) |

History is never inlined. Every new query must be served by an existing index; the implementation card checks `EXPLAIN QUERY PLAN` for each.

### 8. Response example

A Film with two authorized lids, the ratings domain held, a lagging membership projection and history not yet migrated. Every section names its token or marks it `unavailable`:

```json
{
  "contract": "film-aggregate/v1",
  "identity": {
    "verdict": "found",
    "filmId": "film:tmdb:41009",
    "requested": {"scheme": "tmdb_movie", "value": "41009"},
    "redirectedFrom": [],
    "claims": [
      {"scheme": "tmdb", "value": "41009", "trusted": true, "conflicting": false},
      {"scheme": "letterboxd", "value": "10oS", "trusted": true, "conflicting": false},
      {"scheme": "letterboxd", "value": "2bQx", "trusted": true, "conflicting": false},
      {"scheme": "letterboxd_slug", "value": "example-film", "trusted": false, "conflicting": false}
    ],
    "permalink": "/film/tmdb_41009",
    "token": {"generation": 2, "readSet": "sha256:…"}
  },
  "display": {
    "status": "partial",
    "source": "d1:film_metadata",
    "token": {"metadata": "sha256:…", "ownerReview": "sha256:…"},
    "fields": {
      "title": {"status": "present", "value": "…", "provenance": "owner"},
      "runtime": {"status": "unknown"}
    }
  },
  "watchlist": {
    "status": "present",
    "source": {"member": true, "lids": ["10oS"], "authority": "d1", "generation": 1, "version": 57, "snapshotId": "…", "listSha256": "…"},
    "projection": {"member": false, "authority": "sync", "generation": 3},
    "lag": true
  },
  "availability": {"status": "present", "source": "published_epg", "token": {"programmeRunId": "…", "generation": "…"}, "current": []},
  "personal": {"status": "unavailable", "reason": "ratings_held", "token": null, "tokenStatus": "unavailable"},
  "predictions": {
    "status": "conflict",
    "source": "d1:prediction_pointer",
    "token": {"generation": 4, "pointers": "sha256:…"},
    "current": [{"storageId": "10oS", "version": "…"}, {"storageId": "2bQx", "version": "…"}],
    "coverage": {"status": "incomplete", "reason": "ratings_evidence_unavailable", "token": null, "tokenStatus": "unavailable"}
  },
  "history": {"status": "unavailable", "reason": "history_migration_pending", "token": null, "tokenStatus": "unavailable"}
}
```

The two authorized pointers disagree, so `predictions` is `conflict` even though coverage is incomplete. Had they agreed, it would be `partial`, not `present`.

### 9. Typed errors

| HTTP | Identity `verdict` | `reason` examples |
| --- | --- | --- |
| 400 | `invalid` | not a typed id |
| 404 | `absent` | — |
| 409 | `conflict`, `unverified`, `cycle` | `competing_owner`, `untrusted_only`, `redirect_cycle`, `identity_fanout` |
| 410 | `retired` | `tmdb_retired` |
| 503 | `unavailable` | `film_person_held`, `identity_moved`, `canonical_read_unavailable` |

### 10. Side effects

The route is a pure GET under [ADR 0107](0107-get-head-read-side-effect-boundary.md) and must pass `tests/get-write-audit.mjs`. It repairs, enqueues, promotes and caches nothing.

### 11. Reuse of the existing consumers

| Consumer | Role after this ADR |
| --- | --- |
| `GET /api/catalog/film/<tmdbId>` | Unchanged; public permalinks unchanged. A later accepted consumer migration may embed aggregate sections. |
| `GET /api/enrichment/history` | Unchanged route and contract until its own migration. |
| `GET /api/d1/films/<id>` | Stays an operator view. [D1 catalog views](../reference/api/d1-catalog.md) must state that it reads schema v1 `actual_rating` and `prediction_current`. |
| `catalogFilmIdentityBridge` | Unchanged; keeps its strict callers and their write authorization. |
| `src/canonical-read-model.js` | Reused for display resolution and owner precedence. Stays inactive until an implementation card activates it. |

## Selected options and alternatives

The Product Owner's selections, transcribed by the Coordinator in the [consolidated owner-choice handoff](https://github.com/vladimino/iptv-watchlist/pull/991#issuecomment-7161307943): **A2, B3, C2, D2, E1, F1, G1**, with no qualifications, accepted in the [owner disposition](https://github.com/vladimino/iptv-watchlist/pull/991#issuecomment-7161412265).

| Choice | Selected | Meaning | Alternatives not selected |
| --- | --- | --- | --- |
| A. Film without a TMDB movie id | **A2** | Lid-only admission is a recorded future direction only. No capability and no proof rule now; `exists` stays reserved (ADR 0215 decision 2). A later ADR, coordinated with ADR 0207 and ADR 0215 E4, decides proof, stable id minting, uniqueness and concurrent later TMDB admission, attachment and merge. | A1 not now with no direction; A3 owner-only creation |
| B. Where the aggregate is computed | **B3** | On-demand composition for one Film, no new authority; a list and search projection is designed later from load evidence. | B1 on-demand only; B2 materialized table with its own writer |
| C. Several lids for one Film | **C2** | All authorized aliases, stable event deduplication, explicit conflicts, no winner and no key renaming; history migration separately gated. | C1 strict single lid; C3 fixed-rule winner |
| D. Optional domain failure | **D2** | Typed per-section degradation; canonical identity and the final fence stay fatal. | D1 any failure fails the whole answer |
| E. Consistency | **E1** | Before/after per-section content and authority tokens, plus the mandatory coherent identity read-set and reserved final fence, independent of optional read failures. | E2 retry until all domains are stable |
| F. Cutover | **F1** | Additive internal route; each consumer migration separately accepted; strict writer bridges and public permalinks preserved; legacy history `limited` or `unavailable` until its migration. | F2 replace `/api/d1/films/<id>` in place |
| G. Historical storage aliases | **G1** | Canonical claims are the only identity authority; candidate discovery and coverage protection are mandatory at runtime (decision 6b); promotion only through the ADR 0184 writer with its full fresh proof and a separate owner L3 GO. | G2 read-only bridge authorized at read time with ADR 0184-grade proof |

**AIR-559 and the new cohort.** AIR-559 is Done and its backfill reported zero eligible candidates. The 15 keys found by AIR-627 need a distinct offline investigation that reconciles why the earlier cohort check missed or excluded them and classifies each key's ADR 0184 verdict. No key is assumed to qualify.

## Invariants

1. No Film is deleted or hidden because a fact is missing.
2. No section reports `false`, `0`, `none` or an empty list unless its authority proved it over the full authorized alias set **and** coverage is complete; otherwise `unknown` or `partial`.
3. No title, year or slug match links data to a Film.
4. A historical storage key is never renamed, and a TV number never reads a movie key.
5. A `retired`, `conflict`, `unverified` or `cycle` identity returns no section.
6. A movement of the identity read-set during the read returns no section.
7. One fact reachable through several aliases is counted once.
8. A settled retirement never vetoes a Film and its key is never read.
9. History is never advertised as complete before its migration.
10. A candidate key is never attributed; unproved coverage never yields `none` or "no conflict"; a known conflict is never erased.
11. The read writes nothing.

## Synthetic test plan

Every case asserts no false `404`, no false rating and no false prediction. Synthetic fixtures only.

**Aggregate acceptance (delivery graph steps 2–3):**

1. Prediction stored under an authorized lid, requested by `/film/tmdb_<n>`: present with `storageId` = lid.
2. One Film with two authorized lids: one ratings fact reachable through both is counted once in `personal`; differing current ratings and predictions are `conflict`; `history` is `unavailable` with `history_migration_pending`.
3. Rated-only Film with no shows: `availability.current` empty, Film `found`.
4. Film left the Watchlist and was re-added: source follows `version`; retention keeps the Film between.
5. The four corrected TMDB TV identities, each with a retired movie claim and a verified lid: `tmdb_tv:<n>` and the lid are `found`; `tmdb_<n>` of the retired id is `retired`; no section reads the movie key; equal movie and TV numbers never read each other's keys.
5a. `film:<id>` of an existing Film with no matching external row is `found`; of a merged Film is `redirected`; of an id with neither row is `absent`.
6. Merge: `redirected`. Retirement: `410`. Competing owner: `409 conflict`. Untrusted only: `409 unverified`. Redirect cycle: `409 cycle`.
7. Malformed ids, a lid that looks like `tmdb_<n>`, and a `letterboxd_slug` value: `400` or the typed verdict, never a guess.
8. Concurrent reassignment, merge or retirement between resolution and the last section read: `503 identity_moved` with no section.
9. Ratings domain held: `personal` `unavailable`; `predictions` keeps its authorized values with coverage `incomplete` (`ratings_evidence_unavailable`), so `partial`, or `conflict` when authorized values disagree; sections that do not depend on ratings are unaffected.
10. EPG generation moves during the read: `availability` `unavailable` with `generation_moved`.
11. Owner review changes during the read: `display` `unavailable` with `generation_moved`.
12. Partial metadata: missing fields `unknown`, explicit nulls `absent`.
13. Stale membership projection, including drained effects with an owed per-Film write: `lag: true`, `source.member` from the source authority.
14. Watchlist negative proof: an empty alias set, source mode `epg`, a pending admission row in backoff or terminal, and a handoff row of any due time for an unrelated listed lid each give `member: unknown` with their reason, never `false`; producer projection mode never changes `source.member`.
15. Budget overflow: identity fan-out gives `409 identity_fanout` with no section; the statement limit makes unread sections `unavailable` and the identity capture still runs; alias, show and credit limits make the named section `partial`. None gives a negative.
15a. The final identity capture cannot run: `503` with no section.
15b. A content token changes inside one section without a marker move: that section is `unavailable` with `generation_moved`.
16. Missing or held domain for one alias only: the section is `partial`, the other alias's facts stay.
17. The GET write audit passes for the new route.

**Candidate coverage (also aggregate acceptance, mandatory):**

18. Authorized alias only, seeds present, no other alias on the fact key: prediction `present`, coverage `complete`.
19. Bridge-only pointer with no authorized key: `predictions` `partial`, `unresolved_candidate`, never `none`; the candidate's value is not returned.
20. Authorized pointer plus an unresolved candidate with an **equal** current value: `partial`; with a **different** value: `partial`, never a silent single value.
21. After a fully proved ADR 0184 promotion in the fixture: the key is authorized; different current values give `conflict`, equal values follow C2. A fixture whose ADR 0184 proof fails (missing fact record, a third alias on the fact key, a fact redirect or migration, a `ratings_view` row carrying another key, a conflicting, untrusted, revoked or retired claim, a second lid, a redirect source) is never promoted and coverage stays `incomplete`.
22. Empty seed set, a seed missing from the index, missing link document, held or unreadable ratings domain, a seed absent from the index without a recorded absence, link document over 40 parts, more than 50 000 entries walked, more than 4 fact records or more than 8 candidates: coverage `incomplete` with the matching reason, never `none`.
23. A known conflict between two authorized pointers while coverage is incomplete: `conflict`, not `partial`.
24. One fact reachable through two aliases, and a fact redirect reached from two seeds: counted once.
25. A link entry or fact record changes during the read: the dependent sections are `unavailable` `generation_moved`, other sections stay. A canonical claim changes during the read: `503 identity_moved` with no section, also under G1.

**History migration gate (delivery graph step 6):**

26. Complete multi-alias history across pages; cursor invalidation with `alias_set_changed`, `coverage_changed`, `identity_moved` or `source_changed` when the authorized set, candidate coverage, identity or a source changes between pages; recovery and Started keep their writer authorization unchanged.

## Delivery graph (no card is created by this ADR)

| Step | Kind | Content | Depends on | Gate |
| --- | --- | --- | --- | --- |
| 1 | documentation | Correct `GET /api/d1/films/<id>` limits in [D1 catalog views](../reference/api/d1-catalog.md) | accepted ADR | ordinary review |
| 2 | offline implementation and validation | Read-only typed resolver with the coherent identity read-set and final fence; tests 5–8, 15a | accepted ADR | review, CI; no production use |
| 3 | offline implementation and validation | `FilmAggregateV1` internal route behind the Film/Person marker, **including candidate discovery and coverage (decision 6b)**; tests 1–4, 9–25; `history` limited or unavailable | 2 | review, CI, deploy dormant; no consumer |
| 4 | separately authorized activation | Make the internal route reachable for an approved consumer | 3 | its own card and acceptance |
| 5 | separately accepted consumer migrations | One consumer per card; public permalinks and strict writer bridges unchanged | 4 | its own card and acceptance |
| 6 | offline implementation and validation | Multi-alias history migration with the cursor binding of decision 6a; test 26; only then `history` may be `present` | 3 | its own contract change to [film history](../reference/api/film-history.md) |
| 7 | offline investigation | Classify the AIR-627 cohort under ADR 0184 and reconcile it with AIR-559; no write | 3 (for coverage fixtures) | read-only evidence; any production read needs its own authorization |
| 8 | owner-gated data operation | Promote only keys whose ADR 0184 proof passes, through the existing writer | 7 | separate owner L3 GO; may remain pending without affecting step 3 |
| 9 | future design | Lid-only admission ADR (A2), coordinated with ADR 0207 and ADR 0215 E4 | — | owner decision |
| 10 | future design | List and search projection ADR (B3), from load evidence | 3 in use | owner decision |
| — | optional | Indexed reverse lookup replacing the link walk, with proved parity | 3 | its own card |

False-negative protection is part of step 3 and never waits for steps 7–8.

## Rollback and fencing

The aggregate writes nothing, so rolling back its code restores the previous readers exactly. Every section reads behind its own domain marker, and the identity fence covers the whole response. No data, marker, flag or Scheduled Task changes with this ADR.

## Out of scope

UI and global catalog pages; new migrations or schema; identity migration or renaming of storage keys; backfill, repair, promotion or cache population; changes to ADR 0184, 0201, 0207, 0214 or 0215; any production read or write; a proof rule for lid-only admission; changing the permalink rules of AIR-387; any production reader switch, flag or Task change.

## Consequences

- One documented shape answers "everything about this Film" without a new authority.
- A concurrent identity change can no longer attribute one Film's facts to another inside one answer.
- Historical keys without a canonical claim can no longer produce a false `none` or hide a conflict; they leave the answer `partial` until promoted.
- Readers stop treating schema v1 `actual_rating` and `prediction_current` as complete.
- Lid-only Films stay unsupported until a later ADR decides their proof.
- Each section names its own freshness, so the caller sees lag instead of a false value.
