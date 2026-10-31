# Letterboxd account export — parsing and matching contract

The owner can download a Letterboxd account export (a ZIP of CSV files). [`src/letterboxd-export.js`](../../../src/letterboxd-export.js) parses it and [`src/letterboxd-match.js`](../../../src/letterboxd-match.js) matches its rows with films stored in a production R2 snapshot. Both modules are pure: they read no file, storage or network. The Worker bundles them unchanged (`scoped` as `LetterboxdExport` and `LetterboxdMatch`) for the owner's [archive preview](#in-the-worker); offline, the same files are imported directly. The operator procedure is the [reconciliation runbook](../../runbooks/letterboxd-export-reconciliation.md). This contract does not import ratings, change the watchlist or write R2; it only describes what an offline comparison may conclude.

## Files read

| File | Columns required | Use |
| --- | --- | --- |
| `watched.csv` | `Date`, `Name`, `Year`, `Letterboxd URI` | The watched set. `Date` is kept as `watchedDate` |
| `ratings.csv` | the same plus `Rating` | The rated set and the half-star rating |
| `watchlist.csv` | `Date`, `Name`, `Year`, `Letterboxd URI` | The export watchlist |
| `diary.csv` | the same plus `Rating`, `Watched Date` | Auxiliary: rows are validated and counted only. Its URIs are links to diary entries, not to films, so they never join the other sets |

Other export content (`profile.csv`, comments, reviews, likes, lists, the `deleted/` and `orphaned/` folders) is never opened. A missing `ratings.csv`, `watchlist.csv` or `diary.csv` is reported as `missing_file:<name>`; a missing `watched.csv` stops the run.

## Row rules

- CSV follows RFC 4180: comma separators, LF or CRLF records, a UTF-8 byte-order mark is ignored, double-quoted fields may hold commas, `""` and newlines. A quote inside an unquoted field, text after a closing quote or an unterminated quote is a malformed file and stops the run with the file name and record number.
- `Letterboxd URI` must be exactly `https://boxd.it/<code>` with an alphanumeric code; otherwise `invalid_uri`. The export carries no Letterboxd slug and no TMDB id.
- `Year` is four digits or empty (`missingYear` is counted); anything else is `invalid_year`. `Date` and `Watched Date` are calendar dates `YYYY-MM-DD` or empty, otherwise `invalid_date`.
- `Rating` is a half star from 0.5 to 5; anything else (including 0) is `invalid_rating`.
- A row with another number of cells than the header is `column_count`; an empty name is `missing_name`.
- Within one file a code is kept once. An identical repeated row is a `duplicate`. The same code with a different name, year or rating is a `conflict`, and the code is withheld from that file.

Derived sets, by code: `watched`, `rated`, `watchedUnrated` (watched minus rated), `ratedNotWatched`, `watchlist`, `watchlistWatched` (watchlist ∩ watched). One film record per code takes its name and year from the first of watched, ratings, watchlist; a code whose name or year differs between files is counted in `crossFileMismatches`.

## What the snapshot can contribute

| Snapshot object | Contribution to the index |
| --- | --- |
| `watchlist.json`, `programme.json` | Stored Letterboxd ids (`films[].id`, the `lid` of the watchlist page), titles, original titles, aliases, year, TMDB id when present |
| `metadata.json` | The Letterboxd metadata cache keyed by the same id: titles, aliases, year and the TMDB id read from the film page |
| `enrichment/ratings/published.json` → `enrichment/ratings/generations/<id>.json` | The Letterboxd ids of every film on the public films list with the rating seen there (`ratings: {id: rating or null}`), only when the pointer is projected |
| `enrichment/view-index.json` | `actualRating` per stored id, for Letterboxd ids and catalog ids |
| `epg/discovered-films.json` | Catalog films. Only records whose `canonicalIdentity` is `tmdb:<tmdbId>` count; an observation key without a verified identity is not a film |

## Methods and statuses

Every film gets exactly one record, ordered by code.

