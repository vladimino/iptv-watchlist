# ADR 0177: Film and programme reads may fall back to existing R2 mirrors, best-effort, read-only and visibly degraded

**Status:** Proposed (retained until the corrected text is independently re-reviewed and approved by the owner)  
**Original decision date:** unknown (not yet decided)  
**Recorded at:** 2026-11-19  
**Approval source:** The availability-first direction and decisions A, B3, C1 and D1 are recorded by the Product Owner on [AIR-541](https://trello.com/c/0i308J15) and in the review of PR #791. The ADR text itself is not yet approved.  
**Related work:** [AIR-541](https://trello.com/c/0i308J15), [AIR-414](https://trello.com/c/GJefgNm8), [AIR-79](https://trello.com/c/485tlGLA), [AIR-531](https://trello.com/c/t5dNQxdC), [AIR-537](https://trello.com/c/wbe7jjNs); [ADR 0079](0079-d1-authoritative-published-epg.md), [ADR 0108](0108-epg-mirror-reconciliation-writer.md), [ADR 0162](0162-d1-only-authority-retire-rollback-toolchain.md)  
**Supersedes:** None (narrows ADR 0108 decision 1 and the fail-closed reader rule of ADR 0079 only for the degraded read path below; ADR 0162's refusal of non-`d1`/`open` markers is unchanged)  
**Superseded by:** None

## Context

D1 is the only authoritative database. `GET /api/programme`, `/api/watchlist`, `/api/catalog/available` and `/api/catalog/film/<id>` read the pinned D1 generation and fail closed with `published_epg_unavailable` or a typed 503 when D1, the EPG pin or Discovery cannot answer. On 2026-11-19 about 18:24-18:27 Madrid this produced 503/502 on film, programme and catalog routes and the client showed "Каталог сейчас недоступен" although earlier published data still existed in R2.

### Confirmed mirror contract (code at `main`, 2026-11-19)

- `PublishedEpg.writeMirrors` writes in this order: `epg/generations/<run>/programme.json`, root `programme.json`, root `watchlist.json`, `epg/generations/<run>/watchlist.json`, the pointer `epg/published-generation.json` (`{programmeRunId, phase}`), then the D1 marker (`mirror_programme_run_id`, `mirror_etag`, `mirror_watchlist_etag`) in a fenced update. The five-object update is not atomic and there is no commit manifest.
- **Generation-addressed copies are not immutable.** `putStable()` compare-and-set **overwrites** an existing key when its content differs. `replacePart()` (used by `patchProgramme` and `saveWatchlist`) rewrites the root object and the same run's generation copy after a D1 commit, and `repairMirrors()` may rewrite them again. A copy at `epg/generations/<run>/...` therefore identifies the **run**, not a frozen byte state.
- **`programme.json` carries `runId`; `watchlist.json` does not** (its shape is `{updatedAt, films}`). A watchlist object is tied to a run only by the key of its generation copy, or by the pointer and the D1 marker etags (the latter unreachable while D1 is down). The programme/watchlist pair is therefore a best-effort join, never a proven one.
- `PublishedEpg.readAuthority()` throws `published_epg_unavailable` for **both** transient D1 failures **and** structural refusals: partial or missing `published_epg*` tables, a `schema_contract` version below 8, and `mode !== 'd1'` or `cutover !== 'open'` (the intentional ADR 0162 fail-closed cases). The code alone cannot distinguish them today.
- `/api/catalog/film/<id>` needs the film **identity** from Discovery admission / Film-Person. `catalogFilmRoute()` returns its typed 503 when that identity refuses, **before** it reads the optional programme and watchlist context (which already degrade to "nothing known" and are listed in `degraded`).
- Read-only R2 inspection recorded on AIR-541 (by the owner's session, not repeated here): recent generation-addressed `programme.json` and `watchlist.json` mirrors exist, the **current run has no `discovered-films.json`**, and the root `discovered-films.json` mirror is historical. This ADR therefore does not rely on any R2 catalog identity copy.

## Owner decisions (settled; recorded on AIR-541)

- **A. No hard mirror TTL.** Verified stable fields stay visible with their own timestamps. A historical schedule is distinguished from an unverified *current* availability.
- **B3. Existing run ids and etags are a best-effort degraded join heuristic.** The owner knowingly accepts eventual-consistency risk. No new manifest writer and no strict cross-document atomicity requirement.
- **C1. Existing mirrors only.** A verified film identity is displayed from them if available; a Discovery-only film with no usable source gets a neutral shell. No new catalog or Discovery R2 writer.
- **D1. Last-known-good lives only in app-instance memory.** No persistence across reload.

## Decision (proposed)

1. **D1 stays the authority; R2 is a degraded read replica.** A healthy D1 never reads R2 for these routes, and no request is ever served from a mirror by default.

2. **Fallback classifier: temporary faults only.** The fallback runs only when the authoritative read ends in a *temporary* state, and `published_epg_unavailable` alone is not enough. Implementation must make the two classes distinguishable at the throw sites (a typed `temporary: true`/reason on the error, not message matching):
   - **Temporary (fallback allowed):** the D1 binding itself fails (transport error, timeout, overload) before or while the marker is read; `discovery_unavailable`, `discovery_fence`, `discovery_incomplete`, `film_person_unavailable`, `film_person_generation_moved`, `admission_unavailable`; `published_epg_fence` only after the existing one bounded D1 retry also fails.
   - **Structural (hard refusal, no fallback, unchanged):** a successfully read marker with `mode !== 'd1'` or `cutover !== 'open'`; missing/partial `published_epg*` tables; an invalid `schema_contract` version; `discovery_not_authoritative`, `film_person_not_open_read`, `canonical_read_not_authoritative`; a held cutover (`film_person_held`). These keep today's 503 and never reach R2.
   - **`published_epg_fence` (409, `retry:true`) keeps its meaning:** the client retries D1; a fence is never answered from a mirror on first sight.
   - Confirmed absence, retirement and conflict (404/410/409) are produced only from authoritative state and are **never** produced from a mirror.

3. **Per-object candidate selection, not per package.** For each needed object, candidates in order: the pointer's generation copy, the root mirror object, older generation copies by run id in the key. Each object is validated alone: JSON parses, bounded size, required fields, and for `programme.json` `runId` equals the run in its key (or the pointer for the root object). `watchlist.json` has no `runId`, so it is validated by shape (`films` array, `updatedAt`) and attributed by key. An invalid object is discarded and does not disqualify the others. Because copies can be overwritten within a run (see Context), no field is treated as frozen.

4. **Best-effort join (B3).** A programme and a watchlist are joined only when both come from the same run key (or the root pair whose programme `runId` equals the pointer run). This is a heuristic: the response labels the join `joined:"best_effort"` with each document's own `asOf`. If no pair qualifies, the independent objects are shown without joined facts. No cross-run derived fact is computed.

5. **Freshness (A).** No TTL. Each object carries its own `asOf` (programme timestamp, watchlist `updatedAt`). Schedule data (`shows`, `availableUntil`) is shown as a *historical schedule at `asOf`*. States that depend on "now" (`available`, `soon`, hot, last-chance, Discovery membership) are not recomputed against a stale snapshot and are shown as `unverified`; no fictitious show status is created.

6. **C1: film page identity from existing mirrors.** When the Discovery/Film-Person identity refuses with a *temporary* fault, `catalogFilmRoute()` no longer exits at once: it attempts a mirror identity lookup. A film identity is *verified from a mirror* only if a validated programme object (`films` or `catalogFilms`) or watchlist object contains an entry whose TMDB id equals the requested id exactly (`tmdb_<id>` / `tmdbId`), with the minimal fields the page needs (id, title). If two valid candidates disagree on title or year for the same id, the identity is unproven (neutral shell), never a 409. The answer is `200` with `source:"mirror"`, `readOnly:true`, and only the fields the mirror holds; D1-owned facts (predictions, fingerprints, owner facts, ratings) and metadata are omitted and listed in `degraded`. A direct `/film/<id>` load and a reload use the same path. For a Discovery-only film with no usable mirror entry, the API keeps its typed `503 unavailable` (with `reason`) and the HTML/client render the neutral shell "Сведения пока не загружаются" with a retry; the HTML document status stays 200 for a fault and is never turned into 404/410.

7. **Write fence (server-enforced).** A `readOnly:true` GET and disabled controls are not the fence. Rules:
   - No mutating handler ever reads from the mirror reader. Every mutation (`POST /api/started`, `POST /api/catalog/watched`, ratings and owner-fact writes, `/api/ui/filter-presets` POST/PATCH/DELETE, sync/executor routes) keeps its own authoritative D1 read-and-fence first and answers a typed 503 when D1 cannot answer, exactly as today. The degraded read module is not importable by write paths (enforced by a static test).
   - **Degraded-origin contract:** a client that rendered from a mirror sends `X-Data-Origin: mirror` on mutating requests. The server refuses it with `409 degraded_origin_write_refused` even when D1 has recovered, so a stale degraded page cannot write after recovery until it completes an authoritative refresh. Film-dependent writes additionally accept `X-Expected-Run: <runId>`; a mismatch with the current pin answers `409 published_generation_changed`. Requests without these headers behave exactly as today, so normal mode has no new write refusal.
   - GET/HEAD perform no R2 PUT, no reconcile, no SQL write. Authority transitions (held, switching) refuse writes through the existing gates.

8. **Client.** A compact "Сохранённая копия · обновлена …" note names source and `asOf`; write controls are disabled with tooltip and aria text; no optimistic writes. **D1:** the last good result is kept only in app-instance memory (a transient error keeps what is shown) and is lost on reload; nothing is persisted. After D1 recovers, the normal source and write actions return only after a successful authoritative refresh.

9. **Observability.** Additive diagnostic fields `source=authoritative|mirror`, `runId`, `asOf`, `readOnly`, typed `reason`, `joined`; events for fallback activation, success/failure, age, validation failure and automatic recovery, with no personal data and de-duplicated to avoid spam. The normal response shape is unchanged.

## Test plan (acceptance for the implementation)

Offline, isolated fault injection only; no production write:

- **Healthy D1:** identical responses and statuses as before, and **zero additional R2 GET/HEAD** on the normal hot path (instrumented bucket).
- **Classifier:** transient D1 error, Discovery/Film-Person temporary faults and `published_epg_fence` retry fall back; wrong marker, missing tables, bad schema version, held cutover and non-authoritative codes do **not**.
- **Races:** pointer older/newer than root and copies; same-run overwrite between two reads (`putStable` change, ABA); programme-only, watchlist-only, different runs.
- **Objects:** corrupt or truncated JSON of one object with a valid sibling gives partial rendering, not a global 503.
- **Freshness:** stale timestamps and time-sensitive claims (`available`/`soon`/hot are `unverified`, historical schedule labelled).
- **Film page (C1):** cold-loaded `/film/<id>` and reload with a mirror identity; conflicting candidates and Discovery-only film give the neutral shell; HTML 404/410/409 for authoritative absent/retired/conflict is unchanged and never produced from a mirror.
- **Write fence:** direct POST with D1 down is refused with no R2 PUT; a `X-Data-Origin: mirror` write after D1 recovery is refused; `X-Expected-Run` mismatch is refused; authority-transition (held) write rejection; normal-mode writes unaffected.
- **LKG (D1):** memory-only; reload loses it; transient error keeps it; recovery refresh restores the normal source.
- Real rendered browser QA (desktop and mobile, Back/Forward, focus/keyboard, disabled states, network request check) as the card requires.

## Alternatives considered

- **Global `isMirrorComplete ? render : fail`.** Rejected by the owner: one bad object becomes a total outage.
- **Fallback on `published_epg_unavailable` alone.** Rejected: it also encodes structural ADR 0162 refusals.
- **Silent R2 fallback for any error.** Rejected: hides D1 faults and risks a mirror on a normal read.
- **New `manifest.json` commit proof (B option b) / new R2 catalog copy (C option b).** Not chosen: the owner accepted B3 and C1.
- **Persistent browser LKG.** Not chosen (D1 is memory-only).
- **Restoring R2 as co-authority.** Rejected: contradicts ADR 0079 and ADR 0162.

## Consequences

- Reads survive a short D1/EPG/Discovery outage for any film that appears in a valid mirror object; films known only to Discovery still get only a neutral shell.
- Mirror staleness and the best-effort join become user-visible and are labelled; a rare eventual-consistency mismatch between a programme and a watchlist is knowingly accepted.
- New code paths and a typed temporary/structural error class in `published-epg.js`; a degraded-origin header contract on write routes with no effect when absent.
- No new writer, schema, flag, cron or Task.

## Recovery and migration boundary

This ADR authorizes no production operation: no R2 or D1 write, flag, schedule, Task, migration or sync. Rollback is a normal code revert to D1-only serving and does not touch stored data.

## Evidence

- **Original decision:** owner decisions A, B3, C1, D1 and the review of PR #791, recorded on [AIR-541](https://trello.com/c/0i308J15).
- **Implementation:** none.
- **Dated verification:** 2026-11-19 code reading of `src/published-epg.js` (`putStable`, `writeMirrors`, `replacePart`, `repairMirrors`, `readAuthority`) and `src/worker.js` (`catalogFilmRoute`, `loadJSON`, write routes); R2 object inventory as recorded on AIR-541 (current run lacks `discovered-films.json`; root copy historical). No production read or write was made by the author of this draft.
- **Uncertainty:** the exact D1 fault class of the 2026-11-19 incident (Observability not read here); retention of older generation copies; how often a programme/watchlist best-effort join is inconsistent in practice.

## Follow-ups

Implementation slices (typed fault classification, mirror reader and C1 identity, write fence, client note and memory LKG, observability, tests and browser QA) follow only after independent re-review and owner approval of this ADR.
