# В эфире / Watchlist

Private single-owner IPTV programme. Public source adapters run in the Cloudflare Worker; R2 holds source metadata, the active sync, the last complete programme and recent unresolved matches. The public webpage reads `/api/programme`; no source credentials are required.

## Cloud update procedure

This Site must remain owner-private. Obtain its current platform service credential through `get_site` and send it only to this Site as `OAI-Sites-Authorization: Bearer ...`. It must never be saved in files, prompts or logs.

1. POST `/api/sync/start` with JSON `{}`. Retain returned `runId` and `stage`. This reads all watchlist pages, checks unique count against the site count, and verifies the first page again for concurrent changes.
2. While stage is `metadata`, POST `/api/sync/metadata` with JSON `{"runId":"<returned value>"}` until stage is `epg`. Each request enriches at most 12 films from their public Letterboxd pages, in groups of three. Metadata cache lasts 30 days. Existing film titles and person names use bundled ID dictionaries. A one-time synopsis backfill reads each current Letterboxd film page and caches the description without refreshing otherwise valid credits; later metadata refreshes update it along with other film data. Newly added films get a provisional Russian title from a unique Wikidata Russian label matched to the exact TMDB film ID; absent or ambiguous matches stay unresolved and are counted in the report. Report missing metadata explicitly.
3. POST `/api/sync/epg` with the same runId. It streams XMLTV, checks the closing tv tag, excludes channels beginning with two uppercase Latin letters and a colon, matches exact normalized aliases with year or compatible feature-film duration, and rejects a short horizon, major programme/channel loss or a collapse in matched broadcasts compared with the last good update. Only then does it commit a self-contained programme snapshot containing the complete watchlist and shows. The separate watchlist copy is repaired on retry if that second write fails. Started-film markers are stored separately and are never rewritten by sync.
4. GET `/api/programme` and `/api/status`. Verify the returned run ID and timestamp belong to this run, `watchlistCount` agrees, stage is `complete`, and `titleMissing`, `metadataMissing`, `synopsisAvailable`, `synopsisMissing`, `peopleMissing` and other reported failures are checked. The programme endpoint includes the complete watchlist, including films with no broadcasts. Summarize only real failures, stale data or user action needed. Routine success is quiet.

Source URLs: https://example.invalid/epg.xml and https://letterboxd.com/demo-user/watchlist/ . No browser session or local files are needed for recurring updates. Transient requests can be retried; never replace a successful programme with empty/error data. Do not pause the schedule on a single failed occurrence.

Archive means past scheduled broadcasts, not verified playable catch-up. Retain previous matched broadcasts within 72 hours only where the new source no longer covers the relevant earlier time. Future shows always come from the latest source. Display source horizon and stale data status.

## Build

`node build.mjs` embeds the existing UI assets and the Worker modules into `dist/server/index.js`. Source lives in `public/` and `src/`. No external build dependency is required. Publish through the Sites workflow using the existing project id.

## Checks

`node tests/sources.mjs` tests time offsets, title normalization, real Letterboxd parsing, stream chunk boundaries, excluded channels, incomplete XML rejection and a full source scan (local source fixtures reside outside the checkout). The live cloud workflow must additionally be run and read back after changes to source adapters or authorization.

## People filters

Every watchlist film stores all directors and the first ten actors in Letterboxd billing order, each keyed by its Letterboxd role URL. Russian names come from Wikidata, matched using the film's TMDB ID and the person's English name. A failed Russian-name request is retried on a later sync; unknown names retain the source spelling rather than an invented translation. `people.json` caches resolved names. `/api/watchlist` exposes the last complete current watchlist including credits; `/api/programme` contains the complete watchlist and people catalog; films without broadcasts have an empty `shows` array and are hidden by default in the UI.

Director and actor comboboxes search Russian and original names without case sensitivity, sort alphabetically, accept keyboard navigation and apply an exact person selection. Both person filters intersect with each other and existing filters. Reset clears both; alphabetical film sorting remains the default.

## Started films

`GET /api/started` lists saved film IDs; `POST /api/started` accepts an explicit `{id, started}` state. Independent R2 objects under `started/` use stable Letterboxd film IDs. This small single-owner flag store reuses existing durable storage without a database migration; separate keys prevent changes to different films from overwriting each other. Source sync never writes this prefix. Removing a mark deletes only that marker. The UI confirms writes before changing the saved state, offers retry on failures, reloads flags on window focus and intersects the started-only filter with existing filters. Reset clears filters, never stored marks. `node tests/started.mjs` covers the persistence boundary and failure cases.

## Activity feed

Immutable events live under `events/items/`, with reverse timestamp keys for newest-first pagination. GET `/api/events` returns 20 events and an opaque cursor. POST `/api/events/bootstrap` seeds only the last confirmed programme/watchlist snapshots and existing started markers; it does not invent historical watchlist changes. Sync events use deterministic run IDs and preserve the before/after difference across retries. Already-committed reports resume logging without fetching EPG again. Started markers retain their last event for an idempotent retry; unmarked tombstones are excluded using R2 custom metadata. The feed distinguishes films from broadcasts and never infers watched status from removal from a watchlist. `node tests/activity.mjs` exercises these boundaries.
