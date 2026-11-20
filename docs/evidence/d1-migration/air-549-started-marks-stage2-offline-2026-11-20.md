# AIR-549 stage 2: Started marks D1 contract, offline evidence

Date: 20 Nov 2026 (UTC). Scope: repository change only. **No production D1, R2, flag, binding, Scheduled Task or Access was read or written**, no migration was applied, nothing was imported and no authority was switched. Source base: `main` at `5c7160c7` (after the Filter presets stage 1 evidence, [PR 816](https://github.com/vladimino/iptv-watchlist/pull/816)). The Filter presets domain is not touched.

## What changed

| Artifact | Content |
| --- | --- |
| `migrations/0029_started_authority.sql` | Schema v29: `started_authority` (marker inserted as `r2`, generation 0, writes `open`), `started_cas`, `started_mark` (exact-spelling id, `started` 0 or 1 with false kept as a tombstone, `started_at`, `last_event_json`, per-row `rev`). Follows a complete v28 and refuses anything else before a table is created. The number 0029 was free in `main` and in every open pull request at the time of writing. |
| `src/started-d1.js` | Storage only: marker read (`legacy` / `r2` / `d1` / `closed`), fenced reads (id list, all marks, one mark), one-row commit with a revision compare-and-swap inside a guarded batch, lost-reply classification. No Film identity, no event, no import. |
| `src/worker.js` | `GET /api/started`, `POST /api/started` and `bootstrapEvents` choose one store per request from the marker. R2 branch unchanged except that it reads the marker again right before its `put`. A marker that cannot be read answers `503`, never R2. The Film identity checks, statuses and the event write order are unchanged. |
| `scripts/started-d1-sql.mjs` | Offline generator of the guarded `hold`, `import`, `activate`, `release` SQL and a `digest` from a local export of the `started/` objects. Opens nothing. Anything the Worker would read differently is a blocker (exit 2, no SQL). |
| `build.mjs`, `scripts/test-classification.mjs` | The bundle scopes the module as `StartedD1`; the new test is in the core suite. |

API shapes (`GET /api/started` `{ids}`, `POST /api/started` `{id, started}`), the spelling of ids, `startedAt`, the event shapes, the started filter and every refusal status (`404`, `409`, `410`, `503`) are unchanged. `CanonicalCatalogReader.catalogStartedFilm` is not modified.

## Contract points proved offline (`tests/started-d1.mjs`, core suite)

- Migration: refused on v27 with nothing created; v29 after the chain; marker `r2`/0/`open`; no rows; second apply refused; no downgrade; constrained mode, flag, revision, JSON and id length; fence row refuses 0.
- Dormant: schema 28 and marker `r2` serve R2 and write no D1 mark row; `r2` with writes `held` keeps R2 reads and refuses every write (a replay included) with zero R2 writes; a wrong database, version 29 without the tables, a deleted marker row, a missing table and no binding answer `503` on the three routes without listing the R2 prefix; only the explicit stand-in serves R2 without a binding.
- D1 branch: set creates a row at revision 1 and one event whose id is stored with the mark; no R2 `started/` object is written or listed; repeat rewrites nothing and delivers the same event; unset keeps a tombstone (`started` 0, `startedAt` null, revision 2); a repeated unset delivers the stored event again; unset of a mark that never existed writes nothing; the listing order equals the R2 key order (`a-b.json` before `a.json`).
- Identity: `404`, `409`, `410`, a held, not-open or generation-moved Film/Person marker and a held Started marker all refuse with zero R2 writes and zero D1 mark rows; cancelling a mark keeps its own last film when the identity disappears or is reassigned to another verified TMDB movie.
- Event delivery: a request that dies after the mark commit and before the event write is repaired by the same-state repeat under the **same event id**; no duplicate.
- Concurrency: three simultaneous identical requests commit once and write exactly one event; opposite simultaneous requests end with a row consistent with its stored event; different ids do not contend; a lost reply is a success only when the stored row is exactly this request's mark, a competitor's commit is a conflict.
- Events: `bootstrapEvents` reads the D1 marks, writes their stored events under their own ids and does not revive a stale R2 mark; a closed marker stops it before any event; `GET /api/started` and `GET /api/events` write nothing.
- R2 branch race: a request admitted before a hold or before the activation, whose marker is read again before its `put`, answers `503` and writes nothing.
- Generator: blockers (not JSON, not an array, foreign key, duplicate key, id mismatch, flag mismatch, bad `startedAt`, bad `lastEvent`, no body, bad id, a statement over the limit) exit 2 with no SQL; the digest does not depend on export order; `hold` → `import` → parity → `activate` with a guard refusing each wrong state (import before hold, repeat, tampered row, stray row, repeat activation, release after activation); `release` before activation restores writes; after activation the Worker lists exactly the started ids of the export in R2 key order and a repeat delivers the imported event under its original id.

## Checks on the final checkout

`npm ci`, `npm run test:all` (core 440 of 440 files, non-functional 35 of 35, on the tree merged with `main` at `6a4af2b4`), `npm run build`, `git diff --check` and the timeless-documentation check (0 errors) passed. Four mutations each fail `tests/started-d1.mjs`: the row revision guard removed from the update, the marker guard removed from the commit batch, the marker re-read removed from the R2 branch, and the lost-reply check loosened to "any row at the next revision".

Existing tests changed only where they pinned "the last migration is 0028 / schema 28": `tests/canonical-producer-chain.mjs`, `tests/canonical-producer-schema.mjs`, `tests/canonical-rated-admission-bundle.mjs`, `tests/canonical-rated-admission-producer.mjs`, `tests/migration-pattern-limit.mjs`. `tests/local-standins.mjs` and `scripts/local-dev.mjs` gain the explicit local flag `STARTED_DB_OPTIONAL` so a local stack without a D1 binding keeps serving `/api/started` from R2; production never sets it.

## Decisions taken inside the existing contract (no new product semantics)

- **Concurrency policy.** The R2 mark write was last-writer-wins. In D1 a mark commit is a compare-and-swap on the row's revision, and a request that loses decides again on the state the winner left. Identical concurrent requests become one write and one event; opposite concurrent requests end in a state that agrees with its stored event. This changes no user-visible rule for a single user and removes the possibility of a mark that disagrees with its stored event. It is recorded here so the reviewer and the owner can object before any activation.
- **No new ADR.** The pattern (a per-domain marker, a held write window, an offline import and a guarded activation) is the one already used for the Filter presets and owner reviews; no authority moves in this change.
- **The fence.** Because an R2 mark write has no compare-and-swap, the runbook closes the in-flight window by observation (drain, then two identical complete listings), and the Worker narrows it with a marker re-read before the `put`. A write admitted in the few milliseconds between that re-read and the `put` is the one case the code cannot exclude; the double listing is what detects it.

## Limits

Production state, the real number of marks, the real event ids and the Worker request-time bound are unknown here. A binding that points at a different database below version 29 is indistinguishable from the true pre-migration state, so the cutover preflight reads the database id. No production operation is authorized by this report; each step of [the runbook](../../runbooks/started-marks-cutover.md) needs its own owner GO.
