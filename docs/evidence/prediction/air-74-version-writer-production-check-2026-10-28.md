# Immutable prediction writer: production read-only verification, 28 October 2026

[AIR-74](https://trello.com/c/5AdAmKPe) · owner-requested read-only check (card comment of 2026-10-28 07:49 UTC), step 3 of [the prediction versions runbook](../../runbooks/prediction-versions.md#1-activating-the-writer-prediction_version_objectson) and step 2 of the [AIR-195 readiness packet](air-195-writer-activation-readiness-2026-10-27.md#proposed-read-only-check-at-the-next-naturally-scheduled-submit).

**Captured:** 2026-10-28, 07:55–07:59 UTC. **Sources:** Cloudflare API `GET …/workers/scripts/iptv/settings` and `…/deployments`, filtered to the two prediction-version flags and the deployment metadata (no other binding value, secret or account id is recorded); production R2 bucket `iptv` read with the scoped snapshot credential through the exporter's read-only client (`scripts/r2-snapshot-export.mjs`, which refuses any method other than `GET`/`HEAD`), plus a signed `ListObjectsV2` of the prefix `enrichment/runs/`. **Code reference:** `main` at `ccd6b3d`. **Scope:** every prediction run record modified since the owner-reported activation (2026-10-27 about 17:42 UTC), and the prediction bundle and current version object of every film those runs report as `created` or `recalculated`. **Operational authority:** read-only. No prediction run, materialization `validate`/`apply`, flag, Scheduled Task, Access, snapshot, export, R2 or D1 write was made. The IPTV MCP `enrichment_status` tool was not called, because its read can record an undelivered stop event. No film id, title, ETag or private payload is recorded here.

## Flag state (Cloudflare settings read, about 07:55 UTC)

| Flag | Binding on Worker `iptv` | Effective value |
| --- | --- | --- |
| `PREDICTION_VERSION_OBJECTS` | plain text `on` | `on` |
| `PREDICTION_MATERIALIZATION` | absent | `off` |

Active deployment `b0fb6e11-e022-4798-a317-0750fcacce6b` (created 2026-10-28 07:49 UTC), version `f0451687-f341-45f5-9621-ebadba605b1c` at 100 %. The owner-reported activation is now independently confirmed as the current binding. The read cannot say when the binding was set; the owner's report places it at about 17:42 UTC on 27 October.

## Runs since activation

`enrichment/runs/` holds 139 run records; 10 were modified after 2026-10-27 17:42 UTC (last modifications from 27 Oct 20:25 to 28 Oct 07:58 UTC). All 10 are `trigger: scheduled`:

| Status | Stop | Runs | Created | Recalculated | Failed |
| --- | --- | --- | --- | --- | --- |
| `complete` | `queue_empty` | 8 | 11 | 0 | 0 |
| `partial` | `external_termination` | 1 | 1 | 28 | 0 |
| `running` (run `294dd99f…`, started 06:58 UTC) | — | 1 | counts not final; 50 films with result `created`/`recalculated` at the read | | |

No run stopped with `storage_error`, and no run recorded a failed item. The `external_termination` stop is the caller ending the run, not a version-write failure.

## Version objects of the touched films

89 distinct films carry a `created` or `recalculated` result in these runs (a film touched by two runs is counted once). For each film the bundle `enrichment/films/<id>/predictions.json` was read, then its `current` record's version object, then the bundle was checked again with `HEAD`.

| Check | Result |
| --- | --- |
| Bundles read | 89 / 89 |
| `current.r2Key` and `current.contentSha256` present | 89 |
| `current.r2Key` = `enrichment/films/<id>/predictions/versions/<current.contentSha256>.json` | 89 (0 mismatches) |
| Version object exists | 89 (0 missing) |
| SHA-256 of the object's raw bytes = `contentSha256` | 89 (0 mismatches) |
| SHA-256 of the `current` record recomputed as the writer defines it (keys sorted, pointer fields and `replacedAt` removed) = `contentSha256` | 89 (0 mismatches) |
| `current.generatedAt` before activation | 0 |
| Bundle ETag changed between the read and the closing `HEAD` | 0 |
| `history` records with a pointer / without one | 1 / 76 |

The 76 unlinked history records are predictions written before activation and moved into `history` by a recalculation. That is the documented behaviour: they stay unlinked until the one-time materialization ([ADR-0026](../../adr/0026-historical-prediction-version-materialization.md)). The one linked history record is a prediction written after activation and later replaced.

Requests: about 550 `GET`/`HEAD` and 2 listing pages over two identical passes (the second pass also covered films the running run committed between the passes). This is more than the "one or a small sample" the request allowed; it is still read-only and touched no lease or fence key.

## Verdict

**GO for the writer itself.** With `PREDICTION_VERSION_OBJECTS=on`, every prediction committed by the scheduled runs since activation is linked to an existing immutable version object whose bytes match the pointer hash and the writer's canonical body. No storage-error stop and no conflict were observed. This verifies stage 2 of the readiness packet only.

**AIR-74 stays G5 NO-GO.** Historical records are still unlinked; the next stages (a new fenced snapshot, the offline materialization plan and rehearsal, production `validate`/`apply`, and reconciliation) each need their own owner approval, as do the remaining AIR-74 gates.

## Limits

- The binding read shows the value at about 07:55 UTC; it does not show when it was set or whether it was ever changed in between.
- Run records were selected by their last-modified time; a run record that was never updated after activation could not have committed a prediction with the writer on.
- The Scheduled Task registry and the run Events were not read.

**Used by:** [AIR-74](https://trello.com/c/5AdAmKPe). **Superseded by:** none recorded.
