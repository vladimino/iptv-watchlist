# EPG Cloudflare executor: offline evidence (AIR-348)

Captured 2026-11-07 (UTC) from the repository only. **No production read or write, no source request (Letterboxd, EPG XML, TMDB), no Cloudflare setting change, no migration apply and no Workflow instance was made or created.** Nothing here is a production observation.

## What was measured

`tests/epg-orchestration.mjs` runs the executor module in a Worker-like context with the scoped policy, a scripted pipeline that moves `sync.json` forward the way the real steps do, a stand-in Workflow binding, and a local sqlite D1 stand-in carrying the real migrations.

| Area | Result |
| --- | --- |
| Migration `0015` | Applied on a complete schema 14 chain: version becomes 15, the table is empty, the published-EPG marker is untouched; refused on chains stopped at 11, 12 and 13 with no table created; only the keys `mode` and `control` are accepted and a non-JSON body is refused; the version cannot go down |
| Schedule | 17:00 Madrid is 16:00Z in winter and 15:00Z in summer; both change days (2026-10-25, 2026-03-29) and the second before and at the due time; `nextDailyDue` across them; the executor and the monitor read the same 17:00 constant |
| Inert | No database, a database without the table, and the table with no mode document: `ensure` answers `external` and creates nothing, the external gate lets the path through (with no fence when the table is absent), reads write no row |
| Mode switch | `close_admission` then `complete`: a recent external step, an unfinished seal, a live previous instance and an unreadable `sync.json` each refuse with their own drain reason; a verified drain completes; a second close, a close in the target mode and a bad request are refused; rollback toward `external` raises the epoch again |
| `ensure` | Not due; two overlapping firings create exactly one instance; an alive instance is `in_progress`; an unreadable platform status is not an ended instance; an errored instance is a counted transient failure with a cooldown and then a successor series; held authority starts nothing; create answering `exists` attaches; a lost create response reads the platform first and attaches an instance that exists, or records `create_uncertain`; no binding starts nothing; a complete date and a run quarantine start nothing, and a run quarantine ends with its date |
| Whole run | Start, two metadata steps, the EPG step, a busy seal that sleeps until its own catch-up time, the seal phases and completion: one run started, every call is the in-process executor caller carrying the mode revision it was admitted with, the control record ends `doneAt` with the published run id and no failure, a second `ensure` on the date starts nothing, the read model is healthy |
| Read after unknown | A run of the same date that already completed (another driver, or a lost control write) is the success: the pipeline is not called and the control record names that run |
| Failures | A thrown source failure cools down and the same run resumes (one start only); a `409` run-id conflict and a generation changed under the run are unsafe and quarantine at once (domain scope) until the owner clears it, with no step run by the clear; a repeating transient failure quarantines after exactly the budget cap and makes exactly that many calls |
| Stale instances | Another series, an old epoch, a bad payload and a rolled date each stop with their reason and call nothing; the owner closing admission mid-run stops the instance at its next admission |
| Epoch fence in the publication batch | On a real D1 stand-in: a commit under the admitted mode revision lands; under an older revision it is refused with `published_epg_fence` and writes nothing; a fence carried on the env behaves the same; `revision: null` (no mode document) lands, and refuses if the document was created in between; no fence passed keeps the previous behaviour and needs no table; a malformed fence is refused before any write |
| External path | Closed admission answers `switch_in_progress`, a completed switch `external_writer_fenced`, an unreadable mode document fails closed; the gate runs before a start writes and before a step records anything |
| Cron | The scheduled handler still calls the projector, Ratings `ensure`, the new `ensure`, the Discovery reconcile and the monitor as independent members of one `Promise.allSettled`; a failing create is reported by value and blocks none; the cron expression is unchanged |

## What this does not show

- The behaviour of a real Workflow instance, the CPU and memory of a live EPG step inside a Workflow (the existing 32 s seal budget and 110 s source fetch fit the 120 s CPU limit by construction, unobserved), Cloudflare's wakeup timing and the platform's real status words.
- Any interaction in a real hourly tick when the cron later moves to minute 0 (the projector's `input_changed` deferrals of [AIR-375](https://trello.com/c/orpa1kJ6) share the same tick; this change does not move the cron).
- Parity of a real published generation, R2 mirrors and the Discovery handoff under the executor: those need the authorized natural run.
- The Ratings logical due time (17:30 in ADR 0090) is not changed by this work; it is a separate record.

## Decisions for the reviewer and the owner

1. The storage form of ADR 0100 decision 3 (one new table with two documents) and the fence statement of decision 4.
2. The activation order in the [deployment runbook](../../runbooks/deployment.md) requires migrations `0013` and `0014` before `0015` because the chain is ordered.
3. Whether the Ratings due-time supersession (17:30 to 17:00) is a small separate PR, as proposed.
