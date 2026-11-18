# Identity work inventory (proposed contract)

**Status:** proposed, not implemented. No route, module or object described here exists yet. The decision is [ADR 0169](../../adr/0169-unified-identity-work-inventory.md), Proposed; this page is the exact contract the implementation must meet once the ADR is Accepted. The installed [Limbo inventory](data-health.md#limbo-inventory) and [`GET /api/admin/limbo`](../api/admin.md#limbo-inventory) are unchanged.

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
  hints: [{kind, trusted: false, ref}],           // title_year_match, same_short_code
  sameShortCodeIn: [archiveSha256],               // information only
  source: { ...the lane's own fields } }
```

`key` is `epg:<observationKey>`, `lbc:<archiveSha256>:<shortCode>` or `film:<canonicalFilmId>`. `status` and `reason` are the source's own words. `disposition` comes from a fixed table per lane and starts nothing. `film` is set only by a D1 `film_rated_admission` row (candidate) or the canonical catalog (observation) with movie provenance; a title, year, short code, alias match or `tmdb_tv` id never sets it.

## Coverage

```text
coverage: {
  film:                    {state, reason},
  epg_observation:         {state, reason, indexed, eligible, omitted},
  letterboxd_rated_candidate: {state, reason},
  archives: {registered, listed, summarized, unindexed, unreadable, registryOrphans}
}
```

`state` is `full`, `partial`, `unavailable` or `unknown`. `full` means the whole lane was read to its end under the pin. An index declared partial, a truncated listing (`listing_truncated`), an oversized or unreadable candidate document (`oversized`, `unreadable`), a prefix missing from the registry (`unindexed`) and a stale registry row (`registry_stale`) are never reported as an empty queue. Counts for archives other than the page's own come from the registry and carry `summarizedAt`.

## Bounds

- One delimiter `list` of `letterboxd/imports/`, at most 1000 prefixes, no bodies.
- One registry object `letterboxd/imports/registry.json`, at most 256 KiB and 500 archives.
- At most one candidate document per request, at most 2 MiB.
- No N+1 reads, no unbounded `list`, no ZIP access.

## Order, pin and cursor

Lane order is `film`, `epg_observation`, `letterboxd_rated_candidate`. Inside a lane: `ageMs` descending, then `key`; candidates by archive `(registeredAt, sha)` and then `shortCode`. There is no global cross-lane sort by age. The `pin` is a tuple of per-lane versions: the Limbo tuple for the first two lanes, the registry etag and the page archive's document etag for candidates. A pin that no longer matches is 409 `stale_pin`; a cursor from another filter, limit or lane position is 400 `stale_cursor`.

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
| Two archives with the same short code | Two rows (`lbc:<shaA>:x`, `lbc:<shaB>:x`), each with the other in `sameShortCodeIn`; no merge |
| Remake with the same title and year | Two rows; the candidate's own `same_title_year` reason; no `film`, no cross-link |
| EPG observation and a candidate for one not yet proven movie | Two rows, each with an untrusted `title_year_match` hint; no `film`, no Film created |
| `tmdb_tv` id on an observation | The claim stays `tmdb_tv`; it is not counted as `tmdb`; no `film` |
| Candidate `verified` with a `film_rated_admission` row | `disposition: resolved`, trusted `film`, absent from the default list, `provenance` kept; the Film row appears only if the Film is itself stalled |
| Candidate `verified` without a D1 admission row | `needs_owner_review`, `reason: admission_unconfirmed`; the historical receipt does not confirm it |
| Candidate `needs_review` or retryable | Own `status` and `reason`; `disposition` from the table; no action started |
| Archive with receipts but not in the registry | Counted in `archives.unindexed`; the lane is `partial`, not empty |
| Registry row whose prefix is not listed | Counted in `registryOrphans`; shown |
| Candidate document unreadable or over 2 MiB | That archive is `partial` with `unreadable` or `oversized`; the lane is not `full` |
| Listing truncated at 1000 prefixes | Lane `partial`, `listing_truncated` |
| Source changed between pages | Next request 409 `stale_pin` or 400 `stale_cursor`; no silently re-cut page |
| Double receipt for one short code in one archive | One row, key `(archiveSha256, shortCode)` |

The Letterboxd candidate lane may be called `full` only when the listing was complete, every listed archive is in the registry and its summary matches, and the page's document was read whole.
