# AIR-484 offline evidence: EPG seal hand-off to a successor instance (14 November 2026, UTC)

Scope: offline tests only (`tests/epg-orchestration.mjs`, scripted pipeline and Workflow stand-ins). No production read or write, no Workflow instance, no Task, flag or migration. This is not production proof: whether the successor lowers memory is to be observed on natural runs, and a fresh isolate is not claimed ([ADR 0144](../../adr/0144-epg-seal-successor-workflow-instance.md)).

## Cases covered

| Case | Result |
|---|---|
| Normal hand-off after durable `stage: seal` | Producer ends with `seal_handoff`; claim `handoff {sealRunId, fromSeries, toSeries}` written with no failure and no budget spent; successor `epg_<day>_<series+1>` finishes the run once. |
| Crash (a): seal durable, claim never written | Restarted producer executes no `/api/sync/epg` unit and hands over; successor completes. |
| Crash (b): claimed, `create()` never ran | Hourly `ensure` creates the same id once. |
| Crash (c): `create()` reached the platform, response lost | Status read back, attached; no second create, one run start. |
| Successor absent / errored / terminated / complete | Same id re-created / cooldown then new recovery series / terminal id never re-created / `evidence_contradictory`, nothing created. |
| Persistent `unknown` status of a claimed successor | Counted under the existing budget, no blind create, quarantine at exhaustion; alive after recovery attaches. |
| Drain proof | `drainState` and `readModel().owner.liveness` read the recorded instance in phase `done`: `instance_live` / `alive` until it is `complete`. |
| Day roll | Yesterday's claimed seal finishes after midnight without setting today's `doneAt`; today starts its own run. Without a claim a rolled day still stops. |
| Mixed version | The pre-change executor (frozen in `tests/fixtures/epg-orchestration-pre-air-484.js`) is fenced out as `not_owner` in the old series, and finishing the claimed series in place starts no second run. |

Result: `node tests/epg-orchestration.mjs` and the full `npm test` pass locally; CI per-shard `Run tests` on the first head took 137, 166 and 179 s (limit 240 s).
