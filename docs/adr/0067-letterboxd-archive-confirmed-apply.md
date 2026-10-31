# ADR 0067: A confirmed Letterboxd archive apply re-checks the ZIP on two owner requests and writes through the existing baseline commit

**Status:** Proposed (code and synthetic tests only; it authorizes no production upload, validate, commit, rollback, R2 or D1 write, flag, Access change, service token or Scheduled Task)  
**Original decision date:** 2026-10-31  
**Recorded at:** 2026-10-31  
**Approval source:** not documented (the owner handed implementation of [AIR-285](https://trello.com/c/FFMUP4qm) on 2026-10-31; acceptance of this record and of the apply diagram is still an owner gate)  
**Related work:** [AIR-285](https://trello.com/c/FFMUP4qm); [AIR-284](https://trello.com/c/Y9udReUR) / [ADR 0066](0066-ephemeral-letterboxd-archive-preview.md) (the preview this apply follows); [AIR-280](https://trello.com/c/ijIEPgm1) (guarded owner actions); [ADR 0053](0053-permanent-letterboxd-baseline-import-route.md); [ADR 0055](0055-retire-letterboxd-facts-switch.md); [ADR 0023](0023-letterboxd-user-facts.md)  
**Supersedes:** None  
**Superseded by:** None

## Context

- **The preview stores nothing.** [ADR 0066](0066-ephemeral-letterboxd-archive-preview.md) accepts one same-origin upload, compares it in memory and drops it. A later apply cannot point at a stored ZIP, and hiding one would put the private archive in R2.
- **The baseline route already commits safely.** `commitBaselineChunk` and `rollbackBaselineChunk` write an intent, compare-and-swap each fact, project the view index and keep a per-chunk receipt. A repeated chunk replays. A later observation is kept on rollback. The CLI reaches that route with a Cloudflare Access service token.
- **The card required a choice.** Use that importer as it stands, or design an owner-only browser transport under a new ADR. The browser must not receive a service token, a dry-run must not commit, and absence from the archive is not `watched: false`.
- **Authorization, size and an interrupted commit had to be checked first.** The preview already refuses an archive above 10 MiB. The baseline intent converges if the client disconnects after the intent and before the receipt. Discovery reconsideration does the opposite with a `running` action that has no receipt: it reports the outcome unknown and does not retry.

## Decision

1. **Browser transport, same commit.** `/admin/letterboxd` does not call `POST /api/letterboxd/baseline/*` and does not send `CF-Access-Client-Id` or `CF-Access-Client-Secret`. After a preview, two further same-origin POSTs, each uploading the ZIP again, confirm and then record one chunk. Fact writes go only through `commitBaselineChunk`. Rollback goes only through `rollbackBaselineChunk`. `LETTERBOXD_FACTS` and `LETTERBOXD_BASELINE_IMPORT` are not read and no Cloudflare setting changes.
2. **Credentials.** The existing Cloudflare Access application stays the authority. The Worker does not verify the JWT signature, as it does not for discovery reconsideration. A write route requires three things before it reads the body: a `Cf-Access-Jwt-Assertion` of 1–8192 characters, `Origin` equal to the Worker origin, and `X-IPTV-Admin-Action: letterboxd_archive_apply`. A missing bucket binding is still the Worker's `Storage unavailable`. A bucket that cannot `put` is `storage_unavailable` and is not read. There is no second login and no anonymous upload.
3. **What one approval covers.** Only films the preview compared (`state: compared`, with facts). Unverified, conflicting, invalid and unmatched films are absent from every batch. One confirmation covers one chunk of at most 50 films. A partial proposal does not block a chunk that was fully compared. The plan hash is the SHA-256 of the baseline items, the same digest the import receipt stores as `itemsHash`. Each film's version hash covers the planned facts and the current value, time and source the owner saw, so a newer stored fact changes the version. The pin is the published programme run id. Drift, a missing programme, or a fingerprint that no longer matches refuses the confirm before any action record is stored.
4. **Confirm stores the confirmation, not the archive.** `POST /api/admin/letterboxd-archive/apply-confirm` re-parses the ZIP, checks the hash, the export time and the plan, then `confirmAction`. It puts only `admin/actions/letterboxd_archive_apply/v1/<idempotencyKey>.json` (`etagDoesNotMatch: *`). The answer is `writes: false`. The same key with the same issued confirmation returns that record. A different scope is `idempotency_conflict` before any fact write.
5. **Commit is a separate request.** `POST /api/admin/letterboxd-archive/apply` uploads the ZIP again with the issued confirmation. The archive hash, export time and source must match the stored record, and the subject must be `<sha256>:<chunk>`. `checkSubmission` runs against a fresh comparison. Only then does `commitBaselineChunk` run. Outcomes: a baseline replay is `already_applied`; a fact conflict is `failed`; any `new` or `replaces` is `written`; an `older` fact with nothing written is `skipped_changed`. The action receipt is `receiptOf`. The response and the action record do not include the import's view before-image. The import receipt itself is unchanged.
6. **An interrupted commit is resumed.** If the action record is `running` and has no receipt, the next apply calls `commitBaselineChunk` again. That function completes an open intent and replays a receipt, so the retry converges. This differs from `discovery_reconsider`, which refuses a `running` record. A `chunk_conflict` is `idempotency_conflict` and writes no fact. Any other commit failure answers `storage_error` and leaves the action `running`, so a later try can finish the intent. A terminal failed receipt is not stored on that path, because it would block the resume.
7. **Rollback is its own capability.** `letterboxd_archive_rollback@1` confirms one chunk from the stored import receipt. The request is JSON and carries no ZIP. The origin passed to `rollbackBaselineChunk` is the receipt's origin, not a client field. A later observation stays `superseded`. The same two clicks apply: confirm, then execute.
8. **One slot, shared with the preview.** Confirm and commit take the preview's isolate slot and answer 429 `preview_busy` when it is held. Length and content type are checked before the slot. The preview route still has no `put`. `POST /api/admin/letterboxd-archive/commit` stays 404.
9. **A rating does not need a diary row.** A `ratings.csv` row is `watched: true` and a rating through the baseline plan, whether or not `diary.csv` has that film. Absence is not an observation. Title and year never accept an identity.

Not decided here, and not authorized by this record: a production upload or import; a bounded baseline-summary object; reading the catalog copy; changing Access, a flag, a Task or a binding.

## Alternatives considered

- **Call the existing baseline HTTP route from the page.** The card allowed the validated importer semantics or a new browser transport. The CLI route expects a JSON plan and a service token. Putting that token in the page was forbidden, and the page would not re-check the ZIP against a stored confirmation. Rejected.
- **Store the ZIP and apply it later.** The card forbids a hidden copy, and [ADR 0066](0066-ephemeral-letterboxd-archive-preview.md) already refused storing the archive. Rejected. Each of confirm and commit uploads the ZIP again.
- **Commit in the same request as the preview or the confirm.** The card forbids a commit that follows a dry-run by itself. Rejected. The confirm answer is `writes: false`, and the page does not chain the two calls.
- **Gate the route on `LETTERBOXD_FACTS` or `LETTERBOXD_BASELINE_IMPORT`.** Both are retired ([ADR 0055](0055-retire-letterboxd-facts-switch.md), [ADR 0053](0053-permanent-letterboxd-baseline-import-route.md)). Reintroducing them would change Cloudflare settings the handoff forbids. Rejected.
- **Verify the Access JWT inside the Worker.** Discovery reconsideration already treats a present assertion, a same-origin request and the action header as the principal, and leaves signature checks to Access. A second verifier would be a new trust boundary. Rejected for this route.
- **Refuse to resume a `running` action with no receipt.** That is what discovery reconsideration does, because its write is not idempotent. The baseline commit is. Reporting it unknown would leave an open intent the owner could not finish from the page. Rejected for this capability only.

## Consequences

- The owner can record one compared chunk from the browser, under the existing Access session, without a service token and without the archive being stored.
- Two new capabilities are registered beside `discovery_reconsider@1`: `letterboxd_archive_apply@1` (50 records, 3 writes each, 10 minutes) and `letterboxd_archive_rollback@1` (one record). The pure library is unchanged.
- Confirm and commit each cost a full preview read, including at most 300 fact-record GETs, plus the baseline commit's own writes on the second request. They share the preview's one-at-a-time slot.
- The action record names the archive hash, the export time, the chunk, the plan hash, the programme run id and per-film outcome codes. It does not contain the ZIP, CSV text, film names, rating values or a token. Letterboxd ids are the record ids.
- A code deploy does not import anything. Facts written by a later, separately approved apply stay until that chunk's rollback. A code revert does not remove them.

## Recovery and migration boundary

- Rollback of a committed chunk is `rollbackBaselineChunk`, after its own confirmation. A later observation is kept. The import intent and receipt are the recovery record.
- This record authorizes no production `validate`, `commit`, `rollback`, ZIP upload, R2 or D1 write, Access or service-token change, flag, Task or migration. Each of those needs its own owner approval.

## Evidence

- **Original decision:** [AIR-285 handoff](https://trello.com/c/FFMUP4qm), 2026-10-31, which required this ADR to choose the transport and the failure retry.
- **Implementation:** the AIR-285 pull request (routes, page, synthetic tests).
- **Dated verification:** not recorded. Synthetic tests cover a rating with no diary row, a kept value, a newer fact, a held identity, replay, a tampered archive, a changed programme, a conflict, a partial chunk, rollback after a later observation, access denied, a missing binding and a malformed ZIP. No production upload was made, and no new resource measurement was taken.
- **Uncertainty:** owner acceptance of this record and of the apply diagram is outstanding. The production edge was not measured again. The preview's workerd probe remains the size evidence.

## Follow-ups

Owner acceptance of this Proposed record and of the apply sequence in [letterboxd ingestion](../architecture/letterboxd-ingestion.md) before merge. A joint visual acceptance of the preview and this apply, after deploy, is a separate gate and is not granted here. A bounded baseline-summary projection, if wanted, stays its own card.
