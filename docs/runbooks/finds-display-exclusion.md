# Finds display-only title exclusion (owner approval required)

The Finds section can hide watched Letterboxd export films that have no accepted identity, by a strict original-title and exact-year match ([ADR-0028](../adr/0028-finds-display-only-watched-exclusion.md), with the namesake guards of [ADR-0033](../adr/0033-finds-exclusion-namesake-relaxation.md) for lists tagged `strict_original_exact_year_v2`). The rule, the list format and its validation are in the [catalog API](../reference/api/catalog.md#display-only-title-exclusion). This page is the procedure. A merge or a deploy authorizes none of it: building the list from the real export, every production read for the preflight, placing or deleting the R2 object, and setting `FINDS_TITLE_EXCLUSION` each need their own owner approval.

## What the tools never do

- The builder sends nothing. It reads the export ZIP, the baseline plan directory and the snapshot locally, and writes one private file outside the repository.
- No film name, code, URI or rating reaches standard output, a commit, a PR, a card or a log. Names exist only in the private list file and in R2.
- The Worker only reads the list. It writes no list, fact, rating, link, view-index entry or prediction for it.
- The route response carries only `displayExclusion.state` and the `excluded` count, never a title, id or hash.

## Inputs

| Input | Rule |
| --- | --- |
| `--zip` | The export archive the baseline plan was made from; the plan's `origin.json` must accept it unchanged |
| `--plan` | The directory of the newest verified [baseline import](letterboxd-baseline-import.md) plan for that archive. Its accepted films are the identities the list leaves out, and its `planSha256` becomes `source.baselinePlanSha256` |
| `--snapshot` | The verified snapshot the plan was made from. The builder re-derives the accepted films from it and refuses if they differ from `plan.jsonl` in any way, so a wrong or empty snapshot cannot put identified films back into the list |
| `--output` | A new private absolute file outside the repository; written once with mode `600` |

## Procedure

1. **Rehearse.** `node tests/finds-title-exclusion.mjs` runs the builder against an invented export, plan and snapshot, and the read path against every case of the ADR, with an in-memory bucket.
2. **Build (offline; owner approval to use the real export).** Run:
   ```bash
   node scripts/letterboxd-display-exclusion.mjs build --zip <zip> --plan <plan dir> --snapshot <snapshot> --output <file>
   ```
   Standard output gives `counts`: `exportFilms` (watched or rated), `withIdentity`, `droppedNoYear`, `droppedNoName`, `droppedExportNamesake`, `keptExportNamesake` and `entries`. Compare them with the [identity alternatives evidence](../evidence/letterboxd/air-193-identity-alternatives-2026-10-27.md) and with the list currently in R2 before going on. The builder always writes the `strict_original_exact_year_v2` tag.
3. **Preflight (owner approval for each production read).** On a fresh verified snapshot or an approved read-only check, measure on the current generation:
   - how many visible Finds the list would hide;
   - aggregate collisions;
   - the owner's known examples;
   - when the new list replaces one with the legacy `strict_original_exact_year` tag, the films the new list hides that the old one did not, for the owner's private review, and the distribution of `|Letterboxd year − TMDB year|` over the accepted identities (the year-drift risks B and C of ADR-0033).
   Per-film samples stay private.
4. **Place the list (owner approval).** Upload the file unchanged as `letterboxd/display-exclusion.json` in the production bucket, out of band with the owner's credentials, for example `wrangler r2 object put iptv/letterboxd/display-exclusion.json --file <file> --content-type application/json --remote`. No Worker route or MCP tool does this.
5. **Confirm.** The rule runs as soon as the object is in place; there is no switch ([ADR 0041](../adr/0041-retire-finds-title-exclusion-switch.md)). Confirm `displayExclusion.state` is `applied` and check the `excluded` count in a read of `GET /api/catalog/available`. `unavailable` means the object is missing or invalid, and nothing is hidden.
6. **Accept.** The owner checks Finds visually on real data.

## Replace, disable, roll back

A deploy of a Worker that reads both tags changes nothing on its own: the list in R2 keeps its tag, and a legacy list is read with the legacy guard. The relaxed guard starts only when a list with the `strict_original_exact_year_v2` tag is placed. Before that upload, keep the private copy of the list it replaces, outside the repository with mode `600`.

- **Replace:** build a new list after every export or identity import (a newer plan), then upload it over the old object. The object is replaced as a whole; a reader sees either the old or the new list.
- **Disable at once:** delete `letterboxd/display-exclusion.json` (owner approval, out of band, after keeping a private copy). The next request reports `unavailable` and shows every film. The former `FINDS_TITLE_EXCLUSION` variable no longer disables anything.
- **Back to the legacy guard:** upload the kept legacy list over the object. The next request reads it with the legacy guard.
- **Code rollback:** reverting the retirement brings the `FINDS_TITLE_EXCLUSION` switch back, and the leftover binding `on` keeps the rule running; reverting further removes the rule. A Worker that knows only the legacy tag treats a `strict_original_exact_year_v2` list as `unavailable` and hides nothing until a legacy list is placed again. No other data was written, so nothing needs restoring.

Stop and disable (remove the list object, above) on any of these:
- a film the owner has not seen is hidden;
- an `excluded` count far from the preflight;
- `unavailable` after a placement;
- a list built from a plan older than the latest identity import.
