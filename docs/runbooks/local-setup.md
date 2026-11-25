# Local setup

`npm run dev` builds the Worker when `src/`, `public/`, `data/`, or `build.mjs` is newer than `dist/server/index.js` (the build writes each output to a temporary file and renames it into place, so a test or server reading the bundle never sees a partial file), then serves it at `http://127.0.0.1:8787` with a **local R2 bucket and a local D1 database**, both Miniflare stores of the selected local store directory. Nothing is written to Cloudflare, no credential is read (the process removes any Cloudflare token from its environment) and both bindings are opened with remote bindings off. `npm run dev -- --watch` rebuilds those sources while the server is running.

The dev Worker runs the same strict D1 paths as production. Its generated config binds `BUCKET` and `DB` only; it sets none of the `*_DB_OPTIONAL` stand-in flags that the test harness uses for a Worker without a D1 binding ([ADR 0162](../adr/0162-d1-only-authority-retire-rollback-toolchain.md)), and the committed `wrangler.jsonc` is not used. A domain that is empty or invalid is refused locally exactly as in production, never served as healthy.

## What the local D1 holds

[scripts/local-d1.mjs](../../scripts/local-d1.mjs) installs the database of a store and nothing else touches it:

1. **Schema.** Every file of [migrations/](../../migrations/README.md) is replayed in order on the empty database, then the contract version is checked against the last file. A database that already holds a schema is never migrated in place: the store is deleted and imported again.
2. **Rows.** The synthetic rows of the dummy catalog (see below), or the operator's own rows for a snapshot store, are written first.
3. **Markers.** The authority markers move through the same guarded transitions that production activation uses (a trigger of the migrations refuses any other path): Film/Person `d1` open (via `prepared` and a verified baseline), prediction, owner review, ratings (`d1` open), metadata cache, filter presets, started marks, EPG checkpoint and published EPG are `d1`. The watchlist authority stays at `epg` and the prediction auxiliary documents at `r2`, as migrated; the latter stay in the local bucket.
4. **Published generation.** The programme and watchlist documents of the bucket are published through the Worker's own published-EPG writer (`publishGeneration`: fenced, chunked, with its mirrors), then the Discovery authority is pinned to that generation. Show times are therefore D1 rows, not only R2 objects.

The R2 bucket keeps what R2 still owns: the immutable prediction, fingerprint and profile bodies (the Worker verifies each D1 row against its body by SHA-256), the frozen `titles.json` and `people.json` mirrors, `sync.json`, events, and the compatibility mirrors of the published generation. The retired raw view index object `enrichment/view-index.json` is not an input: the Worker derives the view from D1 rows ([view index contract](../reference/domain/view-index-read-model.md)).

A store is reused only when both halves are whole: `programme.json` and `watchlist.json` in R2, the immutable R2 bodies that the D1 prediction rows name (present and hash-consistent: the active profile always, the fingerprint and pointer rows up to 500 each, ordered by film id), and a D1 at the head of the migration chain with every marker above, a pointed Discovery authority and a published generation. Anything less (a deleted directory, an older migration chain, a marker moved off `d1`, a missing or corrupt immutable body, a failed import) imports the store again. The store marker records the migration chain by a hash of the files, so adding a migration re-imports an existing store on the next `npm run dev`.

## Dummy site

Another computer does not need the private production snapshot. The committed catalog is [fixtures/local-site/catalog.json](../../fixtures/local-site/catalog.json). It contains `Movie1`, `Movie2`, and `Movie3`, `Director1`, `Actor1`, `Actor2`, `Genre1`, and `Genre2`.

```bash
npm ci
npm run dev
```

The script turns the catalog into R2 objects and D1 rows. Dummy data and each private snapshot have their own directory under gitignored `.wrangler/state/stores/`, holding both its R2 and its D1. The fixture store is `stores/fixtures`. A snapshot store is `stores/snapshot-` plus a hash of the absolute snapshot path, so the path itself is not a directory name. Switching modes serves only the selected store.

R2 objects:

- `programme.json` and `watchlist.json`
- `epg/published-generation.json` naming the `local-fixture` generation, with the generation copies `epg/generations/local-fixture/programme.json` and an empty `epg/generations/local-fixture/discovered-films.json`
- `titles.json` with one provisional title (`Movie2`) and `people.json` with one cached name (`Actor2`), frozen mirrors of the D1 localization rows below
- `sync.json`, `enrichment/profile/current.json`, `events/items/*` (an EPG, a watchlist, a started and an unstarted event)
- the immutable bodies of the active profile, of the fingerprints of `Movie1` and `Movie2` and of the prediction of `Movie2`

D1 rows:

- canonical Film/Person: a `film` per catalog film with metadata, credits and, for `Movie1`, a trusted TMDB claim (`Movie2` and `Movie3` carry none, so they read as identity-unresolved); a `person` per credited name; the provisional localization of `Movie2` and of `Actor2`, which the owner page at `http://127.0.0.1:8787/admin` shows as the provisional queue
- `ratings_view`: the rating of `Movie1` (4.5, watched)
- `prediction_profile` (active, version 1), `prediction_fingerprint` for `Movie1` and `Movie2`, `prediction_pointer` for `Movie2` (predicted 4.0, probability 0.7)
- `started_mark`: `Movie1`
- the published generation and its shows

