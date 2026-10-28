# Historical prediction version materialization: fresh snapshot, plan, rehearsal and read-only validate, 28 October 2026

[AIR-74](https://trello.com/c/5AdAmKPe) · owner-approved stage of 28 October 2026 (fresh fenced snapshot, plan, offline rehearsal, read-only production validate), steps 1–5 of [the prediction versions runbook](../../runbooks/prediction-versions.md#2-one-time-materialization-of-historical-versions-implemented-no-production-execution-recorded-here). Follows the [offline GO/NO-GO](../d1-migration/air-74-offline-go-no-go-2026-10-28.md).

**Captured:** 2026-10-28, 16:15–17:17 UTC and 19:56–20:15 UTC (section 7), from the agent container; code at `main` `49edea7`. **Scope:** read-only. Cloudflare API reads of the Worker settings, deployment and Access configuration; production R2 bucket `iptv` read with the bucket-scoped read-only credential; offline plan and rehearsal; validate as dry runs only. **Not done:** `apply`, any R2 write, any flag, Access, Scheduled Task or D1 change. Private files (snapshot, `plan.jsonl`, per-batch results) stay outside the repository; film ids are not reproduced here.

**Verdict:** **validate GO for the plan below.** All 47 batches complete, 2,346 `would_materialize`, 0 `bundle_changed`, 0 stops, 0 errors, 0 writes. The same result through the real Cloudflare Access/HTTP path followed at 20:13 UTC (section 7). The next gate (apply) needs its own approvals (section 6).

## 1. Preflight (16:15–16:20 UTC)

| Check | Result |
| --- | --- |
| Worker `iptv` deployment | `96e59c83…`, version `aae07d99…`, created 2026-10-28T16:13:41Z by `wrangler` (the post-merge deploy of `main`) |
| `PREDICTION_VERSION_OBJECTS` | `on` (immutable writer active; untouched) |
| `PREDICTION_MATERIALIZATION` | **absent** (effective `off`); not changed, see section 5 |
| `DISCOVERY_LEDGER_MODE` | absent (the Worker acts as `frozen` while the archive exists); untouched |
| Access | application "All Workers" (allow: Cloudflare account members) in front of the Worker; "IPTV MCP" (owner email) on `/mcp`; no Service Auth policy; the only service token is `LETTERBOXD_IMPORT_ACCESS_CLIENT` |
| Materialize Access token in this session | `PREDICTION_MATERIALIZE_ACCESS_CLIENT_ID` / `_SECRET` missing |
| Conflicting operations | prediction runner `completed` (run `92a21a9e…`, 12:31–15:58 UTC, `queue_empty`, lease expired 16:13); daily EPG commit done (generation `fc7e7d74…`, `sync.json` 16:00:17); last discovery chunk 16:09; Scheduled Tasks running on their schedules (not touched) |

## 2. Fresh fenced snapshot

`scripts/r2-snapshot-export.mjs --concurrency 16`, then `--verify`; started by a read-only watcher (one `LIST` pass per minute) after 4 minutes without any write.

| Attempt | Window (UTC) | Result |
| --- | --- | --- |
| 1 | 16:22:01–16:28:45 | NO-GO `source_changed`: the hourly Task (17:20 Madrid) rewrote `enrichment/prediction-queue.json` during the cut. No manifest |
| 2 | 16:49:31–16:57:40 | **`consistent_fenced`**, `noGoReasons` empty, 0 listing changes, fence ok; `--verify` identical |

| Field | Value |
| --- | --- |
| Objects / bytes | 9,142 / 738,204,085 |
| Aggregate SHA-256 | `2ce0866d07211afe969f8c0c02949079f7a6fae77d08c8333f08f5266385dd8c` |
| SHA-256 of `manifest.json` | `929579b71b1d8944e76f31140efaec7a50e98a57d45e1fe6b577f84b8f4835ba` |
| Listing pages | 10 |
| Published generation / `sync.json` `updatedAt` | `fc7e7d74-0f91-4d08-b5c6-ac25fe62fd85` / 2026-10-28T16:00:17.876Z |
| Continuation `at` / `hopId`; latest enrichment run | 2026-10-28T16:09:42.803Z / `39c7fa51…`; `a9a11f05…` |

The cut is after the [AIR-222 install](../discovery-ledger-split-air-222-stage-2-2026-10-28.md), so it holds `epg/discovery-archive/v1/`; that matters for the D1 importer (blocker 5 of the offline GO/NO-GO), not for this plan. The directory was write-protected after `--verify`.

## 3. Plan (offline)

`prediction-versions-materialize.mjs plan` on this snapshot only.

| Measure | Value |
| --- | --- |
| Plan id (= snapshot aggregate) | `2ce0866d…` |
| `plan.jsonl` SHA-256 | `52bec800ceea516d9fd51fae0e30f635ddf94e55739f97315f9867c279922b65` |
| Bundles | 2,382 |
| Records already linked by the live writer | 324 (36 bundles fully linked, outside the plan) |
| **Records pending** | **2,346** in 2,346 bundles, 47 batches (46–50 films each) |
| Objects to write / bytes | 2,346 / 1,795,851 |
| Stops | 0 malformed, 0 checksum mismatch, 0 unreadable; 0 objects already present, 0 unreferenced version objects |

## 4. Rehearsal (offline)

`rehearse` against an in-memory copy of the snapshot with the Worker code: **`ok: true`**. 47 batches 200 (dry) and 200 (apply), 2,346 `materialized`, 47 replays recognized, 0 incomplete; check: 2,382 bundles, 2,346 planned with provenance, 36 outside the plan unchanged, 0 pending, 0 malformed, 2,670 records linked, 0 object mismatch, 0 body changed.

## 5. Read-only validate against production (16:58:06–17:16:31 UTC)

**Transport.** The documented `validate` posts each batch to the Worker route through Cloudflare Access with a service token. No service token or Service Auth policy exists for this route, and creating one is an Access change outside this approval. Validate therefore ran the **same deployed Worker code path** (`POST /api/enrichment/predictions/materialize` with `dryRun: true`, the exact `planId`, batch numbers and items of `plan.jsonl`) in the rehearsal's Worker context, with `env.BUCKET` bound to production bucket `iptv` over the S3 API using the **read-only** snapshot credential and the installer's `createS3Store` with `allowedWrites: null`, which refuses every `put` and `delete` before a request is built. The route reads `PREDICTION_MATERIALIZATION` only for non-dry runs, so the flag plays no role in a dry run. The harness is a private file; its summary has the same shape as the CLI's `validate.json`.

| Measure | Value |
| --- | --- |
| Batches requested / done / complete | 47 / 47 / **47** |
| HTTP status per batch | 200 ×47; 0 replays (no receipt exists for this plan) |
| Films | 2,346: **`would_materialize` 2,346**, `bundle_changed` **0**, `bundle_missing` 0, `checksum_mismatch` 0, `bundle_unreadable` 0, `malformed_pointer` 0 |
| Classes | done 2,346, replan 0, stop 0 |
| Version objects to write / already present | 2,346 / 0 |
| Failed batch | none |
| R2 calls | 4,739 `GET`, 0 `HEAD`, 0 `LIST`, **0 `PUT`, 0 refused writes** |

Every bundle still had the ETag and SHA-256 of the snapshot at validate time, about 19 minutes after the cut and before the 17:20 UTC hourly run. Bundles that later submits rewrite will answer `bundle_changed` at apply time and belong to a later plan, as the runbook describes.

**`PREDICTION_MATERIALIZATION` was not enabled.** The owner approved setting it; the dry run does not need it, and enabling it now would open the write path while `apply` is not authorized. It is to be set immediately before an approved apply and returned to `off` afterwards.

## 6. Obstacles to the next gate (apply)

1. **Access path to the Worker route.** `apply` must run through the Worker (it writes under the prediction writer lease and seals receipts). Section 7 proved the owner's `cloudflared` Access login works from this container without any Access change; an apply run needs a transport that may send `dryRun: false`, which the dry-run adapter refuses by design, and a valid login at that time.
2. **Separate approvals** for `PREDICTION_MATERIALIZATION=on`, the `apply` run itself, and switching the flag back off; `PREDICTION_VERSION_OBJECTS` stays `on`.
3. **Plan freshness.** Submits since 16:57 UTC rewrite some bundles; those films return `bundle_changed` (class `replan`) and leave their batch unsealed. If the drift is large, take a new fenced snapshot, re-plan and re-validate just before apply.
4. **Reconcile** after apply with a new fenced snapshot and `prediction-versions-plan.mjs` (0 pending outside films a later submit wrote with the writer on); then the D1 importer must report no `prediction_version_*` reasons.

## 7. HTTP dry-run through Cloudflare Access (19:56–20:15 UTC, owner-approved)

The documented transport, the deployed Worker route behind Access, run on the same plan `2ce0866d…` (`plan.jsonl` SHA-256 `52bec800…`) in the same container.

| Step | Result |
| --- | --- |
| Preflight | plan and snapshot intact (planId, `plan.jsonl` and `manifest.json` checksums as above); Worker deployment `130314e4…`; `PREDICTION_VERSION_OBJECTS` `on`, `PREDICTION_MATERIALIZATION` absent; route code unchanged since section 5 |
| Network | the cloud environment's policy first refused `iptv.vladimino.workers.dev`, `vladimino.cloudflareaccess.com` and `login.cloudflareaccess.org`; the owner allowed the three hosts and the running container picked the change up without a restart |
| Authorization | `cloudflared access login` (2026.9.0) for the "All Workers" Access application; the owner confirmed the login in their browser; the JWT stays in the container's cloudflared store and is never printed. No Service Auth policy and no service token were created; Access applications and policies are unchanged |
| Path check | `GET /api/status` with the token: HTTP 200 JSON from the Worker; without it: 302 to the Access login |
| Transport | private, uncommitted adapter around the standard CLI's `remote({mode: 'validate'})` (same batches, order, stop rule and `validate.json`), adding only the `cf-access-token` header; it parses each request body and refuses anything other than `dryRun: true` to the materialize route before a request leaves |
| Smoke | batch 0: HTTP 200, 50 `would_materialize`, complete |
| Full run (20:02:37–20:13:19 UTC) | **47/47 batches HTTP 200, 47 complete, 0 incomplete, 0 replays, no failed batch**; films 2,346: **`would_materialize` 2,346**; `already_materialized` 0, `nothing_pending` 0, `bundle_changed` 0, `bundle_missing` 0, `checksum_mismatch` 0, `bundle_unreadable` 0, `malformed_pointer` 0; classes done 2,346, replan 0, stop 0; no Access, HTTP, Worker or storage error |
| No writes | 47 requests, all `dryRun: true`; read-only R2 listing of `enrichment/predictions-materialization/` afterwards: 0 receipt objects; flags re-read: unchanged |

**Verdicts.** HTTP transport: **GO** (real Access path to the deployed Worker). Plan freshness: **GO** at 20:13 UTC (every planned bundle still had the snapshot's ETag and SHA-256, 3 h 15 min after the cut). Apply: **not authorized**; it needs its own owner approval (flag on, apply, flag off), a write-capable transport for that run and a fresh dry run just before it.

## Limits

- Section 5 ran the Worker code without the HTTP path; section 7 covers the Access and network path.
- Consistent at the snapshot's `finishedAt`; validate shows the bundles were unchanged at 16:58–17:16 UTC only.

**Used by:** [AIR-74](https://trello.com/c/5AdAmKPe), [ADR-0026](../../adr/0026-historical-prediction-version-materialization.md). **Superseded by:** none recorded.
