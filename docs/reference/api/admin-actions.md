# Guarded owner actions (contract and fixture exemplar)

This page is the contract every Data Health recovery action must follow before it may write: a versioned capability, a read-only eligibility decision, a dry-run preview, the owner's explicit confirmation of one exact scope with an expiry, checks against a fresh read at submission, bounded execution with CAS per record, an honest receipt, and retry and compensation rules. It is implemented as a pure library and a fixture exemplar. **No production action exists**: the Worker has no action route, does not bundle the library, and no capability is wired to R2, D1, a Scheduled Task, Access, a flag or an external service. The one live owner workflow, poster restoration on `/admin/posters`, follows the same principles over the existing maintenance route without this library; see [the poster page](#the-poster-page).

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

## Transport shape

`fixtureActionRequest` shows the shape a future owner route must keep, without being one: `GET /preview` only previews; `POST /execute` only executes; any other method is 405, an unknown path 404, a non-owner principal 403 before anything else. A refused submission answers 409 for a concurrency or freshness refusal (`stale_pin`, `record_changed`, `eligibility_changed`, `idempotency_conflict`, `lease_held`, `in_progress`) and 400 otherwise. A production route built on this contract also keeps the Worker's same-origin check for non-GET requests and is subject to its own card, tests, ADR classification and owner approval.

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

## Prediction recovery

There is **no capability for the prediction of one film**, and none is to be declared on top of the current queue. The data health model can mark a film `prediction_retry` eligible (a due or overdue retry, or a stalled film the queue does not list); that statement is not executable, and the [prediction recovery read](admin.md#prediction-recovery-get-apiadminprediction-recovery) explains the film instead, with `targetedAction.available: false` and `writer: {exists: false, decision: "no_go"}`. Every case it can report is handled by an existing mechanism or belongs to another subsystem:

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

The queue object has several writers: the prediction runner's routes under the 90-second prediction mutation lease, and refreshes from the EPG commit, the profile update, the resolver checkpoint and `POST /api/enrichment/queue/reconcile`, which do not take that lease. Each refresh is a blind whole-object put, without an etag condition, and carries forward the `retries` it read. A per-film edit of that object therefore cannot carry CAS semantics, and a retry override stored inside it would be dropped or overwritten by the next refresh. The same race can also lose a just-written retry record (its `retryAt` and `attempts`): a refresh rebuilds membership, not a lost retry, so such a film becomes eligible before its backoff ends. That pre-existing risk belongs to queue reliability, not to this read. A future targeted prediction writer needs a durable design of its own (for example a separate per-film override object that `refreshPredictionQueue` honours under the writer lease, with an etag condition, an idempotent receipt and a restorable before-image), on top of conditional writes by every queue writer, an accepted ADR, the Mermaid changes it implies and the owner's approval before it is implemented. Until then the panel offers no control.

## The poster page

`/admin/posters` ([admin reference](admin.md#poster-coverage)) restores catalog posters through `POST /api/enrichment/catalog/posters`, the permanent maintenance route of [ADR 0048](../../adr/0048-permanent-catalog-poster-maintenance-route.md), which predates this contract and keeps its own guards. It is not a registered capability and the Worker gains no action route; the page applies the principles above on the client, in [`src/admin/posters-run.js`](../../../src/admin/posters-run.js):

| Principle | On the poster page |
| --- | --- |
| Read-only preview | `GET /api/admin/posters` with the chosen cursor and batch size: counts, the first batch by title and TMDB id, the most the run can touch. No TMDB request, no write, no lease |
| Eligibility from data health | the catalog poster summary (`poster_hydration`); a record is in scope only with a numeric `tmdbId` that is its `canonicalIdentity`, the route's own rule |
| Exact scope, expiry | a checkbox naming calls, batch size, maximum records, start and generation; the scope key is the generation, cursor, limit, call budget and the first batch's `id=tmdbId` pairs; ten minutes, one run, dropped by any option change |
| Fresh check | a new GET with the confirmed cursor and limit immediately before the first call; another generation, another first batch, nothing to do or a rate-limit gate refuses with nothing sent |
| Bounded execution | at most 30 sequential calls of at most 10 records; stop on `done`, the budget, five idle calls, `retryAt`, a generation change, a busy or lost lease, TMDB not configured, a rejected request, an unreadable answer or an unknown outcome code |
| Per-record CAS | done by the route: the expected-generation fence the page sends on every call (`expectedProgrammeRunId`, refused before TMDB and before any write), the resolver lease, the generation check before every write and a compare-and-swap per catalog copy |
| Honest receipt | every call and the latest outcome of every record; partial writes between the two copies are named; raw codes, keys, cursors and HTTP statuses only in «Технические подробности»; a code without a sentence is shown as unknown, never guessed |
| Retry and compensation | retryable outcomes keep the route's cursor before them, so the next run retries them first; terminal ones (`no_poster_on_tmdb`, `tmdb_id_mismatch`) are listed. There is no compensation step: a written poster is the TMDB asset of the verified id, and removing it is a separate approved write ([runbook](../../runbooks/catalog-poster-hydration.md#rollback)) |

Deviations, by design: the confirmation is held by the page, not issued by a server, because the route already decides what may be written and the confirmation only guards against an accidental click (ADR 0048: confirmation is not authorization); there is no idempotency key, so a repeated call after an unknown result is a new call, which the route makes harmless (an already written poster is `already_present`), and the page asks for a re-check before any further run; run history lives in the browser, not on the server.
