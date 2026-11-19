# Mirror fallback diagnostics (read-only)

For [ADR 0177](../adr/0177-read-only-mirror-fallback-for-film-and-programme.md) and the [degraded reads contract](../reference/api/degraded-reads.md). Everything here is an L0/L1 read: Worker Observability, safe `GET`s and R2 metadata. **Nothing on this page authorizes** a manual sync, a mirror repair, a flag, a migration, a Task, a lease reset or any production write. A degraded answer is not repaired by reading it: only the hourly `EpgOrchestration.ensure` and the publication tail write the mirrors ([ADR 0108](../adr/0108-epg-mirror-reconciliation-writer.md)).

## Is a page showing a saved copy?

- In the browser: the note «Сохранённая копия · обновлена …» and disabled write controls.
- In an API answer: `source: "mirror"`, `readOnly: true`, header `X-Data-Origin: mirror`, and `reason`, `runId`, `asOf`, `joined` (see the contract). A body without `source` is authoritative.

## Worker events (Observability)

| Event | Meaning | What to check |
| --- | --- | --- |
| `mirror_fallback_activated` | a typed temporary failure was answered from a mirror (`route`, `reason`, `ageSeconds`) | `reason` names the failing authority read; a large `ageSeconds` means the hourly reconcile has not run or failed |
| `mirror_fallback_unusable` | the failure was temporary but no mirror object was usable | `rejected` lists why (`absent`, `invalid_json`, `invalid_shape`, `run_mismatch`, `too_large`) |
| `mirror_validation_failed` | one object was dropped, the others were still used | the `key` and `reason` |
| `mirror_fallback_recovered` | an authoritative read succeeded after a degraded one (`afterMs`) | confirms automatic recovery |
| `degraded_write_refused` | a write labelled `mirror` (or with a stale `X-Expected-Run`) was refused | expected after a recovery while an old page is open |

Events are rate-limited to one per route, reason and minute per isolate. They carry no film, title or person data.

## No fallback happened although D1 failed

That is correct when the failure is **structural**: a marker that is not `d1`/`open`, a held cutover, a missing table or column, a schema version below the required one, `discovery_not_authoritative`, `film_person_not_open_read`, `canonical_read_not_authoritative`, or invalid stored content. These keep today's 503 by design (ADR 0162). `published_epg_fence` is a `409` with `retry: true`; reload to read D1 again. Read the authority markers and the schema version before suspecting the fallback.

## The mirrors are stale or missing

Read the D1 marker fields (`mirrorProgrammeRunId`, `mirrorEtag`, `mirrorWatchlistEtag`) and the R2 object metadata (`programme.json`, `watchlist.json`, `epg/published-generation.json`, `epg/generations/<run>/programme.json` and `watchlist.json`) read-only. Generation copies are mutable within a run, the five objects are not updated atomically and a pointer can lag the root objects; the response labels this with `joined` and per-object times (decision B3). Repairing the mirrors is the existing writer's job, not an operator action here, and needs its own owner-approved procedure if the hourly reconcile cannot do it.

## Not covered

`GET /api/catalog/available`, `GET /api/enrichment/view`, ratings, predictions and the Discovery catalog are not degraded; a Discovery-only film that no mirror proves shows the neutral shell with a retry. Rollback of the code is a normal revert to D1-only serving and changes no stored data.
