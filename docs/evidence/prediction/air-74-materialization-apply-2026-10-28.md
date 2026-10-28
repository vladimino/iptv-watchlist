# Historical prediction version materialization: production apply and reconciliation, 28 October 2026

[AIR-74](https://trello.com/c/5AdAmKPe) · the owner-approved production apply of plan `2ce0866d…` (owner GO in the session of 28 October 2026), steps 4–7 of [the prediction versions runbook](../../runbooks/prediction-versions.md#2-one-time-materialization-of-historical-versions-implemented-no-production-execution-recorded-here) and [ADR-0026](../../adr/0026-historical-prediction-version-materialization.md). Follows the [plan, rehearsal and validate evidence](air-74-materialization-validate-2026-10-28.md).

**Captured:** 2026-10-28, 20:20–23:50 UTC, from the agent container that holds the plan and its snapshot; code at `main` `be9b5e2`. **Scope:** one production write operation through the deployed Worker route, under the owner's Cloudflare Access login; the temporary flag; read-only reconciliation on a new fenced snapshot. **Not done:** any other flag, Access, Scheduled Task, lease, D1 or deletion; no export before the apply (the plan stayed fresh). Private files (plan, receipts copies, logs, snapshots) stay outside the repository; no film id, key, ETag or credential is reproduced here.

**Verdict:** **materialization GO.** All 2,346 planned historical records are immutable version objects, every planned bundle links them with this plan's provenance, no prediction body changed, nothing is pending in the bucket, and `PREDICTION_MATERIALIZATION` is back to absent. This is not an AIR-74 G5 GO (section 6).

## 1. Preflight (20:20–21:08 UTC)

| Check | Result |
| --- | --- |
| Plan | `origin.json` planId `2ce0866d…`, `plan.jsonl` SHA-256 `52bec800…`, 47 batches, 2,346 films and records; snapshot `manifest.json` SHA-256 `929579b7…`, directory read-only |
| Route code | `materializePredictionVersions` and the plan/rule code unchanged on `main` since the validate runs |
| Flags before | `PREDICTION_VERSION_OBJECTS` `on`, `PREDICTION_MATERIALIZATION` absent |
| Runner | last scheduled run 20:19 UTC idle (queue empty), no current run |
| Access | owner `cloudflared` login from the validate stage, JWT valid about 22 h; Access applications and policies unchanged; no Service Auth |
| Final dry run | first attempt hung on one request without a timeout (the CLI's `remote()` sets none) and was stopped; rerun 20:55:31–21:04:24 UTC with a 120 s request timeout: **47/47 HTTP 200 and complete, 2,346 `would_materialize`, 0 `bundle_changed`, 0 stops** |

## 2. Temporary flag

The agent's Cloudflare API connection is read-only (`PATCH …/workers/scripts/iptv/settings` answered 403 and changed nothing). The owner therefore set and later removed the variable in the dashboard; every state was read back through the API.

| Time (UTC) | State (read back) |
| --- | --- |
| before 21:08 | `PREDICTION_MATERIALIZATION` absent, 16 bindings |
| 21:08:51 | owner deployment `f837bdc0…` (dashboard): `PREDICTION_MATERIALIZATION` `on`, `PREDICTION_VERSION_OBJECTS` `on`, 17 bindings, all other bindings and the secret unchanged |
| 22:57:10 | owner deployment `5989d98e…` (dashboard): `PREDICTION_MATERIALIZATION` **absent**, `PREDICTION_VERSION_OBJECTS` `on`, 16 bindings, secret present; Access applications and service tokens unchanged |

The flag was on for 1 h 48 min, the duration of the apply.

## 3. Apply (21:09:45–22:53:13 UTC)

Transport: a private, uncommitted adapter around the standard CLI's `remote({mode: 'apply'})` (batches, order, stop on the first non-2xx answer, `apply.json`, `--from-batch` resume unchanged) that adds the owner's `cf-access-token` and refuses before sending anything other than a `POST` to the materialize route on the Worker host with `planId` `2ce0866d…`, `dryRun: false` and items byte-equal to `plan.jsonl` for that batch; 300 s request timeout.

| Run | Batches | Result |
| --- | --- | --- |
| 1 | 0–25 answered, 26 lost | 26 × HTTP 200 (about 87–98 s each); the response to batch 26 was lost (`ECONNRESET` on the client connection) |
| check | — | read-only: receipts 0–25 present and complete, none for 26; the writer lease expired at 21:52:50 UTC |
| 2 (`--from-batch 26`) | 26–41 answered, 42 lost | batch 26: HTTP 200, receipt **40 `already_materialized` + 10 `materialized`** (the Worker had finished 40 films before the connection dropped); batches 30–41 took about 194–205 s each; the response to batch 42 was lost (`other side closed`) |
| check | — | receipts 0–41 present, contiguous, complete; lease expired 22:45:04 UTC |
| 3 (`--from-batch 42`) | 42–46 | batch 42: HTTP 200 in 1 s, a receipt **replay** (the Worker had sealed it after the drop); 43–46: HTTP 200 |

No HTTP 409 (`prediction_writer_busy` or `receipt_mismatch`), no non-2xx answer, no `bundle_changed`, `bundle_missing`, `checksum_mismatch`, `bundle_unreadable`, `malformed_pointer` or `readback_failed`.

**Receipts** (read from R2, all 47 for this plan, contiguous):

| Measure | Value |
| --- | --- |
| Films | 2,346 |
| `materialized` | 2,306 |
| `already_materialized` | 40 (batch 26, see above) |
| Classes | done 2,346, replan 0, stop 0 |
| Incomplete or dry-run receipts | 0 |

## 4. Reconciliation on a new fenced snapshot

`scripts/r2-snapshot-export.mjs --concurrency 16` after 3 quiet minutes, then `--verify`:

| Field | Value |
| --- | --- |
| Window (UTC) | 22:58:13–23:08:42 |
| Status | `consistent_fenced` (export and `--verify`), `noGoReasons` empty |
| Objects / bytes | 11,544 / 741,370,844 (9,142 before the apply) |
| Aggregate SHA-256 | `7a0117e7b5a05749039167e28fc96d84af6104586e3bf55999652146d7f3af58` |
| SHA-256 of `manifest.json` | `8d1dbc0855d2ed8f64ee08c5ad62e68e6fb158179493cf82b8ebd986f3429612` |
| Published generation / latest enrichment run | `fc7e7d74…` / `a9a11f05…` (unchanged) |

Independent check (private script with the Worker's own version rules) of every planned bundle against the pre-apply snapshot:

| Check | Result |
| --- | --- |
| Planned bundles present | 2,346 / 2,346 |
| `materialized` block with planId `2ce0866d…` and the planned previous SHA-256 | **2,346 / 2,346** |
| Pending / malformed records | **0 / 0** |
| Linked records | 2,633; every object present, its SHA-256 equals `contentSha256` and its bytes equal the record's canonical body (0 missing, 0 mismatch) |
| `current` body unchanged | 2,346 / 2,346 (no later submit touched these bundles) |
| Every pre-apply body still in its bundle | `current` 2,346 and `history` 287 kept, **0 lost** |
| Receipts in the snapshot | 47 |

`prediction-versions-plan.mjs` on the whole bucket: 2,382 bundles, 2,670 records linked, **0 pending**, 0 malformed, 0 objects to write, 0 checksum mismatches, 0 unreadable bundles, 0 unreferenced version objects.

IMPORTER_RESULT

## 5. State after the operation

- `PREDICTION_MATERIALIZATION` absent, `PREDICTION_VERSION_OBJECTS` `on` (the writer keeps linking new predictions).
- No Access object was created; the owner's `cloudflared` login stays in the container until the remaining Access-dependent checks are finished.
- The three hosts the owner added to the environment's Allowed domains are left as they are, pending the owner's decision.

## 6. Remaining G5 blockers (unchanged by this operation)

1. [AIR-264](https://trello.com/c/P0elt7dL): the importer's disposition for the 38 immutable fingerprint storage keys; `main` still stops on them (`unknown_key`).
2. Class C: the owner's row-by-row decision on the `film_unresolved` records.
3. The executor replay up to the discovery units on a post-materialization baseline, once 1 and 2 allow it; then the D1 production steps under their own approvals.

## Limits

- The apply's two lost responses were client-side connection drops; the receipts show the Worker completed both batches, and the resumes followed the runbook. The CLI has no request timeout; the private adapters added one.
- Consistent at the new snapshot's `finishedAt` (23:08:42 UTC).
