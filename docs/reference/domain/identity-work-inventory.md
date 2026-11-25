# Identity work inventory

**Status:** implemented and read-only. The route `GET /api/admin/identity-work`, the pure module and the derived archive registry exist; the owner page `/admin/identity` (the «Идентификация» tab of the admin navigation) shows it (see [Owner page](#owner-page)). The decision is [ADR 0170](../../adr/0170-unified-identity-work-inventory.md). The installed [Limbo inventory](data-health.md#limbo-inventory) and [`GET /api/admin/limbo`](../api/admin.md#limbo-inventory) are unchanged. Source: [`src/admin/identity-work.js`](../../../src/admin/identity-work.js) (route and storage reads), [`src/domain/identity-work-inventory.js`](../../../src/domain/identity-work-inventory.js) (pure rows, filters, cursor; bundled as `IdentityWorkInventory`), [`src/domain/letterboxd-import-registry.js`](../../../src/domain/letterboxd-import-registry.js) (pure registry rules; bundled as `LetterboxdImportRegistry`) and the registry hook in [`src/letterboxd-rated-candidates.js`](../../../src/letterboxd-rated-candidates.js). Tests: [`tests/admin-identity-work-api.mjs`](../../../tests/admin-identity-work-api.mjs), [`tests/identity-work-inventory.mjs`](../../../tests/identity-work-inventory.mjs), [`tests/letterboxd-import-registry.mjs`](../../../tests/letterboxd-import-registry.mjs); the [GET side-effect audit](../../../tests/get-write-audit.mjs) registers the route.

**Role:** a read-only owner view of all identity work that has not yet become a trusted Film: EPG observations, Letterboxd rated candidates and stalled canonical Films, in typed lanes with honest per-lane coverage.

## Route

`GET /api/admin/identity-work`, owner-only behind the same Access application. `GET` only; any other method is 405. It calls no `identity-step`, no TMDB or Letterboxd, no Discovery or metadata continuation, no ZIP apply, no D1 or R2 writer and no Task. Its storage calls are `get`, `head` and one delimiter `list` of `letterboxd/imports/`.

| Query | Meaning |
| --- | --- |
| `type` | `film`, `epg_observation`, `watchlist_admission` or `letterboxd_rated_candidate`. Omitted: all lanes, in lane order |
| `disposition` | `retryable`, `blocked`, `needs_owner_review`, `waiting`. `include=resolved` adds `resolved` rows |
| `archive` | One 64-hex `archiveSha256`. Restricts the candidate lane to that archive; the response still reports the global `archives` coverage and never presents the selection as global |
| `q` | Case-insensitive substring of the title or short code, applied inside the page's source only; never a search across unread sources |
| `limit` | Integer 1 to 25 |
| `pin`, `cursor` | Opaque; see below |

An unknown value is 400 (`unknown_type`, `unknown_disposition`, `invalid_archive`, `invalid_limit`), never "everything".

## Row

```text
{ key, type, status, reason, disposition,
  title, year, shortCode, archiveSha256,          // as applicable to the type
  provenance: [{source, ref}],                    // never dropped by deduplication
  observedAt, lastProgressAt, ageMs,
  film: {filmId, proof} | null,                   // only with trusted movie provenance
  observedHints: [{kind, trusted: false, ref}],   // title_year_match, same_short_code; best-effort, see below
  source: { ...the lane's own fields } }
```

`observedHints` are **best-effort and scoped to rows actually present in the same response** (the same page, or the same lane page of one archive). They are computed from those rows only, are never trusted, never set `film` and never create a merge. An empty or absent `observedHints` means "not observed", never "no other candidate exists": no global candidate correlation index exists, and the registry holds only per-archive counts and etags. A bounded derived correlation index (provenance, consistency rules, its own coverage) is a possible later card, not part of this contract.

`key` is `epg:<observationKey>`, `lbc:<archiveSha256>:<shortCode>` or `film:<canonicalFilmId>`. `status` and `reason` are the source's own words. `disposition` comes from a fixed table per lane and starts nothing. `film` is set only by proof. For a candidate the proof is a D1 `film_rated_admission` row whose `archive_sha256` **and** `source_code` both equal the candidate's `(archiveSha256, shortCode)` and whose `tmdb` is a typed movie Film identity; a row that matches the short code alone (another ZIP with the same code) never confirms this candidate, and the historical R2 receipt is never an alternative proof. For an observation the proof is the canonical catalog with movie provenance. A title, year, short code, alias match or `tmdb_tv` id never sets it.

## Coverage

Three different questions are answered separately and are never merged into one word. For the Letterboxd candidate lane:

```text
coverage.letterboxd_rated_candidate: {
  enumeration: {state, reason, registered, listed, unindexed, registryOrphans},
  counts:      {basis: "registry_estimate", summarizedAt, state, byStatus},
  page:        {archiveSha256, state, reason, documentEtag}
}
```

- **`enumeration`** answers "do we know which archives exist": `complete` only when the delimiter listing was not truncated and every listed prefix is in the registry and every registry row has a listed prefix. It proves prefix presence only. A truncated listing (`listing_truncated`), an `unindexed` prefix or a `registryOrphans` row makes it `partial`.
- **`counts`** are an **estimate** from the derived registry, labelled with `summarizedAt`. They are never called verified: the registry is written after the primary write and not transactionally, so the response cannot establish that another archive's document still matches its summary.
- **`page`** is the only verified part: `read_whole` when this request read the page archive's candidate document completely, otherwise `oversized` (over 2 MiB), `unreadable` or `registry_stale` (the document's etag differs from the registry row).

Consequently the response never states that the candidate lane is globally `full`, and never says "no work" for it. It may say "the registry estimates 0 pending in N archives, enumeration complete" and nothing stronger. The `film` and `epg_observation` lanes keep the single-source states `full`, `partial`, `unavailable` and `unknown`; an index that is declared partial is `partial`.

## Bounds

- One delimiter `list` of `letterboxd/imports/`, at most 1000 prefixes, no bodies.
- One registry object `letterboxd/imports/registry.json`, at most 256 KiB and 500 archives.
- At most one candidate document per request, at most 2 MiB.
- No N+1 reads, no unbounded `list`, no ZIP access.

## Order, pin and cursor

Lane order is `film`, `epg_observation`, `watchlist_admission`, `letterboxd_rated_candidate`. Inside a lane: `ageMs` descending, then `key`; candidates by archive `(registeredAt, sha)` and then `shortCode`. There is no global cross-lane sort by age.

**What the pin holds.** The `pin` is the tuple of the versions read at the first page: the Limbo tuple (for the first two lanes) and the **registry etag**. It does not hold any candidate document etag.

**What the cursor holds.** The evaluation clock of the first page (`nowMs`, reused by every later page, so causes, dispositions, ages and filtered positions of the Film and observation lanes cannot move between pages while the source versions stand; a new first request evaluates at the new time), the lane, the position, the filter key and limit, and, when the position is inside the candidate lane, the page archive's `sha` and the `documentEtag` read when the cursor was minted.

**What is validated on each request.** The Limbo tuple and the registry etag (`stale_pin`, 409, when either moved); the filter key and limit (`stale_cursor`, 400); and, for a cursor inside an archive, that the archive's document etag still equals the cursor's (`stale_cursor`, 400). 

**A to B transition.** When archive A is exhausted the next cursor names B with no `documentEtag`; B's document is read fresh at that request and its etag is recorded in the following cursor. B's etag differing from any earlier value is not a change: it is a different document.

**What is not detectable.** A change to A after the reader moved to B is detected only through the registry etag, because the existing writers update the registry after their primary write. If the registry update has not landed, the change is not detected and the pages already served keep their per-archive version. The response therefore states `snapshot: "per_archive"` and each candidate page names its `documentEtag`; it never claims one global snapshot. A caller that needs a fresh view starts again without a cursor.

## Authority

| Data | Owner | Role here |
| --- | --- | --- |
| Canonical Film, `film_rated_admission` | D1 | Read; the only confirmation of a candidate's Film link |
| Discovery observations and decisions | D1 | Read through the existing reader |
| Unverified `rated-candidates.json` | R2, compare-and-swap | Read, one archive per request |
| `letterboxd/admissions/verified-films.json` | R2 receipt | Evidence only; never confirms a link |
| `letterboxd/imports/registry.json` | derived R2 projection | Read; written only by the existing candidate writers and the owner-confirmed backfill |

## Owner page

`/admin/identity` is its own owner page and its own tab, «Идентификация», of the admin navigation (between «Лимб» and «Постеры»), titled «Единая очередь идентификации». It is not part of `/admin/limb`: that page holds only the Limbo queue, and the two pages are two documents with two scripts (`/admin-limbo.js`, `/admin-identity.js`), so opening either starts only its own read and sends nothing to the other's route. The page is read-only: its only request is `GET /api/admin/identity-work`, it posts nothing, starts no import, identity step, backfill or restore, and stores nothing in the browser. Source: [`public/admin-identity.html`](../../../public/admin-identity.html), [`src/admin/identity-work-client.js`](../../../src/admin/identity-work-client.js) (the GET client), [`src/admin/identity-work-view.js`](../../../src/admin/identity-work-view.js) (pure HTML) and [`public/admin-identity-work.js`](../../../public/admin-identity-work.js) (controller); tests: [`tests/admin-identity-work-page.mjs`](../../../tests/admin-identity-work-page.mjs) and, on the served assets of the built Worker, [`tests/admin-limb-startup.mjs`](../../../tests/admin-limb-startup.mjs).

- Controls: type, state (`disposition`), a search box (`q`, applied by the server inside the page's own source), «показывать и решённые» (disabled while a state is chosen, because a state filter already decides about resolved rows), apply, reset, refresh. The default list is unresolved.
- Rows are grouped under a heading per lane in the order the server returns them. Each row shows its disposition, the source's own status and reason, age, provenance and last progress. A Film link appears only for a row whose `film` carries proof; otherwise the row says the Film is not confirmed. Observed hints are listed as unproven and never as a link.
- «Показать ещё» continues from `nextCursor` under the pin of the first page. A page can be short or empty while `nextCursor` is set; the page then says the queue has not ended. A `stale_pin` or `stale_cursor` keeps the shown rows on screen under a banner that says they are not current and offers a reload from the first page.
- A new first page (apply, reset, refresh, reload) clears the previous query's rows, coverage, pin and cursor before it reads, so a failed first read shows nothing of the old list as current and sends no old cursor. A failed or stale list hides «Показать ещё»; retry and reload start from the first page.
- Coverage is in a closed panel under the verdict: per-lane state for Film and EPG, and for Letterboxd the enumeration, the registry-estimated counts (labelled as an estimate with its time, never as verified, and scoped to the archives the registry holds; archives outside it are named as unknown). An absent, unreadable or invalid registry shows no counts at all, never zeros and the page archive's own state. The page never states that the candidate lane is complete or that no work exists.

## Group entry link

The heading of `/admin/identity` carries a permanent link «Открыть групповую идентификацию» to `/admin/identity/group` (a plain anchor, not part of the queue read). The group page reads this queue itself, `type=epg_observation`, `limit=10`, as a bounded and partial worklist; that read adds no parameter or field to the route. A row whose `film.filmId` is `tmdb_<digits>` carries a link to `/admin/identity/group?tmdbId=<digits>` ([ADR 0181](../../adr/0181-owner-confirmed-group-assign-of-selected-observations.md)). The link is navigation only: the queue route stays read-only, its response shape is unchanged and no group candidate is read by the queue.

## Registry

`letterboxd/imports/registry.json` is a derived, droppable projection: `{schemaVersion: 1, updatedAt, archives: {<sha>: {registeredAt, generatedAt, counts: {pending, admitting, needs_review, verified, removed}, documentEtag, revision, summarizedAt}}}`, at most 256 KiB and 500 archives. Every successful write of a candidate document (register, identity step, retry and the other mutation paths all go through one compare-and-swap helper) is followed by a bounded registry update (three attempts, its own compare-and-swap) that names the etag of the document just saved. The update never fails or undoes the primary write, never creates a second owner and never hides an older archive. Rules:

- Every candidate document carries a `revision` that rises by one inside the compare-and-swap that writes it, and the registry row names the revision it summarizes. A summary whose revision is not newer than the row's (or has none) never replaces the row, so a delayed writer cannot overwrite the row of a newer document, and no clock is involved; `summarizedAt` is only a label. `registeredAt` is kept from the first registration.
- A new archive beyond 500 archives, or a registry beyond 256 KiB, is refused and the archive stays `unindexed`.
- A registry that is unreadable or of another schema is left untouched by writers and reported by the read (`registry_unreadable`, `registry_invalid`, `registry_oversized`); dropping the object is the recovery, and the next writer starts it again from its own archive.
- A write that changes nothing writes nothing. An archive whose document was last written before the registry existed stays `unindexed` until its next write or an owner-confirmed backfill.

## Implementation notes and limits

- Archives that are present in the listing but not in the registry are paged **after** the registered ones, each labelled `indexed: false`; they are counted in `enumeration.unindexed` and are never reported as an empty queue. With no registry object at all every listed archive is paged this way, ordered by hash.
- An archive filter accepts any 64-hex hash; an archive with no candidate document reports `page.state: absent`.
- A page reads at most one candidate document, so a page can be shorter than `limit` (or empty) while `nextCursor` names the next archive. A caller continues until `nextCursor` is `null`.
- A page that the Film and Discovery lanes fill exactly hands over to the candidate lane with a cursor and reads no candidate document in that request.
- Film rows group every Limbo issue of one Film into one row (`source.issues`); the Discovery observation row carries no `film` because the Limbo reader holds no canonical movie proof for it. A `tmdb_tv` claim is never a Film link.
- Admission proof is one `SELECT ... FROM film_rated_admission WHERE archive_sha256 = ? LIMIT 5001` per request, and only when the page archive holds a `verified` candidate. More than 5000 rows, or a failed read, makes the proof `unavailable`: such rows are `waiting` with reason `admission_unreadable`, never `resolved` and never `admission_unconfirmed`.
- A candidate with state `pending` or `admitting` in an archive whose checkpoint is stopped is `blocked` with the stop code as `reason`; a `needs_review` row is `retryable` when its reason is one the identity step can retry, otherwise `needs_owner_review`.
- If the Limbo evaluation cannot be loaded the Film and EPG lanes report `unavailable` with the reason and the candidate lane is still served; the pin then carries `unavailable` for that part.
- A query for only the candidate lane does not load the Limbo snapshot; a query for only Film or EPG rows does not list or read the candidate store.

## Response

```json
{
  "pin": "I1|e%3Aabc|L2%7C...",
  "snapshot": {"sources": ["letterboxd/imports/registry.json", "..."], "evaluatedAt": "2026-11-18T12:00:00.000Z", "scope": "per_archive"},
  "type": null, "disposition": null, "include": null, "archive": null, "q": null, "limit": 25,
  "rows": [{"key": "lbc:<sha>:Aa1", "type": "letterboxd_rated_candidate", "status": "needs_review", "reason": "tmdb_fetch_failed", "disposition": "retryable", "title": "Film", "year": 2001, "shortCode": "Aa1", "archiveSha256": "<sha>", "provenance": [{"source": "letterboxd_archive", "ref": "<sha>"}, {"source": "archive_chunk", "ref": "0"}], "observedAt": "...", "lastProgressAt": "...", "ageMs": 864000000, "film": null, "observedHints": [], "source": {"chunk": 0, "rating": 4, "enrichment": null, "retryOf": null, "historicalTmdb": null, "stopped": false}}],
  "nextCursor": null,
  "coverage": {
    "film": {"state": "partial", "observed": 2},
    "epg_observation": {"state": "partial", "observed": 1, "index": {"available": true}},
    "letterboxd_rated_candidate": {
      "enumeration": {"state": "partial", "reason": "unindexed_archives", "registered": 1, "listed": 2, "unindexed": 1, "unindexedArchives": ["<sha>"], "registryOrphans": 0, "orphanArchives": []},
      "counts": {"basis": "registry_estimate", "summarizedAt": "...", "state": "estimate", "byStatus": {"pending": 1, "admitting": 0, "needs_review": 1, "verified": 0, "removed": 0}},
      "page": {"archiveSha256": "<sha>", "state": "read_whole", "reason": null, "documentEtag": "...", "indexed": true, "admissions": "not_needed"},
      "snapshot": "per_archive", "selected": null
    }
  },
  "vocabulary": {"types": ["film", "epg_observation", "watchlist_admission", "letterboxd_rated_candidate"], "dispositions": ["retryable", "blocked", "needs_owner_review", "waiting", "resolved"]}
}
```

A lane that the query excluded has no `coverage` entry. `page.state` is `read_whole`, `registry_stale`, `oversized`, `unreadable`, `absent` or `not_read`. `enumeration.state` is `complete`, `partial` or `unknown` (listing unavailable). Errors: 400 `unknown_type`, `unknown_disposition`, `unknown_include`, `invalid_archive`, `invalid_query`, `invalid_limit`, `invalid_pin`, `stale_cursor`; 405 for a method other than `GET`; 409 `stale_pin`. The `epg_observation` lane is `unavailable` with `reason: index_stale` and `index.reasons: ['generation_moved']` when the observation index answered `stale` without a manifest (the D1 generation moved during the read); it is never `partial` with a count of zero, and the `film` and `letterboxd_rated_candidate` lanes still answer.

## Performance bounds

The Film and EPG lanes read what `GET /api/admin/limbo` reads, and each request loads those sources itself; the two owner pages are separate pages, so one page never has both reads in flight (a second tab or another client still can). The observation index reads at most 3,000 observations with their shows in chunks of 80 keys (about 40 statements).

| Bound | Value |
| --- | --- |
| Delimiter `list` per request | 1, at most 1000 prefixes, no bodies |
| Registry object | 1 `get`, at most 256 KiB and 500 archives |
| Candidate document | 1 `head` and at most 1 `get`, at most 2 MiB; a larger one is judged from `head` and never read |
| D1 | at most 1 `SELECT` of `film_rated_admission` for the page archive, `LIMIT 5001`, none without a `verified` candidate; the Limbo lanes read what the Limbo route reads |
| Rows per page | `limit` 1 to 25 |
| Cursor | at most 6000 characters |
| Outbound calls, writes, ZIP access | none |

Measured production sizes are in the [dated measurement](../../evidence/letterboxd/identity-work-inventory-measurement-2026-11-18.md).

## Synthetic cases the implementation must satisfy

| Case | Required result |
| --- | --- |
| Two archives with the same short code | Two rows (`lbc:<shaA>:x`, `lbc:<shaB>:x`); no merge. Each carries a `same_short_code` observed hint only when both rows are in the same response; otherwise no hint, which means "not observed" |
| Remake with the same title and year | Two rows; the candidate's own `same_title_year` reason; no `film`, no cross-link |
| EPG observation and a candidate for one not yet proven movie | Two rows. A `title_year_match` hint appears only when both rows are in the same response and is untrusted; no `film`, no Film created |
| `tmdb_tv` id on an observation | The claim stays `tmdb_tv`; it is not counted as `tmdb`; no `film` |
| `film_rated_admission` row with the same `source_code` but another `archive_sha256` | Does not confirm the candidate: `needs_owner_review`, `reason: admission_unconfirmed`; the typed movie identity must also match |
| Candidate `verified` with a `film_rated_admission` row matching `archive_sha256`, `source_code` and a movie `tmdb` | `disposition: resolved`, trusted `film`, absent from the default list, `provenance` kept; the Film row appears only if the Film is itself stalled |
| Candidate `verified` without a D1 admission row | `needs_owner_review`, `reason: admission_unconfirmed`; the historical receipt does not confirm it |
| Candidate `needs_review` or retryable | Own `status` and `reason`; `disposition` from the table; no action started |
| Archive with receipts but not in the registry | Counted in `enumeration.unindexed`; enumeration is `partial`, never empty |
| Registry row whose prefix is not listed | Counted in `enumeration.registryOrphans`; shown; enumeration `partial` |
| Candidate document unreadable or over 2 MiB | `page.state` is `unreadable` or `oversized`; no rows are invented for that archive |
| Listing truncated at 1000 prefixes | `enumeration.state: partial`, `listing_truncated` |
| Candidate document of the page archive changed between pages | 400 `stale_cursor` |
| Registry changed after A was served, reader now on B | 409 `stale_pin` |
| Archive A mutated after the reader moved to B, registry not yet updated | Not detected; B's page is internally consistent, the response says `snapshot: per_archive`; a restart reads A anew |
| Limbo tuple moved between pages | 409 `stale_pin` |
| Registry estimate says 0 pending, enumeration complete | Reported as an estimate with `summarizedAt`; never as "no work" |
| Double receipt for one short code in one archive | One row, key `(archiveSha256, shortCode)` |

## The Watchlist admission lane

`watchlist_admission` lists the durable ledger of Letterboxd ids that still need a Film (`watchlist_admission_pending`, [ADR 0186](../../adr/0186-letterboxd-sync-and-independent-watchlist-authority.md)), one row per id, read from D1 and joined to the first-seen snapshot for the title, year and age. Key `wla:<lid>`; `shortCode` is the Letterboxd id; `status` is the ledger state; `reason` is the last bounded reason code.

| Ledger state | `disposition` |
| --- | --- |
| `terminal` (the attempt cap of the shared check, or `owner_dismissed`; rows written before AIR-599 may carry `age_exceeded`) | `needs_owner_review` |
| `pending` with a retry time in the future | `waiting` |
| `pending`, due | `retryable` |
| `resolved`, `superseded` | `resolved` (shown only with `include=resolved`) |

**The filter is part of the SQL, before any page limit.** The requested `disposition` and `include` become one source filter (`owner_review`, `waiting`, `retryable`, `history`, `open` or `all`; `blocked` names no ledger state and yields no rows), so a work list is complete however many historical `resolved`/`superseded` rows (which have no cap) precede a row. The lane is paged by **keyset** over `(first-seen version, lid)`: the cursor carries the position of the last row read and the **Watchlist authority generation** of the page that minted it, and a cursor from another generation is `stale_cursor`. A page may hold fewer rows than the limit only because the title search (`q`) is applied to the page read; the cursor still continues, so nothing is skipped and nothing repeats while rows change between pages.

The row never carries a `film` link: identity stays a Film fact. `coverage.watchlist_admission` is `complete` (this was the last page), `partial` with reason `more_pages` (another page exists; the answer carries `nextCursor`) or `unavailable` with a reason (tables absent or the repository unreadable), never an empty queue. The route writes nothing.

Since AIR-599 ([ADR 0207 decision 4b](../../adr/0207-letterboxd-admissions-coordinated-in-d1-only.md)) each ledger row's `source` also carries `class` (the classifier of the shared check for a pending row's last reason, `needs_owner_review` for a terminal one), `streak` (the transport streak of the shared Diary entry, when one exists) and `revision` (`state`, `attempts`, `updatedAt`: the compare-and-swap token of the owner action).

## The Diary identity lane (AIR-599)

`diary_identity` lists the shared Letterboxd check document (`letterboxd/facts/scans/diary-identity.json`: the entries and its bounded backlog), read only, in queue order (oldest `queuedAt` first). It is an in-memory lane paged by index like `film`. Keys: `did:<lid>` for an entry, `dbl:<lid>` for a backlog id (an id with an entry is shown once). `source` carries `attempts`, `streak`, `nextRetryAt`, `class`, `slug`, `route`, `checkId`, `requeued` and `queuedAt`.

| Entry | `disposition` |
| --- | --- |
| `owner_dismissed` | `resolved` (only with `include=resolved`) |
| attempts at the cap (6) | `needs_owner_review` |
| due (`nextAttemptAt` past or absent) | `retryable` |
| backed off | `waiting` |
| backlog id (reason `diary_cap`) | `waiting` |

`coverage.diary_identity` is `{state: 'complete', version, backlogVersion, entries, backlog, cap, backlogCap}` (the backlog is part of the same document: both versions are its one stored version, the compare-and-swap token of the owner action) or `{state: 'unavailable', reason}`. The owner page shows each ledger and Diary row's class, attempts, transport streak and next check, and the lane's fill. The owner `requeue` and `dismiss` are the separate route [`POST /api/admin/identity-work/owner-action`](../api/admin.md#owner-requeue-and-dismiss-of-the-shared-letterboxd-check-post-apiadminidentity-workowner-action); this `GET` stays read-only.
