# ADR 0216: Canonical Film lifecycle and the unified Film read contract

**Status:** Proposed  
**Original decision date:** pending Product Owner disposition  
**Recorded at:** 2026-11-25, from `main` `a537c9c7`. Revised the same day after the [independent technical review](https://github.com/vladimino/iptv-watchlist/pull/991#issuecomment-7156435200) of `bb1605aa` the [second review](https://github.com/vladimino/iptv-watchlist/pull/991#issuecomment-7156853568) of `cfc48c6d`, the [third review](https://github.com/vladimino/iptv-watchlist/pull/991#issuecomment-7156969487) of `c08984ee`, and the [owner's instruction adding choice G](https://github.com/vladimino/iptv-watchlist/pull/991#issuecomment-7157683873) from the AIR-627 audit.  
**Approval source:** none yet. This record must not merge while it is `Proposed` ([ADR merge gate](../process/agent-workflow.md#adr-merge-gate)).  
**Related work:** [AIR-628](https://trello.com/c/zwJum962), companion audit [AIR-627](https://trello.com/c/IOERZ9GI). Coordinated with, and not extending, Accepted [ADR 0214](0214-film-metadata-per-field-provenance.md) (per-field metadata provenance, AIR-613) and Accepted [ADR 0215](0215-identity-evidence-full-model.md) (full identity evidence model, AIR-616).  
**Supersedes:** None. It amends no accepted decision.  
**Superseded by:** None

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

## Decision (proposed)

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

The statements for the final capture are **reserved from the request budget before any section read** (decision 7). After **all** section reads, the resolver re-reads the identity read-set. If the marker generation, any revision, any claim row, any redirect or any retirement decision differs, the **whole aggregate** fails closed with `503 unavailable`, `reason: identity_moved`, and returns no section. If the final capture cannot run or cannot complete, the answer is the same `503` with no section; a partially fenced aggregate is never returned. This holds under either consistency choice E1 or E2. A lid that is revoked or reassigned while personal facts are being read therefore cannot attribute those facts to the wrong Film.

The display section also captures the owner-review authority token (the `owner_review_entry` rows read for the survivor and its redirect ancestors) and the localization source rows read. A change of either fails the display section with `generation_moved`, not the whole aggregate.

**Per-section fence (E1).** Every section captures its tokens **before** its reads and re-reads them **after**, in addition to the identity fence. Tokens include content, not only markers: document `etag`s, `content_sha256`, row versions and pointer versions. Any difference makes that section `unavailable` with `generation_moved`. A token returned in the answer is a statement of what was read, not by itself a fence.

### 5. Sections, their authority and their tokens

The aggregate is computed per request over the existing safe readers. It is not a new table, writer or authority (choice B).

| Section | Alias set read | Authority | Token (required) | Negative proof |
| --- | --- | --- | --- | --- |
| `identity` | — | D1 Film/Person tables | identity read-set digest | verdict `absent` only from step 0 (no `film` or redirect row) or step 1 (no claim row of any trust) |
| `display` | survivor and redirect ancestors (owner entries) | `film_metadata` with per-field provenance (ADR 0214), localization sources, `owner_review_entry` (owner > reviewed > automatic) | metadata `content_sha256` or `updated_at`, owner-review token | a field is `absent` only when its provenance records an explicit null; otherwise `unknown` |
| `watchlist` | verified `letterboxd_lid` claims of the survivor | source: `watchlist_authority` and `watchlist_current` (ADR 0186); projection: `watchlist_membership_authority` and `watchlist_film` (ADR 0203) | `watchlist_authority.generation`, `watchlist_current.version`, `snapshot_id`, membership authority mode and generation | see "Watchlist negative proof" below |
| `availability` | `tmdb_<n>` of the trusted movie claim, and each verified lid, as the published document names films | published EPG generation and its pin | `programmeRunId`, `generation` | empty `current` only from the pinned generation; past generations are out of scope |
| `personal` | verified lids and `tmdb_<n>`, through the ratings link index | ratings domain D1: `ratings_view`, `ratings_document` (fact records, Diary history and state) | ratings marker generation, each document `etag` read | `watched:false` only from a `ratings_view` row with `watched=0`; a missing Diary entry is never "unwatched" |
| `predictions` | verified storage ids (`tmdb_<n>` and each verified lid) | prediction domain D1 `prediction_pointer`, `prediction_lineage`; bodies in immutable R2 objects | prediction marker generation, pointer row version | `none` only when the pointer is absent for every **authorized** storage id **and** candidate coverage is complete (decision 6b); never from `prediction_current` |
| `history` | see decision 6a | the existing history route, unchanged, until the migration card | none in v1 (`token: null`, `tokenStatus: "unavailable"`) | never claimed |

**Watchlist negative proof.** `watchlist.source.member` means **membership of the survivor's verified aliases**, not proven real-world membership of the work. Its values:

- `true`: a verified lid is listed in the current source snapshot.
- `false` only when all of these hold: the alias set is not empty; the source authority is `d1` with a complete snapshot and every verified lid was checked against it; **no listed lid of that snapshot is unsettled**: no `watchlist_admission_pending` row in any state other than `resolved` or `superseded` (so `pending` in backoff or not yet due, and `terminal` unresolved, all count) and no `watchlist_membership_handoff` row of any due time or attempt count for any listed lid, because an unresolved listed lid might be this Film; when that coverage cannot be read or proved, the answer is `unknown`; the identity fence passed.
- `unknown` otherwise, with a reason: `no_verified_alias`, `source_epg_mode`, `unresolved_listed_ids`, `snapshot_incomplete`.

Under the projection writer mode `producer` the `projection` part reports the producer-written `watchlist_film` row and its mode; it never strengthens `source.member`.

Rules shared by every section:

- **Verified alias set.** A storage id joins a section's alias set only through a trusted, non-conflicting claim of the survivor that survived the identity fence. The raw requested key is never read as a fallback when it is not in that set.
- **Field statuses.** The identity section carries a **verdict** (decision 3). Every other section and each field carries a **status**: `present`, `absent`, `unknown`, `unavailable`, `partial`, `conflict` or `limited` (`limited` is used only by `history`, decision 6a), plus `source` and the token above. A required token that cannot be read makes the section `unavailable`, never `present`.
- **Coverage.** A section that read only part of its alias set, or hit a budget (decision 7), is `partial` and names what it skipped. It never reports a negative.
- **Projection lag.** `watchlist.projection` reports the membership the projection holds, separately from `watchlist.source`. A difference is reported as `lag`, including when effects are drained but the per-Film membership write is still owed.

### 6. Several aliases for one Film (choice C)

Under C2, every section reads every verified alias and:

- **Deduplicates by stable event identity.** One ratings fact reachable through two aliases (the link index maps both to one `factKey`) is read and counted **once**. Two distinct events under two aliases stay two events, each with its `storageId`.
- **Reports conflicts.** When two aliases carry different current values (two current ratings, two current predictions, two Diary links), the field is `conflict` with each value and its `storageId`. No value is chosen.
- **Never drops silently.** Diary entries of every verified lid are included. A Diary lid candidate outside the verified set stays excluded and is named in `notes`.
- **Fact redirects** of the ratings documents are followed once per alias, as the history route does, and deduplicated by the resulting `factKey`.

#### 6a. History before and after its migration

Until the multi-alias history migration card (delivery graph step 4) is delivered, the aggregate does **not** advertise complete history:

- `history.status` is `limited` with `reason: history_migration_pending` when the survivor has exactly one verified lid, the requested id is `tmdb_<n>` or that lid, and the legacy route accepts it. `href` points to the legacy route, which answers under its own contract and its own completeness notes.
- In every other case (several verified lids, a `film:` or `tmdb_tv:` request, a bridge the legacy route rejects) `history.status` is `unavailable` with the same reason and **no `href`**, so no raw requested key is read as a fallback.
- `history.status` is never `present` in v1.

The migration card must deliver, before `present` may be returned: acceptance of every typed id of decision 2; a cursor bound to the canonical survivor, the verified alias set with its proof (the identity read-set digest) and the source tokens of every source read; typed invalidation (`409 history_changed` with `reason` `identity_moved`, `alias_set_changed` or `source_changed`); and stable event identities `<storageId>|<sourceEventId>` with the deduplication of decision 6.

The standalone history route keeps its contract until a separately approved migration card changes it. Its strict bridge consumers keep their write authorization; nothing here broadens what `POST /api/started` or recovery may write.

#### 6b. Authorized aliases and candidate coverage (mandatory under G1 or G2)

Every section that reads storage keys distinguishes two sets:

- **Authorized aliases:** keys this aggregate may attribute to the Film. Under G1 these are the verified canonical claims only. Under G2 they also include bridge keys that pass the G2 proof.
- **Candidate aliases:** keys that might belong to the Film but are not authorized, found by **bounded, indexed discovery**: the ratings link index entries for the Film's authorized `letterboxd:<lid>` and `tmdb:<n>` aliases, the other aliases that map to the **same fact key**, and fact-record redirects reached from them, followed once. Discovery reads at most 8 candidate keys and 2 fact records per Film; it is never a scan of `prediction_pointer`.

Rules:

- A candidate key is **never** read as an attributed value. Its existence (or the failure to rule it out) only affects coverage.
- `coverage` is `complete` only when discovery ran, stayed within its cap, the ratings domain was readable at `d1`/`open`, and every candidate is either authorized or proved to belong elsewhere. Otherwise `coverage` is `incomplete` with a reason: `unresolved_candidate`, `ratings_evidence_unavailable`, `discovery_cap`.
- With incomplete coverage the section is `partial`. A value found under an authorized key is still returned, but the answer never states `none`, never states that no conflict exists, and never presents a current value as the single current value.
- Candidate discovery adds its rows (link index entries, fact key, fact record `etag`, ratings generation) to the section's before/after tokens. Under G2 they also join the identity read-set.
- `links.json` alone is **not** proof. Only the full ADR 0184 proof (decision G2) can authorize a candidate.

### 7. Budgets and failure on overflow

Each limit is per request. Exceeding one makes the affected section `partial` with `reason: budget_exceeded` and the limit named. It never truncates to a negative.

| Limit | Value | On overflow |
| --- | --- | --- |
| identity rows read (steps 1–5) | 64 claim rows, 8 redirect hops, 16 Films | whole aggregate `409 conflict`, `reason: identity_fanout` |
| verified aliases per scheme | 8 | affected sections `partial` |
| D1 statements per request | 40, of which the final identity capture is reserved first | sections not yet read are `unavailable`, `reason: budget_exceeded`; the identity capture still runs |
| current shows returned | 50 | `availability` `partial` |
| credits returned | 60 | `display.credits` `partial` |
| prediction lineage rows | current only by default; lineage via the history route | not read inline |
| whole-document reads (ratings documents, Diary history) | only those the history route already reads, once per request, never per alias | section `unavailable` if a document is over its existing size cap |
| batch input | not offered in v1 | a list or search projection is a separate future ADR (choice B3) |

History is never inlined. The aggregate returns `history.href` to the existing paged route. Every new query must be served by an existing index; the implementation card checks `EXPLAIN QUERY PLAN` for each.

### 8. Response example

A Film with two verified lids, the ratings domain held, a lagging membership projection and history not yet migrated. Every section names its token or marks it `unavailable`:

```json
{
  "contract": "film-aggregate/v1",
  "identity": {
    "status": "found",
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
    "token": {"generation": 4},
    "current": [{"storageId": "10oS", "version": "…"}, {"storageId": "2bQx", "version": "…"}],
    "coverage": {"status": "complete", "candidates": 0}
  },
  "history": {"status": "unavailable", "reason": "history_migration_pending", "token": null, "tokenStatus": "unavailable"}
}
```

### 9. Typed errors

| HTTP | `status` | `reason` examples |
| --- | --- | --- |
| 400 | `invalid` | not a typed id |
| 404 | `absent` | — |
| 409 | `conflict`, `unverified`, `cycle` | `competing_owner`, `untrusted_only`, `redirect_cycle`, `identity_fanout` |
| 410 | `retired` | `tmdb_retired` |
| 503 | `unavailable` | `film_person_held`, `identity_moved`, `canonical_read_unavailable` |

### 10. Side effects

The route is a pure GET under [ADR 0107](0107-get-head-read-side-effect-boundary.md) and must pass `tests/get-write-audit.mjs`. It repairs, enqueues and caches nothing.

### 11. Reuse of the existing consumers

| Consumer | Role after this ADR |
| --- | --- |
| `GET /api/catalog/film/<tmdbId>` | Unchanged. A later card may embed aggregate sections. |
| `GET /api/enrichment/history` | Unchanged route and contract. Multi-alias history needs its own migration card under C2. |
| `GET /api/d1/films/<id>` | Stays an operator view. [D1 catalog views](../reference/api/d1-catalog.md) must state that it reads schema v1 `actual_rating` and `prediction_current`. |
| `catalogFilmIdentityBridge` | Unchanged; keeps its strict callers. |
| `src/canonical-read-model.js` | Reused for display resolution and owner precedence. Stays inactive until an implementation card activates it. |

## Owner choices

Each choice is independent. Recommendations are the Executor's and need the Coordinator's own assessment under the facilitation protocol.

### A. Creating a Film without a TMDB movie id

**Current capability:** none. Every admission today is proved by a TMDB movie (ADR 0207). ADR 0215 decision 2 keeps `exists` reserved and unused, and future proof policy belongs to E4.

- **A1. Not now.** A verified lid with no TMDB stays a Letterboxd observation and gets no Film or page.
- **A2. Record lid-only admission as a future direction only.** No proof rule is set here. A later ADR, coordinated with ADR 0215 E4 and ADR 0207, must decide: the evidence and proof that admit a lid without TMDB; how the Film id is minted and kept unique; and what happens when a TMDB movie for the same work is admitted or attached later, including concurrent admission and merge.
- **A3. Owner-only creation as a future direction.** The same later ADR and the same safety questions apply.

**Recommendation: A1 now, A2 as the recorded direction.** The census shows no live case. Choosing A2 here creates no capability and amends neither ADR 0207 nor ADR 0215.

### B. Where the aggregate is computed

- **B1. On-demand composition per request.** No new table. Fresh by construction.
- **B2. Materialized aggregate table with its own writer.** Cheap reads, but a new writer, a new authority question and staleness.
- **B3. Hybrid.** On-demand for one Film; a separate list and search projection later.

**Recommendation: B3.**

### C. Several trusted lids for one Film

- **C1. Strict single lid.** A Film with several lids answers `conflict` in every section that reads lids.
- **C2. Read every verified lid** with the rules of decision 6.
- **C3. Read every verified lid and pick one current value by a fixed rule.**

**Recommendation: C2.** It matches ADR 0203 and drops no supported fact.

### D. Response contract when an optional domain fails

- **D1. Strict.** Any optional domain failure fails the whole response.
- **D2. Per-section status.** Identity and the identity fence are fatal; other sections degrade with a typed reason.

**Recommendation: D2.**

### E. Cross-domain consistency (beyond the mandatory identity fence)

- **E1. Per-section tokens.** Each section is internally consistent and names its tokens.
- **E2. Retry until all domain tokens are stable within one window.** Stronger, but costs extra reads and can starve.

**Recommendation: E1.**

### F. Migration and cutover

- **F1. Additive route first.** A new internal route returns `FilmAggregateV1`; consumers switch one by one on separate cards.
- **F2. Replace `/api/d1/films/<id>` in place.**

**Recommendation: F1.**

### G. Completeness with unconfirmed historical storage aliases

The problem: 15 historical prediction keys are reachable only through the ratings link (Context). Decision 6b keeps them from producing a false `none` or a hidden conflict under either option. This choice decides whether they can ever be **read as the Film's values** without first becoming canonical claims.

- **G1. Canonical claims stay the only identity authority.** Missing claims are identified offline and materialized only through the existing ADR 0184 writer, after its full fresh proof at write time. Until a claim exists, the key is a candidate: the section is `partial` and the key is never attributed. The offline coverage work and preflight are separate from any production claim promotion, which needs its own owner L3 GO. The existing [AIR-559](https://trello.com/c/733sRAxu) scope is checked first to avoid duplicate work.
- **G2. A separate read-only bridge with ADR 0184-grade proof.** At read time the aggregate may authorize a bridge key when **all** of ADR 0184 decision 2 holds: both markers `d1`/`open` with unmoved generations; the link index maps the lid and the movie to the **same fact key**, no other alias carries that key, and the fact record names the same lid and movie and is neither a redirect nor mid-migration; `ratings_view` only corroborates; exactly one trusted, non-conflicting `tmdb` claim on a Film that is not a redirect source, not retired, with a matching `canonical_identity`; no competing, untrusted or conflicting claim of either value; the single-lid restriction of ADR 0184. The proof rows (link entries, fact key, fact record `etag`, ratings generation, the canonical rows and absence predicates) join the **identity read-set** and are revalidated by the final capture; under C2 history they also bind the history cursor. This extends **read** authorization only: it renames no key, writes nothing, and does not widen what recovery, `POST /api/started` or any writer may do. ADR 0201 does not authorize a ratings-only alias. A policy broader than ADR 0184 (for example several lids) is not part of G2 and would need its own explicit choice.

**Recommendation: G1.** It keeps one identity authority and reuses an accepted writer. G2 duplicates the ADR 0184 proof on every read and makes the identity fence depend on ratings documents.

## Invariants

1. No Film is deleted or hidden because a fact is missing.
2. No section reports `false`, `0`, `none` or an empty list unless its authority proved it over the full verified alias set; otherwise `unknown` or `partial`.
3. No title, year or slug match links data to a Film.
4. A historical storage key is never renamed, and a TV number never reads a movie key.
5. A `retired`, `conflict`, `unverified` or `cycle` identity returns no section.
6. A movement of the identity read-set during the read returns no section.
7. One fact reachable through several aliases is counted once.
8. A settled retirement never vetoes a Film and its key is never read.
9. History is never advertised as complete before its migration.
9a. A candidate key is never attributed; unproved coverage never yields `none` or "no conflict".
10. The read writes nothing.

## Synthetic test plan

Every case asserts no false `404`, no false rating and no false prediction.

1. Prediction stored under a lid, requested by `/film/tmdb_<n>`: present with `storageId` = lid.
2. One Film with two lids: one ratings fact reachable through both aliases is counted once in `personal`; differing current ratings and predictions are `conflict`; `history` is `unavailable` with `history_migration_pending`.
3. Rated-only Film with no shows: `availability.current` empty, Film `found`.
4. Film left the Watchlist and was re-added: source follows `version`; retention keeps the Film between.
5. The four corrected TMDB TV identities, each with a retired movie claim and a verified lid: `tmdb_tv:<n>` and the lid are `found` (the retired claim is not a conflict); `tmdb_<n>` of the retired id is `retired`; no section reads the movie key; equal movie and TV numbers never read each other's keys.
5a. `film:<id>` of an existing Film with no matching external row is `found`; of a merged Film is `redirected`; of an id with neither row is `absent`.
6. Merge: `film:<retired id>` is `redirected`. Retirement: `410`. Competing owner: `409 conflict`. Untrusted only: `409 unverified`. Redirect cycle: `409 cycle`.
7. Malformed ids, a lid that looks like `tmdb_<n>`, and a `letterboxd_slug` value: `400` or the typed verdict, never a guess.
8. Concurrent reassignment: a lid is revoked or moved to another Film, a merge or a retirement commits between resolution and the last section read. The whole aggregate is `503 identity_moved`.
9. Ratings domain held: `personal` `unavailable`, other sections present.
10. EPG generation moves during the read: `availability` `unavailable` with `generation_moved`.
11. Owner review changes during the read: `display` `unavailable` with `generation_moved`.
12. Partial metadata: missing fields `unknown`, explicit nulls `absent`.
13. Stale membership projection, including drained effects with an owed per-Film write: `lag: true`, `source.member` from the source authority.
14. Watchlist negative proof: an empty alias set, source mode `epg`, a pending admission row and a due handoff row for an unrelated listed lid each give `member: unknown` with their reason, never `false`; producer projection mode never changes `source.member`.
15. Budget overflow: identity fan-out gives `409 identity_fanout` with no section; the statement limit makes unread sections `unavailable` and the identity capture still runs; alias, show and credit limits make the named section `partial`. None gives a negative.
15a. The final identity capture cannot run (D1 error at the end): `503` with no section.
15b. A content token changes inside one section without a marker move (a ratings document `etag`, a pointer version): that section is `unavailable` with `generation_moved`.
16. Missing or held domain for one alias only: the section is `partial`, the other alias's facts stay.
17. The GET write audit passes for the new route.

Choice G (synthetic fixtures only):

18. Direct trusted alias: the prediction is `present`, coverage `complete`.
19. Bridge-only pointer, no authorized key: `predictions` `partial`, `unresolved_candidate`, never `none` (G1); under G2 with full proof, `present`.
20. Authorized pointer plus an unresolved candidate with an **equal** current value: `partial`; with a **different** value: `partial`, not a silent single value.
21. After a fully proved ADR 0184 promotion (G1) or an authorized G2 bridge: different current values give `conflict`; equal values follow choice C.
22. Ratings evidence unavailable or held, and discovery cap overflow: coverage `incomplete`, never `none`.
23. G2 proof failures, each giving `partial` with no attribution: missing fact record, a third alias on the fact key, a fact redirect or migration, `ratings_view` carrying another key, a conflicting, untrusted, revoked or retired claim, a second lid, a redirect source.
24. One fact reachable through two aliases is counted once.
25. Concurrent change of a link entry, fact record or canonical claim during the read: under G2 the whole aggregate is `identity_moved`; under G1 the section is `unavailable` `generation_moved`. No unsafe attribution.
26. History cursor invalidation when the candidate or authorized set changes between pages (history migration gate), and unchanged writer authorization of recovery and Started.

Moved to the history migration gate (delivery graph step 4): complete multi-alias history across pages, alias removal between two pages (`409 history_changed`, `alias_set_changed`), and a source change between pages (`source_changed`).

## Delivery graph (each a separate card, none authorized by this ADR)

1. Docs correction of `GET /api/d1/films/<id>` limits in [D1 catalog views](../reference/api/d1-catalog.md) (no code).
2. Read-only typed resolver with the identity read-set and fence (offline code and tests 5–8).
3. `FilmAggregateV1` internal route behind the Film/Person marker (F1), with tests 1–4 and 9–17; `history` limited or unavailable.
4. Multi-alias history migration, if C2 is chosen (its own contract change to [film history](../reference/api/film-history.md)), with the cursor binding of decision 6a and the moved history tests. Only then may `history` be `present`.
5. Consumer adoption, one consumer per card.
6. Lid-only admission ADR, coordinated with ADR 0215 E4, only if A2 or A3 is chosen.
7. List and search projection ADR, only after a load profile.
8. Choice G: under G1, an offline candidate-coverage preflight over the AIR-627 cohort, reconciled with AIR-559, then any ADR 0184 promotion only under a separate owner L3 GO; under G2, the read-only bridge with its proof and extended read-set, after step 2.

## Rollback and fencing

The aggregate writes nothing, so rolling back its code restores the previous readers exactly. Every section reads behind its own domain marker, and the identity fence covers the whole response. No data, marker, flag or Scheduled Task changes with this ADR.

## Out of scope

UI and global catalog pages; new migrations or schema; identity migration or renaming of storage keys; backfill, repair or cache population; changes to ADR 0184, 0201, 0207, 0214 or 0215; any claim promotion or production read; a proof rule for lid-only admission; changing the permalink rules of AIR-387; any production reader switch, flag or Task change.

## Consequences

- One documented shape answers "everything about this Film" without a new authority.
- A concurrent identity change can no longer attribute one Film's facts to another inside one answer.
- Readers stop treating schema v1 `actual_rating` and `prediction_current` as complete.
- Lid-only Films stay unsupported until a later ADR decides their proof.
- Each section names its own freshness, so the caller sees lag instead of a false value.
