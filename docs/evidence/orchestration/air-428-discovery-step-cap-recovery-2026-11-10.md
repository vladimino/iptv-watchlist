# AIR-428: Discovery Workflow did not open a successor after `step_cap` (10 November 2026)

**Captured:** 2026-11-10 (logs) and 2026-11-11 (code). **Scope:** read-only Cloudflare Workers Observability and Workflows API, plus offline tests. No production write, create, retry or flag change.

## What the logs prove

Worker cron `0 * * * *` is configured. Scheduled invocations of script `iptv` with trigger `0 * * * *` ran at **20:00, 21:00 and 22:00 UTC** on 2026-11-10 (21:00, 22:00, 23:00 Europe/Madrid). Each of those ticks logged four Worker events: the cron line, `d1_enrichment_phase`, `d1_enrichment_projection` with `window.outcome=granted` and `outcome=complete`, and `monitor`. There was **no** `discovery_workflow_reconcile` (or any other Discovery reconcile) event.

The published generation's only Workflow instance is `discovery_6d9e3c36bba24e4aa92db2984abdc810_0`. Platform status `complete`, `ended_on=2026-11-10T19:50:48.000Z` (20:50 Europe/Madrid). No `_1` instance exists in the Workflows list.

## What the logs do not prove

`reconcileDiscoveryWorkflow` turns refusals into `{started:false,reason}` and, before this change, wrote nothing to Workers Logs. A successful cron therefore does not prove that Discovery recovery ran or that it returned `projector_window`, `write_conflict`, or `d1_unavailable`. The parallel projector window on the same tick is the confirmed collision (hypothesis a); hypotheses (b) transient D1 admission and (c) CAS/`create()` uncertain are **not** distinguished in the 10 November log, because the reconcile outcome was not persisted.

## Code conclusion

The same hourly `scheduled()` `Promise.allSettled` starts the projector (which grants `projector_window`) and `reconcileDiscoveryWorkflow`. A held window refuses the successor state write as `projector_window`. The next hourly tick grants a new window again, so waiting for the next cron does not recover. The in-instance recovery path already sleeps to the window expiry; the scheduled fallback did not.

The fix retries a scheduled `projector_window` in the same tick, at most three attempts, after the window's one expiry (capped), and logs every attempt as `discovery_workflow_reconcile` (reason, attempt, instance/series, no secrets). An unscheduled caller still returns the typed refusal immediately.

**Verdict:** GO for that scheduled retry and diagnostic. Not production evidence that a successor has already been created.
