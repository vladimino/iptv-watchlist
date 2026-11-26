# AIR-612: bounded recovery of the old Letterboxd admission queue (no-op acceptance)

Date of observation: 2026-11-26 (UTC). Trello: [AIR-612](https://trello.com/c/qyJAOoc1), prerequisite [AIR-599](https://trello.com/c/vj7WPo27) (done).

## Scope and method

AIR-612 recovers only entries that the old rules aged out while the id is still on the Watchlist, or that stopped on a transport last reason, and only through an owner-approved exact id list in batches of at most 50 (ADR 0207 decision 4b, [PR #975](https://github.com/vladimino/iptv-watchlist/pull/975)). The report is an L0 read: three `SELECT` statements on D1 `iptv`, no write, no Worker route, no Task, no flag.

The last recorded reason is not proof of the attempt history, so a candidate is only an input to the owner's list, never an automatic requeue.

## Result

| Source | Observation | `rows_written` |
| --- | --- | --- |
| `ratings_domain_authority` | `d1` / `open`, generation 4513 | 0 |
| `watchlist_admission_pending WHERE state = 'terminal'` (the statement of `scripts/letterboxd-check-legacy-report.mjs`) | 0 rows | 0 |
| `ratings_document` key `letterboxd/facts/scans/diary-identity.json` | 1 part, 30 bytes, etag `b9ba541928fff6a1ffd711d91053038845d84d3bb78410c41133b87f572312fe` | 0 |

The Diary document has the same etag as the 25 November 2026 report recorded on AIR-599 and is 30 bytes, so it holds no entries. The ledger has no terminal row. Candidates: 0 entries, 0 rows, 0 batches.

## Verdict

The list is empty, so this is the evidence/no-op acceptance named on the card. No requeue, reset, dismissal or other production write was made, and none is proposed. New natural failures follow the AIR-599 retry contract (cap 6, transport failures uncharged, owner-visible `at cap`).

## Limits

- The report is the state at the read time, not the history of past failures.
- The document was checked by size and etag against the earlier report, not by reading its JSON body.
- No code, schema, flag, Task or Access change; documentation impact: none beyond this evidence page and its index row.
