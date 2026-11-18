# AIR-529 hot/cold priority incident, 18 November 2026

Status: offline fix and regression test. Production acceptance is pending a natural EPG, Discovery and Prediction run.

## Root cause (code)

`priorityRefreshDue` and `queueAdvanceGate` compared only `programmeRunId`. Discovery inserts `published_epg_show` rows (`basis='discovery'`) into the already published generation, so the completed programme gained showings while the queue kept ranking on the earlier basis. The Discovery comment that the runner "refreshes the queue on every step" was out of date after AIR-431. The incident trigger on the day (a rebuild at 11:56:57 Madrid) is not proven; the incident figures (hot 0 to about 3,000) are as recorded on the card and were not re-read here.

## Fix

- `PublishedEpg.assignedShowsSignature`: one statement reading the exact (film, channel, start) of the run's Discovery rows in generation-index order, hashed with SHA-256. A first version used a numeric aggregate (count, max rowid, sum); independent review showed it misses a reassignment because SQLite reuses a freed rowid, so it was replaced.
- The queue stores `showsSignature`; `batchPreflight` marks priority due on mismatch, on a missing stored value, and on an unreadable current value (`priorityCause`), so a start never silently selects cold when hot outstanding cannot be verified. The dry run reports the cause.
- No new schema or index. A revision counter on the generation would be cheaper per preflight but needs an owner decision and an ADR.

## Evidence

`tests/prediction-hot-reconcile-same-generation.mjs`: reassignment of the only slot to another film, channel and start changes; 3,600 assigned shows hashed by one statement in about 7 ms on the local stand-in (rows read: 3,600 per preflight; D1 production cost is not measured here); 3,200 catalog films under one generation go from 0 hot to 3,100 hot at the next natural start; unreadable signature blocks the cold manifest and the next start recovers; incremental Discovery chunks; a signature that lands during a rebuild is picked up by the next start; rollover stays on the existing path.

## Limits

D1 production read cost and walltime are not measured; the preflight reads the assigned rows once per batch start. Lost or duplicate checkpoints and CAS conflicts rely on the existing `prediction-queue-cas` and `prediction-queue-discovery-independence` tests. No ADR: local bugfix. No production action was taken.