| Status | Method | When |
| --- | --- | --- |
| `accepted` | `lid_exact` | The export code equals a stored Letterboxd id **and** the stored data corroborates it: the export name equals a stored title, original title or alias of that id, and the stored year (if any) is within one year of the export year |
| `accepted` | `tmdb_verified` | As `lid_exact`, and that id carries exactly one stored TMDB id that equals a verified catalog record; the record lists the catalog id `tmdb_<n>` |
| `provisional` | `lid_exact` or `tmdb_verified` | The export code equals a stored id that carries no stored title (for example an id known only from a ratings generation, or only a year): code equality alone is not corroborated (`code_uncorroborated`). Never accepted; manual review |
| `candidate` | `title_year` | The code is not a stored id, and the normalized name equals a stored title, original title or alias of exactly one film within one year (`identity_unverified`), or the export year is missing (`missing_year`). An agreeing rating (`rating_agrees`) or the title on both watchlists (`watchlist_member`) is recorded as evidence but proves nothing about the Letterboxd identity. Never accepted |
| `ambiguous` | none | More than one film fits the title within the year window (remakes in adjacent years, shared aliases), or the export year is missing and the title names several films. Never accepted |
| `conflict` | `lid_exact` or none | The code equals a stored id whose stored year is more than one year away (`stored_year_disagrees`) or whose stored titles do not include the export name (`stored_title_differs`), or the stored id carries two different TMDB ids |
| `unmatched` | none | No stored id and no stored title fits |

Title normalization is Unicode NFKC, lower case, `ё` as `е`, and every run of non-letters and non-digits as one space. Two stored records with the same TMDB identity are one film, so a watchlist film and its catalog record never make a title ambiguous. A rating difference never decides a status: on a corroborated id match it does not block acceptance (the owner may have re-rated since the generation) but is counted. Only `accepted` records are fit for a later import; `provisional`, `candidate`, `ambiguous` and `conflict` records need the owner's manual review.

## Whether the export code is the stored Letterboxd id

The watchlist parser stores `data-postered-identifier.lid` as the film id, and the films-list parser keys ratings generations by the same `lid`. The export carries `boxd.it` short codes. Whether a code equals the `lid` cannot be decided from code alone; the report's `lidHypothesis` judges it from a snapshot:

| Verdict | Meaning |
| --- | --- |
| `supported` | Some codes equal stored ids, none of those disagree on year or rating, and no export film matched by title alone a stored id that no export code equals |
| `refuted` | No code equals a stored id while titles do match stored ids |
| `mixed` | Both exact id matches and title-only matches to stored ids no code equals, or disagreements |
| `inconclusive` | The snapshot holds no Letterboxd id |

A title match to a stored id that another export code already equals is a second film with a similar title (a remake or namesake); the report counts it as `titleYearOnCodeMatchedLid` and it does not weaken the verdict. `titleYearOnStoredLid` counts only title matches to stored ids no code claims.

Until a snapshot verdict is `supported`, treat `lid_exact` counts as an observation about this one snapshot, not as a general rule.

## Identity from the Letterboxd film page

A film the matcher leaves unresolved can get its identity only from the Letterboxd film page its own export code leads to. [`src/letterboxd-identity.js`](../../../src/letterboxd-identity.js) decides it; it is pure and receives the page evidence, the reconciliation rows and the identities already imported. The page is read with `parseFilm` of [`src/sources.js`](../../../src/sources.js), the parser the Worker's metadata cache uses, so the resolver trusts nothing the Worker does not already trust. The operator command and network policy are in the [reconciliation runbook](../../runbooks/letterboxd-export-reconciliation.md#identity-from-film-pages).

**Queue.** Every `match` row that is not `accepted`, whose code is a valid export code and is not already an imported Letterboxd id (`lid` of a baseline import plan item), in this order: `candidate`, `ambiguous`, `unmatched`, then any other status; by code within a group.

**Evidence of one page.** The shortlink `https://boxd.it/<code>` is followed hop by hop; a hop may only go to `https://boxd.it` or `https://letterboxd.com`, and the last one must be a film page `https://letterboxd.com/film/<slug>/` answering 200. From that page the resolver keeps: the code of `<link rel="shortlink">`, the path of `<link rel="canonical">`, every `data-tmdb-id` and `data-tmdb-type`, the film name and alternative titles from `parseFilm`, and the release year from `og:title` and the JSON-LD `releasedEvent`. It keeps no HTML.