So `GET /api/programme`, `/api/watchlist`, `/api/started`, `/api/enrichment/view`, `/api/catalog/available`, `/api/enrichment/footer/status`, `/api/events`, `/api/ui/filter-presets` and the admin reads (`/api/admin/overview`, `films`, `people`, `health`, `limbo`) answer `200` with this data. The prediction queue, the Discovery continuation and the catalog copy of the dummy store are empty, which the admin health view shows as unknown or missing: the honest state of a store that has never run those jobs.

Show times are calculated from the moment of import, so `Movie1` has one recent broadcast and one later the same day. `Movie3` has no broadcasts; enable “Показывать фильмы без показов” to see it. A later `npm run dev` reuses the fixture store when the catalog file and the migration chain are unchanged and the store is whole (see above). The marker for that store is written only after the import succeeds, and an import that fails leaves no marker, so the next start imports again. `npm run dev -- --refresh` deletes the selected store (R2 and D1) and imports it again. Other stores are left in place.

An older combined directory at `.wrangler/state/v3` is not read. The next run fills the new store from the catalog or the snapshot directory.

Do not copy these fixtures into the production bucket. The local D1 is a separate Miniflare database and nothing here can address the production D1 `iptv`.

## Private snapshot

If this machine has the private export, copy [.local-dev.example.json](../../.local-dev.example.json) to `.local-dev.json` and set `snapshot` to that directory’s absolute path. `.local-dev.json` is gitignored. `npm run dev` then imports that snapshot into its own store instead of the dummy catalog. Remove `snapshot` or set it to an empty string to return to the fixtures. The fixture store stays on disk and is not served while the snapshot is selected. The dummy catalog needs no snapshot and no `d1Sql`.

### Required D1 input

A snapshot is an R2 export and holds no D1. The snapshot store therefore needs its D1 input from you, in `.local-dev.json`:

```json
{
  "snapshot": "/absolute/path/to/the/export",
  "d1Sql": "/absolute/path/to/local-d1-rows.sql"
}
```

`d1Sql` is a local SQL file of `INSERT` statements that you provide (for example from your own local D1 export of those tables). The store refuses to import without it:

- **Required tables:** `prediction_profile` (the active profile) and `ratings_view`. A snapshot store whose ratings or prediction domain would be empty is refused, not served as healthy.
- **Optional tables:** `ratings_document`, `prediction_fingerprint`, `prediction_pointer`, `prediction_lineage`.
- Only `INSERT INTO <those tables>` statements are accepted. DDL, `UPDATE`, `DELETE`, markers and every other table are refused, so the file cannot change the schema or an authority marker. The file is read locally and never uploaded.
- The `r2_key` and `content_sha256` of each row must name an immutable body that the snapshot's R2 objects hold (`enrichment/profile/versions/<n>.json`, `enrichment/films/<film>/fingerprints/<hash>.json`, the prediction versions): the Worker verifies the body by SHA-256 when it reads the row.

Everything else is derived from the snapshot itself, with no operator input: the schema and markers as above; the canonical Film/Person rows (a Film per programme or watchlist film with its metadata, TMDB claim and credits, a Person per credited name, and the provisional or reviewed titles and names of its `titles.json` and `people.json`), so the localized titles and names are served from D1 at the Film/Person authority; the started marks from its `started/<id>.json` objects; and the published generation from its `programme.json` and `watchlist.json`. A film, person, title or name that those documents do not hold gets no row. The raw `enrichment/view-index.json` object is copied when the snapshot has it (operator tools) and is not required or read by the Worker. The input file is part of the store identity: a changed file (path, size or modification time) imports the snapshot store again.

### Shifting broadcast times to today

An exported snapshot is frozen at its export date, so every show is soon in the past and the dashboard reports that the saved window has ended. Set `"shiftToNow": true` next to `snapshot` in `.local-dev.json` to import the snapshot as if the programme had been refreshed today. The import moves the broadcast timestamps forward by a whole number of calendar days in `Europe/Madrid`, the site's display time zone, chosen so that the shifted `programme.updatedAt` is the latest one not past the current time. Every show keeps its original local hour of the day, including across a DST transition between the export date and today, so a 21:00 Madrid broadcast still starts at 21:00 Madrid time. All timestamps of one import go through the same wall-clock mapping, which keeps the window, the shows and the update markers consistent with each other; durations that straddle a transition hour may change by one hour, as they do in a real programme.

