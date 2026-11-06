# Events log

The activity list reads objects under `events/items/`. The key is `events/items/<reverse-timestamp>-<id>.json`, so a page is newest first. `GET /api/events` returns one page and may also recover an undelivered prediction stop event. That route is not a safe production read. Clients ignore an event type they do not render. A rendered event shows its `at` in Europe/Madrid and does not show storage keys, hashes, prompts or profile text.

| `type` | When it is written | What the list shows |
| --- | --- | --- |
| `epg` | A programme commit | Counts of films and broadcasts |
| `watchlist` | A watchlist commit | Added and removed films |
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
- **Watchlist event.** Its diff (`added`, `removed`, `total`, `baseline`) is computed from the watchlist before the run and the run's watchlist, so a rescan yields the same delta. It is rebuilt for the new scan unless its removed films were already handed over to the removal queue: the queue references the event by key (`events/items/<reverse-timestamp>-<id>.json`, derived from `at`), so such an event keeps its key and the first-scan time rather than leave the reference dangling. Pending hand-over references of the same run are replaced, never duplicated.
- **Idempotency.** A repeated `finishSync`, a resumed committed run and an events refresh write the same keys; no second event is created. Events written by earlier code are not rewritten, and ordering and pagination by key are unchanged.
- **Not covered.** A one-off correction of an event that was already written with a stale time (the 5 November 17:03 entry) is a separate owner-approved action: exact key, idempotency and readback. This contract changes code only.
