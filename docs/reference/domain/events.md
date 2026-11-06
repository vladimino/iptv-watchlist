# Events log

The activity list reads objects under `events/items/`. The key is `events/items/<reverse-timestamp>-<id>.json`, so a page is newest first. `GET /api/events` returns one page and may also recover an undelivered prediction stop event. That route is not a safe production read. Clients ignore an event type they do not render. A rendered event shows its `at` in Europe/Madrid and does not show storage keys, hashes, prompts or profile text.

| `type` | When it is written | What the list shows |
| --- | --- | --- |
| `epg` | A programme commit | Counts of films and broadcasts |
| `watchlist` | A watchlist commit | Added and removed films |
| `ratings` | A Ratings run that ended (finished, error or closed as unknown) | One compact result: Diary rows checked, new facts, removals handled, honest error or interruption |
| `started`, `unstarted` | An owner mark on one film | The film title |
| `enrichment` | A prediction run's start, progress, stop or completion | Queue progress, separate from profile publication |
| `taste_profile` | One committed move of the taste-profile current pointer | Version transition, a short category and selective or global scope |

## Taste-profile publication

`PUT /api/enrichment/profile` writes this event only after compare-and-swap has made the version current ([publication contract](../api/enrichment.md#taste-profile-publication)). A dry run, a refusal, a lost compare-and-swap and a version record that is not current write none. The current pointer may be the R2 object or the D1 profile row. The event is always the R2 object above. The two writes are not one transaction.

```json
{"id":"taste-profile-3","type":"taste_profile","at":"2026-11-02T20:15:00.000Z","fromVersion":2,"toVersion":3,"changedFields":["horrorPreferences"],"scope":"selective"}
```

`id` and `at` come from the committed version (`taste-profile-<toVersion>` and that record's `updatedAt`), so a replay stores the same object and does not append another. `fromVersion` is the previous lineage link, or `null` when this version has no stored predecessor. `changedFields` are the field names the publisher already accepted, not the field text. `scope` is `selective`, `global`, `identity`, or `null` for the first version. The profile body, `profileHash`, approval and declaration hash are not copied.

The list turns one known field into a short category, several known fields into one summary line, and `identity` with no known field into a line that the content did not change. `selective` and `global` become «Влияние: выборочное» and «Влияние: глобальное». Any other scope adds no impact line. An unknown field name is not printed. Nothing in this event is a count of recalculated predictions.

If the event put fails, the publication response stays HTTP 200 and adds `publicationEvent: {recorded: false}`. Current stays where it is. The identical request then answers HTTP 409 `version_not_increasing`, does not move current, and records the missing event only when the committed version body has `tasteProfileEventExpected: true`. That field is server-written on the immutable version record. A version without it, including one that was already current before this writer, stays without an event; a caller-supplied field does not create one. A different body for that same version does not. The procedure is in the [publication runbook](../../runbooks/taste-profile-publication.md).

## EPG and watchlist events: publication, retry and idempotency

Contract of [AIR-359](https://trello.com/c/0IV9qKWR).

- **One `epg` event per published generation.** Its id is `<runId>-epg`, `at` is the published report's `updatedAt`, and `films`, `archive`, `future` and `broadcasts` are counted from that report. The journal is written only by `finishSync`, after the publication, so an attempt that never moved the pointer leaves no event.
- **Rescan inside a run.** If an earlier attempt of the same run failed before the pointer moved, the next scan builds the events again for the scan it is about to publish (`epgSync` rebuilds them when the saved `epg` event does not carry the new `updatedAt`). A run saved by earlier code that still carries an `epg` event of a superseded scan has that event rebuilt from the published report by `finishSync`.
- **Watchlist event.** Its diff (`added`, `removed`, `total`, `baseline`) is computed from the watchlist before the run and the run's watchlist, so a rescan yields the same delta. An event with no removal is rebuilt for the new scan and carries the published time. An event that reports removals keeps its key, and with it the time of the first scan of the run: the removal hand-over references the event by key (`events/items/<reverse-timestamp>-<id>.json`, derived from `at`), the commit hands the references to the removal queue **before** it publishes, and a queue entry cannot be re-pointed afterwards, so a rebuilt key would leave that reference dangling. For such an event `at` therefore denotes the watchlist observation (the first scan of the run that saw the removal), not the EPG publication. This is a contract decision that needs the owner's approval ([AIR-359](https://trello.com/c/0IV9qKWR) records the request); the alternative is to hand the references over only after the publication, which changes the commit order and needs its own card.
- **Idempotency.** A repeated `finishSync`, a resumed committed run and an events refresh write the same keys; no second event is created. Events written by earlier code are not rewritten, and ordering and pagination by key are unchanged.
- **Not covered.** A one-off correction of an event that was already written with a stale time (the 5 November 17:03 entry) is a separate owner-approved action: exact key, idempotency and readback. This contract changes code only.

## Ratings run result (`ratings`)

Contract of [AIR-361](https://trello.com/c/pKYwrxcZ). One immutable event per Ratings run that reached a terminal state in the run record (`finished`, `error`, or `unknown` when a stale or interrupted run is closed). Never one per film, per step or per heartbeat, and none for a run that never started or whose terminal state was not persisted.

| Field | Meaning |
| --- | --- |
| `id`, `runId` | `<runId>-ratings` and the run id. The Workflow instance id, the hour and the generation time play no part |
| `at` | The run's real end (`finishedAt`, or `closedAt` for an unknown close); the key is `events/items/<reverse-timestamp>-<id>.json` as for every event |
| `state`, `cause` | `finished` / `error` / `unknown`; `cause` is one of `failed`, `blocked`, `rate_limited`, `interrupted`, `abandoned`, `diary_off` or null |
| `trigger` | `scheduled` or `manual` |
| `coverage` | `recent_window` while only Diary page one was read; never «whole history checked» |
| `diary` | Counts only: `pages`, `rows` (checked), `added` and `updated` (Diary entries), `written` (facts written), `unchanged`, `skipped` (already recorded), `conflicts` |
| `removal` | `pending` at the start, `checked` lookups, `resolved` removals |

Written, read and unchanged are different numbers: 50 rows checked with one new fact reads «записей проверено 50, новых фактов 1». The payload carries no titles, ids, URLs, rating lists or raw Letterboxd content.

**Delivery.** The D1 run record is the source and R2 is a projection, and the two are not atomic. The event is built from the committed terminal state only and put with a create-only precondition, so a repeat finds the key and writes nothing. It is delivered right after the terminal commit, and again at the next look at the record: a start, a terminal read by the Cloudflare executor, the closing of a stale run, or an explicit reconcile. The run is marked `ratingsEventAt` once delivered. If the record is replaced before delivery, the event is carried on the new record (`pendingEvents`, at most three, five attempts each) and dropped after the bound with no further retry. A failed put never fails the run, never reads Diary again and never repeats a step; the status reads and writes nothing. Events for runs that ended before this change are not created.
