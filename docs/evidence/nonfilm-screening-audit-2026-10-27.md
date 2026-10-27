# EPG non-film screening audit against the production snapshot

**Captured:** 2026-10-27, offline on the owner's machine; `scripts/air-94-screening-audit.mjs` with the rule of this delivery and a frozen copy of the previous rule  
**Input:** the [AIR-175 production R2 snapshot](d1-migration/air-175-r2-snapshot-identity-2026-10-26.md), `consistent_fenced` (7,994 objects, aggregate `f71eee10…`, `manifest.json` SHA-256 `c26e0453…`, `finishedAt` 2026-10-26T22:19:31.757Z), read only; its published generation's discovery ledger, resolution decisions, catalogue and programme  
**Scope:** offline only; no network, no Worker route, no TMDB request, no R2 or D1 write, no backfill  
**Verdict:** the previous rule wrongly screened real feature films (the card's `Star Wars: Episode N` family among them) and let numbered episode codes reach TMDB; the new rule screens no known Film title and removes those leaks. Potential effect only; no production run was measured  
**Used by:** [AIR-94](https://trello.com/c/bWYwLgqo)

Aggregates only. Title lists stay in a private directory outside the repository; no snapshot key, generation id or programme title from the snapshot appears here. Contract: [EPG non-film screening](../reference/domain/nonfilm-screening.md).

## Data gaps

- **No raw EPG feed.** The snapshot holds no XMLTV file. Programmes that `scanEPG` screened never entered the ledger, so the titles behind `filteredNonMovies` (2,965 in this generation) cannot be audited, and the XMLTV `episode-num`/`category` usage of the provider is unknown.
- **The ledger is not the raw feed.** Every number below is per discovery candidate (one normalized title and year), not per airing. Up to eight raw title spellings per candidate are kept; the episode-code frequency is measured on those.
- **Control set.** Known Films are the published programme's watchlist films and the verified catalogue: 27,241 distinct titles and aliases. A film absent from both cannot be recognised as a false positive.

## Control set: known Film titles screened

| Reason code | Previous rule | New rule |
| --- | --- | --- |
| `episode_label` | 3 | 0 |
| `season_episode_suffix` | 2 | 0 |
| `show_label` | 1 | 0 |
| **Total** | **6** | **0** |

The previous six are a `Season N` sequel title, a `Show …` documentary title, date-like titles of one film and an alias carrying `Ep N`.

## Discovery ledger: old rule vs new rule

51,643 candidates, 17,890 current at the snapshot time.

| Reason code | Previous rule | New rule | False positives prevented | Additional non-films screened |
| --- | --- | --- | --- | --- |
| `episode_label` | 2,565 | 2,712 | 18 | 165 |
| `season_episode_suffix` | 529 | 526 | 3 | 0 |
| `series_label` | 1,627 | 1,627 | 0 | 0 |
| `broadcast_episode` | 4 | 4 | 0 | 0 |

Manual review of the 21 prevented rows (private list): 14 are feature films (13 spellings of the Star Wars `Эпизод N` family and one date-titled film), 2 are parts of a documentary film, and 5 are serialized programmes the new rule now lets through (a season written in parentheses without an episode, a date-like miniseries code, a numbered vlog and a mid-title `Ep N`). These 5 are accepted false negatives: each costs bounded TMDB lookups, never a lost film.

All 165 additional rows carry an episode code of the form `s01ep04`, which the previous `\bs\d{1,2}e\d{1,3}\b` missed.

## Stored `excluded_nonfilm` decisions

| Measure | Count |
| --- | --- |
| Stored `excluded_nonfilm` | 4,769 (`episode_label` 2,581, `series_label` 1,627, `season_episode_suffix` 557, `broadcast_episode` 4) |
| Not reproduced by the new rule (re-checkable) | 65 (`episode_label` 34, `season_episode_suffix` 31) |
| …of which current now | 5 |

The 65 include all 13 Star Wars rows and multi-part films aired as `N-серия`, which an earlier rule had stored. 60 of them are not current and stay untouched until they air again. The 5 current ones are episodes of one series in a `N|M` form; they would cost at most 5 bounded lookups before the normal retry and terminal limits apply.

## Episode codes (`S01E01` family)

| Measure | Count |
| --- | --- |
| Raw title spellings in the ledger | 68,432 |
| Raw spellings with an episode code | 190 |
| Candidates with an episode code | 190 |
| …current and actionable under the previous rule (leaks) | 147 |
| …current and actionable under the new rule | 0 |

The aggregate `filteredNonMovies`/`rejectedNonfilm` counters cover every reason code and are not this frequency.

## Potential savings and trade-off

- **Potential savings:** 147 current candidates that the previous rule left actionable would no longer be searched; each would have used at least one TMDB Movies search, and an unresolved one retries up to the attempt limit. This is a potential figure, not an observed call count; no traces were used.
- **Potential new cost:** 5 current stale exclusions become actionable once, plus future airings of ambiguous forms that the previous rule screened (`Episode N`, `Season N`, `Эпизод N`, `N-серия`).
- **Trade-off:** the screen now prefers a false negative (an episode searched and left unresolved by the existing gate) to a false positive (a feature film silently never searched). Russian `N серия`/`серия N` remains screened, as before, because unscreening it would send several hundred numbered episodes per generation to TMDB for no recovery; a watchlist or catalogue match still outranks it during the EPG scan.

## Reproduce

```bash
node scripts/air-94-screening-audit.mjs ~/iptv-snapshots/iptv-2026-10-26 --private-out ~/iptv-private/air-94
```

The private directory must be outside the repository; the script refuses a path inside it.
