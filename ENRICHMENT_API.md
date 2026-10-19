# Enrichment API for «В эфире»

The production API is Cloudflare Worker `iptv` at `https://iptv.vladimino.workers.dev/`, private behind Cloudflare Access. Scheduled Tasks are off. Unattended authorization to Cloudflare is not configured, and this document does not define one.

`get_site`, `siwc_bypass_bearer_token`, and `OAI-Sites-Authorization` belong only to the legacy Site. They are not credentials for the Cloudflare Worker. Do not send them to `workers.dev`.

The prediction launch steps later in this file are historical. The current runner contract is [docs/prediction-runner.md](docs/prediction-runner.md). Do not start predictions from the historical steps while Scheduled Tasks remain disabled.

This subsystem uses a separate `enrichment/` R2 namespace. It does not write programme, watchlist, metadata, sync, or started records. It is safe for programme sync to work without it.

## Publish a taste profile manually from Project Movies

First read `GET /api/enrichment/schema`. `PUT /api/enrichment/profile` accepts:

```json
{
  "version": 1,
  "schemaVersion": 1,
  "profile": {
    "ratingScale": "How the 0.5–5.0 Letterboxd scale should be used",
    "positiveSignals": ["A specific positive pattern"],
    "negativeSignals": ["A specific negative pattern"],
    "characterLogic": "Rules for character decisions and competence",
    "pace": "Pacing preferences",
    "payoffEnding": "Weight of payoff and ending",
    "genrePreferences": "General genre preferences",
    "comedyPreferences": "Comedy-specific preferences",
    "horrorPreferences": "Horror-specific preferences",
    "scifiAdventurePreferences": "Sci-fi and adventure preferences",
    "actionPreferences": "Action preferences",
    "anchorFilms": [{"title":"Example film","rating":4.5,"reason":"Why it got this rating"}],
    "hardSkips": ["A severe negative pattern"],
    "calibration": "Guidance for predicted rating and probability 4+"
  }
}
```

Each text field must be nonempty. `anchorFilms` can be empty if no anchored actual ratings are ready. `positiveSignals`, `negativeSignals`, and `hardSkips` are string arrays. The server computes `profileHash`, stores an immutable version record, then changes the current pointer. Versions must increase. This is intentionally manual: the scheduled job never reads Project files or memory.

`GET /api/enrichment/profile` returns the published profile or 404 before publication. The Site footer displays the current version. Publishing a new version makes old predictions stale without deleting them or invalidating fingerprints.

## Run a bounded batch (manual and scheduled) — historical

This section is the older bounded-batch caller. It is not the current operating procedure. Follow [docs/prediction-runner.md](docs/prediction-runner.md) instead, and do not run either procedure until Scheduled Tasks are separately restored.

After a successful programme commit or taste profile update, the Site reconciles a persistent `enrichment/prediction-queue.json` from every watchlist film whose prediction is missing or stale. Broadcast times never make a prediction stale. Films available in the current archive or next 24 hours come first, then the rest. A valid fingerprint is reused even when its prediction is stale. Programme sync succeeds even if queue reconciliation fails; the next batch reconciles again.

EPG discovery accumulates normalized, unmatched programme candidates in a persistent resolver ledger. Candidate titles are not film identities. Local screening removes explicit non-movies; TMDB confirms canonical film IDs and aliases. The resolver is independent of prediction runs and rapidly continues bounded chunks in separate Worker invocations. Only available (hot) catalogue films with missing/stale forecasts enter the prediction queue; cold catalogue entries remain cached without blocking hot work. See the v2 pipeline contract below.

EPG titles are canonicalized before deduplication: known format prefixes such as `х/ф` are stripped, a trailing parenthesized or bare four-digit release year is parsed, and the original labels remain in `rawTitles`. The key keeps the year, so same-title remakes do not merge. `POST /api/enrichment/discovery/reconcile` migrates an already saved catalog once, preserves verified TMDB identities, backs up prior data, and retries uncertain results whose search title changed. TMDB search checks Russian and Ukrainian localized results within a 48-request budget per API call, preserving the candidate for a later batch if the budget is reached. Verified TMDB metadata stores Russian, Ukrainian, English, and alternative titles as aliases under one movie ID. A later candidate can reuse that identity without another TMDB request only when its alias, explicit year, and runtime agree with one known movie. Yearless titles and ambiguous remakes still require verification; different-language labels are never merged from text alone. The `reused` field in the batch result counts alias matches that avoided TMDB calls.

