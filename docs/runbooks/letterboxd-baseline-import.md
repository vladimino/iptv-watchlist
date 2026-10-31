# Letterboxd baseline import (owner approval required)

`scripts/letterboxd-baseline-import.mjs` imports the owner's Letterboxd account export as fact observations under [ADR-0023](../adr/0023-letterboxd-user-facts.md). The storage rules, the merge order and the request contract are the [user facts contract](../reference/integrations/letterboxd-user-facts.md). This page is the procedure. The route is a permanent owner-only maintenance tool with no switch of its own ([ADR 0053](../adr/0053-permanent-letterboxd-baseline-import-route.md)). Nothing on this page is authorized by a merge or a deploy: issuing an Access credential, every `validate`, every `commit` and every `rollback` against production each need their own owner approval.

## Proportionality and existing tooling limits

This CLI currently **requires** a verified `consistent_fenced` snapshot for `plan`; a small archive, limited number of accepted Films or repeated import does not remove that input requirement. Do not invent a supported target-only import mode. The snapshot protects cross-source identity matching and freshness at planning time, while the Worker uses chunk receipts, create-only intents and fact precedence to avoid overwriting newer observations. Those are data-integrity requirements, not general availability ceremonies.

Once a plan is fixed to its archive SHA-256, chunking and accepted identities, **one owner authorization may name a bounded execution** (for example validate plus explicitly enumerated commit chunks), including internal integrity reads and safe receipt-based resume. A new archive, changed plan, additional chunks, conflicting identity or a rollback outside the approved bounds requires a new decision. A failed or timed-out commit is handled through the existing idempotent intent/replay protocol, **not** a new full snapshot or a new plan for each retry. Do not require repeating a successful validate merely to reproduce an identical result; validate again when source facts or the accepted plan may have changed.