**Decisions.**

| Decision | When |
| --- | --- |
| `accepted` (method `letterboxd_page`) | Every queued film is observed (the run is final) and every check below passes: the shortlink code equals the export code; the canonical path, if present, is the landing path; exactly one TMDB id of type `movie`; the normalized export name equals the page's film name; the export and page years are equal; and no cross-film check fires |
| `provisional` | Every check passes, but some queued film is not observed yet (`queue_incomplete`). It carries no TMDB id and is not fit for an import: a film observed later can still make it a `duplicate_tmdb` conflict or a `same_title_year` review |
| `conflict` | A contradiction: `shortlink_mismatch`, `canonical_mismatch`, `tmdb_multiple` (two TMDB ids on one page), `title_differs`, `year_disagrees` (more than one year apart), `tmdb_already_imported` (the TMDB id belongs to an imported film), `duplicate_tmdb` (two queued codes land on one TMDB id; both are conflicts) |
| `owner_review` | Missing or weak evidence: `shortlink_missing`, `tmdb_missing`, `tmdb_not_movie`, `tmdb_type_missing`, `title_missing`, `title_alias_only` (the export name is only an alternative title), `year_off_by_one`, `page_year_missing`, `page_year_inconsistent`, `export_year_missing`, `ledger_candidate_differs` (the title/year candidate pointed at a stored film with another TMDB id: a remake or namesake), `ledger_ambiguous`, `same_title_year` (another queued export film has the same normalized name and year), and the page outcomes `not_found`, `redirect_off_site`, `not_film_page`, `too_many_redirects`, `unexpected_status`, `unparsable_page` |
| `pending` | Not observed yet (`not_fetched`) or the fetch failed within its retry bound (`fetch_failed`) |

Title normalization is the matcher's. Cross-film checks look at every observed film, so a decision can change while the queue is incomplete. Decisions are final only when the report says `final: true`, that is, no queued film is `pending`; `accepted` exists only then. A run bounded to the priority wave (`candidate` and `ambiguous`) reports that wave as observed in `progress` but decides it provisionally; the later `unmatched` films are still compared with it before anything is accepted. An `accepted` decision is an identity proposal for a later, separately approved import; nothing here writes facts.

## In the Worker

The owner's archive preview (`POST /api/admin/letterboxd-archive/preview`, [admin API](../api/admin.md#letterboxd-archive-preview-post-apiadminletterboxd-archivepreview), [ADR 0066](../../adr/0066-ephemeral-letterboxd-archive-preview.md)) applies this contract to a ZIP the owner uploads, in memory and without storing it:

- **ZIP.** [`src/letterboxd-zip.js`](../../../src/letterboxd-zip.js) uses Node's `Buffer` and `zlib` and stays offline. The Worker uses [`src/domain/letterboxd-archive-zip.js`](../../../src/domain/letterboxd-archive-zip.js), on Web APIs only, with hard limits on size, entries, ratio and rows. For an archive within those limits it returns the same four texts, SHA-256 and export time as the offline reader; tests pin the equivalence.
- **Index.** The matcher's index is built from the published generation's programme, `metadata.json` and the published ratings generation, read as single objects from live R2 instead of from a snapshot. The generation's catalog copy is not read, so the Worker finds fewer `title_year` candidates than an offline run with a snapshot; `lid_exact` and `tmdb_verified` are unaffected.
- **Facts.** For `accepted` films only, the facts an import would write are compared with the stored fact records by the [user facts](letterboxd-user-facts.md) merge rules. Nothing else in this contract changes.

A confirmed apply re-reads the same ZIP on two later requests and writes only through the baseline commit ([ADR 0068](../../adr/0068-letterboxd-archive-confirmed-apply.md)). The preview request still writes nothing. The ZIP is not stored. A row that is only in `ratings.csv` is still a watched and rated fact. The diary is not required.
