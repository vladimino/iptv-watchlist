# Letterboxd export reconciliation (offline, private data)

`scripts/letterboxd-reconcile.mjs` compares the owner's Letterboxd account export with the films stored in production. It is offline: it reads the extracted CSV files and, optionally, a local R2 snapshot, and writes an aggregate report plus a private row file. The parsing and matching rules are the [export contract](../reference/integrations/letterboxd-export.md).

A complete reconciliation needs a production R2 snapshot made by the [read-only snapshot export](r2-snapshot-export.md). Taking that snapshot is a separately approved operation; this page does not grant it. Without a snapshot the command still parses the export and reports set counts, with matching marked `blocked: snapshot_missing`.

## What the command never does

- No network request, no R2 or D1 access, no Worker route, no Letterboxd fetch. (The separate [identity resolver](#identity-from-film-pages) is the only tool here that can fetch Letterboxd pages, and only with an explicit flag.)
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

## Identity from film pages

`scripts/letterboxd-identity-resolve.mjs` decides the identity of films the reconciliation left unresolved, from the Letterboxd film page each export code's `boxd.it` shortlink leads to. The decision rules are in the [export contract](../reference/integrations/letterboxd-export.md#identity-from-the-letterboxd-film-page).

**Running it with `--network` sends requests to Letterboxd and is a separately approved operation; this page does not grant it.** Without `--network` the command sends nothing: it reads its inputs, re-decides what the private checkpoint already holds and rewrites the report.

| Path | Content | Privacy |
| --- | --- | --- |
| `--ledger <file>` | `matches.jsonl` of a reconciliation run with a snapshot | Private |
| `--imported <file>` | `plan.jsonl` of the [baseline import](letterboxd-baseline-import.md) that was committed: its `lid` codes are skipped and its TMDB ids are collisions | Private |
| `--output <dir>/checkpoint.jsonl` | First line binds the run to the SHA-256 of the ledger and the plan; then one observation per code (landing path, shortlink code, TMDB ids and types, page title, aliases, years, or the page outcome). No HTML | **Private** |
| `--output <dir>/resolution.jsonl` | One decision per queued code with reasons, the accepted TMDB id and the film path | **Private.** Never commit, attach, paste into Trello or GitHub, or log |
| `--output <dir>/report.json` | Policy, network counters, stop reason, queue counts and counts per decision, group and reason | Contains no code, name, path or TMDB id |

All paths are absolute and outside the Git repository (a symlink into it is refused). `--limit <n>` observes at most `n` codes in one run.

**Network policy.** One request at a time; request starts at least one second apart, every redirect hop counted; a 15-second timeout per request; a code whose request times out, fails or answers 5xx is retried at most twice, five and ten seconds later, and is then left `pending`; three such codes in a row stop the run. Only `https://boxd.it` and `https://letterboxd.com` are requested, and an off-site redirect is not followed. HTTP 429, HTTP 403 or a challenge page (`cf-mitigated: challenge`, a Cloudflare challenge script or interstitial) stops the run at once with no retry and no attempt to get past it; the stopped code is not recorded. The User-Agent is the Worker's own. Standard error carries progress counts only.

**Resume.** Rerunning with the same ledger and plan continues where the checkpoint ends: observed codes are not fetched again, codes left `pending` by a failed fetch are tried again, and a truncated last checkpoint line is ignored. A checkpoint made from another ledger or plan is refused.

Exit codes: `0` report written (including a run bounded by `--limit`); `2` usage error or a path inside the repository; `3` an input is not JSON Lines or the checkpoint belongs to other inputs; `4` the run stopped on 429, 403, a challenge or repeated failures. After a stop, wait and ask the owner before running again; never change the policy to get past a block.

Procedure:

1. **Rehearse.** `node tests/letterboxd-identity-resolve.mjs` runs the resolver against invented pages through an injected fetch.
2. **Prepare inputs** from an approved reconciliation run and the committed import plan, in a private directory outside the repository.
3. **Approved network run.** `node scripts/letterboxd-identity-resolve.mjs --ledger /absolute/private/letterboxd-report/matches.jsonl --imported /absolute/private/baseline/plan.jsonl --output /absolute/private/letterboxd-identity --network`, optionally with `--limit` for a small first batch.
4. **Read the report.** Only a report with `complete: true` is final, because duplicate TMDB ids and same title/year pairs are judged across all observed films. `accepted` decisions are proposals for a separately approved import; `owner_review` and `conflict` rows need the owner's manual review in the private file. Only aggregate counts may go to a Trello card or an [evidence](../evidence/README.md) page.

## Rollback

Neither command changes anything outside its output directory; deleting that directory removes the result. Deleting `scripts/letterboxd-identity-resolve.mjs`, `src/letterboxd-identity.js` and `tests/letterboxd-identity-resolve.mjs` removes the identity resolver; deleting `scripts/letterboxd-reconcile.mjs`, `src/letterboxd-export.js`, `src/letterboxd-match.js`, `tests/letterboxd-reconcile.mjs` and this page removes the reconciliation tool.
