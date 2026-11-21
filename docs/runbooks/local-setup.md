# Local setup

`npm run dev` builds the Worker when `src/`, `public/`, `data/`, or `build.mjs` is newer than `dist/server/index.js` (the build writes each output to a temporary file and renames it into place, so a test or server reading the bundle never sees a partial file), then serves it at `http://127.0.0.1:8787` with a local R2 bucket. Nothing is written to Cloudflare. `npm run dev -- --watch` rebuilds those sources while the server is running. That process has no D1 binding. Its generated config sets `PUBLISHED_EPG_DB_OPTIONAL` to `standin`, so the local programme stays on those R2 objects. The committed `wrangler.jsonc` does not set that variable: a production Worker without `DB` fails closed. Owner reviews have the same local stand-in: the dev server sets `OWNER_REVIEW_DB_OPTIONAL` to `standin`, so local owner reviews stay on the R2 object `admin/owner-reviews.json`. `wrangler.jsonc` does not set it either, and a Worker whose owner-review binding, schema, tables or marker are missing or invalid fails closed. The metadata cache has the same opt-in: the dev server sets `METADATA_CACHE_DB_OPTIONAL` to `standin`, so the local metadata working set stays on `metadata.json`; without it, and in production, a missing binding, schema, table or a marker that is not `d1` fails closed ([ADR 0162](../adr/0162-d1-only-authority-retire-rollback-toolchain.md)). The EPG run checkpoint (`sync.json` and `watchlist-ingest.json`) has the same local stand-in: the dev server sets `EPG_CHECKPOINT_DB_OPTIONAL` to `standin`, so the run state stays in the local R2 objects when the checkpoint tables are not installed at all. The committed `wrangler.jsonc` does not set it, and a partly installed domain, version 30 without the tables or a marker that is not `d1` stays refused.

## Dummy site

Another computer does not need the private production snapshot. The committed catalog is [fixtures/local-site/catalog.json](../../fixtures/local-site/catalog.json). It contains `Movie1`, `Movie2`, and `Movie3`, `Director1`, `Actor1`, `Actor2`, `Genre1`, and `Genre2`.

```bash
npm run dev
```

The script turns the catalog into the R2 objects the dashboard reads. Dummy data and each private snapshot have their own directory under gitignored `.wrangler/state/stores/`. The fixture store is `stores/fixtures`. A snapshot store is `stores/snapshot-` plus a hash of the absolute snapshot path, so the path itself is not a directory name. Switching modes serves only the selected store.

- `programme.json` and `watchlist.json`
- `epg/published-generation.json` naming the `local-fixture` generation, with the generation copies `epg/generations/local-fixture/programme.json` and an empty `epg/generations/local-fixture/discovered-films.json`, so the pinned readers (`/api/catalog/available`, `/api/admin/*`) answer locally
- `titles.json` with one provisional title (`Movie2`) and `people.json` with one cached name (`Actor2`), which the owner page at `http://127.0.0.1:8787/admin` shows as the provisional queue; `Movie1` carries a synthetic TMDB id so it reads as resolved. The health view (`/admin/health`) reads the same store: the fixture has no prediction queue, continuation record or catalog copy, so those subsystems show as unknown or missing there, which is the honest state of the dummy store
- `sync.json`
- `enrichment/profile/current.json`, a local version and hash so the dummy prediction is not marked stale
- `enrichment/view-index.json`, one record per film id, including `moodLabels`, `fingerprintHash`, and `execution`: a stand-in object for operator tools and snapshot import. The Worker derives the view index from D1 and never reads this object ([view index contract](../reference/domain/view-index-read-model.md)).

After the view index retirement the local development stack serves the programme, started-mark and admin reads, but `GET /api/enrichment/view`, Finds (`/api/catalog/available`) and the footer refuse with `502` or `503`: the view index is derived from D1 and local development has no authoritative D1. A local D1 that satisfies the ratings contract also forces the published-EPG authority (the [ADR 0162](../adr/0162-d1-only-authority-retire-rollback-toolchain.md) stand-ins apply only while those tables are absent). `scripts/local-fixtures.mjs` and `scripts/local-store.mjs` still write `enrichment/view-index.json`, only for the operator tools and snapshot import; the Worker never reads it. A local D1 importer is a separate follow-up that does not exist yet.
- `started/movie-1.json`
- `events/items/local-fixture-epg.json`

The local view response is not available (see above).

Show times are calculated from the moment of import, so `Movie1` has one recent broadcast and one later the same day. `Movie3` has no broadcasts; enable “Показывать фильмы без показов” to see it. A later `npm run dev` reuses the fixture store when the catalog file is unchanged and `programme.json`, `watchlist.json`, and the view index are present. If those objects are missing, unreadable, or the view index is not a film map, the store is imported again. The marker for that store is written only after the import succeeds. `npm run dev -- --refresh` deletes the selected store and imports it again. Other stores are left in place.

An older combined directory at `.wrangler/state/v3` is not read. The next run fills the new store from the catalog or the snapshot directory.

Do not copy these fixtures into the production bucket.

## Private snapshot

If this machine has the private export, copy [.local-dev.example.json](../../.local-dev.example.json) to `.local-dev.json` and set `snapshot` to that directory’s absolute path. `.local-dev.json` is gitignored. `npm run dev` then imports that snapshot into its own store instead of the dummy catalog. Remove `snapshot` or set it to an empty string to return to the fixtures. The fixture store stays on disk and is not served while the snapshot is selected.

### Shifting broadcast times to today

An exported snapshot is frozen at its export date, so every show is soon in the past and the dashboard reports that the saved window has ended. Set `"shiftToNow": true` next to `snapshot` in `.local-dev.json` to import the snapshot as if the programme had been refreshed today. The import moves the broadcast timestamps forward by a whole number of calendar days in `Europe/Madrid`, the site's display time zone, chosen so that the shifted `programme.updatedAt` is the latest one not past the current time. Every show keeps its original local hour of the day, including across a DST transition between the export date and today, so a 21:00 Madrid broadcast still starts at 21:00 Madrid time. All timestamps of one import go through the same wall-clock mapping, which keeps the window, the shows and the update markers consistent with each other; durations that straddle a transition hour may change by one hour, as they do in a real programme.

The shift applies to `programme.json` (`updatedAt`, `watchlistUpdatedAt`, `cutoff`, `window`, `stats.epgStart`/`epgEnd`, every `shows[].start`/`end` and stored `availableUntil`), `watchlist.json`, `sync.json`, `epg/discovery-latest.json`, `epg/discovered-films.json`, staged copies under `epg/generations/`, and the `at` of EPG and watchlist events in `events/items/*`. Fingerprints, predictions, the taste profile, leases, started markers and their events keep their real timestamps, so prediction freshness is not faked and no event lands in the future. The shift is part of the store marker: the next `npm run dev` on a later day imports the snapshot again with a larger shift, while a restart on the same day reuses the store. The option has no effect on the dummy catalog, whose shows are already built from the current time, and it never writes to the snapshot directory or to Cloudflare.

`IPTV_DEV_PORT`, `IPTV_LOCAL_STATE`, and `IPTV_LOCAL_CONFIG` override the port, the state root, and the config file. The local smoke test uses them so it does not touch a developer’s `.local-dev.json` or `.wrangler/state`.

Local Node 20 uses Wrangler 4.86 and compatibility date `2026-05-03` for this process only. The committed Worker compatibility date is unchanged.
