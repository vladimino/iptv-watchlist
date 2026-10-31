# ADR 0063: Terminal TMDB poster answers are remembered in one index and stay out of the ordinary queue

**Status:** Accepted 2026-10-31 (architecture only; no production execution authorization)  
**Original decision date:** 2026-10-31  
**Recorded at:** 2026-10-31  
**Approval source:** explicit owner approval in the AIR-302 / PR #282 conversation on 2026-10-31 (Europe/Madrid): ADR 0063 **Accepted**, and the rendered Mermaid in `docs/architecture/discovery-and-resolution.md` **visually approved**; [AIR-302 owner-decision record](https://trello.com/c/9rqjCMhy#comment-6ae5d030b513156865faa56b)  
**Related work:** [AIR-302](https://trello.com/c/9rqjCMhy); [AIR-283](https://trello.com/c/s35GwqRz); [ADR 0020](0020-owner-triggered-catalog-poster-hydration.md); [ADR 0048](0048-permanent-catalog-poster-maintenance-route.md)  
**Supersedes:** [ADR 0020](0020-owner-triggered-catalog-poster-hydration.md) in part: the completion invariant that a cursor followed until `done` settles every verified record without a poster. [ADR 0048](0048-permanent-catalog-poster-maintenance-route.md) in part: terminal `no_poster_on_tmdb` and `tmdb_id_mismatch` answers are retained, and the ordinary queue no longer revisits them  
**Superseded by:** None

## Context

`POST /api/enrichment/catalog/posters` asks TMDB again for every verified catalog record that still has no poster. Two of its answers do not change on the next call: TMDB returned the film and has no `poster_path`, or TMDB returned a different id. Those records stayed in the ordinary queue, so every later run spent a TMDB request on a result the owner had already seen. A transient failure (`tmdb_failed`, `429`, a lost lease, a changed generation) is different: it may succeed later and must stay in the queue.

The owner decided, on 31 October 2026, that a terminal answer is remembered on the server and kept out of the ordinary queue. The page must show that split, and one named record can be asked again only by an explicit confirmation. Browser history does not decide the queue.

## Decision

1. **One index, one object.** `epg/catalog-poster-negatives.json` is a versioned JSON object (`schemaVersion: 1`) whose keys are verified canonical numeric TMDB ids (`/^[1-9]\d{0,11}$/`), not catalog ids and not a generation. Each entry is `no_poster_on_tmdb` with `checkedAt` and `nextCheckAt`, or `tmdb_id_mismatch` with `checkedAt` only. The object is capped at 2,000 entries. An absent object is an empty index. A present object that is not this schema is unreadable.
2. **What is stored.** Only those two outcomes, and only from an explicit owner `POST` with `dryRun: false`. `tmdb_id_mismatch` is stored only when the HTTP 200 body carries a different valid positive numeric movie id (`/^[1-9]\d{0,11}$/`, a safe integer or that string). A 200 body whose id is missing, null, zero or not that form is retryable `tmdb_failed` and is not stored. `tmdb_failed`, `rate_limited`, `not_attempted`, `catalog_changed`, a lost lease and a changed generation are not stored. A failed write of the index is reported (`negativeSaved: false`, `negatives.persisted: false`) and is not treated as stored.
3. **The ordinary queue.** `GET /api/admin/posters` and the maintenance `POST` share one partition. No entry, or a `no_poster_on_tmdb` whose `nextCheckAt` has passed, is actionable. An unexpired `no_poster_on_tmdb` stays out for 90 days from `checkedAt`. A `tmdb_id_mismatch` stays out until the verified canonical id changes; it is never retried by an ordinary call. A poster that appears in either catalog copy drops the entry. `done` means the actionable queue was walked, not that every record without a poster was filled.
4. **One explicit recheck.** `recheck` is an array of one or more numeric TMDB ids, at most the call's limit, only with `dryRun: false` and with no cursor. It asks TMDB for those ids and ignores the index and the sweep cursor. An id that is not a verified record without a poster is `not_eligible` and is not requested. The page sends one such call, for one id, after its own confirmation. It does not move the sweep's saved position.
5. **The same guards.** The index is written only after the catalog writes of that call, under the resolver lease and the published-generation check, with one compare-and-swap and one retry. An unreadable index refuses the call with `503` before the lease and before any TMDB request, and the read reports the queue as unknown rather than empty. There is no new cron, Scheduled Task, feature flag, service or two-phase protocol.
6. **The page shows the split.** Counts are: without a poster, actionable now, no poster on TMDB until a date, TMDB identity to review, and without a verified id. Remembered answers are listed with their TMDB link, the date and the reason, at most ten per group in id order. There is no paging or search; the counts are the full numbers, and a recheck from the page can name only an id in that sample. `localStorage` shows this browser's runs only and does not control the queue. Old browser verdicts are not imported.

Not decided here: a production hydration run, any write to the live index, a migration of past receipts, or a cleanup of the object. The data-health poster summary still counts every verified record without a poster.

## Alternatives considered

- **Keep the answers only in the browser.** Rejected by the owner: another browser, or a direct `POST`, would ask TMDB again, and the queue would still contain records that cannot be filled.
- **A per-film object, a per-generation copy, or a Worker cron that expires entries.** Rejected: one compact object already fits the catalog, the next generation must see the same answers, and expiry is a date on the entry checked when the queue is built.
- **Remember every failure, including `429` and `tmdb_failed`.** Rejected: those are not terminal, and storing them would hide a record that the next call can finish.

## Consequences

- The ordinary queue is shorter than `verifiedMissing`. A sweep can report `done` while records without a poster remain, and the counts say why.
- A new TMDB id on the same catalog record is not blocked by the previous verdict. The old key is dropped once no verified record without a poster still carries it.
- At the cap, a new answer is not stored and is reported as such; the stored entries are kept. The next ordinary call asks for the unsaved id again.
- Code that predates this index treats every verified record without a poster as actionable. The object, if present, is then unused until this code is deployed again.

## Recovery and migration boundary

Reversible by a code revert. The revert does not delete the index; the two catalog copies and the EPG are untouched. Older code shows the previously remembered records in the ordinary queue again and does not write the index. No import, migration or cleanup is part of this decision. This record authorizes no production `POST`, no TMDB call and no R2 write; a deploy does not approve one.

## Evidence

- **Original decision:** owner decision on [AIR-302](https://trello.com/c/9rqjCMhy), 2026-10-31.
- **Implementation:** `src/discovery.js`, `src/admin/posters.js`, `src/admin/posters-run.js`, `public/admin-posters.js`.
- **Dated verification:** not recorded. Deterministic tests cover the queue, the 90-day return, an id change, a mismatch, a malformed HTTP 200 that stays retryable, transient errors, the cap, a lost compare-and-swap and an unreadable index. Production behaviour of the index is not established by those tests.
- **Uncertainty:** production behavior of the new negative index remains unverified until an explicitly authorized owner POST; accepting the ADR and deploying code authorize no such execution.

## Follow-ups

None inside this decision. A production hydration run, including the first write of the index, needs its own owner approval.
