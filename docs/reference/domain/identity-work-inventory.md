# Identity work inventory (accepted design contract)

**Status:** accepted architecture, not implemented. No route, module or object described here exists yet. The decision is [ADR 0170](../../adr/0170-unified-identity-work-inventory.md), Accepted on 2026-11-18; this page is the design contract for separately approved implementation. The installed [Limbo inventory](data-health.md#limbo-inventory) and [`GET /api/admin/limbo`](../api/admin.md#limbo-inventory) are unchanged.

**Role:** a read-only owner view of all identity work that has not yet become a trusted Film: EPG observations, Letterboxd rated candidates and stalled canonical Films, in typed lanes with honest per-lane coverage.

## Route

`GET /api/admin/identity-work`, owner-only behind the same Access application. `GET` only; any other method is 405. It calls no `identity-step`, no TMDB or Letterboxd, no Discovery or metadata continuation, no ZIP apply, no D1 or R2 writer and no Task. Its storage calls are `get`, `head` and one delimiter `list` of `letterboxd/imports/`.

| Query | Meaning |
| --- | --- |
| `type` | `film`, `epg_observation` or `letterboxd_rated_candidate`. Omitted: all lanes, in lane order |
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

Lane order is `film`, `epg_observation`, `letterboxd_rated_candidate`. Inside a lane: `ageMs` descending, then `key`; candidates by archive `(registeredAt, sha)` and then `shortCode`. There is no global cross-lane sort by age.

**What the pin holds.** The `pin` is the tuple of the versions read at the first page: the Limbo tuple (for the first two lanes) and the **registry etag**. It does not hold any candidate document etag.

**What the cursor holds.** The lane, the position, the filter key and limit, and, when the position is inside the candidate lane, the page archive's `sha` and the `documentEtag` read when the cursor was minted.

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
