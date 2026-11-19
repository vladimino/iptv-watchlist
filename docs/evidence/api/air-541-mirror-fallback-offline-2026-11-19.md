# AIR-541: read-only mirror fallback, offline evidence (19 November 2026)

Dated, offline evidence for [ADR 0177](../../adr/0177-read-only-mirror-fallback-for-film-and-programme.md) and the [degraded reads contract](../../reference/api/degraded-reads.md). **No production read or write was made**: every check ran against local stand-ins (a sqlite D1 with every migration applied, an in-memory R2, the production bundle `dist/server/index.js`). Nothing here proves behaviour on the deployed Worker; post-merge verification and owner UX acceptance are separate gates on [AIR-541](https://trello.com/c/0i308J15).

## Automated tests

`npm run test:all` on the final tree: core suite 424 of 424 files passed, non-functional suite 35 of 35 passed (the pre-push hook ran the core suite again on the pushed commit). `npm run build` passed. New core files:

| File | What it proves |
| --- | --- |
| `tests/mirror-fault-classifier.mjs` | A caught storage error is temporary only by its cause: transport, timeout, overload and busy errors are temporary; `no such table`, `no such column`, syntax, constraint, corruption, unknown and empty causes are not, and a structural word wins over a transient one. The four copies of the classifier are identical. `readAuthority` marks a transient failure after a successful marker read as temporary and a wrong marker, a missing table or an old schema version as structural. No top-level code alone is temporary; `published_epg_fence` is never answered from a mirror |
| `tests/mirror-read.mjs` | Per-object validation: pointer's generation copy first, a root programme valid by its own `runId` although the pointer lags, only a programme, only a watchlist, an older run only (found by listing), truncated JSON, wrong shape, a copy whose `runId` is not its key, an oversized object and a failing key each drop only that object; a same-run overwrite during the read keeps each part's own `asOf` and the overall `asOf` is the oldest; best-effort join labels; TMDB identity needs a resolved movie link; two valid copies with different titles are one identity with a deterministic candidate; contradictory identity keys, an unresolved link and an unknown id are unproven; the module has no write call |
| `tests/mirror-fallback-routes.mjs` | The production bundle with D1 failures injected at each stage. Healthy D1: no mirror object read, no R2 list, no write, unchanged shape. Marker read succeeds then the document SELECT fails: `200`, `source: mirror`, `readOnly`, `asOf`, `joined`, header, zero R2 and D1 writes, a rate-limited activation event without film data. The marker SELECT failing, the Film/Person titles SELECT failing (`canonical_read_unavailable`), partial mirrors, a corrupt generation copy, a lagging pointer. Structural refusals (held marker, missing table, missing column, syntax error, `no such column` inside the titles SELECT) are not answered from a mirror and read none. The film page: found from a mirror, two titles of one id, Discovery-only film and a contradictory key keep the typed `503`. The write fence: `409 degraded_origin_write_refused` for POST/PATCH/DELETE/PUT even with a healthy D1 and with no write, GET not fenced, `X-Expected-Run` mismatch `409`, unreadable `503`, malformed `400`, normal and `authoritative` requests untouched, a direct POST with D1 down has no PUT and reads no mirror. One recovery event, then none |
| `tests/mirror-read-write-fence.mjs` | No source file except the Worker uses the mirror reader; the Worker uses exactly its read API; every degraded builder sits in a GET read handler; the fence runs after the origin check and before every `/api/` handler; the degraded block has no write |
| `tests/mirror-fallback-client.mjs` | The note and its accessible text; `writeHeaders` adds `X-Data-Origin: mirror` only while degraded; started, Finds watched and filter-preset writes are disabled and send nothing; a cold load from a saved copy is shown, an authoritative result in memory is never replaced by a saved copy, the next authoritative read ends the degradation and reloads the started marks; the film page from a mirror, its authoritative replacement, the neutral shell with a retry, a confirmed absence unchanged, a non-read-only body not trusted as a copy, the last good film kept through a failure; no browser storage is used |

Existing tests changed: `tests/film-permalink.mjs` (the unavailable shell text), `scripts/test-classification.mjs` (five new files, core). `tests/canonical-catalog-titles-mutation.mjs` still passes unchanged (its anchors are kept).

## Rendered browser check

A real Chromium against the production bundle behind a local HTTP port (sqlite D1, in-memory R2, a switch that makes document reads fail with `D1 DB is overloaded`), desktop 1280×900 and mobile 390×844, 39 checks, all passed:

- healthy page: no note; outage cold load: «Сохранённая копия · обновлена …» and the saved film rendered;
- the «Начал просмотр» button is `disabled` and `aria-disabled="true"`, and **no non-GET request** was sent while degraded;
- cold `/film/tmdb_42` and its reload show the film with the note; list → film → Back → Forward works;
- an unknown film shows «Сведения пока не загружаются» (not «Фильм не найден») with a keyboard-focusable retry, focus reaches the retry control with Tab;
- recovery: after D1 returns, the retry shows the authoritative answer (a confirmed absence for that id), a reload removes the note, and **without a reload** a live refresh clears the note and the write controls come back;
- no horizontal overflow at 390 px.

No screenshot was created, saved or committed. Limits of this check: it used synthetic films, not production data; the «started button enabled after recovery» check passes also when the page has no such button, so it is weaker than the other checks.

## Not verified

The behaviour of the deployed Worker against a real D1 outage, real R2 object timing and retention of older generation copies, the production fault class of 19 November 2026, and the rendered GitHub view of the two new Mermaid diagrams (recorded on the PR). Owner UX acceptance is outstanding.
