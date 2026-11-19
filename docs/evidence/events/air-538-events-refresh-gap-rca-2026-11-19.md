# AIR-538: Events Log hole after a background refresh (RCA, 19 November 2026 UTC)

## Method and limits

Code reading of `src/worker.js` (`eventPage`) and `public/app.js` (`loadEvents`, `renderActivity`) plus an offline reproduction in `tests/events-pagination-ui.mjs`. Production was read through the owner-approved Access login with only `GET /api/events`, 12 pages following the cursor (240 events, counts and ids only, no payloads kept). No R2, D1, Discovery or flag operation was run.

## Production result

The API returns the four hours in order on pages 3 and 4, between the 04:00Z and 23:00Z controls, with no duplicate ids across the 240 events: `discovery-hour-...-20261118T23` (checked 1418, added 53), `...19T00` (1411, 106), `...19T01` (1386, 115), `...19T02` (1343, 143). Totals 5,558 checked and 417 added match the card. So the server side and R2 are correct and the loss happens in the client (`loadedEvents` and cursor handling), not in `GET /api/events`.

## Findings

- `eventPage` lists `events/items/` (limit 20, reversed-timestamp keys), reads each object and returns the objects plus the R2 cursor. It writes nothing and drops nothing except an unreadable object.
- `renderActivity` and the hourly Discovery card hide no event for `queueEmpty=false` or `status=running`.
- `loadEvents(false)` (background refresh of the first page) merged the new page into `loadedEvents` and kept the old cursor. When more events arrived than one page holds, the new page shared no id with the loaded list, so the events between them were in no page the kept cursor would ever return. They stayed in R2 but never reached the list. This matches the symptom (23:00 and 04:00 shown, 00:00-03:00 missing).

## Fix

A first-page refresh that shares no event id with the loaded list, while a cursor remains, restarts the list from the fresh page and its cursor. Older events return by scrolling, each once. Overlapping refreshes merge as before. The server, the stored events and the AIR-530 UX are unchanged.

## Test

Scenario 14 of `tests/events-pagination-ui.mjs` fails without the fix and passes with it: disjoint refresh restarts, scrolling reaches every event once with no gap, the end marker appears only at cursor exhaustion; an overlapping refresh keeps the list without duplicates. `npm test` (416 files) and `npm run build` passed locally.

## Not yet proven

The exact client sequence that dropped the hours in the owner's browser was not observed (the refresh gap is the code-level cause that fits). After deploy, check that `/events` shows 00:00-03:00 Madrid. Desktop 1280 / mobile 390 Visual QA, and independent review of the exact HEAD.
