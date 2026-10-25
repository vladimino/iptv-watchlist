# Local setup

`npm run dev` builds the Worker when `src/`, `public/`, `data/`, or `build.mjs` is newer than `dist/server/index.js`, then serves it at `http://127.0.0.1:8787` with a local R2 bucket. Nothing is written to Cloudflare. `npm run dev -- --watch` rebuilds those sources while the server is running.

## Dummy site

Another computer does not need the private production snapshot. The committed catalog is [fixtures/local-site/catalog.json](../../fixtures/local-site/catalog.json). It contains `Movie1`, `Movie2`, and `Movie3`, `Director1`, `Actor1`, `Actor2`, `Genre1`, and `Genre2`.

```bash
npm run dev
```

The script turns the catalog into the R2 objects the dashboard reads. Dummy data and each private snapshot have their own directory under gitignored `.wrangler/state/stores/`. The fixture store is `stores/fixtures`. A snapshot store is `stores/snapshot-` plus a hash of the absolute snapshot path, so the path itself is not a directory name. Switching modes serves only the selected store.

- `programme.json` and `watchlist.json`
- `sync.json`
- `enrichment/profile/current.json`, a local version and hash so the dummy prediction is not marked stale
- `enrichment/view-index.json`, one record per film id, including `moodLabels`, `fingerprintHash`, and `execution`
- `started/movie-1.json`
- `events/items/local-fixture-epg.json`

The current view response uses the film-id map, mechanics, and mapped mood ids. It does not yet return the stored `execution` object.

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