1. Verify `GET /api/status` has a completed programme snapshot. If `GET /api/enrichment/profile` is 404, stop quietly. `GET /api/enrichment/queue/status` exposes `pendingCount`, `lastBatch`, and `nextCatchUpAt`.
2. `POST /api/enrichment/start` with `{"scope":"watchlist_all","mode":"queued","trigger":"scheduled"}` (use `manual` for a manual trigger). Queued mode is the default even when `mode` is omitted, so older callers cannot accidentally launch an unbounded run. The server selects an adaptive bounded batch of 4/8/12/20 (or fewer for a small queue), capped at 20 and 12 minutes. Unknown usage caps it at 12; caller-reported remaining capacity caps it at 8 below 25% and 4 below 10%. Exhausted capacity preserves the queue as blocked, not a successful no-op. Legacy scheduled `batchSize:4` is a compatibility hint, not a cap. Fetch `GET /api/enrichment/runner` first for the current runner contract. A response with `status:"noop"` needs no further calls. A still-active run is resumed; an abandoned run is marked partial, then its remaining work is selected again.
3. `POST /api/enrichment/next` with `{"runId":"...","batchSize":1}`. The response includes the current profile and at most the selected batch. Each item says `fingerprint_and_prediction` with safe metadata, or `prediction_only` with a cached fingerprint. Actual user ratings are deliberately absent.
4. For new fingerprints, return a `fingerprint` object according to `GET /api/enrichment/schema`. Every core `execution` field is required; use `unknown` when there is no evidence. Never infer execution quality solely from the premise. Use model knowledge and, where necessary, a targeted public web lookup. Keep `sourceRefs` to real HTTPS references or `model_knowledge`. Also return a `prediction` based on the full taste profile and fingerprint. There is no hand-coded scoring formula.
5. `POST /api/enrichment/submit` with `{"runId":"...","items":[{"filmId":"...","fingerprint":{...},"prediction":{...}}]}`. For `prediction_only`, omit `fingerprint`. A film's validation/storage failure does not roll back other films in the batch. Repeat transient HTTP failures at most twice; validation/model failures are reported in `results` and not repeated indefinitely.
6. Continue `next`/`submit` only within this selected batch, then `POST /api/enrichment/complete` with `{"runId":"..."}` and verify `GET /api/enrichment/status`. On a time/quota/error interruption, call `complete` with a short `reason` when possible. Completion writes one user-facing event; repeating it does not duplicate it. Submitted films leave the queue immediately, so the next hourly invocation resumes the remainder. If the job dies before `complete`, the next invocation expires its lease and records a partial batch. A no-op is cheap and silent.

The hourly Site schedule should start at 18:00 Europe/Madrid and continue each hour. It must execute one bounded batch per invocation, not a loop over the full backlog. The prior daily invocation is also bounded by the server default. A manual invocation uses the same queued API. Only explicit `mode:"legacy"` permits the old all-film selection for diagnostic compatibility.

The API persists fingerprints and prediction histories per film ID independently of watchlist membership. A later discovery scope can reuse both. New programme runs alone do not invalidate them. A profile or prompt version change only invalidates predictions; a fingerprint schema change invalidates fingerprints. The UI index contains each current fingerprint's `plotMechanics`, mood facets, and the thirteen general execution dimensions. It does not replace or mutate the full saved fingerprint. Deploying the execution facet does not backfill older index entries; that needs a separately approved fingerprint-view backfill or the next fingerprint save. `POST /api/enrichment/fingerprint-view/backfill` with `{"limit":1..100,"cursor":"previousNextCursor"}` materializes older persisted fingerprints into that index in bounded batches; a null `nextCursor` means complete.

## Actual ratings

Actual Letterboxd ratings are stored separately with `PUT /api/enrichment/actual-ratings`:

```json
{"items":[{"filmId":"123456","rating":4.5}]}
```

Use `rating:null` to clear one. The film's actual rating never enters the `/next` model payload. The owner's UI can display actual and predicted ratings together. `GET /api/enrichment/view` supplies current predictions to the UI while preserving stale prediction history internally. Its fingerprint facet also includes the thirteen general `execution` dimensions when they were saved, omitting `unknown` and `not_applicable`. Genre-specific execution fields are not part of that facet. An older index entry receives the compact execution object from `POST /api/enrichment/fingerprint-view/backfill` or the next fingerprint save; the view request does not reread every fingerprint.

## Failure behavior

`GET /api/enrichment/status` returns the latest run with trigger, start/finish, checked/added/updated/failed, and queue status with remaining count, last batch stage/reason, and next catch-up time. The programme API does not read enrichment storage. A failed recompute keeps the previously committed prediction and its history, and the UI continues to show the programme. Ordinary successful checks need no ChatGPT notification; the Site's Events panel and footer expose progress.

## Letterboxd personal ratings and runtime

Film runtime is already parsed from each Letterboxd film page as minutes and is included in the programme snapshot. Some unreleased films have no published runtime; their value remains `null` until Letterboxd supplies it. The card displays runtime when available.

The user's own rating is fetched from the public member-film page (`https://letterboxd.com/demo-user/film/<slug>/`) and identity-checked against the exact film URL and member before persistence. It is stored in `enrichment/films/<id>/actual.json`, never in a fingerprint or prediction input. A missing member-film page means no verified rating from that source; it does not erase an older known rating.

