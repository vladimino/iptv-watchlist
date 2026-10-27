# Letterboxd identity alternatives and display-only watched exclusion

**Captured:** 2026-10-27, offline on the owner's machine; analysis script kept privately next to its output, run with `normTitle` from `src/letterboxd-match.js` at `main` `8bedc50`  
**Inputs:** the private ledger of the [AIR-169 reconciliation](air-169-reconciliation-2026-10-26.md) (`matches.jsonl`), the committed AIR-173 baseline plan (420 films), the [AIR-175 production R2 snapshot](../d1-migration/air-175-r2-snapshot-identity-2026-10-26.md) (`consistent_fenced`; published generation catalog of 1,924 verified films and `enrichment/view-index.json`)  
**Scope:** offline only; no Letterboxd, TMDB, Wikidata or other data request, no R2 or D1 access, no Worker route, no import. One public web search about the Wikidata property format  
**Verdict:** no offline source proves a Letterboxd code ↔ TMDB identity for any of the 2,040 unresolved films. A **display-only** exclusion in Finds, kept apart from identity, could cover 503 of the 560 catalog candidates under a strict rule (514 under a relaxed one), including 4 of the 5 films the owner reported as false Finds. It needs an ADR and owner acceptance before any implementation  
**Used by:** [AIR-193](https://trello.com/c/DqBF3HLy); context: [AIR-185](https://trello.com/c/PKvrDGKZ) stopped on a Letterboxd challenge after 2 requests

Aggregates only. Per-film rows stay in a private directory outside the repository; no title, code, URI, rating or TMDB id of the owner's films appears here.

## Two separate problems

| | (A) Identity | (B) Watched exclusion in Finds |
| --- | --- | --- |
| Needed for | Storing facts by TMDB ([ADR-0023](../../adr/0023-letterboxd-user-facts.md)), ratings, imports | Not showing films the owner has seen |
| Error cost | A false link is persisted, projected under every alias and feeds predictions | A false exclusion hides one film from Finds; a miss shows a seen film |
| Acceptable evidence | Independent proof that a code is that TMDB film | A conservative, reversible match judged only at read time |
| Status | No offline proof; film-page lookup blocked by the challenge | Measured below; not implemented |

Title and year never become identity. Option (B) must not write a Letterboxd ↔ TMDB link, fact or rating.

## The 560 catalog candidates

Of the 561 `candidate` films, 560 match a record of the published catalog (the other is a watchlist/metadata film). All 560 are rated.

| Measure | Count |
| --- | --- |
| Export name equals the catalog original title (normalized) | 540 |
| Export name matches only an alias | 20 |
| Year equal | 544 |
| Year differs by one | 16 |
| Another export film has the same normalized name (any year) | 15 |
| The catalog has another TMDB film with the same normalized title (any year) | 15 |
| Two export codes point at the same catalog TMDB id | 2 |
| Candidate TMDB id equals one of the 420 imported films | 0 (the one such collision is the non-catalog candidate) |
| Catalog record carries directors | 560 (the export carries none, so directors cannot corroborate) |
| Strong Finds forecast in the snapshot (rating ≥ 4, P(4.0+) ≥ 0.7, confidence not low) | 165 |

The catalog holds only verified TMDB movies, so a TV item cannot be a catalog candidate; the export does not say whether an entry is a film or a series.

### Display-only exclusion rules

Common guards for both rules: no other export film with the same normalized name, no other catalog film with the same normalized title in any year, no TMDB id claimed by two codes, no TMDB id of the 420 imported films, match on the catalog original title (not a localized title or an alias only).

| Rule | Year | Covered | Of them strong Finds | Not covered | Strong Finds not covered |
| --- | --- | --- | --- | --- | --- |
| Strict | equal | 503 | 145 | 57 | 20 |
| Relaxed | ±1 | 514 | 148 | 46 | 17 |

Owner-reported false Finds: 4 of 5 are covered by both rules (exact original title, equal year, no namesake, no remake). The fifth is matched only through an alias with a one-year difference, so neither rule covers it; this is the expected limit of a conservative rule.

**Residual risk.** A covered film is still unproven: a same-title film absent from the catalog (for example a short or a TV film with the same name and year) would be hidden by mistake. The guards measure uniqueness only inside the export and the current catalog. The rule must be re-evaluated per catalog generation, be marked with its own provenance, and be switchable off.

## The 1,478 unmatched films

| Measure | Count |
| --- | --- |
| Unmatched | 1,478 (1,474 rated, 4 watched without a rating) |
| Name present in the catalog at any year | 29 |
| Missing year | 0 |

They do not affect the current Finds. The same display rule would apply automatically when a matching film enters a later catalog generation; identity for them still needs (A).

## Alternatives for identity

| Source | What it links | Fit for (A) | Limits |
| --- | --- | --- | --- |
| Letterboxd film page from `boxd.it/<code>` ([resolver](../../runbooks/letterboxd-export-reconciliation.md#identity-from-film-pages)) | code → page → `data-tmdb-id` | Yes, independent | Blocked by a Cloudflare challenge after 2 requests; bypass is not allowed |
| Official Letterboxd API | account data with ids | Yes | Not open to personal or recommendation applications ([access policy](https://letterboxd.com/api-beta/access/)) |
| Wikidata P6127 (Letterboxd film ID) + P4947 (TMDB movie ID) | Letterboxd slug ↔ TMDB | No | Values are film slugs, not `boxd.it` codes; joining a code to a slug still needs Letterboxd or the title. Coverage is partial. Needs a separately approved network or dump download |
| Letterboxd export | code, name, year | No | No slug, no TMDB id, no director |
| Snapshot: watchlist, programme, metadata | lid ↔ TMDB | Already used | Only the 420 films that were ever on the watchlist |
| Snapshot: films-list ratings generation | lid ↔ rating | No | Absent from this snapshot; carries no TMDB id |
| Owner's manual confirmation | any | Yes | Declined at this scale |

Wikidata could add a second signal for (B) — a TMDB film whose Letterboxd slug equals the slug form of the export name and year — but it is still title-derived and does not prove the code.

## Synthetic cases a display rule must pass

| Case | Expected |
| --- | --- |
| Same name, same year, unique in export and catalog | Excluded (display-only) |
| Same name, a remake in another year in the catalog | Not excluded |
| Same name, year ±1, otherwise unique | Strict: not excluded; relaxed: excluded |
| Match through an alias only | Not excluded |
| Two export films with the same name in different years | Neither excluded |
| Two codes pointing at one TMDB id | Not excluded |
| TMDB id of a film already imported under another code | Not excluded |
| Film absent from the catalog | Nothing to exclude; no record created |
| Missing export year | Not excluded |
| Match through a localized catalog title only | Not excluded (no match on the original title) |

## Proposed next steps (each separately approved)

1. **ADR: display-only watched exclusion.** Decide the rule (strict vs relaxed), provenance, switch, and that it never writes identity, facts or ratings; update the [catalog API contract](../../reference/api/catalog.md) and the Finds read path diagram.
2. **Implementation with synthetic tests** of the cases above, behind an off-by-default flag; the matching input is a private, owner-supplied derived list, not the raw export.
3. **Owner acceptance** on real data: before/after counts and the five known films; flag change is a separate approval.
4. **Identity (A)** stays open: retry the film-page resolver only if Letterboxd stops challenging ordinary requests, or with another independent source the owner approves.

No production operation was performed.
