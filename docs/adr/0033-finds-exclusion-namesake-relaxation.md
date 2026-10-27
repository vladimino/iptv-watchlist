# ADR 0033: The Finds title exclusion keeps a name the owner watched in several distinct years, and ignores an alias-only namesake whose year is at least two years away

**Status:** Accepted 2026-10-27 (owner-approved design decision only; it authorizes no code activation, list build, upload, flag change, R2 or D1 read or write, production read or Letterboxd or TMDB request)  
**Original decision date:** 2026-10-27  
**Recorded at:** 2026-10-27  
**Approval source:** explicit owner acceptance on 2026-10-27, including residual risks B and C, on [AIR-216](https://trello.com/c/hx6QPPZf)  
**Related work:** [AIR-216](https://trello.com/c/hx6QPPZf), [AIR-198 rollout evidence](../evidence/letterboxd/air-198-finds-exclusion-rollout-2026-10-27.md), [AIR-217](https://trello.com/c/oMmKr9FV) (implementation), [AIR-218](https://trello.com/c/lmToHh5p) (follow-up), [ADR-0028](0028-finds-display-only-watched-exclusion.md), [catalog API](../reference/api/catalog.md#display-only-title-exclusion)  
**Supersedes:** [ADR-0028](0028-finds-display-only-watched-exclusion.md) in part, and only for lists tagged `strict_original_exact_year_v2`: the export-namesake clause of decision 2 ("a normalized name that no other film of the same export carries in any year"), the alias part of decision 3.3 (catalog uniqueness) and the synthetic case "Two export films with the same name in different years". Every other part of ADR-0028 stays in force.  
**Superseded by:** None

## Context

[ADR-0028](0028-finds-display-only-watched-exclusion.md) hides a catalog film from Finds when its normalized original title and exact year match a watched or rated Letterboxd export film without an accepted identity. Two guards protect unseen films from a false hide:

- **Export uniqueness (builder).** `scripts/letterboxd-display-exclusion.mjs` drops every name that the export carries more than once, in any list and any year. That includes watchlist-only and identified films.
- **Catalog uniqueness (reader).** `findsTitleSuppressor` in `src/worker.js` refuses a key when any other verified TMDB film of the catalog copy carries it as its original title, localized title or alias, in any year.

The production rollout ([AIR-198 evidence](../evidence/letterboxd/air-198-finds-exclusion-rollout-2026-10-27.md)) hides 478 films, and the owner found no false hide. The owner had watched all five films still shown at the top of Finds:

| Cause | Films | Addressed here |
| --- | --- | --- |
| The owner watched two films with the same name in different years, so the export-namesake guard dropped the name | 2 | Yes, decision 2 |
| An unrelated catalog film carries the title as an alias, so the catalog guard blocked it (for example, a 2026 film with the alias "The Dark Knight" blocks the 2008 film) | 1 | Yes, decision 3 |
| Export year differs from the TMDB year by one | 1 | No: year ±1 stays refused |
| Matched only through an alias, and the year differs by one | 1 | No: alias matches and year ±1 stay refused |

The guards were deliberately broad: "any year" and "any title kind". Some of that breadth does not buy safety. An exact-year match already separates namesakes whose years are far apart, and an alias, unlike an original title, is not what the rule matches on. But two facts limit how far the guards can relax:

- **Years drift.** A Letterboxd year and the TMDB year of the same film can differ. The [AIR-193 evidence](../evidence/letterboxd/air-193-identity-alternatives-2026-10-27.md) found a cluster of ±1-year differences (514 matches with ±1 against 503 exact). Differences of two or more years were not measured.
- **The export name is often not the original title.** For a foreign film, Letterboxd usually shows an English title. In the catalog that title can be the film's localized title or one of its aliases. So an export entry whose name equals an alias of a catalog film may be that very film, not the one that has the name as its original title.

This ADR uses only that public, aggregate evidence. It reads no export, list, snapshot or production data.

## Decision

### 1. A new rule tag selects the relaxed rule; the legacy tag keeps ADR-0028 exactly

- The relaxed builder writes `"rule": "strict_original_exact_year_v2"`. `schemaVersion` (1), `kind` (`letterboxd_display_exclusion`) and `normalization` (`normTitle_v1`) do not change. Every other field, limit and validation of ADR-0028 decision 5 also stays: 2 MiB, 20,000 entries, strictly ascending unique `(title, year)` entries, `contentSha256`, exact keys and the `source` checks.
- The reader accepts exactly two rule tags:
  - `strict_original_exact_year`: ADR-0028 guards, unchanged and bit-for-bit the same result as today.
  - `strict_original_exact_year_v2`: the guards of decisions 2 and 3 below.

  Any other tag, including a future one, makes the list `unavailable`: every film is shown and the route answers `200`.
- The reader relaxation (decision 3) is bound to the list tag, not to a new switch. Deploying the implementation therefore changes nothing while the current legacy list is in R2 and `FINDS_TITLE_EXCLUSION` is `on`. The relaxed behaviour starts only when the owner, under a separate approval, uploads a list built with the new tag. A code rollback below the implementation makes a v2 list `unavailable`, which shows every film (fail-open) and loses the 478 legacy hides until a legacy list is put back.
- `counts` gains one non-negative integer, `keptExportNamesake`: the number of entries whose name the export carries more than once. `droppedExportNamesake` keeps its meaning: watched or rated films without identity dropped because their name failed the namesake rule. The reader already accepts any non-negative integer counts and checks only `counts.entries`, so the extra count needs no reader change.

### 2. Export namesakes (builder, v2 only)

For a normalized key `k`, let `N(k)` be every film of the export whose name normalizes to `k`, in any list (watched, rated, watchlist), with or without an accepted identity. A watched or rated film `f` of `N(k)` without an accepted identity and with an integer year produces the entry `{title: k, year: f.year}` only when all three of the following hold:

1. **Every namesake has a year.** Every film in `N(k)` has an integer year.
2. **Watched namesakes have distinct years.** The watched-or-rated films of `N(k)`, identified or not, have pairwise different years. Two of them in the same year drop the name: an exact year can no longer say which film a catalog record is.
3. **An unseen namesake is at least two years away.** Every film of `N(k)` that is neither watched nor rated (watchlist-only) has a year that differs by **at least 2** from the year of every watched-or-rated film of `N(k)`. A gap of 0 or 1 drops the name, because a one-year drift could make the unseen film's catalog record carry the watched film's year.

If any condition fails, every unidentified watched-or-rated film of `N(k)` is dropped and counted in `droppedExportNamesake`. The decision is per name, not per entry, which keeps it easy to review. When `N(k)` has a single film, the rule is the ADR-0028 rule. Identified films never produce an entry, as before, but they still count as namesakes in conditions 1–3.

### 3. Catalog uniqueness (reader, v2 only)

For a record `R` that already matched an entry by its normalized original title `k` and exact year `y` (ADR-0028 decision 3.1, 3.2), sort every **other** TMDB film `F` of the same catalog copy that carries `k` into one of two kinds. A TMDB film is one `tmdbId` across all its verified records:

- **Title namesake:** some verified record of `F` has `k` as its normalized original title or localized title.
- **Alias-only namesake:** no verified record of `F` has `k` as its original or localized title, but at least one has `k` among its aliases.

`R` passes catalog uniqueness when both hold:

1. **No title namesake.** No other TMDB film is a title namesake of `k`, in any year. This part of ADR-0028 decision 3.3 is unchanged: remakes, earlier versions and localized-title collisions still block.
2. **Every alias-only namesake is far.** Every verified record of every alias-only namesake has an integer `year` with `|year − y| ≥ 2`. An alias-only namesake with any record without a year, or with a year within one of `y`, blocks `R`.

All other conditions of ADR-0028 decision 3 are unchanged:

- verified identity and an integer year;
- original title only and exact year; the localized title and aliases never produce a match, and a year ±1 never matches;
- one entry for one film;
- identity wins.

Decisions 1, 4, 5, 6 and 7 of ADR-0028 also stand: display only, per-request evaluation on the pinned generation, the exact-`on` switch and fail-open, aggregate-only observability, and no Worker writer.

### Why the relaxation adds no false hide beyond the stated residual risk

A false hide needs an unseen catalog record `R` with original key `k` and year `y`, while the list holds `(k, y)` for some other watched film `W`.

- **Under decision 2.** Where can `W`'s unseen namesake `R` be?
  - `R` is in the export as watchlist-only: condition 3 keeps the name only when `R`'s Letterboxd year is at least two years from `y`, so `R`'s catalog year must have drifted by two or more years onto exactly `y` (residual risk B).
  - `R` is a watched namesake: hiding it is correct.
  - `R` is absent from the export: this is the ADR-0028 residual risk A.
  - `W` itself is in the catalog with `k` as its original or localized title: `W` is a title namesake of `R`, and catalog uniqueness blocks as before.
- **Under decision 3.** The only new path is a `W` that is in the catalog, carries `k` only as an alias and, as the real film behind the entry, has Letterboxd year `y` but a catalog year two or more years away (residual risk C). If `W` carries `k` as its original or localized title, it is a title namesake and blocks. If its catalog year is within one of `y`, it blocks. If `W` is absent from the catalog, or carries `k` nowhere, that is residual risk A, which ADR-0028 already accepted.

### Residual risks

| | Risk | Status |
| --- | --- | --- |
| A | A watched film absent from the catalog (or not carrying its export name) shares the name and exact year with an unseen catalog film | Inherited from ADR-0028, unchanged |
| B | A watchlist-only namesake's TMDB year differs from its Letterboxd year by two or more and lands exactly on a watched namesake's year, while that watched namesake is not a title namesake in the catalog | New, needs a ≥2-year drift onto one exact year |
| C | A watched foreign film, known in the catalog only by an alias equal to its export name, has a TMDB year two or more years away from its Letterboxd year, and an unseen film with that original title has exactly the Letterboxd year | New, needs a ≥2-year drift onto one exact year |

The owner accepted B and C with this ADR. The [rollout evidence](../evidence/letterboxd/air-198-finds-exclusion-rollout-2026-10-27.md) and the [AIR-193 evidence](../evidence/letterboxd/air-193-identity-alternatives-2026-10-27.md) report no drift of two or more years, but they did not measure it. Before the upload, the implementation's owner-approved preflight measures B and C privately. It reports only aggregates: the distribution of `|Letterboxd year − TMDB year|` over the accepted identities, the number of films the v2 list adds to the hidden set, and the owner's private review of those added films.

### Counterexamples

"Shown" means the record stays in Finds. Years are Letterboxd years for export films and TMDB years for catalog records. Real titles illustrate public shapes only; they are not the owner's data.

| # | Shape | Export (watched = W, watchlist-only = L) | Catalog | Result under v2 | Why |
| --- | --- | --- | --- | --- | --- |
| 1 | Remake, both watched, both in catalog (*Funny Games* 1997/2007) | W "Funny Games" 1997, W "Funny Games" 2007 | Both, original "Funny Games" | Both shown | Both entries are kept, but each record is a title namesake of the other |
| 2 | Remake, both watched, one in catalog | W "X" 1990, W "X" 2010 | X 2010 only | 2010 hidden (correct) | Distinct years, no other catalog namesake |
| 3 | Same-year namesakes in export | W "X" 2014, W "X" 2014 (two films) | X 2014 | Shown | Condition 2.2 drops the name |
| 4 | Watchlist-only namesake one year away | W "X" 1990, L "X" 1991 | X 1990 (could be either) | Shown | Condition 2.3 drops the name |
| 5 | Watchlist-only remake far away | W "X" 1990, L "X" 2010 | X 1990, X 2010 | Both shown | Name kept, but the 2010 record is a title namesake of the 1990 one |
| 6 | Watchlist-only remake far away, only the watched film in catalog | W "X" 1990, L "X" 2010 | X 1990 | 1990 hidden (correct) | The unseen 2010 film can match only year 2010, which has no entry |
| 7 | Namesake without year | W "X" 1990, L "X" (no year) | X 1990 | Shown | Condition 2.1 drops the name |
| 8 | Identified namesake | W "X" 1990 (identity), W "X" 2010 (no identity) | X 2010 | 2010 hidden (correct) | The entry is 2010 only; 1990 stays with identity |
| 9 | Alias-only, far year (the reported case) | W "The Dark Knight" 2008 | The Dark Knight 2008; unrelated 2026 film with alias "The Dark Knight" | 2008 hidden (correct) | `|2026 − 2008| ≥ 2` |
| 10 | Alias-only, same year: the alias is the watched film's real English title | W "X" 2015, which is the foreign film "Le X" | "Le X" 2015 with alias "X"; unseen "X" 2015 | Shown | Alias-only namesake within one year blocks |
| 11 | Alias-only, one year away | W "X" 2015 (= "Le X") | "Le X" 2016 with alias "X"; unseen "X" 2015 | Shown | Within one year blocks |
| 12 | Alias-only namesake without year | W "X" 2015 | Film with alias "X" and no year; "X" 2015 | Shown | A missing year blocks |
| 13 | Localized-title collision (*Solaris*: Tarkovsky 1972 "Солярис", Soderbergh 2002 "Solaris", localized "Солярис") | W "Solaris" 2002 | Soderbergh: original "Solaris" 2002; Tarkovsky carries "Solaris" only as an alias, 1972 | 2002 hidden (correct) | Tarkovsky is alias-only for `solaris` and 30 years away; the localized "Солярис" collision concerns key `солярис`, which no entry has |
| 14 | Localized title equals the key | W "X" 2015 | "X" 2015; another film whose localized title is "X", any year | Shown | A localized title is a title namesake |
| 15 | Export namesakes, one foreign (*Oldboy* 2003 Korean original, 2013 remake) | W "Oldboy" 2003, W "Oldboy" 2013 | Remake "Oldboy" 2013; Korean film 2003 with alias "Oldboy" | 2013 hidden (correct); the 2003 film shown (no original-title match) | Distinct years; the Korean film is alias-only and 10 years away |
| 16 | Residual C | W "X" 2015, whose TMDB year is 2018 and which carries "X" only as an alias | That film 2018 with alias "X"; unseen "X" 2015 | Unseen "X" 2015 **hidden** | Accepted residual risk C |
| 17 | Residual B | W "X" 1990 (not in catalog), L "X" 1992 whose TMDB year is 1990 | Unseen "X" 1990 | **Hidden** | Accepted residual risk B |
| 18 | Year ±1 | W "X" 2008 | "X" 2009 | Shown | Exact year only, unchanged |

### Synthetic cases the implementation must pass

Builder (`strict_original_exact_year_v2`):

| Case | Expected |
| --- | --- |
| Single watched film, unique name | Entry, as in ADR-0028 |
| Two watched, unidentified films with the same name in years 1990 and 2010 | Two entries; `keptExportNamesake` 2 |
| Two watched films with the same name in the same year | Both dropped; `droppedExportNamesake` 2 |
| Watched 1990 and watchlist-only 1991 (and 1989) | Dropped |
| Watched 1990 and watchlist-only 1992 | Entry 1990 kept |
| Watched 1990 and a namesake without a year (watched or watchlist-only) | Dropped |
| Identified watched 1990 and unidentified watched 2010 | One entry, 2010 |
| Identified watched 2010 and unidentified watched 2010 | Dropped |
| Three watched namesakes 1980, 1990, 1990 | All dropped |
| Output | `rule` is `strict_original_exact_year_v2`; entries strictly ascending by title, then year; `counts.entries` equals the entries; no codes, ratings or dates |

Reader:

| Case | Expected |
| --- | --- |
| Legacy-tag list with the same catalog and switch | Exactly the ADR-0028 result, including an alias-only namesake blocking at any year |
| v2 list, alias-only namesake 2 or more years away | Hidden |
| v2 list, alias-only namesake 0 or 1 year away, or without a year | Shown |
| v2 list, alias-only namesake with two records, one far and one within a year | Shown |
| v2 list, another TMDB film with the key as its original title, any year | Shown |
| v2 list, another TMDB film with the key as its localized title, any year | Shown |
| v2 list, another film carries the key as an alias on one record and as its localized title on another | Shown (title namesake) |
| v2 list, two entries of one name in different years, two catalog records each matching one | Both shown (each is a title namesake of the other) |
| v2 list, two entries of one name, one catalog record matching one | Hidden |
| v2 list, match through an alias or the localized title of `R` itself, or year ±1 | Shown |
| v2 list, `R` has a trusted Letterboxd id | Title rule not applied; identity decides |
| Unknown `rule` tag (for example `strict_original_exact_year_v3`) or unknown `normalization` | `unavailable`, every film shown, `200` |
| v2 list with an extra `counts.keptExportNamesake` | Accepted; a wrong `counts.entries` is still `unavailable` |
| Any state | Response and logs carry no title, code, id or list hash |

## Alternatives considered

- **Keep ADR-0028 unchanged.** It is the safest option, but it leaves in Finds the three reported watched films that this ADR addresses. The owner can still mark single films by hand through the separate manual mark ([AIR-213](https://trello.com/c/VbE31Rzj)), which this ADR neither depends on nor changes.
- **Keep a watched namesake whenever its years differ, and ignore watchlist-only namesakes.** Rejected: a one-year drift lets an unseen watchlist film hide (counterexample 4).
- **Drop a name with any watchlist-only namesake, whatever its year.** Safer, but it refuses counterexamples 5 and 6, where the unseen film cannot match. The two-year gap keeps the same protection against the measured one-year drift. Kept as the fallback if the owner rejects residual risk B.
- **Ignore every alias-only namesake, whatever its year.** Rejected: an export name is often the English title of a foreign film that the catalog stores as an alias, so the alias carrier may be the very film watched (counterexamples 10 and 11).
- **Ignore localized-title namesakes as well.** Rejected: the card requires them to keep blocking. A localized title is the film's own displayed name, and collisions through it are no weaker than through the original title.
- **Allow title namesakes when every catalog namesake has its own exact-year entry.** This would also fix counterexample 1. It extends the risk to every remake pair with adjacent years and replaces a guard the owner chose deliberately. Not decided here; it needs its own ADR and measured drift data.
- **A new switch instead of a new rule tag.** It would need a second flag decision and could activate the reader relaxation over a legacy list that was not built for it. Binding the relaxation to the list tag makes one owner-approved upload the single activation point. Rejected.
- **A new `schemaVersion`.** The JSON shape does not change; only the semantics of the entries and of the reader guard do, which is what `rule` names. Rejected.

## Consequences

- Watched films with namesakes in distant years, and films blocked only by a distant alias, can leave Finds. Remakes that are both in the catalog, same-year namesakes, localized-title collisions and every ±1-year case stay shown.
- Two new residual false-hide paths (B and C), each needing a drift of two or more years onto one exact year. They are invisible on the page, like ADR-0028's risk A; the aggregate count, the private preflight review and the switch are the controls.
- The reader carries two guard variants until the legacy tag is retired by a later decision. Tests must pin the legacy behaviour.
- The builder needs the full namesake set, including watchlist-only and identified films, with their years. It already parses all three lists.
- Rollback options grow: switch off, delete the object, or put back the preserved legacy list. Deleting or replacing the R2 object is still an owner-approved operation.

## Recovery and migration boundary

Fully reversible. Before the v2 list is uploaded, the deployed implementation behaves exactly as ADR-0028. After the upload:

- setting `FINDS_TITLE_EXCLUSION` to anything other than `on` shows every film;
- putting back the preserved legacy list restores the ADR-0028 behaviour;
- reverting the code makes a v2 list `unavailable`, which shows every film.

Nothing else is written.

This ADR authorizes none of the following, each of which needs its own owner approval: the implementation merge, building a v2 list from the real export, the preflight's production or snapshot reads, uploading or replacing the object, and any switch change.

## Evidence

- **Original decision:** owner request on [AIR-216](https://trello.com/c/hx6QPPZf), 2026-10-27, after the [AIR-198](https://trello.com/c/9xpmq2fc) visual acceptance.
- **Implementation:** none yet; [AIR-217](https://trello.com/c/oMmKr9FV) after acceptance.
- **Dated verification:** the [AIR-198 rollout evidence](../evidence/letterboxd/air-198-finds-exclusion-rollout-2026-10-27.md) gives the causes of the five remaining false Finds (aggregate, 2026-10-27). This ADR measures nothing new.
- **Uncertainty:**
  - How many of the two export-namesake films this fixes depends on whether their namesakes are title namesakes in the catalog, or watchlist-only within a year (counterexamples 1 and 4); it is not known publicly.
  - The rate of year drifts of two or more years is not measured.
  - Whether catalog aliases mostly hold distributor English titles is not measured.

## Follow-ups

- [AIR-217](https://trello.com/c/oMmKr9FV): builder and reader under the new rule tag, legacy-tag compatibility, the synthetic cases above, the [catalog API](../reference/api/catalog.md#display-only-title-exclusion) contract, the [runbook](../runbooks/finds-display-exclusion.md) (including keeping the legacy list for rollback) and the [Letterboxd ingestion diagram](../architecture/letterboxd-ingestion.md) if its wording changes.
- A separately approved build, preflight with the drift aggregates above, upload and acceptance, in the rollout card that follows the implementation.
- Year ±1 and alias-only matching stay refused; changing either needs a new ADR.
