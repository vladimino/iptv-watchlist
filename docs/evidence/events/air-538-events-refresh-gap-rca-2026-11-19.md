# AIR-538: Events Log hole after a background refresh (RCA, 19 November 2026 UTC)

## Method and limits

Code reading of `src/worker.js` (`eventPage`) and `public/app.js` (`loadEvents`, `renderActivity`) plus an offline reproduction in `tests/events-pagination-ui.mjs`. **No production read was made**: the four stored hourly reports were not compared with live `GET /api/events` pages, so the production path R2 -> `/api/events` -> `loadedEvents` -> UI is not proven end to end. No R2, D1, Discovery or flag operation was run.

## Findings

- `eventPage` lists `events/items/` (limit 20, reversed-timestamp keys), reads each object and returns the objects plus the R2 cursor. It writes nothing and drops nothing except an unreadable object.
- `renderActivity` and the hourly Discovery card hide no event for `queueEmpty=false` or `status=running`.
- `loadEvents(false)` (background refresh of the first page) merged the new page into `loadedEvents` and kept the old cursor. When more events arrived than one page holds, the new page shared no id with the loaded list, so the events between them were in no page the kept cursor would ever return. They stayed in R2 but never reached the list. This matches the symptom (23:00 and 04:00 shown, 00:00-03:00 missing).

## Fix

A first-page refresh that shares no event id with the loaded list, while a cursor remains, restarts the list from the fresh page and its cursor. Older events return by scrolling, each once. Overlapping refreshes merge as before. The server, the stored events and the AIR-530 UX are unchanged.

## Test

Scenario 14 of `tests/events-pagination-ui.mjs` fails without the fix and passes with it: disjoint refresh restarts, scrolling reaches every event once with no gap, the end marker appears only at cursor exhaustion; an overlapping refresh keeps the list without duplicates. `npm test` (416 files) and `npm run build` passed locally.

## Not yet proven

Production confirmation of the four hours (00:00-03:00 Madrid, 5,558 checked / 417 added), desktop 1280 / mobile 390 Visual QA, and independent review of the exact HEAD.
