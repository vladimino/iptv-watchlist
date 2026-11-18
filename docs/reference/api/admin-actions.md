# Guarded owner actions

This page is the contract every Data Health recovery action must follow before it may write: a versioned capability, a read-only eligibility decision, a dry-run preview, the owner's explicit confirmation of one exact scope with an expiry, checks against a fresh read at submission, bounded execution with CAS per record, an honest receipt, and retry and compensation rules. It is implemented as a pure library, a fixture exemplar and four production capabilities: [`discovery_reconsider@1`](#discovery-reconsideration-discovery_reconsider1), [`discovery_identity_correct@1`](#identity-correction-discovery_identity_correct1), [`letterboxd_archive_apply@1`](#letterboxd-archive-apply-letterboxd_archive_apply1) and [`letterboxd_archive_rollback@1`](#letterboxd-archive-rollback-letterboxd_archive_rollback1). The Worker bundles the library as `AdminActions`. Discovery reconsideration and identity correction register in the discovery-recovery adapter. The two archive capabilities are registered in the archive apply adapter. The library itself is not a D1, Scheduled Task, Access, flag or external-service client. Live Discovery reconsideration and identity correction write D1 when Discovery authority is `d1` and `cutover` is `open`; they write the R2 decision map when that marker is not ready. The archive capabilities write R2. Poster restoration on `/admin/posters` follows the same principles over the existing maintenance route without this library; see [the poster page](#the-poster-page).

Source: [`src/domain/admin-actions.js`](../../../src/domain/admin-actions.js) (the contract, pure), [`src/admin/actions-fixture.js`](../../../src/admin/actions-fixture.js) (in-memory store, executor, GET/POST transport shape), [`src/admin/actions-presentation.js`](../../../src/admin/actions-presentation.js) (the machine-to-human presentation layer), [`src/admin/actions-view.js`](../../../src/admin/actions-view.js) (the reusable panel), [`public/admin-actions.html`](../../../public/admin-actions.html) and [`public/admin-actions.js`](../../../public/admin-actions.js) (the demonstration page at `/admin/actions`). Tests: [`tests/admin-actions.mjs`](../../../tests/admin-actions.mjs), [`tests/admin-actions-presentation.mjs`](../../../tests/admin-actions-presentation.mjs), [`tests/admin-actions-view.mjs`](../../../tests/admin-actions-view.mjs). Eligibility comes from the [data health model](../domain/data-health.md); the pin is the one of the [admin read API](admin.md).

## Boundaries

- Opening a page, a GET, building or rebuilding a preview, and rendering a receipt write nothing. Only a submission carrying a valid confirmation reaches an executor, and only through a method that is not GET.
- A confirmation authorizes one scope of one capability version until its expiry. It is not a credential, not a session and not a general permission to write. Each future production capability needs its own card, its own owner approval of the operation and its own route; adding a capability to a registry executes nothing.
- Access stays the Worker's owner-only Cloudflare Access. The contract's `principal` is what an Access-verified request says about the caller (`{owner: true}`); the library never sees a token, and a receipt never contains one. There is no second login and no browser service token.
- A multi-record action is never atomic. The preview says so (`atomic: false`) and the receipt reports every record's own outcome.

## Capability

`defineCapability(spec)` validates and freezes one declaration; `createRegistry([...])` refuses a duplicate `id@version`.

| Field | Rule |
| --- | --- |
| `id`, `version` | `[a-z][a-z0-9_]{1,40}`, integer ≥ 1. Another version is another capability |
| `subjectKinds` | the data health subject kinds it may act on (`film`, `catalog`, …) |
| `healthActionCode` | the data health `action.code` it answers (`metadata_refresh`, `poster_hydration`, `prediction_retry`, …) |
| `budget.maxRecords` | integer 1–50, default 10 |
| `budget.maxWritesPerRecord` | integer 1–10, default 1 |
| `budget.externalCallsPerRecord` | integer 0–10, default 0 |
| `retry.maxAttempts` | integer 1–5, default 1; only `failed` and `not_attempted` records are retryable, never `unknown` |
| `retry.backoffMs` | integer 0–604 800 000 (7 days), default 0 |
| `compensation` | `kind`: `none`, `restore_before_image` or `manual`, and the owner-facing `guidance` |
| `confirmTtlMs` | integer 1 000–3 600 000 (1 s – 60 min), default 10 min |

Every numeric field must be a finite integer inside its range; a string, a fraction, a negative number, `NaN` or `Infinity` makes `defineCapability` throw, so a preview's budget and cost figures are always bounded. `budget`, `retry` and `compensation`, when given, must be objects.

## Preview (dry run)

`previewAction(registry, request, observation)` with `request = {capability, version, subject: {kind, id}, pin, ids?}` and `observation = {pin, now, records: [{id, version}], issues}`, where `issues` are data health issues the caller evaluated. Each record is judged by the issue whose `subject.kind` equals the request's subject kind, whose `subject.id` equals the record id and whose `action.code` is the capability's code (an observation and a film with the same textual id never share evidence or eligibility; a record that declares another `kind` is `unsupported` / `subject_kind_differs`): `eligible: true` on `complete` evidence is eligible; `eligible: false` is `ineligible` with the model's reason; `eligible: null` (or eligible on partial evidence, which the model already downgrades) is `unknown`; no such issue is `ineligible` / `no_issue`. A record without a version is `unknown` / `version_unknown`; a requested id that was not read is `unknown` / `record_not_read`.

| `status` | When |
| --- | --- |
| `eligible` | at least one record is eligible and the count is within `maxRecords` |
| `ineligible` | nothing eligible, or `budget_exceeded` |
| `stale` | `request.pin` differs from the pin of the read (`currentPin` is returned) |
| `unsupported` | unknown capability or version, a subject kind it does not take, or a malformed request |
| `unknown` | the observation lacks a clock, records or issues, or every candidate is unknown |
| `empty` | no record at all |

The preview returns `affected` (id and version of every record a confirmation would cover), `excluded` with status and reason, `budget` (`records`, `maxRecords`, `writes`, `externalCalls`), `atomic: false`, `retry`, `compensation`, and the **scope key**: the canonical JSON of capability, version, subject, pin and every affected record with its version. `scopeFingerprint` is a short display hash of it; matching always compares the full key.

## Confirmation and issuance

