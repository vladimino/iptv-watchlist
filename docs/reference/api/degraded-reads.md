# Degraded reads from R2 mirrors and the write fence

Contract of [ADR 0177](../../adr/0177-read-only-mirror-fallback-for-film-and-programme.md) (Accepted; implemented under [AIR-541](https://trello.com/c/0i308J15)). D1 stays the only authoritative database. When a read of the published programme, the watchlist or one film cannot be answered **because of a temporary storage failure**, the Worker may answer from the R2 compatibility mirrors, read-only and labelled. This page is the response and write contract; the picture is in [EPG publication and availability](../../architecture/epg-and-availability.md#degraded-read-from-r2-mirrors-adr-0177) and the diagnosis in the [runbook](../../runbooks/mirror-fallback-diagnostics.md).

## Which reads, and when

| Route | Degraded answer |
| --- | --- |
| `GET /api/programme` | the best valid programme object, joined best-effort with a watchlist; a watchlist alone gives `runId: null`, `scheduleUnavailable: true` and `shows: []` per film (unknown, not empty) |
| `GET /api/watchlist` | the best valid watchlist object, else the member films of a valid programme |
| `GET /api/catalog/film/<tmdbId>` | the film proven by a mirror object (below); otherwise the existing typed `503` |

`GET /api/catalog/available`, `GET /api/enrichment/view` and every other route are **not** degraded: they keep their current behaviour (this slice has no mirror of the Discovery catalog for the current run).

A degraded answer is produced **only** after a typed *temporary* authoritative failure. The error is marked at its throw site from its **cause**, never from a top-level code (`failed()` in `published-epg.js`, `discovery-authority.js`, `film-person-authority.js`, `owner-review-d1.js`, and the `owner_review_unavailable` result of `OwnerReview.loadForRead`):

- **Temporary (degraded allowed):** the D1 binding fails with a transport, timeout or overload error at any stage (marker read, a later document SELECT, the Film/Person titles or metadata SELECT, the Discovery admission SELECT, the owner-review read); `discovery_fence`, `discovery_incomplete` and `film_person_generation_moved`, transient by definition.
- **Never degraded (unchanged 503 or 409):** a marker that is not `d1`/`open` (ADR 0162), a held cutover, a missing or partial table, a schema version below the required one, a structural SQL error (`no such table`, `no such column`, syntax, constraint, malformed), an unrecognised error, `discovery_not_authoritative`, `film_person_not_open_read`, `canonical_read_not_authoritative`, and `canonical_read_unavailable` raised for invalid stored content. `published_epg_fence` keeps its `409` with `retry: true`; the client retries D1.
- A confirmed absence, retirement or conflict (`404`/`410`/`409` of the film route) is produced from authoritative state only and is **never** produced from a mirror.
- A healthy D1 never reads a mirror: the normal path performs no additional R2 GET or list (asserted by `tests/mirror-fallback-routes.mjs`).

If no mirror object is usable, the route keeps its current refusal (`502`/`503`); nothing is invented.

## Response fields (additive)

The healthy response shape is unchanged: **a body without `source` is authoritative.** A degraded body adds:

| Field | Meaning |
| --- | --- |
| `source` | `"mirror"` |
| `readOnly` | `true` |
| `reason` | the typed code that triggered it (for example `published_epg_unavailable`, `canonical_read_unavailable`, `discovery_unavailable`), not an error message |
| `runId` | run of the programme object used (`null` for a watchlist alone) |
| `asOf` | the **oldest** snapshot time among the objects used (a part never claims to be fresher than it is) |
| `joined` | `"best_effort"` or `"none"` (B3: a heuristic, not proof) |
| `joinBasis` | `same_run_key` (generation copies of one run), `pointer_root` (root pair of the pointer's run), `run_mismatch`, `unproven_root` |
| `parts` | per object: `object`, `key`, `runId`, `asOf` |
| `availability` | `"unverified"`: no `available`, `soon`, hot or last-chance state is recomputed from a stale snapshot |

Also the response header `X-Data-Origin: mirror`. `publishedAt` of a degraded programme is the snapshot time. There is no hard TTL (decision A): each object keeps its own time and the page labels it.

### Film page

`found` (HTTP 200) adds `provenance` (`object`, `key`, `runId`, `asOf`) and `degraded: ["predictions","metadata","facts","shows_unverified"]`; the D1-owned facts are omitted, not guessed. Identity is proven **only** by a mirror entry (`films`, `catalogFilms`, or a watchlist film) with `tmdbId` equal to the id **and** a resolved movie `tmdbLink` of the same id. If the selected programme/watchlist pair does not list the film, the same bounded set of recent generation copies is searched (each copy read and validated alone, newest snapshot first), so a film that only an older run still lists is shown with the provenance (`runId`, `asOf`) of that run. Two valid records of the same TMDB id are one identity even when title or year differ: the preferred candidate is deterministic (the pointer's run, then the programme before the watchlist, then the newest `asOf`, then the key) and `disputedAttributes: ["title","year"]` marks the variation. A contradictory identity key (two film ids for one TMDB id, or an entry whose link disagrees with its own id), a film in no mirror and a Discovery-only film are **unproven**: the typed `503 {status: "unavailable"}` is kept and the page shows the neutral shell «Сведения пока не загружаются» with a retry. The SPA member route `/film/<id>` (a non-`tmdb_` id) is resolved by the client from the programme/watchlist as before; it benefits from the degraded `/api/programme` and has no separate server lookup.

### Object validation

Each R2 object is read and validated **alone**; a bad object is dropped and never disqualifies another. The minimum schema: a programme needs a valid `runId`, a valid `updatedAt` and a `films` list in which **every record** has an `id` and a non-empty `title` (and `shows`, when present, is a list of objects), plus well-formed `catalogFilms` entries when present; a watchlist needs a valid `updatedAt` and the same record minimum. A corrupt but syntactically valid object (an empty record, a missing title, a missing timestamp) is rejected as `invalid_shape` and so cannot mask a healthy root or older copy. The **root** `programme.json` is valid by its own schema and `runId` even when `epg/published-generation.json` points to an older run (pointer agreement only ranks candidates and labels the join). A watchlist has no `runId`: it is attributed by the key of its generation copy or as the root object. Objects over 8 MiB, invalid JSON, a copy whose `runId` is not its key, or a wrong shape are rejected (`mirror_validation_failed` event). Candidate order: the pointer's generation copy, the root object, then older generation copies. Run ids are UUIDs, not timestamps, so the older copies are found by listing `epg/generations/` (at most 5 pages of 1000 objects; a cut-off listing is reported as `list_truncated`) and ranking the `programme.json` copies by their R2 `uploaded` time; the six newest are read and the valid one with the latest snapshot time wins. Generation copies are mutable within a run (`putStable`, `replacePart`, `repairMirrors`), so no field is treated as frozen.

## The write fence

A degraded page must not write, and a stale degraded page must not write after D1 has recovered. The fence is server-side and runs **before every `/api/` handler** (`degradedWriteFence`), for every method other than `GET`, `HEAD` and `OPTIONS`:

| Request | Answer |
| --- | --- |
| header `X-Data-Origin: mirror` (or any value other than `authoritative`) | `409 degraded_origin_write_refused`, whether or not D1 is healthy; nothing is written |
| header `X-Expected-Run: <runId>` on `POST /api/started` or `POST /api/catalog/watched`, run differs from the published run | `409 published_generation_changed` |
| the same header, published run unreadable | `503 published_epg_unavailable` |
| the same header, malformed | `400 invalid_expected_run` |
| no such header | unchanged: the handler's own authoritative D1 read and fence decide |

No write handler reads or falls back to a mirror: while D1 cannot answer, a write ends in its existing typed refusal with no PUT (`tests/mirror-read-write-fence.mjs` asserts that the mirror reader is reachable only from the read handlers). The shipped client sets `X-Data-Origin: mirror` on any write it sends while degraded (none is sent: the controls are disabled) and does not send `X-Expected-Run`; the header is available to other callers.

## Client behaviour

A degraded answer shows «Сохранённая копия · обновлена …» with the source time, a tooltip and `aria-label` that say the copy is read-only and that current availability is unverified. **While a saved copy is shown, no claim about the present is derived from its schedule** (decision 5, owner A): the stored shows stay readable as «Сохранённое расписание», but there is no archive, on-air or «скоро» state, no archive deadline, no last-chance badge or filter result, no availability shortlist and no phase labels on the film page; the periods «Архив» and «Скоро» are empty by construction. «Начал просмотр», the watched mark in Finds and saved filter scenarios are disabled (`disabled`, `aria-disabled`, tooltip); no optimistic write is made. The last good authoritative result stays **in memory only** (it is lost on reload; nothing is persisted). A saved-copy answer never replaces an authoritative result already shown, but the page is **read-only from the moment a refresh fails** (a saved-copy answer, a network error or a `503` without a usable copy; the same for a film page whose refresh failed): the data stays visible, the note appears (with the time of the authoritative load) and the write controls are disabled. That last good result keeps its normal lifecycle, because it is authoritative data; only a displayed saved copy has its present-tense claims suppressed. The normal source and the actions return only after a successful authoritative read (the started marks are then read again). A film that cannot be read shows the neutral shell with a retry and is asked again automatically; it is never reported as missing.

## Observability

Structured `console.log` events, without personal data and rate-limited to one per route, reason and minute per isolate: `mirror_fallback_activated` (`route`, `reason`, `runId`, `asOf`, `ageSeconds`, `joined`), `mirror_fallback_unusable` (`route`, `reason`, rejected object reasons), `mirror_validation_failed` (`route`, `reason`, `key`), `mirror_fallback_recovered` (`route`, `afterMs`, when an authoritative read follows a degraded one) and `degraded_write_refused` (`reason`).
