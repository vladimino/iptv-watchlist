# Finds display-only title exclusion (owner approval required)

The Finds section can hide watched Letterboxd export films that have no accepted identity, by a strict original-title and exact-year match ([ADR-0028](../adr/0028-finds-display-only-watched-exclusion.md)). The rule, the list format and its validation are in the [catalog API](../reference/api/catalog.md#display-only-title-exclusion). This page is the procedure. A merge or a deploy authorizes none of it: building the list from the real export, every production read for the preflight, placing or deleting the R2 object, and setting `FINDS_TITLE_EXCLUSION` each need their own owner approval.

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
   Standard output gives `counts`: `exportFilms` (watched or rated), `withIdentity`, `droppedNoYear`, `droppedNoName`, `droppedExportNamesake` and `entries`. Compare them with the [AIR-193 evidence](../evidence/letterboxd/air-193-identity-alternatives-2026-10-27.md) before going on.
3. **Preflight (owner approval for each production read).** On a fresh verified snapshot or an approved read-only check, measure on the current generation:
   - how many visible Finds the list would hide;
   - aggregate collisions;
   - the owner's known examples.
   Per-film samples stay private.
4. **Place the list (owner approval).** Upload the file unchanged as `letterboxd/display-exclusion.json` in the production bucket, out of band with the owner's credentials, for example `wrangler r2 object put iptv/letterboxd/display-exclusion.json --file <file> --content-type application/json --remote`. No Worker route or MCP tool does this.
5. **Switch on (owner approval).** Set `FINDS_TITLE_EXCLUSION=on` and record the observation in the [flag register](../reference/feature-flags.md). Then confirm `displayExclusion.state` is `applied` and check the `excluded` count in a read of `GET /api/catalog/available`. `unavailable` means the object is missing or invalid, and nothing is hidden.
6. **Accept.** The owner checks Finds visually on real data.

## Replace, disable, roll back

- **Replace:** build a new list after every export or identity import (a newer plan), then upload it over the old object. The object is replaced as a whole; a reader sees either the old or the new list.
- **Disable at once:** set `FINDS_TITLE_EXCLUSION` to anything other than `on`. The next request shows every film, and the object is no longer read.
- **Remove the input:** delete `letterboxd/display-exclusion.json`. With the switch still on, the state becomes `unavailable` and nothing is hidden.
- **Code rollback:** reverting the code removes the rule. No other data was written, so nothing needs restoring.

Stop and switch off on any of these:
- a film the owner has not seen is hidden;
- an `excluded` count far from the preflight;
- `unavailable` after a placement;
- a list built from a plan older than the latest identity import.
