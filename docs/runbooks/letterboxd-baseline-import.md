# Letterboxd baseline import (owner approval required)

`scripts/letterboxd-baseline-import.mjs` imports the owner's Letterboxd account export as fact observations under [ADR-0023](../adr/0023-letterboxd-user-facts.md). The storage rules, the merge order and the request contract are the [user facts contract](../reference/integrations/letterboxd-user-facts.md). This page is the procedure. Nothing on it is authorized by a merge or a deploy: setting `LETTERBOXD_BASELINE_IMPORT`, issuing the Access service token, every `commit` and every `rollback` against production each need their own owner approval.

## What the tool never does

- `plan` sends nothing and reads only the export ZIP (in memory) and a verified snapshot; its outputs stay in a private directory outside the repository.
- No film name, code, URI or rating reaches standard output, `report.json`, a commit message, a PR or a card; they exist only in `plan.jsonl` and the private `*.json` results of the remote steps.
- Only films the export matching marks `accepted` are planned; `candidate`, `ambiguous`, `conflict`, `provisional` and `unmatched` films are counted, never imported.
- An export never sets `watched: false` or `watchlist: false`; absence is not an observation.
- The Worker route writes only fact records, the link index, the conflict list, the view-index projection and `letterboxd/imports/<archive sha256>/chunks/`; no other key.

## Inputs