`confirmAction(preview, {now, idempotencyKey, accepted})` succeeds only for an `eligible` preview, only with `accepted: true`, and only with an idempotency key of 16–80 letters, digits, `_` or `-`. It returns `{schemaVersion, capability, version, subject, pin, scopeKey, scopeFingerprint, ids, idempotencyKey, confirmedAt, expiresAt}`. Errors: `not_eligible`, `confirmation_missing`, `invalid_request`.

What is a guarantee and what is not:

- **UI acknowledgement, not security.** The checkbox and `accepted: true` record that the owner looked at the scope. A page can send anything, so nothing about the submitted value is trusted on its own.
- **Security guarantee: issuance.** A confirmation is honoured only when the issuer holds the record it issued under that idempotency key and the submission equals it in every field. The issuer is the server for a live action and the fixture store here (`issueFixtureConfirmation` keeps a frozen copy; one key is issued once). The expiry enforced is the **issued** `expiresAt`: a submission that extends it is `confirmation_mismatch`, and one presented after the issued expiry is `confirmation_expired`. A live action may replace the server-held record with a MAC over the scope key, `confirmedAt` and `expiresAt` under a server-held key, with the same rule: the expiry comes from what the server issued or signed, never from the submission.
- **Security guarantee: freshness.** At submission the scope must still be what an eligible preview over a fresh read produces (pin, record versions, eligibility, budget); the confirmation alone is never sufficient.
- **Not a guarantee of this contract: the caller's identity.** That is the Worker's owner-only Cloudflare Access; the contract only refuses a `principal` that is not the owner.

`validateConfirmation(value)` is the fail-closed parser for submitted values. It returns `null` (refused as `invalid_request`) for anything but an object with exactly the confirmation fields, a known schema version, a capability id, an integer version, a `{kind, id}` subject, a pin, an idempotency key, parseable `confirmedAt` / `expiresAt`, 1–50 distinct ids, a scope key of at most 20 000 characters that parses to exactly the canonical scope (capability, version, subject and pin equal to the fields, one `{id, version}` record per id in order, re-serialized byte for byte) and a fingerprint that matches it. It never throws.

## Submission checks

`checkSubmission(registry, confirmation, fresh, {principal, issued})` runs against a read made at submission time, in this order; the first failure refuses the whole submission before any write, and no input makes it throw:

| Refusal | Check |
| --- | --- |
| `access_denied` | `principal.owner !== true` |
| `confirmation_missing` | no confirmation submitted |
| `invalid_request` | `validateConfirmation` rejects the submitted value (any malformed or inconsistent field, including a capability that disagrees with the scope key), or the fresh read lacks a clock, records or issues |
| `unsupported_capability` | the capability version is not registered |
| `confirmation_missing` | the issuer holds no (valid) record for this idempotency key |
| `confirmation_mismatch` | the submission differs from the issued record in any field (for example an extended `expiresAt` or a narrowed `ids`) |
| `confirmation_expired` | `now` is after the issued `expiresAt` (exactly at the expiry is valid) |
| `stale_pin` | the fresh pin differs from the confirmed one |
| `record_changed` | a confirmed record is missing or its version changed (CAS precondition) |
| `budget_exceeded` | the fresh preview exceeds the budget |
| `eligibility_changed` | the fresh preview is not `eligible` or its scope key differs: a record left or joined the eligible set |

