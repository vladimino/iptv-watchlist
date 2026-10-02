# В эфире / Watchlist

Private single-owner IPTV programme. Public source adapters run in the Cloudflare Worker; R2 holds source metadata, the active sync, the last complete programme and recent unresolved matches. The public webpage reads `/api/programme`; no source credentials are required.

## Cloud update procedure

This Site must remain owner-private. Obtain its current platform service credential through `get_site` and send it only to this Site as `OAI-Sites-Authorization: Bearer ...`. It must never be saved in files, prompts or logs.

1. POST `/api/sync/start` with JSON `{}`. Retain returned `runId` and `stage`. This reads all watchlist pages, checks unique count against the site count, and verifies the first page again for concurrent changes.
2. While stage is `metadata`, POST `/api/sync/metadata` with JSON `{"runId":"<returned value>"}` until stage is `epg`. Each request enriches at most 12 films from their public Letterboxd pages, in groups of three. Metadata cache lasts 30 days. Report missing metadata explicitly.
3. POST `/api/sync/epg` with the same runId. It streams XMLTV, checks the closing tv tag, excludes channels beginning with two uppercase Latin letters and a colon, matches exact normalized aliases with year or compatible feature-film duration, and atomically replaces the stored programme only after successful parsing.
4. GET `/api/programme` and `/api/status`. Verify the programme timestamp belongs to this run, `watchlistCount` agrees, and stage is `complete`. Summarize only real failures, stale data or user action needed. Routine success is quiet.

Source URLs: https://example.invalid/epg.xml and https://letterboxd.com/demo-user/watchlist/ . No browser session or local files are needed for recurring updates. Transient requests can be retried; never replace a successful programme with empty/error data. Do not pause the schedule on a single failed occurrence.

Archive means past scheduled broadcasts, not verified playable catch-up. Retain previous matched broadcasts within 72 hours only where the new source no longer covers the relevant earlier time. Future shows always come from the latest source. Display source horizon and stale data status.

## Build

`node build.mjs` embeds the existing UI assets and the Worker modules into `dist/server/index.js`. Source lives in `public/` and `src/`. No external build dependency is required. Publish through the Sites workflow using the existing project id.

## Checks

`node tests/sources.mjs` tests time offsets, title normalization, real Letterboxd parsing, stream chunk boundaries, excluded channels, incomplete XML rejection and a full source scan (local source fixtures reside outside the checkout). The live cloud workflow must additionally be run and read back after changes to source adapters or authorization.
