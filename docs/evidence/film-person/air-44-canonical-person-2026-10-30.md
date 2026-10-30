# Canonical Person contract on production D1 (AIR-44)

**Captured:** 2026-10-30, 23:06 UTC, in the agent container (Node 22.22), on branch `claude/air-44-canonical-person` from `main` `1b1a4d3`.  
**Input:** read-only SELECT statements against production D1 `iptv` (`3fba0e0a…`, schema v4) through the D1 HTTP API:
- `person`;
- the `kind: name` rows of `person_alias`;
- the localization rows of `person_dimension`;
- `film_person_credit`;
- the `tmdb`/`tmdb_tv` rows of `film_external_id`;
- `film`.

Nothing was written. The rows were mapped in memory to the contract's input and passed to `canonicalPersons` with no owner decisions (none are stored).  
**Card:** [AIR-44](https://trello.com/c/ojtZjVc9); decision [ADR 0058](../../adr/0058-canonical-person-grouping.md) (Proposed).  
**Verdict:** the contract reproduces the existing coCredit review queue and joins 70 further humans through name folding. It finds no ambiguous or conflicting evidence. This is a read model only; nothing is persisted.

Aggregates only. Person ids, names and Film ids stay private.

## Input

| Measure | Value |
| --- | --- |
| Person records | 19,189 |
| Name aliases | 19,191 |
| Localizations | 17,446 |
| Credits | 30,676 |
| Films, of them verified (one trusted, non-conflicting TMDB identity) | 2,420, 2,420 |

## Result

| Measure | Value |
| --- | --- |
| Canonical humans | 16,184 |
| Humans joined from more than one record | 2,933 (2,877 of 2 records, 40 of 3, 16 of 4) |
| `same_key` links (one key under both roles) | 169 |
| `co_credit` links (Letterboxd ↔ TMDB) | 2,836 |
| `owner` links | 0 (no decisions stored) |
| Humans holding two keys of one source | 0 |
| Candidates `ambiguous_co_credit`, `conflicting_keys`, `owner_different` | 0, 0, 0 |
| Candidates `name_only` (a shared name, no shared verified Film) | 105 |
| Candidates `same_name` (namesakes within one source) | 36 |
| Preferred name: reviewed, provisional, missing | 865, 2,544, 12,775 |
| Name conflicts between members | 0 |
| Issues | 0 |
| Time for the whole model in Node | 3.3 s |

## Comparison with the review queue

The SQL of `GET /api/d1/persons/review` was run in the same session.

- **The queue.** It holds 2,782 coCredit pairs: one Letterboxd record and one TMDB record per role, names compared with SQLite `lower()`.
- **Coverage.** All 2,782 pairs fall inside one canonical human each. They make up 2,766 humans: some humans hold a pair in each role.
- **Folding only.** 70 more humans are joined through name folding alone:
  - Cyrillic case, as in «МакГилл» and «Макгилл»;
  - `ё` read as `е`, as in «Мёрфи» and «Мерфи»;
  - punctuation and Latin diacritics.

  A sample of these was checked by hand. Every one was the same person under two spellings of one name.

## Limits

- No owner decisions exist yet, so the owner paths (`same`, `different`, role links) are verified on synthetic fixtures in `tests/canonical-person.mjs` only.
- The 70 humans joined only through folding were checked by sample, not one by one.
- The two watchlist Films added after AIR-286 have no TMDB credits in D1 and give no evidence.