An executor adds three checks of its own: `idempotency_conflict` (the key was used for another scope), a concurrent submission with the same key waits for and replays the same run, and `lease_held` (another key holds the executor's lease).

## Execution and receipt

An executor takes a lease with a fencing number, then handles the confirmed records in scope order. For each record it checks the version, computes the new value (which may await an external call), and then **commits with a compare-and-swap on both the record version and the lease fence at commit time**, in one step that nothing can interleave with (in the fixture, `store.commit` is synchronous; a live executor uses a conditional write such as an R2 `onlyIf.etagMatches` plus a fence check inside the same guarded write). A record changed while the value was computed is `skipped_changed` with `conflict`, never overwritten; a lease lost or revoked meanwhile writes nothing, marks that record and the rest `not_attempted` with `fence_lost`, and ends the run as `aborted`. An abort between records leaves the rest `not_attempted` with `aborted`; a computation that throws is `failed`; one that may or may not have had an effect (a timeout) is `unknown`. The before-image of each written record is kept for compensation. The lease is released only by its own holder.

`receiptOf(...)` derives the run state from the outcomes and never from a hope:

| `state` | Outcomes |
| --- | --- |
| `refused` | a check refused the submission; nothing was attempted |
| `succeeded` | every record `written` or `already_applied` |
| `unknown` | at least one record `unknown`; `retry.retryable` is empty and the note says to read the records again first |
| `aborted` | stopped by the abort signal before every record was handled |
| `partial` | some records done, others not |
| `failed` | no record done |

A receipt carries `idempotencyKey`, capability and version, subject, pin, `scopeFingerprint` (not the full key) — echoed only when the confirmation passes `validateConfirmation`, otherwise `null` — per-record `outcomes` with an error **code** from the closed vocabulary `provider_error`, `timeout`, `rate_limited`, `conflict`, `fence_lost`, `validation_error`, `storage_error`, `aborted`, `internal_error` (anything else, including any exception message, becomes `internal_error`; `actionErrorCode` does the classification), `counts`, `retry` (`retryable` ids, `maxAttempts`), `compensation`, `atomic: false` and `audit` (`actor: "owner"`, `confirmedAt`). It never contains a token, an exception message, an e-mail or another identity; an unknown refusal is reported as `invalid_request`. A repeated submission with the same key returns the stored receipt with `replay: true` and writes nothing.

## Discovery reconsideration: `discovery_reconsider@1`

One production capability ([ADR 0061](../../adr/0061-discovery-observation-index-and-reconsider.md)). It lifts the terminal fence of **one** discovery decision whose automatic attempts ended on unchanged evidence (`no_more_evidence`), so that the next ordinary resolver chunk may take the observation again. It calls no TMDB, runs no chunk and changes no other decision. Routes, refusals and the action record are in the [admin API](admin.md#discovery-observation-recovery-get-apiadmindiscovery-recovery); the gate is in the [recovery assessment](../domain/discovery-recovery.md#the-reconsideration-gate).

The declaration is:

- subject kind `observation`, `healthActionCode: discovery_reconsider`;
- budget: 1 record, 1 write per record, 0 external calls;
- retry: 1 attempt, no backoff;
- compensation `manual`: the action record keeps the before-image;
- `confirmTtlMs`: 10 minutes.

| Principle | In `discovery_reconsider` |
| --- | --- |
| Eligibility | The issue `reconsiderIssue` derives from the assessment, not the data health retry rule. Eligible only for a confirmed `no_more_evidence` on a fresh [observation index](../domain/discovery-observation-index.md) with no live lease, protected wait, throttle, ambiguity or missing configuration; unknown evidence is `null`, never eligible |
| Record version | The index record's `decisionHash`, the SHA-256 of the full decision |
| Preview | `GET /api/admin/discovery-recovery`, read-only, with cost, risk and effect |
| Issuance | Server-side: the confirm route stores the issued confirmation as the action record, created only if absent. `checkSubmission` compares the submission with it |
| Executor lease | The resolver lease (`epg/resolver-lease.json`), the same one every chunk writes under. It is refused when live (`lease_held`) or unreadable (`lease_unknown`, never taken over), and renewed as the fence just before the write |
| Commit with CAS | R2 `onlyIf.etagMatches` on the decision map's etag, after the decision's digest matched; the intent with the before-image is stored before the write |
| Receipt | `receiptOf`, stored in the action record; a replay returns it. A `running` intent without a receipt is `in_progress` / unknown and never redone |
| Retry | None automatic. An `unknown` outcome asks for a fresh read; a lost compare-and-swap is `failed` |

Deviations from the contract text, by design:

- There is no fencing number. The fence is the lease id and its renewal, as for every resolver writer, and the commit is the R2 conditional put.
- `lease_held` and `lease_unknown` refusals are answered before a receipt exists and are not stored, so the same confirmation can be executed once the resolver is free.
- The receipt's audit names only `actor: owner`, and the action record's provenance adds `authority: cloudflare_access`. No e-mail, assertion or token is stored.

Not covered by this capability: `discovery_retry` (a due retry is already taken by the next chunk), a future `retryAt` (backoff is policy), more than one observation, and the movie id itself. Assigning or rejecting one movie id is [`discovery_identity_correct@1`](#identity-correction-discovery_identity_correct1).

## Identity correction: `discovery_identity_correct@1`

The second discovery capability ([ADR 0080](../../adr/0080-discovery-identity-correction.md), Accepted). It assigns or rejects **one** numeric TMDB movie id on **one** current observation. It calls no TMDB, runs no chunk and changes no other decision. While Discovery authority is D1 and `cutover` is `open`, confirm and execute write the D1 decision, intent and receipt; a reject also deletes current-generation `published_epg_show` rows with `basis='discovery'` and `match_reason` equal to that observation key ([ADR 0142](../../adr/0142-epg-owned-generation-addressed-discovery-slots.md) decision 4). It does not update `discovery_admission` or the prediction queue. A title match is not a candidate. Routes and the action record are in the [admin API](admin.md#identity-correction-post-apiadmindiscovery-recoveryidentity-confirm). The pure rules are `src/domain/discovery-identity-review.js`.

The declaration is:

- subject kind `observation`, `healthActionCode: discovery_identity_correct`;
- budget: 1 record, 1 write per record, 0 external calls;
- retry: 1 attempt, no backoff;
- compensation `manual`: the action record keeps the before-image; restoring it is a separate owner-approved write;
- `confirmTtlMs`: 10 minutes.

| Principle | In `discovery_identity_correct` |
| --- | --- |
| Eligibility | `identityIssue` from the index offer and `identityCommand`. Eligible only for one `assign` or `reject` of one movie id on a fresh, complete index, a known store (R2 published generation, or ready D1 Discovery authority with `cutover` `open`), and a series that is not `unknown` or `live_writer`. A missing catalogue read, a torn index and an unpublished generation are unknown, never eligible |
| Record version | `decisionHash:effect:tmdbId`. The hash is the SHA-256 of the full decision. The effect and the id are part of the version, so an assign confirmation cannot be executed as a reject |
| Preview | There is no preview until the owner has chosen the effect and the id. `GET /api/admin/discovery-recovery` returns the offer. `POST …/identity-confirm` builds the contract preview and issues the confirmation |
| Issuance | The confirm route stores the command `{effect, tmdbId, basis}` on the action record, created only if absent. Execute trusts that stored command |
| Executor lease | The resolver lease, refused when live or unreadable, and renewed before the write |
| Commit with CAS | When Discovery authority is D1 and `cutover` is `open`: one fenced D1 batch (`commitOwnerWrite`) that compare-and-swaps the decision by `decision_hash`, writes history and intent, and — if the previous decision was a verified movie assignment — deletes current-generation `published_epg_show` rows with `basis='discovery'` and this observation key. When that marker is not ready: R2 `onlyIf.etagMatches` on the decision map after the decision digest matched the index hash and the version prefix; the running intent with the before-image is stored first |
| Receipt | D1: `discovery_intent.receipt_json`; a replay of that receipt returns `durable: true`. R2: `receiptOf` in the action record. A replay of a stored R2 receipt returns it with `durable: true`, including an `unknown` receipt. A decision read-back is not a stored receipt: if the final action-record put fails or loses its compare-and-swap after the decision landed, the answer is `decisionReadBack` with `durable: false` and no success. The same confirmation then stores the receipt only when it matches the stored issuance on every bound field, and does not put the map again. A changed timestamp, expiry, scope or effect is `confirmation_mismatch`. An original issuance that has expired, when the decision already matches, is `confirmation_expired` with `decisionReadBack: true` and no new receipt. A `running` intent whose decision does not read back as that submission stays unknown and is not rewritten |
| What changed | The JSON field `application` is outside the receipt: `consumers` is always `["resolution_decision"]`. `shows` is `next_ordinary_chunk`, `after_series_wait` or `next_series` when the assigned film is already in the catalogue, `awaiting_catalog_film` when a confirmed id has no catalogue object, `cleared_assigned_rows` only for a D1 reject of a currently verified movie assignment (the same condition as `assignedRowsDelete`), and `not_this_action` otherwise (R2 reject, or a D1 reject whose previous decision was not a verified assignment) |

The catalogue etag is not part of the pin. Confirm and execute each re-read the one catalogue object for an assign. A catalogue change that fails the command writes no decision. A resolution-map change changes the pin, so execute usually refuses `stale_pin` before the digest compare.

A reject appends the id to `rejectedTmdbIds` (at most eight movie ids), clears `terminalReason` and `retryAt` on that decision, and does not clear another observation. The next ordinary chunk may evaluate a different id. It copies `ownerIdentity` and `rejectedTmdbIds`, does not auto-verify the rejected id, searches again when that id is the first accepted score, and does not fetch its movie detail. Similar titles are not blocked.

Not covered: more than one observation ([AIR-131](https://trello.com/c/0WtLPRnH)), revoke of a stored correction ([AIR-132](https://trello.com/c/3AXbSoHe)), a television id, retiring a catalog admission, and rewriting the prediction queue. A held Discovery marker, or a published-EPG marker that is neither `r2` nor a ready D1 Discovery authority, writes nothing. Retiring an already admitted Documentary or concert recording from the catalog is [`catalog_policy_exclude@1`](#policy-exclusion-catalog_policy_exclude1), not this reject.

## Policy exclusion: `catalog_policy_exclude@1`

The third discovery capability ([ADR 0153](../../adr/0153-catalog-policy-exclusion.md), Proposed). It excludes **one** current movie admission `tmdb_<id>` whose stored payload is a Documentary, a concert recording, or a Music-only `ambiguous` Live/Concert token under [ADR 0150](../../adr/0150-documentary-and-concert-film-exclusion.md). In one resolver-leased D1 batch it rejects every current movie decision with that TMDB id (at most 12, `floor((STATEMENT_CAP-4)/3)`), deletes current-generation `published_epg_show` rows with `basis='discovery'` for those observation keys, and sets the admission `state` to `superseded`. Preview and writer share that observation set; a current admission on a different film_id among those decisions is `linked_admission`. It then settles the film out of the prediction queue (`settleQueueFilms` via `mutatePredictionQueue`) and rebuilds (`refreshPredictionQueue`). It does not delete ratings, fingerprints, immutable predictions, Letterboxd facts, Film/Person R2 objects, or non-discovery EPG shows. It calls no TMDB and starts no chunk. `allEnrichmentFilms` skips ADR 0150 exclusions even when the film is still on the personal watchlist. Independently, `GET /api/programme` (and `GET /api/catalog/available`) withholds a proven Documentary or concert from the presented interesting-programme and Finds lists using the same `admissionPolicy` on stored metadata; `GET /api/watchlist` stays. Routes are in the [admin API](admin.md#policy-exclusion-get-apiadmindiscovery-recoverypolicy-exclude).

The declaration is:

- subject kind `film`, `healthActionCode: catalog_policy_exclude`;
- budget: 12 records, 3 writes per record, 0 external calls;
- retry: 1 attempt, no backoff;
- compensation `manual`: restoring the admission is a separate owner-approved write;
- `confirmTtlMs`: 10 minutes.

| Principle | In `catalog_policy_exclude` |
| --- | --- |
| Eligibility | Ready D1 Discovery authority with `cutover` `open`. Current movie admission whose payload classifies as `documentary`, `concert`, or Music-only `ambiguous` under the same ADR 0150 `admissionPolicy` as programme projection (stored synopsis fills overview). A drama, a TV Movie without independent recording phrases, a missing admission and a non-movie id are not eligible |
| Record version | The admission `film_id` plus the policy kind. A superseded row is `already_applied` for Discovery and still retries the queue |
| Preview | `GET /api/admin/discovery-recovery/policy-exclude?filmId=tmdb_<id>` |
| Issuance | The execute POST carries `{filmId, idempotencyKey}` and the Access action header. A stored R2 receipt for that key replays |
| Executor lease | The resolver lease |
| Commit with CAS | One fenced D1 batch (`ownerPolicyExclude`): decision history and reject payloads, assigned-row deletes, admission `superseded` |
| Receipt | R2 `admin/actions/catalog_policy_exclude/v1/<idempotencyKey>.json`, bound to that `filmId`. A later POST of a different film with the same key is `idempotency_conflict`. A superseded admission on a later POST of the same film is `already_applied` and still retries the queue |
| What changed | Catalog current snapshot, related decisions, discovery-basis shows of those keys, and the prediction-queue membership of that film |

Not covered: bulk exclusion of the AIR-500 inventory, a schema change to `discovery_intent`, deleting personal history, moving the published EPG generation, and any production write. Shipping the capability does not authorize a live exclude.

## Transport shape

`fixtureActionRequest` shows the shape a live owner route keeps, without being one: `GET /preview` only previews; `POST /execute` only executes; any other method is 405, an unknown path 404, a non-owner principal 403 before anything else. A refused submission answers 409 for a concurrency or freshness refusal (`stale_pin`, `record_changed`, `eligibility_changed`, `idempotency_conflict`, `lease_held`, `in_progress`) and 400 otherwise. A production route built on this contract also keeps the Worker's same-origin check for non-GET requests and is subject to its own card, tests, ADR classification and owner approval. The `discovery_reconsider` routes follow this shape with a confirm step in front of the execution: `GET` previews, `POST …/confirm` issues, `POST …/reconsider` executes. Identity correction uses the same GET for the offer, then `POST …/identity-confirm` and `POST …/identity-correct`. A `discovery_reconsider` header on an identity route is 403, and an identity confirmation posted to `…/reconsider` is `confirmation_missing`. The archive apply uses the same confirm-then-execute pair and has no GET of its own: the archive preview is the dry run, `POST …/apply-confirm` issues, and `POST …/apply` executes. Rollback is the same pair. A `running` apply that has no receipt is retried, which discovery reconsideration does not do.

## Letterboxd archive apply: `letterboxd_archive_apply@1`

Records one chunk of a previewed Letterboxd archive through the existing baseline commit ([ADR 0068](../../adr/0068-letterboxd-archive-confirmed-apply.md), [admin API](admin.md#letterboxd-archive-apply)). The archive preview remains the dry run and writes nothing.

The declaration is:

- subject kind `letterboxd_archive_chunk`, `healthActionCode: letterboxd_archive_apply`;
- budget: 50 records, 3 writes per record, 0 external calls;
- retry: 1 attempt, no backoff;
- compensation `restore_before_image`: rollback is a separate confirmation of the same chunk, and a later observation is kept;
- `confirmTtlMs`: 10 minutes.

| Principle | In `letterboxd_archive_apply` |
| --- | --- |
| Eligibility | A synthetic issue per compared film, `applyIssue`, with complete evidence. The request subject id is `<archive sha256>:<chunk>`. Each record id is the film's Letterboxd id, and the issue subject id matches that record |
| Record version | SHA-256 of the planned facts plus the current value, time and source the preview showed |
| Pin | The published programme run id |
| Preview | The archive preview's `batches`, still a read. Confirm re-runs that comparison |
| Issuance | The confirm route stores the issued confirmation as the action record, created only if absent |
| Executor lease | None. The preview's one-at-a-time isolate slot is the only concurrency gate, and it answers 429 rather than `lease_held` |
| Commit with CAS | `commitBaselineChunk`: an intent, then one compare-and-swap per fact, then the view index, then the import receipt |
| Receipt | `receiptOf` on the action record. A stored action receipt replays and writes nothing. A `running` action without a receipt is sent through `commitBaselineChunk` again. If that chunk's baseline intent or receipt already has this plan's `itemsHash`, the check uses the issued scope, so the intent's own fact writes are not `record_changed`; a newer observation is still kept. Replaying that baseline receipt keeps a skip as `skipped_changed` and a conflict as `failed`; only a film the import wrote is `already_applied`, so a partial or failed import is not reported as `succeeded`. A different plan hash is `idempotency_conflict` |
| Retry | No automatic loop inside one request. The owner can send the same confirmation again after `storage_error`. A terminal failed receipt is not stored on that failure, so the resume stays possible |

The action record does not contain the ZIP, CSV text, film names, rating values or a token.

On `/admin/letterboxd` this contract is one visible step at a time. Back and Continue change that step and do not send a request. Step 5 appears only after a write or rollback attempt. The lead totals are additions, changes and skips. Incomplete coverage is not labelled a full check. The archive hash, file hashes, programme run id, chunk id, plan hash and scope fingerprint stay in a closed disclosure. A `partial` or `unknown` receipt is not presented as success. A lost response after confirm, commit or rollback has left the browser is shown as `unknown`, not as a write that never started. «Прервать ожидание» stays outside the file form, so it remains visible on step 4 or 5 while confirm, commit, rollback-confirm or rollback is in flight. Stopping that wait does not cancel or roll back the Worker, and the progress line is not repeated inside the step. The preview's «Отменить» is a different control and drops that read. Choosing another ZIP or another declared time disables new write controls on that preview until that file is checked, and does not drop an unresolved command. Forgetting the command is a separate control and is not a rollback. It is also offered for a lost confirm and a lost rollback confirmation, beside the earlier apply receipt when one exists. HTTP 409 `in_progress` stays recoverable with the same confirmation. A refused rollback does not replace that apply receipt. A manual retry resubmits the issued confirmation, or the same idempotency key, instead of minting a key. The page does not retry by itself. Nothing here changes eligibility, the batch size or the commit.

## Letterboxd archive rollback: `letterboxd_archive_rollback@1`

Rolls back one committed chunk. The request is JSON and carries no ZIP. The origin passed to `rollbackBaselineChunk` is the one stored on the import receipt.

The declaration is:

- subject kind `letterboxd_archive_chunk`, `healthActionCode: letterboxd_archive_rollback`;
- budget: 1 record, 3 writes, 0 external calls;
- retry: 1 attempt, no backoff;
- compensation `restore_before_image`;
- `confirmTtlMs`: 10 minutes.

The single record id is `chunk`. Its version and the pin are the receipt's `itemsHash`. The subject id is `<archive sha256>:rollback:<chunk>`. A later observation is left in place and reported `skipped_changed`. A repeated rollback of the same confirmation replays.

## Presentation layer (machine to human)

The owner decides on meaning, not on internal codes. [`src/admin/actions-presentation.js`](../../../src/admin/actions-presentation.js) turns a preview or a receipt into plain Russian. It is pure: no DOM, storage, network, clock, randomness or language model, and no input reaches an external service. It never decides eligibility, authority or risk; it can only withhold an explanation, and an unexplained preview can never be confirmed. The safety logic stays in the domain contract, which contains no display text and does not depend on this layer.

### Display descriptor

Each capability version has one display descriptor, plain data registered with `createDescriptorRegistry` (a malformed or duplicate descriptor throws). The fixture's is `FIXTURE_DESCRIPTOR` in `src/admin/actions-fixture.js`.

| Field | Meaning |
| --- | --- |
| `capability`, `version` | the capability it explains |
| `healthActionCode`, `subjectKind`, `compensation` | must agree with the capability and with the typed evidence, or nothing is explained |
| `title` | the panel heading, e.g. «Проверка перед обновлением метаданных» |
| `noun` | Russian count forms: `one`, `few`, `many`, and `ofOne`, `ofMany` after «из» |
| `subjectLabel` | how a subject is named, with `{name}` for its trusted display title |
| `problem` | «Что не так» |
| `change`, `fields`, `untouched`, `effect` | «Что мы собираемся изменить»: the change, the fields that may change, what does not change, the expected effect |
| `simulation`, `simulationNote` | a simulation says so in the change section, the headline and the result |
| `externalCalls` | the sentence describing external calls; required when the capability's budget declares any, `null` otherwise |
| `risks` | at least one risk of the capability itself and what to do about it; an empty list is rejected |
| `cta` | the action button; the panel adds the count, e.g. «Смоделировать изменение (2 тестовых фильма)». A live capability names its real change here |
| `confirm` | the scope acknowledgement; must contain both `{count}` and `{names}`, so it lists the whole scope (the domain scope key is enforced independently) |

### Inputs and the explanation

`presentPreview(preview, descriptors, context)` and `presentReceipt(receipt, descriptors, context)` take the trusted read the preview was judged on: `context = {titles, issues}`, where `titles` maps a stable subject id to its display title (trusted presentation metadata, never derived from the id) and `issues` are the data health issues. Every sentence comes from the descriptor, from typed fields (status, reasons, outcomes, error codes, compensation kind, `atomic`, budget, confirmation lifetime) and from the closed copy tables:

| Table | Covers |
| --- | --- |
| `ACTION_PREVIEW_STATE_COPY`, `ACTION_PREVIEW_REASON_COPY` | every preview state and every reason `previewAction` emits, with a next step |
| `ACTION_ISSUE_REASON_COPY` | every data health issue reason: why an included record needs the action |
| `ACTION_EXCLUSION_COPY` | every data health eligibility reason and every exclusion `previewAction` adds (`no_issue`, `not_eligible`, `record_not_read`, `subject_kind_differs`, `version_unknown`), each with a reason and a safe next step |
| `ACTION_RUN_STATE_COPY`, `ACTION_OUTCOME_COPY`, `ACTION_ERROR_COPY` | every run state, record outcome and error code |
| `ACTION_REFUSAL_COPY` | every refusal, with how to fix it |
| `ACTION_COMPENSATION_COPY` | every compensation kind, never promising an automatic rollback |

The explanation follows a fixed order: «Что не так» → «Что мы собираемся изменить» → «Кого это затронет (и почему)» → «Кого пропустим (и почему)», each skipped record with a next step → «Что может пойти не так / как поступить» (non-atomic execution in plain words, concurrent changes, the capability's risks, external calls, undo, the confirmation lifetime) → the exact acknowledgement → «Что получилось» («Удалось для N из M», each record's outcome and next step; an unknown outcome says not to retry without checking; a refusal says why nothing ran and how to fix it).

### Fail closed

The whole preview is unexplainable, shown as «Невозможно достоверно объяснить действие; выполнение недоступно», with no acknowledgement and no button, when any of these holds:

- there is no descriptor for the capability version, or its compensation, subject kind or external calls disagree with the preview;
- a state, reason or exclusion code has no declared copy;
- an included record has no trusted title, no typed issue of this capability's action code and subject kind, an issue reason without copy, or evidence that is not `complete`;
- the preview is `eligible` and an excluded record has no trusted title: a confirmable scope names every subject it mentions.

A receipt with an undeclared state, refusal, outcome or error code is shown as «Невозможно достоверно объяснить результат…» and asks for a manual check before any retry. Only in a preview that cannot be confirmed anyway is an excluded record without a trusted title called «запись без проверенного названия»; no name is invented and the id is not shown in its place.

A receipt of an unfinished run (`approved`, `running`) is never shown as final: it has no «N из M» summary and no «nothing more to do», lists only the results already known, and asks to refresh the status or check later without starting the action again.

### What the primary view never shows

Stable ids, record versions, the pin, the scope key and fingerprint, the idempotency key, budget fields and limits, raw states, reasons, refusals and error codes, `atomic`, and CAS, lease or fence terms appear only inside a closed `<details>` «Технические подробности», kept in full for support. Every text, including display titles, is HTML-escaped. The stable ids stay in the action scope; display titles are presentation only.

## The panel and the demonstration page

`mountActionPanel(root, adapter)` renders the presentation of a preview in the order above, the exact contextual acknowledgement (a checkbox whose label names the count and the subjects), the action button with its count and **Проверить заново**, and the result under «Что получилось», which receives focus when it appears. The adapter supplies `descriptors`, `context()`, an optional `request()` for a fresh check over current data, `preview`, `confirm` and `execute`. The panel enables the checkbox, and after it the button, only for an `eligible` preview that the presentation layer fully explained; it decides nothing else.

`/admin/actions` is the panel as a simulator on fictional data, all in the tab's memory, under the permanent banner «Тренажёр на вымышленных данных. Реальные фильмы не меняются». Its selector, «Демонстрационные ситуации», is a test harness, not an owner workflow; each situation says what it imitates and what will be seen: two films can be updated, a failure on one film (partial), an unknown result (timeout), data that change after the check (refused, then recovered by a fresh check), and nothing to change. Films carry fictional titles («Север», «Тихая гавань», «Пустой лист», «Двойник»). The page makes no request, stores nothing, calls no model and is not linked from the owner catalogue page.

## Limb page

`/admin/limb` opens on «Требует моего внимания»: only an observation the existing reconsider gate or the existing identity offer already allows. Films have no write on this page, so they are never in that queue. A stale index, an ordinary wait, a scheduled retry and an unknown gate stay out of it. «Все состояния» shows the existing limbo causes as four sentences: «Требует моего решения», «Обычный шаг не назначен», «Ожидает автоматическую обработку» and «Не удалось проверить». `stalled` is the second of those, not an owner decision: nothing automatic is scheduled and the page offers no write for that cause. The grouping is display only. It adds no capability, no button and no POST. The verdict and the queue come before the filters. Coverage above the queue is one line; the counts sit in a closed disclosure after the queue. «Обновить» rereads the published snapshot and does not start a pipeline. A stale list pin is reread once without that pin. A stale confirmation is not posted again. A quiet line offers a refresh when the displayed read is at least 60 minutes old. A successful read that finds 50 canonical films differ says the list was updated and does not ask for another refresh. A failed retry drops the selected detail and does not keep the previous action count. Returning to the tab paints the hour line and does not read. Causes are indicator buttons, not a selector. A pressed button includes that cause, an unpressed button excludes it, and releasing every button lists nothing. The number on a button is confirmed actions in the attention queue and inventory rows in the full register; the line under the buttons names both. «Найти запись» matches titles of rows already shown, including a later page, and does not query the inventory. Escape in that field clears only the local title. «Сбросить фильтры» clears it together with the server filter and returns to the attention queue, and reads the inventory again only when a server filter or the full register was showing. When the open row is filtered out, the first row still on screen becomes the explanation without moving focus and without a read. When none of the loaded rows match, the page says so and keeps «Показать ещё»; that is not a claim about the rest of the inventory. The selected record, beside the queue on a wide screen and under the row on a narrow one, states what happened, who moves next, and whether a result is known. Its action sentence follows `ownerAction` and the control on the row: a confirmed action still needs the separate confirmation inside the panel, a refused gate says there is no step now, an unchecked observation says the write has not been checked, the prediction button only reads an explanation, and a row without those buttons has no write on this page. The data-health `action.eligible` flag stays in the technical disclosure and is not presented as a confirmed write. The detail heading names the record; a jump on the selected row moves focus there without taking Arrow, Home or End off the queue. The owner explicitly approved this fourth display group on 2026-11-03 as a departure from the original three-group wireframe. The snapshot, the filters and the pipeline thresholds sit in closed disclosures after the queue.

The two discovery writes stay inside «Разобрать наблюдение» and inside the closed technical search under the queue. The open panel leads with the read assessment: action now, waiting, changes unavailable, not enough data, or the receipt. One gate that is available is the primary control and states the cost, the risk and, for identity, the before and after (`Сейчас: … → Станет: …`) before the existing two-step confirm. The other gate, and a gate that is not eligible, stays inside the closed «Почему система так решила?» and shows no confirm control. Identity assign and reject use the existing rule for `unknown_authority`: the published-EPG mode is `d1`, or the identity marker is not R2, so the write is not offered. Reconsider uses its own gate, including a stale generation (`generation_changed`) and a stale index. The page does not add a gate and does not treat `manual_review` or a health-model flag as a live writer. An unknown, partial or missing receipt is the primary result and is not success, and the page does not send the POST again by itself. A missing, stale or partial observation index is not an empty limb: the attention queue says the actions were not checked or that none are confirmed, and the full register says the absence of rows cannot be confirmed. An unreadable continuation, discovery status, resolver lease or published-EPG authority is the same kind of unchecked queue, not a verified zero. Mode `d1` is a completed check: the triage refuses an otherwise eligible reconsider with `unknown_authority` and does not offer that write. The reconsider and identity writers are unchanged. Keys, pins and digests stay under «Техническая диагностика».

## Prediction recovery

There is **no per-film queue write for a prediction**, and none is to be declared on top of the current queue. The one targeted capability is the [scoped prediction recovery intent](#scoped-prediction-recovery-intent) below, which never writes the queue. The data health model can mark a film `prediction_retry` eligible (a due or overdue retry, or a stalled film the queue does not list); that statement is not executable, and the [prediction recovery read](admin.md#prediction-recovery-get-apiadminprediction-recovery) explains the film instead, with `targetedAction.available: false` and `writer: {exists: false, decision: "no_go"}`. Every case it can report is handled by an existing mechanism or belongs to another subsystem:

| Film state | Effect a per-film queue write would have |
| --- | --- |
| Queued and ready now | None. `queueReadyIds` already returns it; only a run processes it |
| Ready, but no run for more than 24 hours | None. The cause is the external Scheduled Task, not the film |
| Future `retryAt` | It would bypass the backoff policy (1 h doubling to at most 6 h), which is a safety rule, not a delay to remove |
| Repeated failures | None. A contract rejection (`validation_error`, `parse_error`) repeats on the same input and is fixed in the caller's output; an infrastructure failure (storage, quota, time budget, model availability, lease) is fixed where it occurs; an unrecognised kind needs investigation first |
| Not current and not queued | Overwritten: the queue is a derived projection rebuilt in full by every refresh (prediction start, next, submit and complete, EPG commit, profile update, resolver checkpoint, manual reconcile), and the next refresh adds the film on its own |
| Cold film behind hot work | It would break the hot-first priority rule |
| In flight or run active | It would race the live run |
| Index inconsistent, outside the programme and catalog | The cause is the view index or the identity subsystem |

The queue object has several writers: the prediction runner's routes, and rebuilds from the EPG commit, the EPG scan, the profile update, the resolver checkpoint and `POST /api/enrichment/queue/reconcile`. Every one of them writes conditionally on the etag it read and rebuilds on conflict, carrying forward the `retries` of the queue it last read ([queue writes](prediction-runner.md#queue-writes), [ADR 0064](../../adr/0064-prediction-queue-conditional-writes.md), Accepted 2026-10-31). A retry override stored inside the queue would still be dropped by the next rebuild, because a rebuild keeps only the records of outstanding films and derives everything else. A targeted prediction writer therefore needs a durable design of its own that `refreshPredictionQueue` honours. [ADR 0165](../../adr/0165-scoped-prediction-recovery-intent.md) (Accepted) is that design; the limb panel still offers no control.

### Scoped prediction recovery intent

Owner-only, behind the existing Cloudflare Access application ([ADR 0165](../../adr/0165-scoped-prediction-recovery-intent.md), Accepted; [AIR-477](https://trello.com/c/WhwaXRRl)). Code: [`src/prediction-recovery-intent.js`](../../../src/prediction-recovery-intent.js) (store and pure rules), [`src/admin/prediction-recovery-intent.js`](../../../src/admin/prediction-recovery-intent.js) (routes). Dormant until migration [`0024`](../../../migrations/0024_prediction_recovery_intent.sql) is applied (a separate owner GO on [AIR-478](https://trello.com/c/IbsSCRce)).

An intent denies **one exact stored version** of one film: the prediction token `generatedAt|fingerprintHash|tasteProfileHash` and, in mode `fingerprint_and_prediction`, the fingerprint token `fingerprintHash|generatedAt`. The freshness rule treats that version as not current only when the caller names the film, so the ordinary queue rebuild admits the film with its ordinary lane, priority, retry record and retry budget, and the ordinary batch v2 runner scores it. The first committed new version no longer matches the token: the intent is satisfied without a write and cannot re-score the film twice.

| Route | Effect |
| --- | --- |
| `GET /api/admin/prediction-recovery-intent/preview?films=<ids>&mode=<mode>&ttlHours=<h>` | Read only (get-only bucket, SELECTs only). `films`: 1–50 distinct stored ids, comma-separated, a set (order does not matter). `mode`: `prediction_only` (default) or `fingerprint_and_prediction`. `ttlHours`: 1–168 (default 72). Answers per-film `outcome`/`reason`, `plan`, canonical identity, `lane`, `retry`, `activeIntent`; `counts`; `schema {ready, revision}`; `authority {prediction, filmPerson}`; `runner` lease; `queue`; `budget` (films, model calls estimate, manifests estimate, `externalCalls: 0`); `scopeHash`; `confirmable` and `refusal`. |
| `GET /api/admin/prediction-recovery-intent/cohort?id=<cohortId>` | Read only. The cohort and each film's derived status: `pending`, `satisfied`, `expired`, `settled`, `cancelled`. |
| `POST /api/admin/prediction-recovery-intent/confirm` `{films, mode, ttlHours, scopeHash, idempotencyKey}` | Needs `Cf-Access-Jwt-Assertion`, the same `Origin` and `X-IPTV-Admin-Action: prediction_recovery_intent`. A known key answers `replayed` with the stored receipt only when both the `scopeHash` and the normalized request (sorted films, mode, TTL) are the stored ones; otherwise `409 idempotency_conflict`. The scope hash covers each film's outcome, identity, denied tokens, lane and retry record, the mode, TTL, recovery revision, prediction marker mode/writes and Film/Person state/generation; not the queue generation or the runner lease, which move on every step and heartbeat. Otherwise the server re-runs the preview and requires the exact `scopeHash` (`409 stale_scope` with the fresh hash), then writes one fenced D1 batch for the eligible films only and answers `201 confirmed` with the receipt (`films`, `skipped` with reasons, `expiresAt`, `revision`). |
| `POST /api/admin/prediction-recovery-intent/cancel` `{cohortId}` | Same owner headers. Closes the cohort's still-active intents in one fenced batch; a second cancel answers `already_cancelled`. A prediction the runner already committed stays. |

Per-film outcomes, in the order they are checked:

| Outcome | Reasons |
| --- | --- |
| `blocked` | `profile_missing`, `film_unreadable`, `not_admitted` (outside the watchlist, programme and admitted catalog: v1 fails closed), `identity_unavailable`, `identity_absent`, `identity_retired` (a redirect), `retry_exhausted` (the budget is never reset), `token_unbindable` |
| `conflict` | `identity_conflict` (an untrusted, conflicting or second trusted claim), `identity_mismatch` (the stored typed id is not the Film's trusted claim; no title/year matching), `pointer_absent`, `pointer_mismatch` (the D1 pointer or fingerprint is not the version just read), `active_intent` |
| `unchanged` | `prediction_absent`, `not_current`: the ordinary rule already queues the film |
| `eligible` | the version is current, bound and still the D1 pointer |

Ledger:

| Consumer | Authority | Before-image | Intent | Effect | Refusal |
| --- | --- | --- | --- | --- | --- |
| The freshness rule (queue rebuild, batch selection, batch and dry-run submit, held and staged items, diagnostics) | D1 `prediction_recovery_*`, read only while the prediction marker is `d1` | The denied tokens are the before-image: the pointer, the fingerprint, `prediction_lineage` and every R2 body are never touched | One row per film per cohort, `active` until cancelled, settled by a later confirmation, or past `expires_at` | The film is outstanding at the next ordinary rebuild (`queue.recoveryRevision` changes the advance gate) and is scored by the ordinary runner; the first new version satisfies the intent | `stale_scope`, `idempotency_conflict`, `recovery_schema_not_ready`, `prediction_domain_not_d1`, `prediction_writes_held`, `recovery_scope_empty`, `recovery_cas` (a moved token, a concurrent confirmation, the 300 active-intent cap), `recovery_not_open`, `owner_required`, `recovery_unavailable` |
## The poster page

`/admin/posters` ([admin reference](admin.md#poster-coverage)) restores catalog posters through `POST /api/enrichment/catalog/posters`, the permanent maintenance route of [ADR 0048](../../adr/0048-permanent-catalog-poster-maintenance-route.md), which predates this contract and keeps its own guards. It is not a registered capability and the Worker gains no action route; the page applies the principles above on the client, in [`src/admin/posters-run.js`](../../../src/admin/posters-run.js):

| Principle | On the poster page |
| --- | --- |
| Read-only preview | `GET /api/admin/posters` with the chosen cursor and batch size: the split counts, the first actionable batch by title and TMDB id, the most the run can touch, and a sample of remembered answers. No TMDB request, no write, no lease. A missing or unreadable catalog copy, an untrusted generation pointer or an unreadable negative index is incomplete evidence: the counts are unknown, never zero, and the preview cannot be confirmed |
| Eligibility from data health | the catalog poster summary (`poster_hydration`); a record is in scope only with a numeric `tmdbId` that is its `canonicalIdentity`, the route's own rule |
| Exact scope, expiry | a checkbox naming calls, batch size, maximum records, start and generation; the scope key is the generation, cursor, limit, call budget and the first batch's `id=tmdbId` pairs; ten minutes, one run, dropped by any option change |
| Fresh check | a new GET with the confirmed cursor and limit immediately before the first call; incomplete evidence, another generation, another first batch, nothing to do or a rate-limit gate refuses with nothing sent |
| Bounded execution | at most 30 sequential calls of at most 10 records; stop on `done`, the budget, five idle calls, `retryAt`, a generation change, a busy or lost lease, TMDB not configured, a rejected request, an unreadable answer or an unknown outcome code |
| Per-record CAS | done by the route: the expected-generation fence the page sends on every call (`expectedProgrammeRunId`, refused before TMDB and before any write), the resolver lease, the generation check before every write and a compare-and-swap per catalog copy |
| Honest receipt | every call and the latest outcome of every record; partial writes between the two copies are named; raw codes, keys, cursors and HTTP statuses only in «Технические подробности»; a code without a sentence is shown as unknown, never guessed |
| Retry and compensation | retryable outcomes keep the route's cursor before them, so the next run retries them first. Terminal `no_poster_on_tmdb` and `tmdb_id_mismatch` are stored by the route and leave the ordinary queue; the page lists them and can recheck one id with its own confirmation, which does not move the sweep position. A negative outcome that was not stored says so and will be asked again. There is no compensation step: a written poster is the TMDB asset of the verified id, and removing it is a separate approved write ([runbook](../../runbooks/catalog-poster-hydration.md#rollback)) |

On screen the same read leads with four counts: without a poster, actionable now, held until a date or an identity review, and without a verified TMDB id. An unknown count is «неизвестно» and is never drawn as zero. Batch size, call budget and start sit in a closed «Дополнительные настройки». «Перечитать» only re-reads and sits with the coverage, not beside the write button. History is titled «История этого браузера» and sits after the run.

Deviations, by design: the confirmation is held by the page, not issued by a server, because the route already decides what may be written and the confirmation only guards against an accidental click (ADR 0048: confirmation is not authorization); there is no idempotency key, so a repeated call after an unknown result is a new call, which the route makes harmless (an already written poster is `already_present`), and the page asks for a re-check before any further run; run history lives in the browser, not on the server. The queue does not: remembered TMDB answers live in the R2 index ([ADR 0063](../../adr/0063-catalog-poster-negative-index.md)), and the browser copy of past outcomes is not an input to it.
