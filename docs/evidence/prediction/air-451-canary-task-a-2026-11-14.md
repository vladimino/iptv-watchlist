# AIR-451: production canary and same-ID Task A activation

**Captured:** 14 November 2026, read-only evidence from the live ChatGPT Scheduled Tasks registry, owner-provided event screenshot and IPTV Worker MCP. Timestamps are UTC unless marked Europe/Madrid. The owner separately authorized GO 1 (one-off creation) and the move to GO 2 (same-ID hourly activation). No manual prediction run or production write was made to collect the evidence.

## Task registry

- **Canary / Task A ID:** `6af7a2d8369081918b79bb2892bac0fe`. Title remained `IPTV Predictions v2 Canary` after rescheduling.
- **Natural GO 1:** one-off `DTSTART;TZID=Europe/Madrid:20261114T010000`. Scheduled for 00:00Z, Task started at 00:00:25.721Z and completed at 00:04:36.076Z (`recorded_status=completed`); about 26 seconds of scheduler start jitter for this one sample.
- **GO 2:** the **same ID** was changed to enabled hourly :00: `DTSTART;TZID=Europe/Madrid:20261114T020000`, `RRULE:FREQ=HOURLY;INTERVAL=1`, `timing_mode=exact_schedule`, `default_timezone=Europe/Madrid`. Next nominal run at readback: 14 Nov 02:00 Europe/Madrid.
- **Canonical prompt equality:** Task registry prompt equals the production text between markers in `docs/reference/scheduled-task-prompts/hourly-predictions-batch-v2.md` (23,537 characters, SHA-256 `45a56e60819e57d0d8e119f65d29908a1cc4b3b81c6164359bdca727a5f0f59b`). Configuration `manifestSize=5`, `generationSize=1`, `submitBatchSize=5`; no `dryRun:true`.
- **Exclusivity:** legacy v5 Task `Automation_25293680bdb08191818ee2db30438f49` disabled. Daily Drift monitor `6ade65245de481919b816c5f5026c121` enabled, untouched. Tasks B/C/D on :15/:30/:45 not installed.

## Production outcome

- Worker run `210bf9b5-4f99-4e68-be5a-84bf0f5e8122`, `trigger=scheduled`, `batch_v2`.
- Worker acquired run at 00:00:41.642Z and completed at 00:04:10.689Z, `status=complete`, `stopReason=manifest_spent`. Last-run values: `selectedCount=5`, `checked=5`, `counts.created=5`, `counts.recalculated=0`, `counts.failed=0`, `counts.pending=0`.
- Canary Task execution report: five `assessment=written`, three successful first-submit items, two initially `deferred_budget` but successfully saved in another submit. One film's independent execution criticism was unavailable; Task reported low confidence and unknown execution dimensions rather than claiming a substantive review.
- Read-only Worker state: `currentRun=null`, `eventOutbox.pending=0`, `eventOutbox.quarantined=0`; no `serverFault` or `callerFault`. A stale earlier legacy run was terminally classified with `recovered_stale_lease`; no manual lease reset.
- Consistent queue readback: prediction coverage **3,512/9,648 (36.4%) → 3,517/9,648 (36.5%)**, eligible hot **3,571 → 3,566**, cold pending 2,532 unchanged. Owner screenshot showed two consecutive Events: “Predictions restored” at about 01:01 Madrid (classification of the old interrupted run when the new start recovered a stale lease), and a truthful “Predictions updated” at about 01:04 Madrid with five added, zero failures and reason `manifest_spent`. These are different events, not two successful prediction batches.
- The Worker diagnostics mark some formed HTTP 200 responses as `delivery=unconfirmed` because no caller acknowledgment was recorded. The Task completion report and independent terminal Worker state agree on success; the field alone does not prove response loss.

## Not yet proven

This establishes **one successful natural canary and verified Task A hourly activation**, not model accuracy or stable multi-hour throughput. Acceptance still needs naturally scheduled hourly Task A observations (jitter, overlap, no-op, lease, assessment quality) and separate owner authorization for each additional Task B/C/D. No ad-hoc catch-up, `run_now`, lease reset, flag change, v5 re-enable, or other production operation is authorized by this record.

[Owner approval and activity card](https://trello.com/c/NN3N6kRp) · [Operating runbook](../../runbooks/prediction-operations.md#planned-rollout-of-four-hourly-v2-tasks-air-451) · [Canonical prompt](../../reference/scheduled-task-prompts/hourly-predictions-batch-v2.md)