A future snapshot-free, target-scoped planner would require a separate implementation and contract review (identity alias completeness, freshness and competing writers), not a documentation-only promise. [Risk-proportional policy](../process/agent-workflow.md#risk-proportional-operational-safeguards).

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
| `--output` | A private absolute directory outside the repository, new and empty for every `plan`; it then holds that one plan for good: `origin.json`, `plan.jsonl`, `report.json`, then `validate.json`, `commit.json`, `rollback.json` |
| `--chunk-size` | `plan` only: films per chunk, an integer 1–100, default 50 (see [Chunk size](#chunk-size)). The remote steps take the size from `origin.json` and refuse the flag |
| `--endpoint` | The Worker origin over HTTPS (`http://localhost` for local development only) |
| `LETTERBOXD_IMPORT_ACCESS_CLIENT_ID`, `LETTERBOXD_IMPORT_ACCESS_CLIENT_SECRET` | A Cloudflare Access service token allowed to reach the Worker, in the environment only; sent as `CF-Access-Client-Id`/`CF-Access-Client-Secret`, never printed or written |

## Procedure

0. **Preview (optional, no write).** On `/admin/letterboxd` the owner can upload the same ZIP and see its export time, SHA-256, completeness, match counts and what an import would do per fact (`new`, `replaces`, `older`, `unchanged`, `tie`), with «Нужен свежий архив» only when the export is stale or a compared rating in R2 is newer, and with an unconfirmed-freshness notice when the comparison did not cover the ratings ([admin API](../reference/api/admin.md#letterboxd-archive-preview-post-apiadminletterboxd-archivepreview)). The preview stores nothing, needs no service token and is no substitute for `validate`: it reads live R2 instead of a fenced snapshot, compares at most 300 fact-record GETs (a redirect hop counts) and never imports. Recording a chunk is the [browser apply](#browser-apply), a later pair of requests, not this preview.
1. **Rehearse.** `node tests/letterboxd-baseline-import.mjs` runs the ZIP reader, the plan, the tamper checks and every route outcome against invented data and an in-memory bucket. `node tests/letterboxd-baseline-chunks.mjs` runs the chunk sizes and boundaries, legacy 200-film plans, network failures and resume from the intents the same way.
2. **Plan (offline).** `node scripts/letterboxd-baseline-import.mjs plan --zip <zip> --snapshot <snapshot> --output <dir> [--chunk-size <n>]`, into a new empty directory; `plan` never writes into a directory that already holds a plan or a result file, and the same inputs planned into two new directories give identical files. Check `report.json`: `chunkSize`, `planned` (films, chunks, watched, rated, not rated, watchlist), `matchStatus` and `unresolved` against the [reconciliation evidence](../evidence/letterboxd/README.md).
3. **Access (owner).** The route is a permanent owner-only maintenance route with no switch ([ADR 0053](../adr/0053-permanent-letterboxd-baseline-import-route.md), [ADR 0055](../adr/0055-retire-letterboxd-facts-switch.md)); the former `LETTERBOXD_BASELINE_IMPORT` and `LETTERBOXD_FACTS` are retired and inert. The routine writers always record facts, so the next sync cannot clear imported ratings by absence. Access is the Worker's owner-only Cloudflare Access: the CLI sends the service-token headers below when they are set, and the token used for the first import has been revoked. Issuing a credential for a remote step is a separate owner decision outside this procedure. The [browser apply](#browser-apply) reaches the same commit and rollback through the owner's existing Access session and never sends a service token. Every production `validate`, `commit` and `rollback` run is a separate owner-approved operation.
4. **Validate (no write).** `… validate --zip <zip> --output <dir> --endpoint https://<worker>`. Every chunk reports what a commit would do now: `new`, `replaces`, `older` (a newer stored or scanned observation wins), `unchanged`, `tie`, and `films.conflict`. Review before committing.
5. **Commit.** `… commit --zip <zip> --output <dir> --endpoint https://<worker>` sends the plan's chunks in order and stops at the first failure. Each chunk writes an intent (with the view before-image), the facts, the projection and a receipt. Re-running the same command is safe: committed chunks answer `replay`, an interrupted chunk is completed from its intent. `--from-chunk`/`--to-chunk` bound a run. `commit.json` (like `validate.json` and `rollback.json`) is rewritten after every chunk, so a run that stops still records the chunks it completed and the one that failed.
6. **Rollback (if needed).** `… rollback --zip <zip> --output <dir> --endpoint https://<worker>` walks the committed chunks in reverse. Per fact it restores the value the import replaced only if the import's observation is still current; a later observation (an owner edit, a newer scan) is reported `superseded` and kept. A fact the import created is removed and the view field it projected returns to its before-image. Each chunk's rollback first writes a rollback intent; an interrupted rollback is completed by running the same command again, which converges on the same result without touching values written after the import. A completed rollback is a replay.

Each remote step first re-reads the archive and refuses to continue if the archive, any CSV inside it or `plan.jsonl` differs from `origin.json`, or if a plan line is not in the chunk its position and the recorded chunk size give (exit code 3).

## Browser apply

On `/admin/letterboxd`, after a preview, the owner can record one compared chunk without a service token ([admin API](../reference/api/admin.md#letterboxd-archive-apply), [ADR 0068](../adr/0068-letterboxd-archive-confirmed-apply.md)). Two clicks, never one. «Подтвердить партию» stores only the issued confirmation. «Записать партию» uploads the ZIP again and calls the same commit as step 5, for at most 50 films the preview compared. «Подтвердить откат» then «Откатить» call the same rollback as step 6 and keep a later observation. The page never sends `CF-Access-Client-Id` or `CF-Access-Client-Secret`. The CLI route is unchanged. A production confirm, commit or rollback from the browser is still a separate owner-approved operation. Merging or deploying the page does not run one. A code revert does not remove facts written this way. Use the rollback while the receipt exists.

## Chunk size

The Worker commits a chunk with several sequential R2 operations per film (link index, record read and CAS, floors, projection), on the order of a second per film. A 200-film chunk can exceed the 300 s a Node.js client waits for response headers; the client then drops the request while the Worker has written only part of the chunk. Plans therefore use chunks of **50 films by default and at most 100**, which keeps a commit chunk around a minute and well inside the client limit. Prefer a smaller size over a longer client timeout; there is no timeout flag.

- The chunk size is part of the plan. `origin.json` schema 2 records `chunkSize`; every remote step re-derives the chunks from it, so validate, commit and rollback of one plan always use the same chunks.
- An `origin.json` with schema 1 and no `chunkSize` is a plan made when the size was fixed at 200 films. It keeps that chunking: it still validates, replays its receipts and rolls back chunk by chunk. Do not re-plan it.
- Receipts and intents are keyed by archive SHA-256 and chunk number, and the plan in its directory is the only record of what each chunk holds. `plan` therefore refuses any output directory that already holds `origin.json`, `plan.jsonl`, `report.json` or a result file, even for the same archive and size: another snapshot or other matching can accept other films and would leave the receipts without their plan. A new plan of an already committed archive with another size, in a new directory, is refused by the Worker as `chunk_conflict` on its first chunk; roll the earlier plan back from its own directory first if the archive must be re-imported.
- A new export is a new archive with its own receipts, so a delta import plans with the current default regardless of the size an earlier import used.

## Outcomes

| Exit / answer | Meaning | Next step |
| --- | --- | --- |
| `plan` exit 0 | plan written | review `report.json` |
| exit 2 | usage, a path inside the repository, a missing `watched.csv`, a renamed archive without `--generated-at`, a future export time | fix the input |
| exit 2 `--chunk-size` | a size outside 1–100, the flag on a remote step, or `--output` already holding a plan or a result file | fix the flag, or plan into a new empty directory; keep the old directory for replay and rollback |
| exit 3 | archive or plan differs from `origin.json`, or its chunking differs from the recorded chunk size | re-plan from the original archive into a new directory |
| exit 1, `failed.error: network_error` (`cause` e.g. `UND_ERR_HEADERS_TIMEOUT`, `ECONNRESET`, `TimeoutError`) | the connection dropped or the client timed out; the chunk's outcome is unknown and part of it may be written | rerun the same command: a committed chunk replays, an opened one continues from its intent, so repeated reruns converge. Do not re-plan with another size once any chunk of the archive is opened; a smaller `--chunk-size` is for an archive with no intent yet |
| exit 1, `failed.error: response_unreadable` | an HTTP 2xx whose body was not JSON (a proxy page or a cut body) | rerun the same command; check the endpoint if it repeats |
| HTTP 400 `invalid_request` | a request outside the contract (bad checksum, future time, `watched: false`, a rating without watched, duplicate film, more than 200 films in one request) | do not retry; the plan is wrong |
| HTTP 409 `chunk_conflict` | the chunk number was opened or committed with other items | do not force; re-plan, or roll back the earlier commit first |
| HTTP 409 `not_committed` | rollback of a chunk without a receipt | nothing to roll back |
| HTTP 500 `readback_failed`, `write_contention` or a storage error | a fact did not read back, writers raced past the retries, or a write failed | rerun the same command; the commit or rollback intent completes the chunk |
| `films.conflict` / `conflicts` > 0 | ids that would join a record holding another id of the same kind | listed in `letterboxd/facts/conflicts.json` for the identity review; not written |

## Rollback of the tool

There is no switch to close the route; stop by making no further remote call, since nothing runs by itself. A code revert of [ADR 0055](../adr/0055-retire-letterboxd-facts-switch.md) brings the facts gate back: that code answers 409 `facts_disabled` unless `LETTERBOXD_FACTS=on`, and its legacy sync clears imported ratings by absence while the binding is off or absent. A revert of ADR 0053 as well also brings back the former import switch, and that code answers 409 `import_disabled` until `LETTERBOXD_BASELINE_IMPORT=on` is set under owner authorization. Code rollback does not remove imported facts; use the `rollback` step for that while the receipts exist.
