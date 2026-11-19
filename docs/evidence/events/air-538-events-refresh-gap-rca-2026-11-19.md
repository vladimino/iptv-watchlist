# AIR-538: Events Log hole after a background refresh (RCA, 19 November 2026 UTC)

## Method and limits

Code reading of `src/worker.js` (`eventPage`) and `public/app.js` (`loadEvents`, `renderActivity`) plus an offline reproduction in `tests/events-pagination-ui.mjs`. Production was read through the owner-approved Access login with only `GET /api/events`, 12 pages following the cursor (240 events, counts and ids only, no payloads kept). No R2, D1, Discovery or flag operation was run.

## Production result

The API returns the four hours in order on pages 3 and 4, between the 04:00Z and 23:00Z controls, with no duplicate ids across the 240 events: `discovery-hour-...-20261118T23` (checked 1418, added 53), `...19T00` (1411, 106), `...19T01` (1386, 115), `...19T02` (1343, 143). Totals 5,558 checked and 417 added match the card. So the server side and R2 are correct and the loss happens in the client (`loadedEvents` and cursor handling), not in `GET /api/events`.

## Findings

- `eventPage` lists `events/items/` (limit 20, reversed-timestamp keys), reads each object and returns the objects plus the R2 cursor. It writes nothing and drops nothing except an unreadable object.
- `renderActivity` and the hourly Discovery card hide no event for `queueEmpty=false` or `status=running`.
- `loadEvents(false)` (background refresh of the first page) merged the new page into `loadedEvents` and kept the old cursor. The cursor is kept once an older page has been loaded (or more than 20 events are loaded). When more events arrived than one page holds, the new page shares no id with the loaded list, so the events between them are in no page the kept cursor will ever return. With only the first page loaded the cursor is replaced and there is no hole. They stayed in R2 but never reached the list. This matches the symptom (23:00 and 04:00 shown, 00:00-03:00 missing).

## Fix

A first-page refresh that shares no event id with the loaded list, while a cursor remains, restarts the list from the fresh page and its cursor, renews the prefetch budget (`eventPaging.run`) and cancels the type search (an `exhausted` search described the old cursor and would not be restarted). Older events return by scrolling, each once. Overlapping refreshes merge as before. The server, the stored events and the AIR-530 UX are unchanged.

## Test

Scenario 14 of `tests/events-pagination-ui.mjs`: 60 stored events, a 20-item page, four hourly Discovery events just past the first page (the skipped part), two tied timestamps (one pair across the page boundary), cursors that are event ids so an old cursor stays valid. The tab holds the older 35 with the cursor kept. (a) «Все события» with the prefetch budget used up: after the disjoint refresh the budget is renewed, the list restarts from the fresh 20, scrolling gives all 60 once in order, the end marker only at exhaustion. (b) Filter «Discovery» already `exhausted` on the older archive: after the refresh the search runs again and the four hours appear once. (c) An overlapping refresh keeps the list and the cursor without duplicates. Removing the prefetch reset, the search reset, or the whole fix each fails the scenario. `npm test` and `npm run build` pass.

## Visual QA (19 November 2026, Playwright Chromium, local `public/` with stubbed `/api`, no screenshots saved)

70 epg events plus the four hourly Discovery events (1418/53, 1411/106, 1386/115, 1343/143), on `/events` and in the compact Events block of the home page (on mobile the block sits in the collapsed filter panel, opened for the check). The tab loads two pages, then 25 newer events arrive and the first page is refreshed, then the list is scrolled to the end, at 1280x900 and 390x844.

- Fix: 74 of 74 events shown, 74 unique, in the app's order (time, then id), the four hours present with the right numbers, end marker shown, no horizontal overflow, on `/events` and the home block at both widths.
- Base `main`: 69 of 74 shown, five events missing, and the end marker shown anyway (the hole).
- Not checked: real card styling beyond the numbers (the card markup was the app's own; no screenshot saved).

## Not yet proven

The exact client sequence that dropped the hours in the owner's browser was not observed (the refresh gap is the code-level cause that fits and is reproduced in a browser). After deploy, check that `/events` shows 00:00-03:00 Madrid. Independent review of the exact HEAD.
