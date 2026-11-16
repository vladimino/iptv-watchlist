# AIR-511 — Prediction scoring without a completed EPG snapshot

**Date:** 2026-11-16 UTC  
**Scope:** Offline tests of [ADR 0154](../../adr/0154-prediction-eligibility-independent-of-epg.md). No production read, no Worker deploy, no EPG or prediction write.

## What was run

`node tests/prediction-epg-independence.mjs` and `node tests/prediction-batch-start.mjs` on the implementation commit of this change.

## What held

- With `sync.stage` `seal`, a programme report already renamed to that unsealed `runId`, and a stored queue from `p1`, `prediction_batch_start` (`manifestSize: 5`) returned five film inputs, `batch_submit` created them, and `prediction_complete` (`manifest_spent`) succeeded. `sync.json` and `programme.json` were unchanged. A retry record on a film outside the manifest stayed at 3 attempts. The queue `programmeRunId` stayed `p1`.
- A carried priority keeps `priorityAsOf` from the completed snapshot. A second rebuild does not move it. Setting that instant 37 hours back makes the next rebuild neutral even though `refreshedAt` is recent.
- A film that exists only in `watchlist.json`, not in the partial programme and not in Discovery, is queued during `finalize`, appears in the manifest and submits. It is not settled as a missing admission.
- After one film was predicted, adding a show on the same completed programme and reconciling the queue left that film out of the next manifest.

## What this does not show

Production behaviour of the natural Predictions Task, and whether a live seal leaves `programme.json` in the shape this test injected.
