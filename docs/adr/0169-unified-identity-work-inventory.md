# ADR 0169: One read-only identity work inventory for the owner Limbo, as a separate versioned projection over the current owners

**Status:** Proposed
**Original decision date:** not yet decided (owner decision required before Accepted)
**Recorded at:** 2026-11-18
**Approval source:** not documented. The card's original GO does not cover this architecture; a new material choice needs an explicit owner decision on the pull request.
**Related work:** [AIR-343](https://trello.com/c/hCy6fLne), [AIR-332](https://trello.com/c/fls3b65Z), [AIR-340](https://trello.com/c/zWxj3laC), [AIR-369](https://trello.com/c/GlAKWxvw), [AIR-497](https://trello.com/c/xNqCjZgu), [AIR-499](https://trello.com/c/8ifHCioP), [AIR-320](https://trello.com/c/4cA5GlJn), [ADR 0085](0085-d1-authoritative-discovery.md), [ADR 0087](0087-rated-archive-film-admission.md), [ADR 0090](0090-rated-identity-redirect-proof-and-retry.md), [ADR 0099](0099-canonical-film-person-d1-authority.md), [ADR 0104](0104-inferred-letterboxd-identity.md), [ADR 0107](0107-get-head-read-side-effect-boundary.md), [ADR 0166](0166-diary-rated-only-identity-bridge.md)
**Supersedes:** None
**Superseded by:** None

## Context

The owner page `/admin/limb` lists work that is waiting on identity or enrichment. Confirmed facts on `main` `3d9d81c`:

1. `GET /api/admin/limbo` (`src/admin/limbo.js`, `src/domain/limbo-inventory.js`) has the closed vocabulary `LIMBO_KINDS = ['film', 'observation']`. It reads the published snapshot, the prediction queue, the view index and the discovery observation index, and pins the whole tuple in one cursor.
2. Letterboxd candidates **before** verification live in one R2 object per archive: `letterboxd/imports/<archiveSha256>/rated-candidates.json` (states `pending`, `admitting`, `needs_review`, `verified`, `removed`; checkpoint, stop, retry). It is written with compare-and-swap and is the mutable owner of the unverified queue. Nothing in Limbo reads it.
3. `POST /api/admin/letterboxd-archive/identity-status` reads **one** document for **one** explicitly supplied hash. The ZIP is parsed in the browser and in Worker memory and is stored nowhere. An archive is "registered" only by the existence of `letterboxd/imports/<sha>/chunks/<n>.{intent,receipt,candidates}.json`. There is no archive-level summary object and no list of archives. The health read says so explicitly (finding the latest receipt "would list the bucket").
4. The verified side is already done and is not part of this decision: `admitRatedFilm` writes the canonical Film and `film_rated_admission` in D1 (migration `0015`), the producers are integrated, and the Film/Person marker is `d1` / `open`. `film_rated_admission` holds **only verified** Films. The historical receipt `letterboxd/admissions/verified-films.json` is evidence, not a second Film owner.
5. The EPG and Discovery side is D1-authoritative (marker `d1` / `open`, [ADR 0085](0085-d1-authoritative-discovery.md)). The owner read of unresolved observations is the D1 join (active observations with decisions), behind the same reader `discoveryIndexRead`. Its coverage is declared `partial` by the existing contract: it lists observations that already have a decision.
6. A browser `GET` must not write or repair ([ADR 0107](0107-get-head-read-side-effect-boundary.md)); the audit `tests/get-write-audit.mjs` is the baseline.

The gap is therefore narrow and specific: **an owner cannot see, in one bounded and honest list, all identity work that has not yet become a trusted Film**, because the Letterboxd candidate queue is invisible outside one hand-selected archive, and no one can say how many archives exist.

## Decision

One new **read-only projection**, served by a **new endpoint** `GET /api/admin/identity-work`, aggregates three typed lanes over the **current owners** without moving or copying any of them. `GET /api/admin/limbo` and its contract stay as they are; the Limbo UI is changed in a separate delivery.

### 1. Typed rows and keys

| `type` | Work key | Source | Meaning |
| --- | --- | --- | --- |
| `epg_observation` | `epg:<observationKey>` (the source observation key, unchanged) | D1 Discovery observation and decision, through the existing reader | An EPG title not yet resolved to a trusted movie |
| `letterboxd_rated_candidate` | `lbc:<archiveSha256>:<shortCode>` | `letterboxd/imports/<sha>/rated-candidates.json` | A rated-only short code from one archive, not yet a Film |
| `film` | `film:<canonicalFilmId>` | The existing Limbo Film evaluation, embedded unchanged | A canonical Film with stalled metadata, fingerprint or prediction |

A title, a year, a short code, an alias match or a `tmdb_tv` id is **never** proof of `tmdb:movie`. A row carries a trusted Film link (`film.filmId`) only with proof: for a candidate, a D1 `film_rated_admission` row whose `archive_sha256` **and** `source_code` both equal the candidate's key and whose `tmdb` is a typed movie identity (a row matching the short code alone, from another ZIP, never confirms it; the historical R2 receipt is never an alternative proof); for an observation, the canonical catalog with movie provenance. Otherwise the row carries at most untrusted `observedHints[]`, which are best-effort and computed only from rows present in the same response (an absent hint means "not observed", not "none exists"). The projection creates no Film, no merge and no alias. A global candidate correlation index would need its own bounded design and is not part of this decision.

### 2. Source-specific state, not a merged state machine

Each row keeps its own source `status` and `reason` (`pending`, `admitting`, `needs_review`, `verified`, `removed` for candidates; the existing decision status and cause for observations; the existing cause for Films) plus common read fields: `provenance`, `observedAt`, `lastProgressAt`, `ageMs`, `disposition` (`retryable`, `blocked`, `needs_owner_review`, `waiting`, `resolved`) and `film` (trusted link or `null`). `disposition` is a read-side label derived from the source state by a fixed table; it is not an action and starts nothing. Actions stay source-specific (`identity-step`, `identity-retry`, `discovery_reconsider`) and are out of this decision.

### 3. Deduplication without losing provenance

- A candidate that is `verified` and has a `film_rated_admission` row is shown as `disposition: resolved` with its trusted Film link and is **excluded from the unresolved list** by default (`include=resolved` shows it). It keeps `provenance`; the Film row is the one that remains in the list when the Film itself is stalled.
- A `verified` candidate **without** a D1 row matching both `archive_sha256` and `source_code` is not resolved: `disposition: needs_owner_review`, `reason: admission_unconfirmed`. The receipt `verified-films.json` alone never confirms.
- Two archives with the same `shortCode` are two rows (the key contains the hash). A `same_short_code` observed hint appears only when both rows are in the same response.
- A remake with the same title and year is two rows. `same_title_year` stays the candidate's own `needs_review` reason and links nothing.
- An EPG observation and a Letterboxd candidate for one **not yet proven** movie are two rows; an untrusted hint appears only when both are in the same response. They merge only through a verified Film that both reach by trusted proof.
- A double receipt (a short code present on two chunk receipts of one archive) is one row: the row key is `(archiveSha256, shortCode)`.

### 4. Coverage is part of the answer, and it is not one word

Every response carries per-lane coverage. The `film` and `epg_observation` lanes use `full`, `partial`, `unavailable`, `unknown` for their single source; a declared-partial index is `partial`. The Letterboxd candidate lane separates three questions:

- **Enumeration:** which archives exist. `complete` only when the delimiter listing was not truncated, every listed prefix is in the registry and every registry row is listed. It proves prefix presence only.
- **Counts:** an **estimate** from the derived registry, labelled `summarizedAt`, never called verified, because the registry is written after the primary write and not transactionally.
- **Page:** the only verified part: `read_whole` for the page archive's document, or `oversized`, `unreadable`, `registry_stale`.

The response never calls the candidate lane globally `full` and never says "no work" for it; the strongest statement is "the registry estimates N, enumeration complete". An unindexed archive is counted and never shown as an empty queue. A selected-archive view is never presented as global coverage.

### 5. Bounded archive enumeration (the chosen source for "all archives")

- **Archive registry:** a small derived R2 object `letterboxd/imports/registry.json` (a projection, not an owner): `{schemaVersion, updatedAt, archives: {<sha>: {registeredAt, generatedAt, counts: {pending, admitting, needs_review, verified, removed}, documentEtag, summarizedAt}}}`, capped at 256 KiB and 500 archives. It is written by the **existing** candidate writers (register, identity step terminal write, retry, rollback) with its own compare-and-swap after their primary write. It is derived: a lost or stale registry update never changes a candidate and is repaired by the next writer of that archive or by the explicit backfill below.
- **Completeness probe on GET:** one R2 `LIST` with `prefix=letterboxd/imports/`, `delimiter=/`, at most 1000 prefixes, no object bodies. Every prefix not in the registry is an **unindexed archive** (lane coverage `partial`, the count shown). A truncated listing is `partial` with `reason: listing_truncated`. A registry row whose prefix is not listed is a `registryOrphans` entry, shown, not hidden. Both make enumeration `partial`.
- **Row reads:** at most **one** candidate document per request (the archive of the current page), capped at 2 MiB; a larger or unreadable document is `partial` for that archive with `oversized` or `unreadable`. Counts for the other archives are registry **estimates** labelled `summarizedAt`; a mismatch of `documentEtag` on the page's archive is `registry_stale` for that archive. No N+1 reads, no unbounded `list`, no ZIP access, no TMDB or Letterboxd call.
- **Backfill of archives that exist but are not in the registry:** an owner-confirmed write operation of its own (read the delimiter listing, read each archive's document once, write the registry). It is a downstream card with its own L2 contract; until it runs, those archives are `unindexed` and visible as such.

### 6. Ordering, pin and cursor

Rows are ordered lane by lane (`film`, `epg_observation`, `letterboxd_rated_candidate`), inside a lane by the lane's own deterministic key (`ageMs` descending, then work key); candidates by archive `(registeredAt, sha)` then `shortCode`. There is **no global cross-lane sort by age**: that would require loading all sources.

- **Pin:** the Limbo tuple and the **registry etag**, read at the first page. No candidate document etag is in the pin.
- **Cursor:** lane, position, filter key, limit and, inside the candidate lane, the page archive's `sha` and the `documentEtag` read when the cursor was minted.
- **Validated per request:** the Limbo tuple and registry etag (409 `stale_pin`); filter key and limit; and, inside an archive, that its document etag equals the cursor's (400 `stale_cursor`).
- **A to B:** when A is exhausted the next cursor names B without an etag; B is read fresh and its etag goes into the following cursor. A different etag for B is a different document, not a change.
- **Not detectable:** a change to A after the reader moved to B is detected only through the registry etag, because the existing writers update the registry after their primary write. If that update has not landed, the change is invisible to the cursor. The response therefore says `snapshot: "per_archive"`, names each page's `documentEtag` and never claims one global snapshot; a fresh view needs a new first request.

### 7. Read-only boundary

The route is `GET` only and calls no `identity-step`, no TMDB or Letterboxd, no Discovery or metadata continuation, no ZIP apply, no D1 or R2 writer and no Task. It adds `GET /api/admin/identity-work` to `tests/get-write-audit.mjs` as a route whose only storage calls are `get`, `head` and one delimiter `list`.

### 8. Ownership and authority (no new owner, no second identity source)

| Data | Current owner | Reader | Writer | Target after this decision |
| --- | --- | --- | --- | --- |
| Canonical Film, `film_rated_admission` | D1 | catalog reader, Limbo | fenced D1 adapters (`admitRatedFilm`) | Unchanged |
| EPG Discovery observations, decisions, admissions | D1 | `discoveryIndexRead`, recovery routes | Discovery Workflow, owner actions | Unchanged |
| Unverified `rated-candidates.json` | R2, mutable, compare-and-swap | `identity-status` (one archive), **new** inventory (one archive per page) | owner-driven identity step / retry / rollback | Unchanged: stays R2 |
| Archive receipts and chunk objects | R2 evidence | archive status, **new** completeness probe by prefix | owner archive apply | Unchanged |
| `letterboxd/admissions/verified-films.json` | R2 historical receipt | candidate writer, evidence | existing writer | Unchanged; never a Film owner and never confirms a link |
| `letterboxd/imports/registry.json` | **new**, derived R2 projection | **new** inventory | existing candidate writers, backfill | New, derived, droppable |

Moving the **mutable candidate queue** to D1 is **not** required by this decision. It becomes a separate, owner-gated card only if measurement shows one of: registry write contention that the compare-and-swap cannot absorb, the registry or candidate documents exceeding their caps for the owner's real archive count, or a product need for a cross-archive global sort or full-text filter. Such a card must define fences, backfill, cutover, removal of the fallback and preservation of the receipts.

### 9. Not decided

The Limbo UI, the exact Russian labels, any owner action on a candidate from Limbo, the backfill's authorization, and whether the candidate queue ever moves to D1. This record authorizes no production operation, flag, Task, migration or write.

## Alternatives considered

- **A. Extend `GET /api/admin/limbo` with a new adapter and kind.** Rejected: the closed vocabulary and the single R2-snapshot pin of that route would couple a Letterboxd source with a different pin domain to every Limbo cursor, and it would have to either list archives per request or read every candidate document.
- **B. List and read every archive per request.** Rejected: unbounded `list`, N+1 reads and multi-megabyte JSON on a `GET`; breaks [ADR 0107](0107-get-head-read-side-effect-boundary.md) intent.
- **C. A separate projection with a derived registry and a bounded completeness probe (chosen).** Smallest authority change: no owner moves, bounded reads, honest partial coverage. Cost: one more derived object and a small change in four existing writers, delivered separately.
- **D. Move the whole candidate queue to D1 now.** Rejected for now: a migration with fences, backfill and cutover that the evidence does not yet justify, and it would re-open an authority split that was just closed for Films.
- **E. Registry-only discovery (no listing probe).** Rejected: a lost registry update would silently hide an archive and make coverage look complete.

## Consequences

- One new read route, one pure domain module and tests, one derived R2 object and small hooks in the existing candidate writers, all in later atomic cards. Until they exist, the inventory is **not production-ready** and nothing here may be described as live.
- Owner-visible honesty: unindexed, oversized and partial are explicit states; for the candidate lane "no work" is never asserted, only a labelled registry estimate with complete enumeration.
- Risk: a derived registry can lag its documents and cannot prove other archives' content; it is labelled an estimate, repaired and never authoritative. Risk: a change in an already visited archive can go undetected by the cursor until the registry updates; the response says so. Risk: the lane-sequential order cannot answer "oldest across everything"; the cost is accepted, and the UI must say so.
- Compatibility: `GET /api/admin/limbo`, its pin, cursor and vocabulary are untouched.

## Recovery and migration boundary

The registry is derived and droppable: deleting it returns every archive to `unindexed` and changes no candidate, Film, receipt or decision. Code rollback does not revert R2 or D1 data. A mistaken registry row is corrected by the next writer of that archive or by the backfill. The decision itself writes nothing. Each downstream card needs its own owner approval for any write, backfill, flag or Task; a deploy never grants it.

## Evidence

- **Original decision:** pending owner decision on the pull request that carries this record.
- **Implementation:** none. Architecture only.
- **Dated verification:** facts above were read from `main` `3d9d81c` on 2026-11-18 (`src/admin/limbo.js`, `src/domain/limbo-inventory.js`, `src/letterboxd-rated-candidates.js`, `src/admin/letterboxd-archive-apply.js`). No production read or write was made.
- **Uncertainty:** the real number and size of archives and candidate documents in production is not measured here; the caps in section 5 are proposals to be confirmed by a read-only measurement before the first implementation card.

## Follow-ups

Atomic downstream deliverables, to be created only after this record is Accepted: (1) registry object and hooks in the existing candidate writers; (2) owner-confirmed registry backfill with an L2 contract; (3) pure domain module, read adapter, `GET /api/admin/identity-work`, audit entry and tests; (4) `/admin/limb` UI; (5) conditional: D1 candidate queue migration, only under the criteria in section 8.
