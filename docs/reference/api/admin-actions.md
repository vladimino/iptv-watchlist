# Guarded owner actions (contract and fixture exemplar)

This page is the contract every Data Health recovery action must follow before it may write: a versioned capability, a read-only eligibility decision, a dry-run preview, the owner's explicit confirmation of one exact scope with an expiry, checks against a fresh read at submission, bounded execution with CAS per record, an honest receipt, and retry and compensation rules. It is implemented as a pure library and a fixture exemplar. **No production action exists**: the Worker has no action route, does not bundle the library, and no capability is wired to R2, D1, a Scheduled Task, Access, a flag or an external service.

Source: [`src/domain/admin-actions.js`](../../../src/domain/admin-actions.js) (the contract, pure), [`src/admin/actions-fixture.js`](../../../src/admin/actions-fixture.js) (in-memory store, executor, GET/POST transport shape), [`src/admin/actions-view.js`](../../../src/admin/actions-view.js) (the reusable panel), [`public/admin-actions.html`](../../../public/admin-actions.html) and [`public/admin-actions.js`](../../../public/admin-actions.js) (the demonstration page at `/admin/actions`). Tests: [`tests/admin-actions.mjs`](../../../tests/admin-actions.mjs), [`tests/admin-actions-view.mjs`](../../../tests/admin-actions-view.mjs). Eligibility comes from the [data health model](../domain/data-health.md); the pin is the one of the [admin read API](admin.md).

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

## Transport shape

`fixtureActionRequest` shows the shape a future owner route must keep, without being one: `GET /preview` only previews; `POST /execute` only executes; any other method is 405, an unknown path 404, a non-owner principal 403 before anything else. A refused submission answers 409 for a concurrency or freshness refusal (`stale_pin`, `record_changed`, `eligibility_changed`, `idempotency_conflict`, `lease_held`, `in_progress`) and 400 otherwise. A production route built on this contract also keeps the Worker's same-origin check for non-GET requests and is subject to its own card, tests, ADR classification and owner approval.

## The panel and the demonstration page

`mountActionPanel(root, adapter)` renders a preview (status, capability, snapshot, budget, atomicity, compensation, scope fingerprint, affected and excluded records), a checkbox "Я подтверждаю именно этот объём…", **Подтвердить и выполнить** (enabled only for an eligible preview with the box ticked) and **Построить превью заново**, and the receipt (state, refusal text, per-record outcomes, what may be retried, key, scope fingerprint). It calls only `adapter.preview`, `adapter.confirm` and `adapter.execute`, and decides nothing itself.

`/admin/actions` is the panel on synthetic data, all in the tab's memory: scenarios with two eligible films, a failure in the middle (partial), a timeout (unknown), a snapshot that changes after the preview (refused, stale pin) and nothing eligible. The page makes no request, stores nothing and is not linked from the owner catalogue page.