The shift applies to `programme.json` (`updatedAt`, `watchlistUpdatedAt`, `cutoff`, `window`, `stats.epgStart`/`epgEnd`, every `shows[].start`/`end` and stored `availableUntil`), `watchlist.json`, `sync.json`, `epg/discovery-latest.json`, `epg/discovered-films.json`, staged copies under `epg/generations/`, and the `at` of EPG and watchlist events in `events/items/*`. The shifted programme and watchlist are what the local D1 publishes. Fingerprints, predictions, the taste profile, leases, started markers and their events keep their real timestamps, so prediction freshness is not faked and no event lands in the future. The shift is part of the store marker: the next `npm run dev` on a later day imports the snapshot again with a larger shift, while a restart on the same day reuses the store. The option has no effect on the dummy catalog, whose shows are already built from the current time, and it never writes to the snapshot directory or to Cloudflare.

## Environment and tests

`IPTV_DEV_PORT`, `IPTV_LOCAL_STATE`, and `IPTV_LOCAL_CONFIG` override the port, the state root, and the config file. The local smoke test uses them so it does not touch a developer’s `.local-dev.json` or `.wrangler/state`.

Local Node 20 uses Wrangler 4.86 and compatibility date `2026-05-03` for this process only. The committed Worker compatibility date is unchanged.

Local rollback is deleting the store directory (or `npm run dev -- --refresh`): that removes only the selected local R2 and D1.

### The sqlite3 shell of the test suite

The database tests run SQL through the `sqlite3` command-line shell (`tests/sqlite-session.mjs`, the D1 stand-in). `npm test` checks the shell once per run (`scripts/sqlite-cli.mjs`): it must execute its standard input and stop at the statement that fails under `-bail`. The `sqlite3` of `PATH` is tried first, then Homebrew's keg-only sqlite (`/opt/homebrew/opt/sqlite/bin/sqlite3`, `/usr/local/opt/sqlite/bin/sqlite3`); the first shell that passes is put first in `PATH` for every test file and named in `IPTV_SQLITE3_VERIFIED`. Without a passing shell the run stops with the reasons instead of failing every database test one by one. A test file run on its own makes the same check on its first call.

On macOS the shell Apple ships does not qualify (24 Nov 2026: `/usr/bin/sqlite3` 3.54.0 keeps running the rest of an input line after a statement fails under `-bail`, so a refused write could leave rows behind; and sqlite3 3.54 of either origin reads no input at all when `-cmd` and `-bail` are both given). Install Homebrew's: `brew install sqlite`; `npm test` finds it on its own, or put `$(brew --prefix sqlite)/bin` first in `PATH` to run single files. Every call of the harness is framed by a start and an end marker that must come back, so a shell that executes nothing can never pass a test. Ubuntu's sqlite3 on GitHub Actions passes the check as it is.

`npm run test:nonfunctional` (and the pre-push hook, which runs `npm run test:all`) needs Node 22.5 or later for the production-size memory scenarios, which run the built Worker over `node:sqlite`; the nightly workflow pins Node 22. On an older local Node those scenarios print that they were skipped; the rest of both files still runs. On CI an older Node fails them as before.

The three scenarios skipped that way are `footer-memory-production-size` and `owner-limbo-memory-production-size` (`tests/footer-memory.mjs`) and `user-reads-memory-production-size` (`tests/user-read-memory.mjs`); the nightly `Non-functional tests` workflow still runs all three on Node 22.

On a laptop the heaviest mutation files of the non-functional suite (`canonical-producer-driver-mutation*.mjs`: about 110 s on CI, about 280 s each six at a time on the owner's Mac, and up to about 850 s two at a time while other sessions load the machine) pass the runner's default 300 s per-file limit. The pre-push hook therefore runs `npm run test:all` with a 30-minute per-file limit (`TEST_TIMEOUT_MS=1800000`) unless `TEST_TIMEOUT_MS` is already set; the limit only guards against a hung file. The runner reads `TEST_JOBS` and `TEST_TIMEOUT_MS` from the environment and the hook passes them on, so a push can still lower the concurrency on a busy machine:

```bash
TEST_JOBS=2 git push
```

`npm test`, `npm run test:all` run by hand, and CI keep the 300 s default.

Git opens the SSH connection to GitHub before it runs the hook, and the full suite takes about ten minutes, so an idle connection can be closed under it: the hook passes and the push then dies with exit 141 (SIGPIPE) without updating the remote. Keep the connection alive for a push that runs the suite:

```bash
GIT_SSH_COMMAND="ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=40" git push
```

The tests of this tooling:

| Test | What it proves |
| --- | --- |
| `tests/local-d1.mjs` | The migration splitter reads every migration like sqlite3 does; the guarded marker activation; synthetic rows whose R2 bodies match their SHA-256; readiness refusals; the snapshot `d1Sql` input rules |
| `tests/local-store.mjs` | Fixture and snapshot stores are isolated (R2 and D1), `--refresh` replaces only the selected store, a changed migration chain, a deleted directory, an incomplete D1 or a failed import imports again |
| `tests/local-api.mjs` | The built Worker answers the programme, started, view, Finds, footer and admin reads from the installed D1 with the fixture data, and refuses an absent, old, not-authoritative or body-mismatched D1 |
| `tests/local-dev-smoke.mjs` | `npm run dev` on the real Miniflare D1 and R2: the same reads over HTTP, a second start without import, an import after a stale migration marker, and `--refresh` |
