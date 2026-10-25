# Enrichment API for «В эфире»

The production API is Cloudflare Worker `iptv` at `https://iptv.vladimino.workers.dev/`, private behind Cloudflare Access. External ChatGPT Scheduled Tasks for EPG/watchlist and predictions were restored under [AIR-62](https://trello.com/c/CU71gW4c) and observed enabled with recent executions on 24 October 2026. These use owner-only IPTV MCP, not Worker Cron; check live task state separately from the repository or Worker `schedules=0`.

`get_site`, `siwc_bypass_bearer_token`, and `OAI-Sites-Authorization` belong only to the legacy Site. They are not credentials for the Cloudflare Worker. Do not send them to `workers.dev`.

Legacy prediction-launch instructions have been separated into [the archive](../../archive/superseded/enrichment-v3-batch.md). The maintained protocol is [the continuous runner contract](prediction-runner.md). Do not start additional production writers without specific owner approval.

This subsystem uses a separate `enrichment/` R2 namespace. It does not write programme, watchlist, metadata, sync, or started records. It is safe for programme sync to work without it.


## Operational and historical procedures

- [Owner-authorized taste-profile publication](../../runbooks/taste-profile-publication.md).
- [Obsolete v3 batch instructions](../../archive/superseded/enrichment-v3-batch.md) — historical only, never run against production.
- [Current prediction runner](prediction-runner.md) and [MCP interface](mcp.md).

## Actual ratings

Actual Letterboxd ratings are stored separately with `PUT /api/enrichment/actual-ratings`:

```json
{"items":[{"filmId":"123456","rating":4.5}]}
```

Use `rating:null` to clear one. The film's actual rating never enters the `/next` model payload. The owner's UI can display actual and predicted ratings together. `GET /api/enrichment/view` supplies current predictions to the UI while preserving stale prediction history internally. Its fingerprint facet also includes the thirteen general `execution` dimensions when they were saved, omitting `unknown` and `not_applicable`. Genre-specific execution fields are not part of that facet. An older index entry receives the compact execution object from `POST /api/enrichment/fingerprint-view/backfill` or the next fingerprint save; the view request does not reread every fingerprint.

## Failure behavior

`GET /api/enrichment/status` returns the latest run with trigger, start/finish, checked/added/updated/failed, and queue status with remaining count, last batch stage/reason, and next catch-up time. The programme API does not read enrichment storage. A failed recompute keeps the previously committed prediction and its history, and the UI continues to show the programme. Ordinary successful checks need no ChatGPT notification; the Site's Events panel and footer expose progress. `GET /api/enrichment/footer/status` also returns `integrations` for that footer: watchlist, ratings, EPG ingestion, film recognition and predictions. The states come from the stored job results. The route still does not start a sync, a ratings refresh, or recognition. Ratings health is the later of `sync.json` `ratingObservedAt` / `ratingError` and the ratings status document. `manualRefreshEnabled` is false while `RATINGS_REFRESH` is unset; that note is separate from the source state, and an older blocked status does not override a newer EPG films success. A watchlist fetch that fails before `sync.json` is replaced is recorded in `watchlist-ingest.json` with a fixed code and a timestamp. Recognition uses the current programme run: a normal `epg_committed` or `chunk_budget` continuation is in progress, and a previous generation's completion is not this generation's success. A stored ratings or watchlist failure does not change the EPG or prediction state.

## Submit validation contract

One declarative contract drives both the `POST /api/enrichment/submit` validator and `GET /api/enrichment/schema`, so a caller can run the same checks before `prediction_submit` and, when the Worker still rejects an item, learn which field failed. The rule tables (`FINGERPRINT_RULES`, `PREDICTION_RULES` in `src/enrichment.js`) are the only source of field names, enum lists, list sizes and lengths; the validator interprets them, and the schema route serialises them. Among the rules: `payoff` and `ending_quality` take `weak | mixed | strong | unknown`, `hero_vulnerability` takes `low | mixed | high | unknown`, `moodLabels` holds 2–4 labels of at most 45 characters, the thirteen general `execution` dimensions are required and the genre dimensions are optional. A fingerprint or prediction that the rules accept is stored unchanged; the rules do not alter the stored payload.

`GET /api/enrichment/schema` returns its descriptive fields and `contract`:

| Field | Meaning |
| --- | --- |
| `contract.version` | `1` |
| `contract.fingerprint.rules`, `contract.prediction.rules` | One rule per field. `kind` is `const` (`value`), `enum` (`values`), `enum_list` (`values`), `enum_object` (`fields` with the allowed values per key, `required`, `optional`), `text_list` (`minItems`, `maxItems`, `maxLength`), `ref_list` (as `text_list`; each item is an `https://` URL or `model_knowledge`), `number` (`min`, `max`, optional `step`) or `text` (`maxLength`, `nullable`) |
| `contract.fingerprint.maxChars` | Serialised size cap of an otherwise valid fingerprint (`12000`) |
| `contract.issueCodes` | `required`, `invalid_type`, `invalid_version`, `invalid_enum`, `too_few`, `too_many`, `empty`, `too_long`, `out_of_range`, `invalid_step`, `invalid_ref`, `too_large` |

A rejected item in the `submit` response keeps its previous shape (`status: retryable_failure`, `error: parse_error`, `failureScope: item`, `retryable`, `retryAt`) and adds `validation`:

```json
{"filmId":"tmdb_1","status":"retryable_failure","error":"parse_error","failureScope":"item","retryable":true,"retryAt":1792957895257,
 "validation":{"stage":"fingerprint_schema","reportedBy":"worker","issues":[{"path":"fingerprint.execution.payoff","code":"invalid_enum"},{"path":"fingerprint.moodLabels","code":"required"}]}}
```

`stage` is `fingerprint_schema` or `prediction_schema` (the Worker rejected the submitted object), `fingerprint_missing` (the film has no current fingerprint and none was submitted; `issues` is `[{path: "fingerprint", code: "required"}]`) or `caller_reported` (the caller sent `failure.kind`; `issues` is empty). `path` is `fingerprint` or `prediction`, optionally followed by the field and, for `execution`, the dimension; a list issue names the list, not the item. At most 20 issues are reported, in rule-table order. The same `validation` object is stored on `run.failures[filmId]` and copied into the queue `retries` record, and [`prediction_film_diagnostics`](prediction-diagnostics.md) returns it as `retry.validation` after re-checking every path and code against the vocabulary. A system failure (`storage_error`, run scope) carries no `validation`: a schema violation, a model output the caller could not parse and a storage or API failure are three different records.

### Preflight before submit

The executable preflight is the read-only MCP tool `prediction_validate` ([MCP reference](mcp.md)): the caller passes the complete `fingerprint` and/or `prediction` it intends to submit and receives `valid` plus the same `issues[{path, code}]` the submit would report, with no storage access, no run or lease involvement and no recorded failure. A client that cannot call the tool can evaluate `contract` itself; `tests/submit-validation.mjs` contains a generic evaluator over the published JSON that reproduces the server's issues, which is the parity test for the contract. Either way the Worker validates again on `submit` and is the enforcement point: a caller that skips the preflight is not blocked, it is corrected per field after the fact. Whether the external ChatGPT Scheduled Task performs the preflight is decided by that task's prompt, which is outside this repository and changes only with owner approval; the repository can offer the tool and the contract, not make the client call them.

The validation summary does not alter item-failure semantics: a rejected item is a retryable `parse_error` with the ordinary backoff, re-delivery of the same film is idempotent and returns the stored `validation`, five consecutive distinct format failures stop the run as `format_error_storm`, and the [run-step diagnostic](run-diagnostics.md) `itemValidation.stages` entries keep their `{stage, reportedBy}` shape. The thrown validator message, the payload, the model output and the film title are never copied into the response, the run record, the queue or a log line; only paths and codes from the closed vocabulary are. The runner contract (`GET /api/enrichment/runner`, `itemFailures.validation`) and the MCP tool descriptions point the caller at the contract before `submit`. A retry record without a validation summary gains one only at that film's next rejection; nothing resets or retries deferred films.

## Letterboxd personal ratings and runtime

Film runtime is already parsed from each Letterboxd film page as minutes and is included in the programme snapshot. Some unreleased films have no published runtime; their value remains `null` until Letterboxd supplies it. The card displays runtime when available.

The user's own rating is fetched from the public member-film page (`https://letterboxd.com/demo-user/film/<slug>/`) and identity-checked against the exact film URL and member before persistence. It is stored in `enrichment/films/<id>/actual.json`, never in a fingerprint or prediction input. A missing member-film page means no verified rating from that source; it does not erase an older known rating.

After a successful programme commit, the existing daily sync checks newly added watchlist IDs (including re-added films with cached metadata), refreshes already known ratings, and retries transient rating failures on the next run. A failed rating lookup never rolls back programme or watchlist data. One-time or later manual audits can call `POST /api/enrichment/ratings/backfill` with `{"cursor":0,"batchSize":10}` and continue using `nextCursor` until `done`; pass the first response's `programmeRunId` to detect a changing source snapshot. Results include saved, unchanged, not_found, not_rated or a per-film error. This endpoint only writes ratings; it does not update the programme timestamp.

## EPG resolver / hot–cold pipeline (v2)

Normalization, service prefix/year extraction and explicit series/show filtering run locally, without an LLM. Candidate title keys are **not** film identities: only a confirmed TMDB movie ID is canonical (`canonicalIdentity: tmdb:<id>`). RU/UK/EN translations and alternative titles are retained as aliases; yearless aliases are reused only when the cached identity and runtime are unambiguous. Unconfirmed candidates remain unresolved with a bounded retry time.

The canonical cache is persistent, independently of current broadcasts. `hot` is evaluated against the actual current clock: show start in the last 72 hours or next 24 hours. Older cache records temporarily use `epgLastAiring` until the next EPG scan supplies actual timeslots. The forecast queue contains missing/stale **hot** catalogue films, then any remaining watchlist work; cold EPG catalogue films are deferred. Newly resolved/promoted hot films sort before the older hot backlog. Repeat broadcasts update availability/aliases only, without changing fingerprint or prediction freshness.

`POST /api/enrichment/discovery/resolve` keeps the existing `limit` (1–24) contract. A chunk is also bounded by 22 seconds and 16 TMDB requests, with 200 ms pacing. Each confirmed cache record and resolution decision is persisted individually; a conditional R2 lease prevents overlapping resolver writers. On restart, already confirmed identities are reused. HTTP 429 retains work and stores `retryAt`; no busy retry loop. Ambiguous/no-match decisions remain unresolved with exponential daily retry, capped at seven days.

One request runs one discovery chunk and does not schedule another. A separate HTTP request does not guarantee a new Cloudflare isolate; one chunk per request is a memory hypothesis to verify in production after this change is deployed. `chunks:0` reports the contract without running a chunk. The `DiscoveryContinuation` entrypoint (`src/continuation.js`) stays internal-only and also runs one chunk. Public HTTP always reaches the default export, so the entrypoint has no internet-facing route. A public self-fetch is not a fallback: Access would refuse it, and Cloudflare rejects a Worker's subrequest to its own zone (error 1042). No cookie, Access JWT, `OAI-Sites-Authorization`, or other credential is forwarded or stored. The Sites-era `EPG_SITE_SERVICE_TOKEN` is no longer read.

`epg/resolver-continuation.json` (shown as `continuation` in pipeline status) records `paused` (`epg_committed`, `scan_committed`, `chunk_budget`, `backoff`, `programme_changed`), `running`, `complete`, or `error`. A live lease (`expiresAt` still in the future) returns `discovery.state: busy` and `nextAction: wait` without overwriting the continuation or writing decisions. An expired lease is not deleted ahead of that call.

### Live and orphaned `running` records

A `running` record names the hop (`hopId`) that opened it and the budget that hop had (`remainingChunks`). The raw record cannot say whether that hop is still writing, so pipeline status derives `continuationHealth` from the record, the resolver lease `epg/resolver-lease.json` and the last discovery status `epg/discovery-status.json`, and every continuation response carries the same derivation as `diagnostic.health`:

| `continuationHealth.status` | Meaning | Contract for a `running` record |
| --- | --- | --- |
| `live` | The lease is unexpired (`leaseHop` says whether it belongs to the record's hop or to another one). A writer is active. | `state: running`, `reason: busy`, `nextAction: wait`, `nextCatchUpAt` = the lease expiry (`leaseExpiresAt`) |
| `orphaned` | The lease is expired or missing: the hop did not reach its checkpoint and has been silent for at least one lease TTL. The most likely cause is an interrupted invocation (a thrown handler normally leaves an `error` record), but a failure in the lease release, in the checkpoint write or in the best-effort diagnostics write leaves the same picture; the cause of a given orphan is an inference, not something the record proves. | `state: running`, `reason: orphaned`, `nextAction: continue`, `remainingChunks` = `resumeBudget` |
| `settled` / `idle` | The record is not `running` / there is no record. | Unchanged contract |

For an orphan, `chunkCompleted` says whether the dead hop's own chunk finished. Every status a chunk writes to `epg/discovery-status.json` (the cheap-pass checkpoint, the final summary, the programme-changed summary; `lastBatch` in pipeline status) carries the `hopId` of the lease that wrote it, and a `running` record names the published generation it pins to. The chunk counts as completed only when the last status has a `finishedAt`, names the same `hopId` and the same `programmeRunId` as the record, matches the published generation, and started after the record was opened (`startedAt` ≥ `record.at`). The status object is shared, so a newer status written by another hop, a status without a hop marker (written before statuses carried one) or a cheap-pass checkpoint is not attributed to the orphan: the chunk is then run again with the budget the hop had, which can cost one extra chunk but never repeats a decision or resets the series. `resumeBudget` is the hop's budget minus one when the chunk is attributed, otherwise the full budget.

The next explicit `epg_sync_step` (or `POST /api/enrichment/discovery/resolve`) recovers an orphan in one call, atomically against the record it read:

1. **Generation fence.** When the record's `programmeRunId` differs from the published generation, the orphan is closed as `paused` / `programme_changed` with `remainingChunks: 0` (`nextAction: stop`) and no chunk runs; the next EPG commit queues discovery again.
2. **Settle.** When `chunkCompleted` is true, the record is replaced by the checkpoint the dead hop would have written from the persisted status (the same rule that turns a chunk result into `paused`, `chunk_budget`, `backoff`, `complete` or `programme_changed`), under the dead hop's `hopId`. The chunk's decisions and catalog writes were already stored individually, so nothing is repeated and `remainingChunks` moves by exactly that one chunk.
3. **Resume.** The ordinary decision then applies to the settled record: a chunk runs under a new lease and a new `hopId` when budget and backoff allow (`diagnostic.branch: chunk`, `recovery.action: settled`), or the call reports the settled contract without running one (`diagnostic.branch: orphan_settled`, for example `chunk_budget` / `wait` or `complete` / `stop`). When the chunk had not finished, the record is resumed directly with the hop's full budget (`recovery.action: resumed`).

Two fences protect the writes. **Continuation checkpoints** are compare-and-swap writes on the object's etag, and the final checkpoint is written only while the record still names the writing hop; `diagnostic.saved.write` reports `saved`, `other_hop` (another hop owns the record) or `write_conflict` (both conditional writes were rejected while the record still named this hop; the checkpoint is then reported as not stored, the record stays `running` and the next step settles it from the hop-marked status). A call whose record moved between its read and its write (another hop settled or opened it) releases its lease and answers `busy` / `wait` with `diagnostic.branch: record_changed`. **Chunk side effects** (decisions, catalog, programme showings, status, score preview, variant plan, prediction-queue checkpoint) are each preceded by a renewal of the hop's lease: the renewal is a conditional write that fails as soon as another hop holds the lease, and a failed renewal aborts the chunk before the write (`chunk.error: resolver_busy`, checkpoint `other_hop`). A lease therefore expires only after the hop has been silent for a whole TTL (90 s), and a hop that stalls past it cannot write over its replacement; the residual window is a single storage write of the old hop that itself lasts longer than the TTL. Concurrent callers end with exactly one owner per chunk and one budget decrement. One chunk per explicit call, the 12-chunk budget, backoff and `wait` times, idempotent decisions and the owner boundary are unchanged by recovery; no lease is reset and nothing is forced.

A caller that decides from the raw `continuation.stage` alone treats every `running` record as a live writer and never calls on an orphan. To recover one it must read `continuationHealth` (or the `discovery` contract of a `chunks: 0` report) and call `epg_sync_step` when the status is `orphaned`. The instructions of an external scheduled caller are operational configuration outside this repository; changing them is a separate, owner-approved step, and until it is taken an orphan is recovered only by an explicit, approved call.

Every EPG commit and discovery response includes `discovery`:

| Field | Meaning |
| --- | --- |
| `state` | `paused`, `running`, `complete`, `error`, or `busy`. A finished response is not left `running`; a `running` state in a report is a live writer (`reason: busy`) or an orphan (`reason: orphaned`), see above. |
| `remainingChunks` | Chunks still allowed in this series. A new series starts at 12. |
| `nextAction` | `continue`: call again now. `wait`: do not call before `nextCatchUpAt`. `stop`: do not call until the next EPG commit. |
| `reason` | Why the series is paused or waiting (`epg_committed`, `scan_committed`, `chunk_budget`, `backoff`, `programme_changed`, `busy`, `orphaned`, `idle`, `missing_secret`, an error code), or `null` between chunks. |
| `nextCatchUpAt` | Earliest time for the next call when `nextAction` is `wait`. |
| `retryAt` | Discovery backoff, when one is stored. |
| `programmeRunId` | Programme the chunk was reading, when known. |

`continue` is the response after the EPG commit (`reason: epg_committed`, `remainingChunks: 12`) and after a chunk that still has candidates and budget. `wait` covers the 12-chunk budget, a TMDB or storage backoff, a live lease, and an error whose catch-up time has not arrived. A call before that time does not start another series. Once `nextCatchUpAt` has passed, one new series may start. `stop` means the backlog is finished, the programme changed during the chunk, or there is nothing to resolve. `epg_sync_step` obeys `stop` until the next EPG commit. `POST /api/enrichment/discovery/resolve` may run one more chunk after `stop` when the catalog has new candidates; it still honors a live lease, `chunk_budget`, and `backoff`. A programme change skips the prediction-queue refresh; the next EPG commit queues discovery again. Decisions already saved for that chunk stay.

Since [AIR-151](https://trello.com/c/iZ7TR7y0) a continuation response from `POST /api/sync/epg` and every `POST /api/enrichment/discovery/resolve` response also carry `diagnostic`: the branch `advanceDiscovery` took and its intermediate outcomes (continuation record before, lease state, decision, hop id, chunk summary, continuation record after). The same step is logged as two `{"event":"epg_continuation"}` lines sharing one `id` (`entered` before any storage access, then the outcome) and stored best effort in `epg/resolver-continuation-diagnostics.json`, a ring of the last 20 step entries that `GET /api/enrichment/pipeline/status` returns as `continuationDiagnostics`. Every value is a code from a closed vocabulary, a UUID, a timestamp or a count; thrown messages are classified into error codes, never copied. The field list is in [the MCP contract](mcp.md#continuation-diagnostics-air-151). Nothing in it changes a decision, retries a call or writes on a `GET`.

`ratingsPending` on a completed sync is not a discovery signal. A later `epg_sync_step` does not retry Letterboxd. The rating attempt that belongs to the EPG commit still runs once inside that commit. [AIR-64](https://trello.com/c/WTnyO8bX) is a separate request, `POST /api/enrichment/ratings/refresh`, and it runs only when `RATINGS_REFRESH` is `on`. That variable is unset. A films-page HTTP 403 keeps the last complete ratings snapshot and is reported as `blocked`; it is not retried inside the request. `GET /api/enrichment/ratings/status` only reads. A successful refresh can fill a half-star rating on an existing watchlist removal event. It does not create a second event. A failed event write leaves the published ratings result successful. An incomplete diary page is `diary.cause: incomplete_page` and does not change the films result. See `docs/air-64-ratings.md`.

`POST /api/sync/epg` queues discovery after committing the programme. `POST /api/enrichment/discovery/scan` queues it after scanning `EPG_XML_URL`. Neither request runs the chunk. The prediction runner never waits for TMDB. No schedule change, new LLM invocation or recalibration is required. [AIR-62](https://trello.com/c/CU71gW4c) subsequently restored external ChatGPT Scheduled Tasks, without installing Worker Cron triggers.

`GET /api/enrichment/pipeline/status` separates normalized EPG candidate titles, excluded non-movies, unresolved candidates, unique confirmed TMDB films, hot/cold cached films, queued predictions, hot predictions and cold deferred work. These populations differ; candidate counts must never be presented as film counts. `GET /api/enrichment/queue/status` additionally exposes `hotCount`, `hotPredicted`, `coldCount`, `coldWithoutPrediction`, and hot `priorityCount`.

## Throughput v3

Urgent hot films expiring within 24 hours precede other hot films; cold backfill runs only when no hot predictions remain. Each next request rechecks priority, so newly urgent films preempt reserved cold work. Each submission checkpoints independently, and persisted forecasts survive an interrupted index update. Writer leases serialize mutations; failures retain retry state with bounded backoff.

Run results expose batchSize, hotProcessed, coldProcessed, failed, hotRemaining, coldRemaining and a sanitized reason. Discovery readiness is reported at 100 hot EPG predictions, with target 200, independently of backlog completion.

The isolated benchmark start/trial routes store shadow results only, without overwriting production predictions. The offline benchmark compares JSON payload overhead and parsing at 4/8/12/20; it does not measure model latency, billed tokens or prediction quality. Multiple fingerprints per model call remain disabled until an actual model benchmark establishes comparable outputs.

## Controlled mood vocabulary v1

Mood presentation uses 28 stable canonical IDs. The original fingerprint/prediction JSON, hashes, generatedAt, rating, probability and immutable histories are unchanged. `/api/enrichment/view` exposes only canonical moodIds and Russian vocabulary labels; raw values are not UI options or card tags. Count each film once per canonical ID, combining fingerprint and prediction labels. Pure plot mechanics produce no mood option. Unknown labels remain diagnostic only.

`POST /api/enrichment/moods/backfill` takes a cursor and optional limit (server caps the R2 scan to 12 objects per invocation). Continue nextCursor until done; retries are idempotent. It reads all persisted film records, including films outside the watchlist, and saves derived mood-facet sidecars and view-index facets. Historical raw labels are included in sidecar historyMoodFacets. Source records are never rewritten. New submissions apply the same versioned mapping when writing the view index and sidecar. `GET /api/enrichment/moods/diagnostics` exposes raw-to-canonical mappings, unknown labels and canonical per-film counts. Mapping changes do not invalidate fingerprints or forecasts.

URL mood params contain canonical IDs (e.g. mood=dark&mood=military). Exact legacy Russian vocabulary labels migrate to IDs; unknown old values are ignored. OR within moods and AND across filters are preserved.

[AIR-47](../../evidence/taxonomy/air-47-taxonomy-audit.md) audits this vocabulary and does not change it. Mapping v1 stays in force until [AIR-108](https://trello.com/c/QIke4H2N) implements an accepted successor.