| Input | Rule |
| --- | --- |
| `--zip` | The archive exactly as Letterboxd delivered it, named `letterboxd-<user>-YYYY-MM-DD-HH-MM-utc.zip`; that name is the export time. A renamed archive is refused unless `--generated-at <UTC>` is given, which `origin.json` records as `owner_declared` |
| `--snapshot` | A verified `consistent_fenced` production R2 snapshot ([snapshot export](r2-snapshot-export.md)); it gives the identity of the planned films |
| `--output` | A private absolute directory outside the repository, one plan per directory: `origin.json`, `plan.jsonl`, `report.json`, then `validate.json`, `commit.json`, `rollback.json` |
| `--chunk-size` | `plan` only: films per chunk, an integer 1–100, default 50 (see [Chunk size](#chunk-size)). The remote steps take the size from `origin.json` and refuse the flag |
| `--endpoint` | The Worker origin over HTTPS (`http://localhost` for local development only) |
| `LETTERBOXD_IMPORT_ACCESS_CLIENT_ID`, `LETTERBOXD_IMPORT_ACCESS_CLIENT_SECRET` | A Cloudflare Access service token allowed to reach the Worker, in the environment only; sent as `CF-Access-Client-Id`/`CF-Access-Client-Secret`, never printed or written |

## Procedure

1. **Rehearse.** `node tests/letterboxd-baseline-import.mjs` runs the ZIP reader, the plan, the tamper checks and every route outcome against invented data and an in-memory bucket. `node tests/letterboxd-baseline-chunks.mjs` runs the chunk sizes and boundaries, legacy 200-film plans, network failures and resume from the intents the same way.
2. **Plan (offline).** `node scripts/letterboxd-baseline-import.mjs plan --zip <zip> --snapshot <snapshot> --output <dir> [--chunk-size <n>]`, into a new directory. Check `report.json`: `chunkSize`, `planned` (films, chunks, watched, rated, not rated, watchlist), `matchStatus` and `unresolved` against the [reconciliation evidence](../evidence/letterboxd/README.md).
3. **Gates and token (owner).** The route works only when **both** `LETTERBOXD_FACTS=on` and `LETTERBOXD_BASELINE_IMPORT=on`; with only the import gate it answers 409 `facts_disabled`, because legacy sync would clear imported ratings by absence. Set the facts gate first, then the import gate, and issue the Access service token.
4. **Validate (no write).** `… validate --zip <zip> --output <dir> --endpoint https://<worker>`. Every chunk reports what a commit would do now: `new`, `replaces`, `older` (a newer stored or scanned observation wins), `unchanged`, `tie`, and `films.conflict`. Review before committing.
5. **Commit.** `… commit --zip <zip> --output <dir> --endpoint https://<worker>` sends the plan's chunks in order and stops at the first failure. Each chunk writes an intent (with the view before-image), the facts, the projection and a receipt. Re-running the same command is safe: committed chunks answer `replay`, an interrupted chunk is completed from its intent. `--from-chunk`/`--to-chunk` bound a run. `commit.json` (like `validate.json` and `rollback.json`) is rewritten after every chunk, so a run that stops still records the chunks it completed and the one that failed.
6. **Rollback (if needed).** `… rollback --zip <zip> --output <dir> --endpoint https://<worker>` walks the committed chunks in reverse. Per fact it restores the value the import replaced only if the import's observation is still current; a later observation (an owner edit, a newer scan) is reported `superseded` and kept. A fact the import created is removed and the view field it projected returns to its before-image. Each chunk's rollback first writes a rollback intent; an interrupted rollback is completed by running the same command again, which converges on the same result without touching values written after the import. A completed rollback is a replay.
7. **Turn the gate off** after the import (owner).

Each remote step first re-reads the archive and refuses to continue if the archive, any CSV inside it or `plan.jsonl` differs from `origin.json`, or if a plan line is not in the chunk its position and the recorded chunk size give (exit code 3).

## Chunk size

The Worker commits a chunk with several sequential R2 operations per film (link index, record read and CAS, floors, projection), on the order of a second per film. A 200-film chunk can exceed the 300 s a Node.js client waits for response headers; the client then drops the request while the Worker has written only part of the chunk. Plans therefore use chunks of **50 films by default and at most 100**, which keeps a commit chunk around a minute and well inside the client limit. Prefer a smaller size over a longer client timeout; there is no timeout flag.

- The chunk size is part of the plan. `origin.json` schema 2 records `chunkSize`; every remote step re-derives the chunks from it, so validate, commit and rollback of one plan always use the same chunks.
- An `origin.json` with schema 1 and no `chunkSize` is a plan made when the size was fixed at 200 films. It keeps that chunking: it still validates, replays its receipts and rolls back chunk by chunk. Do not re-plan it.
- Receipts and intents are keyed by archive SHA-256 and chunk number. `plan` refuses an output directory that already holds a plan of another archive or another chunk size. A new plan of an already committed archive with another size, in a new directory, is refused by the Worker as `chunk_conflict` on its first chunk; roll the earlier plan back from its own directory first if the archive must be re-imported.
- A new export is a new archive with its own receipts, so a delta import plans with the current default regardless of the size an earlier import used.

## Outcomes

| Exit / answer | Meaning | Next step |
| --- | --- | --- |
| `plan` exit 0 | plan written | review `report.json` |
| exit 2 | usage, a path inside the repository, a missing `watched.csv`, a renamed archive without `--generated-at`, a future export time | fix the input |
| exit 2 `--chunk-size` | a size outside 1–100, the flag on a remote step, or `--output` already holding a plan of another archive or size | fix the flag, or plan into a new directory |
| exit 3 | archive or plan differs from `origin.json`, or its chunking differs from the recorded chunk size | re-plan from the original archive into a new directory |
| exit 1, `failed.error: network_error` (`cause` e.g. `UND_ERR_HEADERS_TIMEOUT`, `ECONNRESET`, `TimeoutError`) | the connection dropped or the client timed out; the chunk's outcome is unknown and part of it may be written | rerun the same command: a committed chunk replays, an opened one continues from its intent, so repeated reruns converge. Do not re-plan with another size once any chunk of the archive is opened; a smaller `--chunk-size` is for an archive with no intent yet |
| exit 1, `failed.error: response_unreadable` | an HTTP 2xx whose body was not JSON (a proxy page or a cut body) | rerun the same command; check the endpoint if it repeats |
| HTTP 409 `import_disabled` | the import gate is off | owner decision |
| HTTP 409 `facts_disabled` | the import gate is on but `LETTERBOXD_FACTS` is off | turn the facts gate on first (owner decision), or turn the import gate off |
| HTTP 400 `invalid_request` | a request outside the contract (bad checksum, future time, `watched: false`, a rating without watched, duplicate film, more than 200 films in one request) | do not retry; the plan is wrong |
| HTTP 409 `chunk_conflict` | the chunk number was opened or committed with other items | do not force; re-plan, or roll back the earlier commit first |
| HTTP 409 `not_committed` | rollback of a chunk without a receipt | nothing to roll back |
| HTTP 500 `readback_failed`, `write_contention` or a storage error | a fact did not read back, writers raced past the retries, or a write failed | rerun the same command; the commit or rollback intent completes the chunk |
| `films.conflict` / `conflicts` > 0 | ids that would join a record holding another id of the same kind | listed in `letterboxd/facts/conflicts.json` for the identity review; not written |

## Rollback of the tool

Unset `LETTERBOXD_BASELINE_IMPORT`: the route answers 409 and writes nothing. Code rollback does not remove imported facts; use the `rollback` step for that while the receipts exist.
