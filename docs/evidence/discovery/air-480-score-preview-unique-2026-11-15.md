# AIR-480: `unique.discovery_score` after EPG sync (15 November 2026)

Observed (read-only MCP `epg_pipeline_status` view `operational`, `observedAt` 2026-11-15T18:48:38.501Z; Trello AIR-480):

- Published run `3b7c7152…`, `lastCheckpoint.stage=error`, `reason=discovery_conflict`, `at=2026-11-15T18:11:45.534Z`, `failedAt=null`, `failureKind=unique_constraint`, `failureConstraint=unique.discovery_score`.
- Workflow series 17 `waitingReason=discovery_conflict`. Authority D1/open, generation 137170.

`discovery_score.observation_key` is the primary key. `writeScores` deleted only `WHERE programme_run_id IS <current>` then inserted this chunk. A leftover row from the previous programme with the same observation key collided. Slot uniqueness `(programme_run_id, channel_id, start_ms)` is unchanged.

Fix: replace the whole preview table, then insert. Same-batch duplicate keys still `discovery_conflict`. Preview write failures stamp `failedAt=preview`. No schema migration. No production writer in this observation.
