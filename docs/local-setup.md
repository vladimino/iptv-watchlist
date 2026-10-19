# Local setup

`npm run dev` serves the Worker at `http://127.0.0.1:8787` with a local R2 bucket. Nothing is written to Cloudflare.

## Dummy site

Another computer does not need the private production snapshot. The committed catalog is [fixtures/local-site/catalog.json](../fixtures/local-site/catalog.json). It contains `Movie1`, `Movie2`, and `Movie3`, `Director1`, `Actor1`, `Actor2`, `Genre1`, and `Genre2`.

```bash
npm run build
npm run dev
```

The script turns the catalog into the R2 objects the dashboard reads and stores them in gitignored `.wrangler/state`:

- `programme.json` and `watchlist.json`
- `sync.json`
- `enrichment/view-index.json`
- `started/movie-1.json`
- `events/items/local-fixture-epg.json`

Show times are calculated from the moment of import, so `Movie1` has one recent broadcast and one later the same day. `Movie3` has no broadcasts; enable “Показывать фильмы без показов” to see it. A later `npm run dev` reuses this local bucket. `npm run dev -- --refresh` imports the catalog again.

Do not copy these fixtures into the production bucket.

## Private snapshot

If this machine has the private export, copy [.local-dev.example.json](../.local-dev.example.json) to `.local-dev.json` and set `snapshot` to that directory’s absolute path. `.local-dev.json` is gitignored. `npm run dev` then imports that snapshot instead of the dummy catalog. Remove `snapshot` or set it to an empty string to return to the fixtures.

Local Node 20 uses Wrangler 4.86 and compatibility date `2026-05-03` for this process only. The committed Worker compatibility date is unchanged.
