# Events log

The activity list reads objects under `events/items/`. The key is `events/items/<reverse-timestamp>-<id>.json`, so a page is newest first. `GET /api/events` returns one page and may also recover an undelivered prediction stop event. That route is not a safe production read. Clients ignore an event type they do not render. A rendered event shows its `at` in Europe/Madrid and does not show storage keys, hashes, prompts or profile text.

| `type` | When it is written | What the list shows |
| --- | --- | --- |
| `epg` | The successful end of an EPG run (its completion time) | Counts of films and broadcasts |
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

- **One `epg` event per published generation.** Its id is `<runId>-epg`, and `films`, `archive`, `future` and `broadcasts` are counted from the published report. Since [AIR-390](https://trello.com/c/apwh5ERU) its `at` is the **successful end of the run**: `run.completedAt`, the very value that becomes `sync.json` `updatedAt` when the run is `complete`, and so the footer's EPG time (`integrationHealth` `lastSuccessAt`). It is no longer the scan time (`report.updatedAt`), which still defines the archive and future windows the counts use. The event is written only when the run completes: by `finishSync`, or in the staged seal by the `epg_event` unit of the `queue` phase, never in `finalize`. A run that has not published or not completed leaves no event, so there is no false «Обновлён EPG».
- **Stable completion time.** `run.completedAt` is chosen once and saved to `sync.json` **before** the event is written. A retry, a resumed seal or a repeated `finishSync` reuses it, so the key `events/items/<reverse-timestamp>-<runId>-epg.json` never changes for a run, and `sync.json` `updatedAt` is set to the same value at completion. The event stays one per run. Only the `epg` timestamp changed: the watchlist event, its removal-reference key rules and the other event types are untouched, and events already written are never rewritten, moved or deleted (the 8 November 17:01 entry keeps its scan time).
- **Run in flight across the deploy.** A staged run whose `epg` event was already written under the scan time by earlier code (its `finalize` ran before the deploy) keeps that event and gets no second one; its `completedAt` stays unset.
- **Rescan inside a run.** If an earlier attempt of the same run failed before the pointer moved, the next scan builds the events again for the scan it is about to publish (`epgSync` rebuilds them when the saved `epg` event does not carry the new `updatedAt`). A run saved by earlier code that still carries an `epg` event of a superseded scan has that event rebuilt from the published report when the run completes (its `at` is then the completion time).
- **Watchlist event.** Its diff (`added`, `removed`, `total`, `baseline`) is computed from the watchlist before the run and the run's watchlist, so a rescan yields the same delta. An event with no removal is rebuilt for the new scan and carries the published time. An event that reports removals keeps its key, and with it the time of the first scan of the run: the removal hand-over references the event by key (`events/items/<reverse-timestamp>-<id>.json`, derived from `at`), the commit hands the references to the removal queue **before** it publishes, and a queue entry cannot be re-pointed afterwards, so a rebuilt key would leave that reference dangling. For such an event `at` therefore denotes the watchlist observation (the first scan of the run that saw the removal), not the EPG publication. This is a contract decision that needs the owner's approval ([AIR-359](https://trello.com/c/0IV9qKWR) records the request); the alternative is to hand the references over only after the publication, which changes the commit order and needs its own card.
- **Idempotency.** A repeated `finishSync`, a resumed committed run and an events refresh write the same keys; no second event is created. Events written by earlier code are not rewritten, and ordering and pagination by key are unchanged.
- **Not covered.** A one-off correction of an event that was already written with a stale time (the 5 November 17:03 entry and the 8 November 17:01 entry) is a separate owner-approved action: exact key, idempotency and readback. This contract changes code only.

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
| `removal` | `pending` at the start, `checked` lookups, `rated` (removed films whose rating was found in this run, by Diary or by a lookup) and `resolved` (removal references of the Events Log settled with a rating, including films rated earlier). The two count different things and do not overlap; a rating whose reference could not be settled counts as `rated` only |

Written, read and unchanged are different numbers: 50 rows checked with one new fact reads «записей проверено 50, новых фактов 1». The payload carries no titles, ids, URLs, rating lists or raw Letterboxd content.

**Delivery.** The D1 run record is the source and R2 is a projection, and the two are not atomic. An event is built from a **committed** terminal record only and put with a create-only precondition, so a repeat finds the key and writes nothing; a close that a start has not committed (a compare-and-swap that is lost) publishes nothing. It is delivered right after the terminal commit and again at the next look: a start (after its own commit), a terminal read by the Cloudflare executor, the closing of a stale run, or the hourly executor tick, so a missed event is repaired without starting Ratings again. The run is marked `ratingsEventAt` once delivered. If the record is replaced before delivery, the owed event moves to the new record (`pendingEvents`) with a retry time (15 minutes, doubling to a day), so the attempt rate is bounded but the outcome is never given up on. Only when more than 60 outcomes are owed at once (about two months of daily runs with the Events Log unreachable) is the oldest discarded, and `eventsDropped` on the run record counts it. The owner accepted this bounded policy on 2026-11-06 (AIR-361 review); keeping overflow without loss would need another store and a new decision. A failed put never fails the run, never reads Diary again and never repeats a step; the status reads and writes nothing. Events for runs that ended before this change are not created.

## Type filter on the events screen

The events screen (`/events`) shows the one feed of `GET /api/events` in its main column; its sidebar holds a single-select group of six buttons, «Тип событий». The filter is applied in the browser to the events already loaded, never on the server, and it never changes the loaded set or the cursor. The compact feed of the programme and film pages is not filtered.

| Button | Stored `type` values it shows |
| --- | --- |
| «Все события» (default) | Every loaded event, including a type the page does not know |
| «Watchlist и просмотр» | `watchlist`, `started`, `unstarted` |
| «Программа» | `epg` |
| «Оценки» | `ratings` |
| «Прогнозы» | `enrichment` (start, progress, stop and completion of a prediction run) |
| «Модель вкуса» | `taste_profile` (a profile publication, not a prediction run) |

The choice is the `type` query parameter of the events URL, next to the `return` target of the programme page; the default needs no parameter, an unknown value means «Все события», and a deep link, a reload and Back or Forward restore the pressed button. Changing the choice replaces the current history entry.

**Automatic pagination.** Choosing a type (and opening `/events` with one) loads the following pages by itself, in cursor order and one request at a time, until 10 loaded events match or the cursor is exhausted. A page with no match neither stops the search nor needs a click, and events that are already loaded are reused, so nothing is read twice. While it searches the page says «Ищем более давние события…» with the number of matches found among the loaded events, and the matches found so far are listed. When 10 are loaded the search stops and «Более давние события» stays for manual paging. «Все события» never searches: it shows the first page and the manual button.

The search stops at once, and its request is aborted, when the type or the screen changes. It stops on an API error (the reason is shown with «Повторить»; there is no automatic retry, and the retry resumes from the cursor that failed) and on a cursor that repeats or does not advance (a visible message and the same «Повторить»). An empty result is reported only when the whole archive has been read: «Во всём доступном архиве событий этого типа нет.» Before that, a type with no loaded match says «Среди загруженных событий этого типа пока нет.» A count is always a count of the loaded events, not a total. Events are keyed by `id`, so a page that repeats an event does not list it twice. Each page is a normal read of `GET /api/events`, which may also recover an undelivered prediction stop event (see above): this is not a safe production probe.

