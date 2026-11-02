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

If the event put fails, the publication response stays HTTP 200 and adds `publicationEvent: {recorded: false}`. Current stays where it is. The identical request then answers HTTP 409 `version_not_increasing`, does not move current, and records the missing event. A different body for that same version does not. No reader creates an event for a version that was already current. The procedure is in the [publication runbook](../../runbooks/taste-profile-publication.md).
