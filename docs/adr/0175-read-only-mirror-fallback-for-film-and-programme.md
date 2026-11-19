# ADR 0175: Film and programme reads may fall back to independently valid R2 mirrors, read-only and visibly degraded

**Status:** Proposed (owner architecture approval required before implementation)  
**Original decision date:** unknown (not yet decided)  
**Recorded at:** 2026-11-19  
**Approval source:** not documented. Owner intent (availability-first, read-only, quiet indicator) is recorded on [AIR-541](https://trello.com/c/0i308J15); the open decisions below are not approved.  
**Related work:** [AIR-541](https://trello.com/c/0i308J15), [AIR-414](https://trello.com/c/GJefgNm8), [AIR-79](https://trello.com/c/485tlGLA), [AIR-531](https://trello.com/c/t5dNQxdC), [AIR-537](https://trello.com/c/wbe7jjNs); [ADR 0108](0108-epg-mirror-reconciliation-writer.md), [ADR 0162](0162-d1-only-authority-retire-rollback-toolchain.md)  
**Supersedes:** None (proposes to narrow ADR 0108 decision 1 and the "fail closed" reader rule of ADR 0079 only for the degraded read path below)  
**Superseded by:** None

## Context

D1 is the only authoritative database. `GET /api/programme`, `/api/watchlist`, `/api/catalog/available` and `/api/catalog/film/<id>` read the pinned D1 generation and fail closed with `published_epg_unavailable` or a typed 503 when D1, the EPG pin or Discovery cannot answer (`src/worker.js` `loadJSON` / `catalogFilmRoute`, `src/published-epg.js`). On 2026-11-19 about 18:24-18:27 Madrid this produced 503/502 on film, programme and catalog routes and the client showed "Каталог сейчас недоступен" although earlier published data still existed in R2.

Confirmed from code (read-only inspection, no production access):

- `PublishedEpg.writeMirrors` writes five R2 objects in this order: `epg/generations/<run>/programme.json`, root `programme.json`, root `watchlist.json`, `epg/generations/<run>/watchlist.json`, then the pointer `epg/published-generation.json`, then the D1 marker (`mirror_programme_run_id`, `mirror_etag`, `mirror_watchlist_etag`) in a fenced update. Each put is a compare-and-set on the previous etag. There is **no commit manifest** and no per-object run/digest record beyond those etags in D1.
- The five-object update is not atomic. Root `programme.json` and `watchlist.json` can belong to different runs, and the pointer can be older than the root objects. A reader cannot prove a joint generation from R2 alone, except through the `runId` inside each document and the run id in the generation-addressed key.
- The generation-addressed copies are immutable per run once written and are the only R2 objects with provable provenance (run id in the key). Their retention is not established here.
- `/api/catalog/film/<id>` needs the film **identity** from Discovery admission (D1 when the Discovery marker is `d1`), not from programme/watchlist. The programme carries identity and shows only for `films` and `catalogFilms`. Whether R2 still holds a usable `epg/generations/<run>/discovered-films.json` or `titles.json` copy under D1-owned Discovery is not proven by the code comments, which say there is no R2 catalog copy then.
- The film page already degrades optional context (programme, watchlist, index, profile, metadata) to "nothing known" and lists them in `degraded`; it fails only when the **identity** read or a D1-owned fact domain is unavailable.

So a mirror fallback for the programme and watchlist routes is feasible, but a fallback for a *film page* is only as good as the identity source, which the mirrors may not contain.

## Decision (proposed)

1. **D1 stays the authority; R2 is a degraded read replica.** The fallback runs only when the authoritative read fails with a typed temporary fault (`published_epg_unavailable`, `discovery_unavailable`, `discovery_fence`, `discovery_incomplete`, `film_person_unavailable`, a D1 transport error). A healthy D1 never reads R2 for these routes. `published_epg_fence`, confirmed absence, retirement and conflict keep their current 404/410/409 and are never replaced by a mirror.
2. **Candidate order per object, not per package:** current pointer's generation copy, then root mirror object, then older generation copies with run id in the key. Each object is validated alone (JSON parses, `runId` matches its key or pointer, required fields, bounded size). An invalid object is discarded and does not disqualify the others.
3. **No derived cross-object facts without a proven link.** Availability, hot, membership and comparison are computed only from objects with equal `runId`. Otherwise independent fields are shown with their own `asOf` and availability-sensitive facts are omitted.
4. **Read-only by construction.** A degraded response carries `source=mirror`, `runId`, `asOf`, `readOnly=true` and a typed `reason` as additive fields. Every write route (`/api/started`, watched mark, ratings, filter presets, sync) refuses with a typed 503 unless it runs in an authoritative, fenced context; the server enforces this independently of the UI. GET and HEAD perform no R2 PUT, no reconcile and no SQL write.
5. **UI:** a compact "Сохранённая копия · обновлена …" note, write controls disabled with tooltip and aria text, client keeps the last good result on a transient error, and returns to the normal source only after a successful authoritative refresh.
6. **No invented data.** With no usable source the page shows a neutral "Сведения пока не загружаются" shell with retry, never a 404/410.

## Open decisions for the owner

These were named on the card as not pre-approved. Each needs an answer before code:

- **A. Maximum snapshot age** shown as a fallback (none / 72 h / 168 h, matching the retention horizon). Older data is shown only with its date, or not at all.
- **B. Commit proof.** Either (a) accept the existing run ids and the D1 marker etags as sufficient provenance and add no new writer, or (b) add a small `epg/generations/<run>/manifest.json` written last by `writeMirrors`. Option (b) is a writer change and needs its own approval.
- **C. Film outside programme and watchlist.** A film that is only in the Discovery catalog has no R2 source today. Options: show only the shell, or add a generation-addressed R2 copy of the catalog identity (a new mirror writer).
- **D. Client LKG scope.** Whether the browser keeps a last-known-good copy of the film page and programme (and for how long), and whether it may show it after a reload.

## Alternatives considered

- **Global `isMirrorComplete ? render : fail`.** Rejected by the owner on the card: it turns one bad object into a total outage.
- **Silent R2 fallback for any error.** Rejected: it hides D1 faults and risks serving a mirror to a normal read.
- **Restore R2 as a co-authority.** Rejected: contradicts ADR 0079 and ADR 0162.
- **Client-side cache only.** Insufficient on a cold load, which is the incident case.

## Consequences

- Reads survive a short D1/EPG/Discovery outage for any film whose data exists in a valid mirror object.
- New code paths to test: pointer older/newer than copies, programme-only and watchlist-only, different runIds, ABA during a read, corrupted object with a valid sibling, stale date, Discovery-only film.
- Staleness of mirrors (hourly reconcile) becomes user-visible, which is intended and labelled.
- Normal hot path gains no R2 reads, to be proven by a test.

## Recovery and migration boundary

This ADR authorizes no production operation. No R2 or D1 write, flag, schedule, Task, migration or sync is required. Rollback is a normal code revert to D1-only serving; it does not touch stored data. Any manifest or catalog-copy writer (decisions B and C) is a separate writer change needing its own owner approval.

## Evidence

- **Original decision:** not yet decided; intent on [AIR-541](https://trello.com/c/0i308J15).
- **Implementation:** none.
- **Dated verification:** 2026-11-19 code reading of `src/published-epg.js`, `src/worker.js`, `src/enrichment.js`; no production read was made for this draft.
- **Uncertainty:** which R2 objects exist for the failing run and how long generation copies are retained; whether any R2 catalog identity copy exists under D1-owned Discovery; the incident's exact D1 fault class. These need safe read-only R2 metadata and Observability checks before decisions B and C.

## Follow-ups

Implementation card slices (offline contract and fault-injection tests, Worker fallback, write gate, UI, observability) follow only after owner approval of this ADR.
