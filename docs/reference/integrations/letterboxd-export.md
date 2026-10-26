# Letterboxd account export — parsing and matching contract

The owner can download a Letterboxd account export (a ZIP of CSV files). [`src/letterboxd-export.js`](../../../src/letterboxd-export.js) parses it and [`src/letterboxd-match.js`](../../../src/letterboxd-match.js) matches its rows with films stored in a production R2 snapshot. Both modules are pure: they read no file, storage or network and are not part of the Worker bundle. The operator procedure is the [reconciliation runbook](../../runbooks/letterboxd-export-reconciliation.md). This contract does not import ratings, change the watchlist or write R2; it only describes what an offline comparison may conclude.

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
| `accepted` | `lid_exact` | The export code equals a stored Letterboxd id, and the stored year (if any) is within one year of the export year |
| `accepted` | `tmdb_verified` | As `lid_exact`, and that id carries exactly one stored TMDB id that equals a verified catalog record; the record lists the catalog id `tmdb_<n>` |
| `accepted` | `title_year` | The code is not a stored id; the normalized name equals a stored title, original title or alias of exactly one film whose year is within one year, **and** an independent stored signal agrees: the stored Letterboxd rating equals the export rating (`rating_agrees`), or the film is on both the export watchlist and the stored watchlist (`watchlist_member`) |
| `candidate` | `title_year` | The same single title and year agreement without a second signal, with a missing export year, or with a stored rating that differs. Never accepted |
| `ambiguous` | none | More than one film fits the title within the year window (remakes in adjacent years, shared aliases), or the export year is missing and the title names several films. Never accepted |
| `conflict` | `lid_exact` or none | The code equals a stored id whose stored year is more than one year away, or the stored id carries two different TMDB ids |
| `unmatched` | none | No stored id and no stored title fits |

Title normalization is Unicode NFKC, lower case, `ё` as `е`, and every run of non-letters and non-digits as one space. Two stored records with the same TMDB identity are one film, so a watchlist film and its catalog record never make a title ambiguous. A rating difference on an exact id match does not block it (the owner may have re-rated since the generation) but is counted.

## Whether the export code is the stored Letterboxd id

The watchlist parser stores `data-postered-identifier.lid` as the film id, and the films-list parser keys ratings generations by the same `lid`. The export carries `boxd.it` short codes. Whether a code equals the `lid` cannot be decided from code alone; the report's `lidHypothesis` judges it from a snapshot:

| Verdict | Meaning |
| --- | --- |
| `supported` | Some codes equal stored ids, none of those disagree on year or rating, and no code matched a stored id only by title |
| `refuted` | No code equals a stored id while titles do match stored ids |
| `mixed` | Both exact id matches and title-only matches to stored ids, or disagreements |
| `inconclusive` | The snapshot holds no Letterboxd id |

Until a snapshot verdict is `supported`, treat `lid_exact` counts as an observation about this one snapshot, not as a general rule.
