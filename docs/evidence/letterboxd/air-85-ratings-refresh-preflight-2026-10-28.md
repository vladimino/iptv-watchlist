# Ratings-only refresh: read-only preflight and GO/NO-GO packet

- **Card:** [AIR-85](https://trello.com/c/NVS7Ywdq). **Captured:** 28 October 2026, 15:37–15:50 UTC. **Code:** GitHub `main` at `b00d071`; production Worker `iptv` deployment `5663ba32…` of 13:35:46 UTC (version `94a2926d…`, the same `main`). **Published EPG generation:** `b2699929-0d83-4e8f-93f7-1f17de0edc24` (27 October, 16:06 UTC).
- **Scope:** everything the card's step 1 asks for, read-only: the live `RATINGS_REFRESH` binding, the ratings lease, backoff and snapshot state, the writers that touch the same objects, and the baseline a later outcome is compared with. No flag, Scheduled Task, Access, R2 or D1 change; no `POST`; no GET with a recovery side effect.
- **Sources:** Cloudflare API reads of the Worker settings, deployments and R2 object metadata/bodies (owner session, GET only); IPTV MCP `epg_status`, `epg_pipeline_status`, `enrichment_queue` (read-only tools); the code of `src/enrichment.js` (`ratingsRefresh`, `runRatingsFullRefresh`, `stageRatingsGeneration`, `finishRatingsGeneration`, `recoverPendingRatings`, `acquireRatingsLease`, `ratingsBackoffMs`) and `src/letterboxd-facts.js` (`applyFilmsListScan`, `stagedScan`, `casJSON`, `projectRecords`) at `b00d071`; `tests/ratings-refresh.mjs`.
- **Verdict:** **GO for the owner's decision**, with the conditions in section 4. Nothing was executed. The verdict is a preflight, not an acceptance.
- **Lifecycle / Used by:** input to the owner's separate GO on the temporary binding and on the single `POST` (AIR-85 steps 3–4). **Superseded by:** the outcome report of the same card once the test or a NO-GO decision is recorded.
- **Operational authority:** none. The owner executes every production action named here.

## 1. Live state

| Item | Observed | Meaning for the test |
| --- | --- | --- |
| `RATINGS_REFRESH` binding | **absent** from the Worker settings (read 15:38 UTC) | effective `off`; `POST /api/enrichment/ratings/refresh` answers 409 without reaching Letterboxd. Matches the register's last documented value. |
| `LETTERBOXD_FACTS` | `on` | the refresh's projection goes through the facts writer (`applyFilmsListScan`), not through a direct view-index rewrite: only changed fact records and a staged scan summary are written. |
| `LETTERBOXD_BASELINE_IMPORT` | `off` | the baseline import route is closed; no import writer competes. |
| `enrichment/ratings/*` | **no object exists** (`status.json`, `published.json`, `pending.json`, `lease.json`, `generations/`) | the AIR-64 route has never run in production. There is **no previous ratings generation to lose**, no held lease, no backoff (`nextRetryAt`) and no half-published generation to finish. A blocked outcome creates `status.json` only. |
| `letterboxd/facts/scans/films-list.json` and its `.pending.json` | absent | no films-list scan has completed since the facts gate was turned on (27 October 10:41 UTC); no open stage will be resumed by the refresh. |
| `letterboxd/facts/scans/watchlist.json` | scan `b2699929…`, 27 October 16:04 UTC, 396 films; its stage is `done` | the watchlist scan of the last commit completed; the refresh does not touch it. |
| `sync.json` | `runId b2699929…`, `stage complete`, `updatedAt 2026-10-27T16:06:38Z`, `ratingPending: ["public-films-list"]`, `ratingError: null`, `ratingRepair: null`, `ratingObservedAt: null` | the last commit's own films-list attempt never recorded an outcome: the resume-path invocation was killed in the ratings tail ([commit interruption RCA](../epg-commit-interrupted-2026-10-27.md)). Whether Letterboxd currently answers 403 is therefore **not known** from production data. |
| Letterboxd fact records | 438 objects under `letterboxd/facts/films/`, newest 28 October 06:55 UTC; `links.json` 24,612 bytes, same time; no `conflicts.json` | the baseline import (AIR-173) and the owner marks are the only fact writers so far. |
| `enrichment/view-index.json` | 6,198,275 bytes, ETag `c1c00ae3…`, last modified 15:49:23 UTC; 2,783 entries, 232 with `actualRating`, 258 with `watched: true` (read 15:47 UTC) | rewritten every few minutes by the running prediction writer; its ETag is **not** a usable before/after fence for the ratings test. Ratings-owned comparisons use the ratings objects and the facts objects instead (section 3). |
| Prediction runner | run `92a21a9e…`, `scheduled`, running since 12:31 UTC, lease to 16:01 UTC; queue `hotRemaining 0`, `coldRemaining 9`; next nominal trigger 16:20 UTC | the continuous writer stays on. It writes the view index by compare-and-swap; the refresh's projection does the same (five attempts on contention). No stop is needed and none is proposed. |
| Discovery continuation | `paused / chunk_budget` on `b2699929…`, settled, hourly | writes only `epg/*` objects; disjoint from the ratings test. |
| Daily EPG Scheduled Task | 17:00 Europe/Madrid = **16:00 UTC** (DST ended 25 October) | its commit runs the **same films-list scan** (`refreshRatingsFromFilms` → `applyFilmsListScan`) and is the only other writer of the ratings-owned facts objects. Its outcome in `sync.json` (`ratingPending` cleared or `ratingError` set) is a free read-only signal of Letterboxd's current answer. |
| `programme.json`, `watchlist.json` | ETags `d4139c1d…` (16:06:22 UTC) and `575f8d62…` (16:06:24 UTC), 27 October | the refresh must leave both unchanged; the 16:00 UTC commit will legitimately replace them, so the check compares against the values read right before the `POST`. |
| Other open streams | AIR-222 stage 2 installed; AIR-74 snapshot work not running at capture (no fenced export observed; resolver and runner leases are the only live leases) | no fenced R2 snapshot to coordinate with at capture time; re-check at GO time. |

## 2. What the single `POST` does (code at `b00d071`)

1. `ratingsEnabled`: exact `on`, otherwise 409 and no fetch. `mode` must be `full` or `repair`; the test uses `{"mode":"full"}`.
2. `acquireRatingsLease`: `enrichment/ratings/lease.json`, 120 s, renewed before every page and every write; a second concurrent `POST` gets 409 `Ratings refresh is already running`.
3. `recoverPendingRatings`: nothing to recover (no `pending.json`). `nextRetryAt` backoff: none stored.
4. `readLetterboxdFilms`: `GET https://letterboxd.com/<user>/films/` and its `page/N/` pages (15 s timeout each, at most 60 pages; the 26 October export had 2,460 films, about 35 pages). A 403 with a challenge body, a 429, a non-OK status, an incomplete or inconsistent page returns a failure **without** staging anything.
5. On failure: `status.json` is written with `state: blocked` (anti-bot) or `degraded`, `lastFailureAt`, `nextRetryAt` (+1 h for 403, `Retry-After` capped at 6 h for 429, +15 min otherwise), `attempt.outcome blocked|failed`, `attempt.cause`, `attempt.error`, `attempt.page`; `generationId` stays `null`. No other object changes.
6. On a complete list: `stageRatingsGeneration` writes `generations/<uuid>.json` (immutable: `ratingsHash`, `publishedAt`, `pages`, `watched`, `ratings`) and `pending.json {generationId, startedAt}`; `finishRatingsGeneration` projects it (`applyFilmsListScan`: a staged scan summary at `letterboxd/facts/scans/films-list.json`, changed fact records only, for films that already have a record or are on the current watchlist, then one CAS write of the changed view-index entries), then `commitRatingsPointer` (CAS on `published.json`, `projected: true`), then `pending.json {done: true}`; `healthyRatingsStatus` decorates recent removal events with a half-star rating where one is confirmed (`enrichRecentRemovalRatings`, best effort) and writes `status.json` `healthy` with `lastSuccessAt`, `generationId`, `pages`, `watched`.
7. A crash between 6's steps leaves `pending.json` with the generation id; the next `POST` finishes it **without** calling Letterboxd (`recoverPendingRatings`). The pointer is switched only after the projection, so a half-finished generation is never the published one.
8. The route never writes `programme.json`, `watchlist.json`, `sync.json`, the prediction queue or `epg/*`. `tests/ratings-refresh.mjs` proves the 403-blocked path with the snapshot preserved, the backoff 409, the crash-and-recover paths for the index, the pointer and the observations, the lease, and that no EPG object changes.

## 3. Baseline for the outcome comparison

Ratings-owned objects (must be compared before and after the `POST`):

| Object | Before |
| --- | --- |
| `enrichment/ratings/status.json` | absent |
| `enrichment/ratings/published.json` | absent |
| `enrichment/ratings/pending.json` | absent |
| `enrichment/ratings/lease.json` | absent |
| `enrichment/ratings/generations/` | empty |
| `letterboxd/facts/scans/films-list.json`, `.pending.json` | absent |
| `letterboxd/facts/films/` | 438 records, newest 2026-10-28T06:55:50Z |
| `letterboxd/facts/links.json` | ETag `6c927d48…`, 2026-10-28T06:55:49Z |

Not ratings-owned (routine writers may change them; a change alone is not a violation): `enrichment/view-index.json` (prediction writer), `enrichment/prediction-queue.json`, `enrichment/latest-run.json`, `events/items/*` (prediction progress events), `epg/*` (continuation). Must stay unchanged **by the refresh**: `programme.json`, `watchlist.json`, `sync.json`, `epg/published-generation.json`; read their ETags immediately before the `POST`, because the 16:00 UTC commit replaces them legitimately.

Expected after a **success**: `published.json {generationId, projected: true}`, one object under `generations/`, `pending.json {done: true}`, `status.json {state: healthy, lastSuccessAt, generationId, pages ≈ 35, watched ≈ 2,460}`, `scans/films-list.json` with the same `total`, fact records changed only where a rating or watched value differed, `view-index` entries changed only for those films. Expected after a **403**: `status.json {state: blocked, attempt.cause: anti_bot, attempt.page: N, nextRetryAt: +1 h}` and nothing else.

## 4. GO / NO-GO criteria

**GO conditions (all required at execution time):**

1. Owner GO on the temporary binding, then a second owner GO on the single `POST` (two separate approvals, per the card).
2. `sync.json` is not in a running sync (`stage` is `complete`), the 16:00 UTC commit has finished (its `sync.json` outcome recorded, `programme.json` ETag stable for a few minutes), and no fenced R2 export (AIR-74/AIR-222 style) is in progress.
3. `enrichment/ratings/lease.json` absent or expired; `letterboxd/facts/scans/films-list.pending.json` absent or `done`.
4. The prediction runner may be running; no stop and no quiet window is required. Avoid starting the `POST` inside the commit's own ratings tail (roughly 16:00–16:15 UTC) so the two films-list scans do not stage against each other.

**NO-GO triggers (do not `POST`, record and stop):** the binding read-back does not show exactly `on`; a running sync; an open, not done films-list stage; a held ratings lease; a fenced snapshot in progress; or an owner decision to close the verification without the test.

**Rollback:** in every outcome the owner removes `RATINGS_REFRESH` again (back to absent, the baseline). A blocked or failed attempt leaves only `status.json`; a success leaves one immutable generation, the pointer and changed facts, which stay valid data and are not rolled back (deleting `enrichment/ratings/` would drop only this snapshot and status, per the contract). Nothing in the test needs a code deploy or a Worker rollback.

## 5. Production actions for the owner (each needs its own explicit GO)

1. **Binding on:** Cloudflare dashboard, Worker `iptv`, Settings → Variables: add plain text `RATINGS_REFRESH` = `on`, deploy (a dashboard deployment of a new version, `keep_vars` style; every other variable unchanged). Read-back by the agent: settings read shows the binding `on` and the new deployment id.
2. **One `POST`:** from an Access-authenticated browser session on `https://iptv.vladimino.workers.dev/`, in the devtools console:
   `await (await fetch('/api/enrichment/ratings/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"mode":"full"}'})).json()`
   and paste the JSON answer (it is the status view: state, attempt, generationId; no secret). No second call, no `repair`, no retry inside the backoff. A service token is not needed and not proposed.
3. **Read-back by the agent (read-only):** the objects of section 3, the `sync.json` / `programme.json` / `watchlist.json` ETags, the facts record count and the view-index counts.
4. **Binding off:** remove `RATINGS_REFRESH` again, deploy; read-back by the agent. The disabled-409 check needs another `POST`; it is safe (no Letterboxd call when off) but it is a separate owner decision whether to run it.

## 6. Risks and limits

- **Letterboxd 403 is likely.** The last known answer to the films list from the Worker was 403 (AIR-64 review, 23 October); the 27 October commit never recorded its attempt. The 16:00 UTC commit today gives a fresh signal before any GO: `ratingPending` cleared and `scans/films-list.json` appearing mean the list is readable; `ratingError` with `HTTP 403 … (anti-bot challenge)` means the `POST` will most likely end `blocked`. A `blocked` outcome is a valid, honest acceptance result under the card, not a failure of the procedure.
- **Request size.** About 35 sequential page fetches plus one 6 MB view-index CAS inside one Worker request. The standalone route does not carry the EPG scan that exhausted memory in the commit; this is the first production measurement of the route by itself.
- **Side observation, outside this card:** the dashboard deployment of 13:21 UTC left the Worker without `SCORED_RESOLUTION` (inert since `main` `247bf3c`) and without `LIFECYCLE_LOCALIZATION`. On the current `main` the second one still selects the localization of the programme/watchlist reads and of the EPG commit, so until [PR #198](https://github.com/vladimino/iptv-watchlist/pull/198) (AIR-89) is merged those paths run the **legacy** localization; today's 16:00 UTC commit will localize through it. Not a blocker for the ratings test; reported to the owner separately.
- The Worker cannot report the binding itself; the read-back above is a Cloudflare settings read, which is the authoritative source the flag register asks for.
