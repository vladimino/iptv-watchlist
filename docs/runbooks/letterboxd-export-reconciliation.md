# Letterboxd export reconciliation (offline, private data)

`scripts/letterboxd-reconcile.mjs` compares the owner's Letterboxd account export with the films stored in production. It is offline: it reads the extracted CSV files and, optionally, a local R2 snapshot, and writes an aggregate report plus a private row file. The parsing and matching rules are the [export contract](../reference/integrations/letterboxd-export.md).

A complete reconciliation needs a production R2 snapshot made by the [read-only snapshot export](r2-snapshot-export.md). Taking that snapshot is a separately approved operation; this page does not grant it. Without a snapshot the command still parses the export and reports set counts, with matching marked `blocked: snapshot_missing`.

## What the command never does

- No network request, no R2 or D1 access, no Worker route, no Letterboxd fetch.
- It opens only `watched.csv`, `ratings.csv`, `watchlist.csv` and `diary.csv` in the export directory, and only the keys listed in the contract inside the snapshot.
- It writes only `report.json` and `matches.jsonl` in the output directory. The export, snapshot and output directories must be absolute paths outside the Git repository (a symlink into the repository is refused too).
- It never prints a film name, URI, code or rating. Standard output carries set counts, status counts and the hypothesis verdict.
- It imports nothing: no rating, watched mark or watchlist change is written anywhere.

## Inputs and outputs

| Path | Content | Privacy |
| --- | --- | --- |
| `--export <dir>` | The extracted Letterboxd ZIP | Private personal data; keep outside the repository |
| `--snapshot <dir>` | Output directory of `r2-snapshot-export.mjs`. The manifest must be a production export with status `consistent_fenced`, no NO-GO reasons, `fence.ok` and no changes; each object read must match its manifest size and SHA-256 | Private production data |
| `--output <dir>/report.json` | Aggregate counts only: per file (records, valid, invalid by reason, duplicates, conflicts), per set, per status and accepted method, per set and status, reasons, index sizes, missing snapshot keys, the `lidHypothesis` verdict | Contains no names, codes, URIs or ratings. Still review before quoting it anywhere |
| `--output <dir>/matches.jsonl` | One `invalid_row` line per rejected row (file, record number, reason) and, with a snapshot, one `match` line per film with name, code, rating, sets, status, method, stored ids and evidence | **Private.** Never commit, attach, paste into Trello or GitHub, or log |

Exit codes: `0` report written (including `blocked: snapshot_missing`); `1` malformed CSV or another read failure, nothing written; `2` usage error, a path inside the repository, a relative path or a missing `watched.csv`; `3` the snapshot is not a fenced consistent production cut or an object fails its checksum. The same inputs always produce byte-identical `report.json` and `matches.jsonl`.

## Procedure

1. **Rehearse.** `node tests/letterboxd-reconcile.mjs` runs parser, matcher and command against invented data, including refusal of an output inside the repository and of a NO-GO snapshot.
2. **Extract the export** into a private directory outside the repository, for example `/absolute/private/letterboxd-export`. Do not copy any of its files into the repository.
3. **Parse only.** `node scripts/letterboxd-reconcile.mjs --export /absolute/private/letterboxd-export --output /absolute/private/letterboxd-report`. Check that the set counts match what Letterboxd shows (watched, rated, watchlist) and that `invalidRows` is zero or explained by `matches.jsonl`.
4. **With an approved snapshot.** After an owner-approved [snapshot export](r2-snapshot-export.md) has produced and verified a `consistent_fenced` directory: `node scripts/letterboxd-reconcile.mjs --export … --snapshot /absolute/private/snapshot --output /absolute/private/letterboxd-report`.
5. **Read the result.** Start with `matching.lidHypothesis.verdict`. `supported` means the export codes are the stored Letterboxd ids for this snapshot and `lid_exact`/`tmdb_verified` counts are trustworthy identity links. `refuted` or `mixed` means identity must not be derived from codes at all. Title and year never accept a film; `provisional`/`candidate`/`ambiguous`/`conflict` rows need manual review in the private file. `missingKeys` lists snapshot objects that were absent and therefore contributed nothing.
6. **Record findings.** Only aggregate counts may go to a Trello card or an [evidence](../evidence/README.md) page. Any import, rating write or watchlist change based on the result is a separate, separately approved task.

## Rollback

The command changes nothing outside its output directory; deleting that directory removes the result. Deleting `scripts/letterboxd-reconcile.mjs`, `src/letterboxd-export.js`, `src/letterboxd-match.js`, `tests/letterboxd-reconcile.mjs` and this page removes the tool.
