# Continuous prediction runner v5

The same start/next/submit/complete protocol serves manual and scheduled triggers. Read GET /api/enrichment/runner before every launch. Its contract supersedes the obsolete v3 single-batch/deadline instructions.

1. POST start with scope watchlist_all, mode queued and trigger scheduled/manual. Supply real known capacity only. Do not impose a total-film or time cap.
2. already_running is a successful no-op: never adopt another trigger's runId. busy is transient contention; retry with bounded backoff, without starting concurrent generation.
3. Read next, generate only requested work using the unchanged schema/profile/scoring rules, and submit each film immediately. Repeat next/submit across batches continuously.
4. Before model calls renew POST heartbeat; renew concurrently every 10 minutes if an individual call can last that long. Checkpoints also renew automatically. A 15-minute persistent R2 CAS lease stores owner/runId, heartbeatAt and expiresAt. Expired owners cannot submit. Crash checkpoints survive takeover.
5. next re-evaluates hot urgency before every selection. Cold may run only while hot has no outstanding work. Model call batching remains disabled. Valid fingerprints/predictions are reused; timeslot changes never invalidate them.
6. An isolated malformed/invalid film output is reported through submit items[].failure.kind (parse_error or validation_error), is persisted as a retryable item failure and must not end the run. Failed items are skipped within that run and deferred by a 1-hour exponential retry (maximum 6 hours). Five consecutive distinct format failures trigger format_error_storm. mustComplete means call complete with stopReason. At actual quota/model/API/storage error, complete with a short safe reason and retain all saved predictions. No credentials in outputs, URLs, Events or persisted error reasons. A killed process recovers through lease expiry.
7. Progress Events aggregate the run every 50 successful predictions or 30 minutes, whichever comes first; the final event is separate. Check heartbeat/next/submit to emit time-based progress during active work. Successful empty checks don't spam Events. Eligible queue exhaustion with deferred item retries is a normal completion, not a run interruption.

Run counters and film outcomes persist after each submission. Current-batch film reads stay bounded; completed batches are counted from saved outcomes rather than loading every completed film on every next request.

Tests: node tests/continuous-drain.mjs; node tests/throughput.mjs; node tests/enrichment.mjs. The multi-batch integration test uses an isolated R2 implementation and deterministic validated model outputs; it is not a production LLM throughput benchmark.
