# Enrichment API for «В эфире»

The Site is private. Use `get_site` for project `appgprj_REPLACE_ME` and its current `current_live_url` and `siwc_bypass_bearer_token`. Send the token only to that Site as `OAI-Sites-Authorization: Bearer <token>`. Never print or store the token. The browser uses the owner's normal Site session.

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

## Run a bounded batch (manual and scheduled)

After a successful programme commit or taste profile update, the Site reconciles a persistent `enrichment/prediction-queue.json` from every watchlist film whose prediction is missing or stale. Broadcast times never make a prediction stale. Films available in the current archive or next 24 hours come first, then the rest. A valid fingerprint is reused even when its prediction is stale. Programme sync succeeds even if queue reconciliation fails; the next batch reconciles again.

EPG discovery also stores long unmatched programme candidates in `epg/discovery-latest.json`; this is a candidate list, not a claim that every entry is a film. The Site secret `TMDB_API_READ_ACCESS_TOKEN` is used only server-side. At the start of each queued run, up to six unseen candidates are searched in TMDB. Only a unique exact title, compatible year (when present), and compatible runtime produces a stable TMDB film identity and metadata. Ambiguous, mismatched, and unmatched candidates are recorded separately and never passed to the prediction model. Verified films outside the watchlist join the same prediction queue under a `tmdb_<id>` key; a known watchlist TMDB ID takes precedence so duplicate forecasts are avoided. A later EPG timeslot does not invalidate the cached film fingerprint or prediction. `GET /api/enrichment/discovery/status` reports candidate, checked, pending, and verified counts. `POST /api/enrichment/discovery/scan` is a one-time bootstrap for the current EPG; daily programme sync refreshes the candidate list thereafter. TMDB failures leave candidates pending and do not stop watchlist or EPG sync.

1. Verify `GET /api/status` has a completed programme snapshot. If `GET /api/enrichment/profile` is 404, stop quietly. `GET /api/enrichment/queue/status` exposes `pendingCount`, `lastBatch`, and `nextCatchUpAt`.
2. `POST /api/enrichment/start` with `{"scope":"watchlist_all","mode":"queued","batchSize":4,"trigger":"scheduled"}` (use `manual` for a manual trigger). Queued mode is the default even when `mode` is omitted, so older callers cannot accidentally launch an unbounded run. `batchSize` defaults to 4 and is capped at 5. A response with `status:"noop"` needs no further calls. A still-active run is resumed; an abandoned run is marked partial, then its remaining work is selected again.
3. `POST /api/enrichment/next` with `{"runId":"...","batchSize":4}`. The response includes the current profile and at most the selected batch. Each item says `fingerprint_and_prediction` with safe metadata, or `prediction_only` with a cached fingerprint. Actual user ratings are deliberately absent.
4. For new fingerprints, return a `fingerprint` object according to `GET /api/enrichment/schema`. Every core `execution` field is required; use `unknown` when there is no evidence. Never infer execution quality solely from the premise. Use model knowledge and, where necessary, a targeted public web lookup. Keep `sourceRefs` to real HTTPS references or `model_knowledge`. Also return a `prediction` based on the full taste profile and fingerprint. There is no hand-coded scoring formula.
5. `POST /api/enrichment/submit` with `{"runId":"...","items":[{"filmId":"...","fingerprint":{...},"prediction":{...}}]}`. For `prediction_only`, omit `fingerprint`. A film's validation/storage failure does not roll back other films in the batch. Repeat transient HTTP failures at most twice; validation/model failures are reported in `results` and not repeated indefinitely.
6. Continue `next`/`submit` only within this selected batch, then `POST /api/enrichment/complete` with `{"runId":"..."}` and verify `GET /api/enrichment/status`. On a time/quota/error interruption, call `complete` with a short `reason` when possible. Completion writes one user-facing event; repeating it does not duplicate it. Submitted films leave the queue immediately, so the next hourly invocation resumes the remainder. If the job dies before `complete`, the next invocation expires its lease and records a partial batch. A no-op is cheap and silent.

The hourly Site schedule should start at 18:00 Europe/Madrid and continue each hour. It must execute one bounded batch per invocation, not a loop over the full backlog. The prior daily invocation is also bounded by the server default. A manual invocation uses the same queued API. Only explicit `mode:"legacy"` permits the old all-film selection for diagnostic compatibility.

The API persists fingerprints and prediction histories per film ID independently of watchlist membership. A later discovery scope can reuse both. New programme runs alone do not invalidate them. A profile or prompt version change only invalidates predictions; a fingerprint schema change invalidates fingerprints.

## Actual ratings

Actual Letterboxd ratings are stored separately with `PUT /api/enrichment/actual-ratings`:

```json
{"items":[{"filmId":"123456","rating":4.5}]}
```

Use `rating:null` to clear one. The film's actual rating never enters the `/next` model payload. The owner's UI can display actual and predicted ratings together. `GET /api/enrichment/view` supplies only current predictions to the UI while preserving stale prediction history internally.

## Failure behavior

`GET /api/enrichment/status` returns the latest run with trigger, start/finish, checked/added/updated/failed, and queue status with remaining count, last batch stage/reason, and next catch-up time. The programme API does not read enrichment storage. A failed recompute keeps the previously committed prediction and its history, and the UI continues to show the programme. Ordinary successful checks need no ChatGPT notification; the Site's Events panel and footer expose progress.

## Letterboxd personal ratings and runtime

Film runtime is already parsed from each Letterboxd film page as minutes and is included in the programme snapshot. Some unreleased films have no published runtime; their value remains `null` until Letterboxd supplies it. The card displays runtime when available.

The user's own rating is fetched from the public member-film page (`https://letterboxd.com/demo-user/film/<slug>/`) and identity-checked against the exact film URL and member before persistence. It is stored in `enrichment/films/<id>/actual.json`, never in a fingerprint or prediction input. A missing member-film page means no verified rating from that source; it does not erase an older known rating.

After a successful programme commit, the existing daily sync checks newly added watchlist IDs (including re-added films with cached metadata), refreshes already known ratings, and retries transient rating failures on the next run. A failed rating lookup never rolls back programme or watchlist data. One-time or later manual audits can call `POST /api/enrichment/ratings/backfill` with `{"cursor":0,"batchSize":10}` and continue using `nextCursor` until `done`; pass the first response's `programmeRunId` to detect a changing source snapshot. Results include saved, unchanged, not_found, not_rated or a per-film error. This endpoint only writes ratings; it does not update the programme timestamp.