After a successful programme commit, the existing daily sync checks newly added watchlist IDs (including re-added films with cached metadata), refreshes already known ratings, and retries transient rating failures on the next run. A failed rating lookup never rolls back programme or watchlist data. One-time or later manual audits can call `POST /api/enrichment/ratings/backfill` with `{"cursor":0,"batchSize":10}` and continue using `nextCursor` until `done`; pass the first response's `programmeRunId` to detect a changing source snapshot. Results include saved, unchanged, not_found, not_rated or a per-film error. This endpoint only writes ratings; it does not update the programme timestamp.

## EPG resolver / hot–cold pipeline (v2)

Normalization, service prefix/year extraction and explicit series/show filtering run locally, without an LLM. Candidate title keys are **not** film identities: only a confirmed TMDB movie ID is canonical (`canonicalIdentity: tmdb:<id>`). RU/UK/EN translations and alternative titles are retained as aliases; yearless aliases are reused only when the cached identity and runtime are unambiguous. Unconfirmed candidates remain unresolved with a bounded retry time.

The canonical cache is persistent, independently of current broadcasts. `hot` is evaluated against the actual current clock: show start in the last 72 hours or next 24 hours. Older cache records temporarily use `epgLastAiring` until the next EPG scan supplies actual timeslots. The forecast queue contains missing/stale **hot** catalogue films, then any remaining watchlist work; cold EPG catalogue films are deferred. Newly resolved/promoted hot films sort before the older hot backlog. Repeat broadcasts update availability/aliases only, without changing fingerprint or prediction freshness.

`POST /api/enrichment/discovery/resolve` keeps the existing `limit` (1–24) contract. A chunk is also bounded by 22 seconds and 16 TMDB requests, with 200 ms pacing. Each confirmed cache record and resolution decision is persisted individually; a conditional R2 lease prevents overlapping resolver writers. On restart, already confirmed identities are reused. HTTP 429 retains work and stores `retryAt`; no busy retry loop. Ambiguous/no-match decisions remain unresolved with exponential daily retry, capped at seven days.

Hosted resolver calls automatically continue in **new** Worker invocations, up to twelve continuation hops per trigger (`chunks:0` disables chaining for diagnostics). Sites consumes inbound service authorization before dispatching to the Worker. Therefore self-invocations use `EPG_SITE_SERVICE_TOKEN`, an encrypted production runtime secret configured through Sites. It is sent only to the same Site origin and never stored in code, R2 records, client assets, or schedule instructions. If service access is absent or continuation fails, status records the reason and the existing hourly resolver retries. The daily EPG writer also starts this chain after committing the programme; the prediction runner never waits for TMDB. No schedule change, new LLM invocation or recalibration is required.

`GET /api/enrichment/pipeline/status` separates normalized EPG candidate titles, excluded non-movies, unresolved candidates, unique confirmed TMDB films, hot/cold cached films, queued predictions, hot predictions and cold deferred work. These populations differ; candidate counts must never be presented as film counts. `GET /api/enrichment/queue/status` additionally exposes `hotCount`, `hotPredicted`, `coldCount`, `coldWithoutPrediction`, and hot `priorityCount`.

## Throughput v3

Urgent hot films expiring within 24 hours precede other hot films; cold backfill runs only when no hot predictions remain. Each next request rechecks priority, so newly urgent films preempt reserved cold work. Each submission checkpoints independently, and persisted forecasts survive an interrupted index update. Writer leases serialize mutations; failures retain retry state with bounded backoff.

Run results expose batchSize, hotProcessed, coldProcessed, failed, hotRemaining, coldRemaining and a sanitized reason. Discovery readiness is reported at 100 hot EPG predictions, with target 200, independently of backlog completion.

The isolated benchmark start/trial routes store shadow results only, without overwriting production predictions. The offline benchmark compares JSON payload overhead and parsing at 4/8/12/20; it does not measure model latency, billed tokens or prediction quality. Multiple fingerprints per model call remain disabled until an actual model benchmark establishes comparable outputs.

## Controlled mood vocabulary v1

Mood presentation uses 28 stable canonical IDs. The original fingerprint/prediction JSON, hashes, generatedAt, rating, probability and immutable histories are unchanged. `/api/enrichment/view` exposes only canonical moodIds and Russian vocabulary labels; raw values are not UI options or card tags. Count each film once per canonical ID, combining fingerprint and prediction labels. Pure plot mechanics produce no mood option. Unknown labels remain diagnostic only.

`POST /api/enrichment/moods/backfill` takes a cursor and optional limit (server caps the R2 scan to 12 objects per invocation). Continue nextCursor until done; retries are idempotent. It reads all persisted film records, including films outside the watchlist, and saves derived mood-facet sidecars and view-index facets. Historical raw labels are included in sidecar historyMoodFacets. Source records are never rewritten. New submissions apply the same versioned mapping when writing the view index and sidecar. `GET /api/enrichment/moods/diagnostics` exposes raw-to-canonical mappings, unknown labels and canonical per-film counts. Mapping changes do not invalidate fingerprints or forecasts.

URL mood params contain canonical IDs (e.g. mood=dark&mood=military). Exact legacy Russian vocabulary labels migrate to IDs; unknown old values are ignored. OR within moods and AND across filters are preserved.
