# AIR-554: read-only preflight and bounded export request (A3/A4), 22 Nov 2026

Observation window 17:00-17:13 UTC, 22 Nov 2026 (18:00-18:13 Madrid). Read-only: no R2 export, no production R2 credential, no migration `0034`, no marker, Task, flag, Access, Workflow, model run, sync or lease change. Counts, bytes, hashes, times and statuses only; no R2 keys of private data, manifests, bodies, tokens or identities.

This page is a **request record, not an approval**. Running the export below needs a separate, explicit owner GO; the page grants nothing.

## Sources

- Code: `main` `920ad8a6` (contains the merged operator [#897](https://github.com/vladimino/iptv-watchlist/pull/897) at `3fab7f86`, the `closed` gate [#893](https://github.com/vladimino/iptv-watchlist/pull/893) and the converter [#896](https://github.com/vladimino/iptv-watchlist/pull/896)). Post-merge CI of the replacing `main` push: [#45046012676](https://github.com/vladimino/iptv-watchlist/actions/runs/45046012676) 4/4 success; a later [#45046246553](https://github.com/vladimino/iptv-watchlist/actions/runs/45046246553) success. CI success is not live authority.
- D1 `iptv` through `SELECT` only; the MCP read tools `feature_flags` and `prediction_queue_overview`.

## Live state read

| Item | Observation |
| --- | --- |
| D1 schema (`schema_contract`) | 33; no `prediction_aux_authority` and none of the four aux tables exist, so `0034` has not been applied and the auxiliary authority is R2 |
| `prediction_domain_authority` | mode `d1`, generation 37520, queue_generation 3211, writes `held` (reference only) |
| Runner lease | released (`expires_at` 0), last holder epoch 514, last heartbeat 16:58:30 UTC |
| Writer lease | released (`expires_at` 0) |
| Latest `prediction_run` | complete, stop reason `manifest_spent`, 16:49:21 UTC; no active run at read time |
| Queue | eligible and ready; pending 7,022 (hot 3,627, cold 3,395), retry-exhausted 0; coverage 43.2% |
| Flags | `MONITOR` on, `MONITOR_TRANSPORT` telegram; every other registered flag absent or retired |
| `prediction_run` documents | 731 rows from 4 Oct 2026 (3.2 MB of JSON); this is the count of run documents, not of source revisions |

Natural run outcomes per UTC day (D1 `prediction_run`, status / stop reason): 19 Nov complete 69, interrupted by `lease_expired` 10, partial `api_error` 1; 20 Nov 59 / 11; 21 Nov 52 / 28; 22 Nov (until 16:49 UTC) 17 / 21. The share of `lease_expired` interruptions is rising and is a confounder for any later baseline; its cause was not investigated here.

**Not readable from this session:** the status of the four ChatGPT Scheduled Tasks (no read tool here; recorded below from the coordinator), active `iptv-prediction-start` Workflow instances, the outbox and Events (R2 until cutover) and competing EPG, Discovery or Letterboxd activity. They stay unknown until the export window and need an owner or coordinator read.

## Offline checks (no credential)

- `node scripts/r2-snapshot-export.mjs --plan --output /absolute/private/aux-snapshot` printed mode `plan`, network false, credentials not read. The planned requests are paged `ListObjectsV2`, `HeadObject` with `If-Match` before and after each object, `GetObject` with `If-Match`, a closing `ListObjectsV2` and `HeadObject` on the seven fence keys (the two lease objects of the writer and the runner, the resolver lease, the published-generation, `sync`, the resolver continuation and the profile pointer). The client builds only GET, HEAD and LIST.
- `tests/r2-snapshot-export.mjs`, `tests/prediction-aux-export-convert.mjs` and `tests/prediction-aux-cutover-production.mjs` pass on `main` `920ad8a6` (about 3, 5 and 10 seconds).
- The export is a **full-bucket** snapshot, not prefix-scoped: that is the real cost and confidentiality surface. The last known full fenced snapshot (28 Oct 2026, [AIR-74](air-74-materialization-validate-2026-10-28.md)) had 7,994 objects and 581,345,885 bytes. The current size is **unknown** (the R2 metadata API available here reports no size). Private disk should allow at least 2 GB free for the snapshot plus the converted tree.

## Scheduled Task registry (coordinator read, 22 Nov 2026 snapshot after the 17:00-17:45 UTC slots)

Read-only registry readback by the coordinator; no Task was changed or run manually. It shows the state of the ChatGPT Tasks only, not leases or Workflow instances. Times below are UTC (the coordinator reported Madrid, UTC+1).

| Task | State | Last finished slot | Result |
| --- | --- | --- | --- |
| Predictions v2 `:00` | enabled, hourly | 17:00 UTC | `recovery_unavailable` on `prediction_batch_start`, 0 predictions; the Worker run id is unknown. The 18:00 UTC slot had started at 18:03:17 UTC and was still in progress at readback |
| Predictions v2 `:15` | enabled, hourly | 17:15, finished 17:22:59 | complete, `manifest_spent`, 5 of 5 processed, 5 created, 0 errors |
| Predictions v2 `:30` | enabled, hourly | 17:30, finished 17:34:57 | blocked, `storage_error`, 0 predictions after a heartbeat failure `D1 DB exceeded its CPU time limit and was reset` (HTTP 502); `prediction_complete` confirmed the end |
| Predictions v2 `:45` | enabled, hourly | 17:45, finished 17:54:09 | complete, `manifest_spent`, 5 of 5 processed, 3 created, 2 recomputed, 0 errors |

What follows from it: all four Tasks run every hour, so a Task slot starts every 15 minutes and a run lasts about 4 to 9 minutes. There is **no regular quiet interval**: a full-bucket export will overlap natural writers, and the fence may return NO-GO. An earlier proposal on this page to start a few minutes after the hourly cron tick does not avoid the Task slots (the `:00`, `:15`, `:30` and `:45` runs write the auxiliary state) and is superseded by the bounds below. The D1 CPU-limit failure at 17:30 UTC and the `recovery_unavailable` result at 17:00 UTC are observations; their causes were not investigated here.

Still **not obtained**: the state of live `iptv-prediction-start` Workflow instances and of competing EPG, Discovery or Letterboxd activity, so the absence of active Workflow or internal writes is not proven. A fresh read-only preflight of leases, Workflows and competing writers is required immediately before any approved window.

## Requested export (one bounded read-only run)

- Target: bucket `iptv`; operations `ListObjectsV2`, `HeadObject`, `GetObject` (`If-Match`) only, the whole bucket.
- Credential: a read-only, bucket-scoped R2 API token issued and revoked by the owner, valid for at most 24 hours, placed only in the environment of the machine that runs the export. It is never put in chat, the repository or Trello.
- Output: an absolute private directory outside the repository (mode 0700, no symlink), never uploaded to Cloudflare or GitHub.
- Commands after approval: `node scripts/r2-snapshot-export.mjs --output <private>/aux-snapshot --concurrency 4`; then `--verify` on the same directory; then `node scripts/prediction-aux-export-convert.mjs <private>/aux-snapshot <private>/aux-converted`; then the importer `report`, `digest` and `preflight` on `<private>/aux-converted/tree`; then the operator's read-only `status --converted <private>/aux-converted --generation N` (N hypothetical until a real close).
- Bounds: concurrency 4 (permitted range 1-16); at most 3 attempts (resume after a transient read failure only). Because a Task slot starts every 15 minutes, the owner chooses one of: start right after a slot run has finished (the registry and `prediction_queue_overview` show it) and accept a NO-GO caused by the next slot, or accept more attempts than 3 inside a stated period, or approve a separate short freeze of the Scheduled Tasks (not requested here, and never applied without its own approval). Without a decision the run stays at the 3-attempt bound.
- Abort / NO-GO: `no_go`, `incomplete`, `inventory_changed`, any 401 or 403, an unknown key or blocker in the converter, an orphan run id, a stage-head conflict, a partial export. A NO-GO means no import, and is not repaired by freezing a Task, Access or a Workflow without a separate approval.
- Cleanup: remove the snapshot and the converted tree after acceptance; public reports carry counts, bytes, hashes, times and status only.

## Measurements to take after an approved export

`--verify` status (`consistent_fenced`); converter integrity and no-loss; real counts of sources, revisions and pieces, manifests and pieces, held stage items, delivered, pending and quarantined outbox events and the pending index; bytes and SHA-256 digests; unknown keys and blockers; the size of the derived import SQL against the D1 batch limits (at most 2,000 statements, 8 MiB, 100 KiB per statement); `planRunPreflightSql` (select-only) for orphan run ids. The verdict is **fits** or **does not fit** on the real numbers only; the synthetic scratch import (7 statements, 16 KB for one run) is not evidence for production scale. A non-fitting import needs a separately reviewed resumable-import contract (generation fence, progress receipt, byte parity, refusal on an unknown outcome, no partially authoritative reads); it is not chunked by hand.

## Handover boundary (for a later, separately approved phase)

- `close` makes the Worker refuse new legacy writes (`prediction_aux_closed`); `closed` to `r2` is possible only before an import, and `d1` is one-way.
- Silence of a Task or an equal listing does not prove that no already-admitted PUT is in flight. The evidence available is two distinct converter captures (after the close and a fresh one before the flip) with equal `(key, ETag, size)` identity and the scratch interleaving test of [#897](air-554-aux-cutover-operator-offline-2026-11-22.md). A PUT that passed its marker read and lands after the final capture stays the residual risk of [ADR 0196](../../adr/0196-prediction-aux-admission-closed-state.md); no atomic cross-store fence is claimed.
- A bounded drain wait after the close, a measured bound for an in-flight request and the owner's acceptance of the residual risk are required inputs for any GO on the flip.
- Natural-run baseline: compare identical prompt, model and batch configuration by cohort (normal, incident, EPG-priority hold, catalog hold, recovery) using `prediction_step_timing`, p50 and p95, completed, interrupted and skipped runs, successful films per hour and storage operations. Nothing is reconfigured to produce a baseline.

## Open inputs

The state of active Workflow instances and of competing writers immediately before the window (the Task registry is recorded above); the current bucket size; the owner decision on a resumable import if the real size does not fit; the explicit GO for the export above. None of these is granted by this page.
