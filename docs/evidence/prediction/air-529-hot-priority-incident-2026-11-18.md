# AIR-529 hot/cold priority incident, 18 November 2026

Status: offline fix and regression test. Production acceptance is pending a natural EPG, Discovery and Prediction run.

## Root cause (code)

`priorityRefreshDue` and `queueAdvanceGate` compared only `programmeRunId`. Discovery inserts `published_epg_show` rows (`basis='discovery'`) into the already published generation, so the completed programme gained showings while the queue kept ranking on the earlier basis. The Discovery comment that the runner "refreshes the queue on every step" was out of date after AIR-431. The incident trigger on the day (a rebuild at 11:56:57 Madrid) is not proven; the incident figures (hot 0 to about 3,000) are as recorded on the card and were not re-read here.

## Fix

- `PublishedEpg.assignedShowsSignature`: one indexed aggregate (count, max rowid, small content sum) per generation. The content sum is needed because SQLite reuses a freed rowid, so a delete plus re-insert at the same count is otherwise invisible (found by the test).
- The queue stores `showsSignature`; `batchPreflight` marks priority due on mismatch; no full scan on submit or complete.

## Evidence

`tests/prediction-hot-reconcile-same-generation.mjs`: signature semantics; an all-cold queue on a fixed generation becomes 60 hot at the next start with no new generation; unchanged and unreadable signatures rebuild nothing; a dry run writes nothing.

## Limits

Concurrent-writer and rollover scenarios rely on the existing queue CAS tests (`prediction-queue-cas`, `prediction-queue-discovery-independence`), which pass. No ADR: a local bugfix, no new data contract or schema. No production action was taken.
