# Immutable prediction writer: production activation readiness (owner GO/NO-GO packet)

**Captured:** 2026-10-27, 16:40–16:55 UTC, read-only  
**Code reviewed:** `main` `a01ac96`; the deployed Worker version is `a8761df3-f1bf-4c2b-9c51-80df71473ae0` (deployment `46ff5cc9-ec47-478f-b3d4-af09d5af4ef0`, 2026-10-27 16:39 UTC, built from `ff987b0`); `git diff ff987b0 a01ac96 -- src` is empty, so the deployed writer is the code reviewed here  
**Sources:** repository code and tests; Cloudflare API `GET …/workers/scripts/iptv/settings`, `…/deployments` and `…/versions/<id>` (filtered to the two flags and to deployment metadata; no other binding value, secret or account id is recorded); Workers Observability aggregate counts of `POST /mcp`  
**Scope:** preparation only. **Nothing was activated.** No flag, variable, secret, Access policy, token or Scheduled Task was created, changed or run; no R2 or D1 object was read or written; no prediction run, snapshot, export, materialization, `validate` or `apply` was started  
**Verdict:** **GO for the owner decision on `PREDICTION_VERSION_OBJECTS=on`**, with the conditions in [the packet](#owner-gonogo-packet). No blocker found in code or documentation; one documentation omission fixed (a version-write failure stops the whole run, not only the item)  
**Used by:** [AIR-195](https://trello.com/c/8gzh6iES); feeds [AIR-74](https://trello.com/c/5AdAmKPe) blocker «prediction version objects» through [ADR-0026](../../adr/0026-historical-prediction-version-materialization.md)

## Live flag state (read-only, 2026-10-27 16:48 UTC)

| Flag | Binding on Worker `iptv` | Effective value |
| --- | --- | --- |
| `PREDICTION_VERSION_OBJECTS` | absent | `off` |
| `PREDICTION_MATERIALIZATION` | absent | `off` |

The Worker carries 11 bindings in total; their names and values were not printed. The read went through the account's Cloudflare API connector with a `GET` only; it neither changes settings nor creates a version. Recorded in the [flag register](../../reference/feature-flags.md#production-configuration-evidence-ledger).

## What the code does (verified on `main`)

| Question | Answer | Where |
| --- | --- | --- |
| Gate | `env.PREDICTION_VERSION_OBJECTS === 'on'`, exact, case-sensitive, read per request; anything else is `off` | `predictionVersionsEnabled`, `src/enrichment.js` |
| What a submit writes with the flag on | For each item that becomes `created` or `recalculated`: first one object `enrichment/films/<id>/predictions/versions/<sha256>.json` (sorted-key record without pointer fields and `replacedAt`; key carries the SHA-256 of those bytes), then the bundle `predictions.json` with `current.r2Key` and `current.contentSha256`, then the view index with the same record. `already_current`, validation failures and caller-reported failures write no version object | `enrichmentSubmit`, `writePredictionVersion` |
| Create-only | `put(key, text, {onlyIf: {etagDoesNotMatch: '*'}})`. If the key exists, its bytes are read back: equal → idempotent retry, same pointer; different → `Error('Prediction version objects conflicts')`. The Worker never deletes or overwrites a version object | `writePredictionVersion`; test `tests/prediction-versions.mjs` (write-once retry and conflict) |
| Order | Version object before bundle (test asserts `versionPut < bundlePut`). A crash between them leaves an unreferenced object and an unchanged bundle, never a pointer to a missing object | test «partial commit» |
| Submit when the version write fails | The item is recorded as `failed`, `error: storage_error`, `failureScope: run`; the bundle and view index are not touched; the run gets `systemicStopReason: storage_error`, the submit loop stops and answers `mustComplete: true`; the queue stores a retry for that film with exponential backoff from 1 h (max 6 h). This is the same path as a failed bundle write: the **whole run** stops, and the next scheduled run resumes the queue | `enrichmentSubmit` catch block |
| Concurrency | Every submit, next, start, heartbeat and complete runs under the prediction writer lease `enrichment/writer-lease.json` (90 s); a concurrent writer gets HTTP 409 `prediction_writer_busy` | `predictionWriter` |
| Interaction with `PREDICTION_MATERIALIZATION` | Independent. The writer flag alone never touches historical records and starts nothing. A materialization **write** batch needs both flags (409 `materialization_off` / `version_objects_off`); dry runs need neither. Materialization batches take the same writer lease, so they and submits exclude each other. Once materialization runs, the writer flag must stay on, or the next submit puts an unlinked `current` back | `materializePredictionVersions` |
| Readers | Unchanged. Freshness ignores the pointer fields; UI, footer, MCP diagnostics and the importer read the bundle as before | prediction runner reference |
| Other writers of `predictions.json` | Only the submit path and the materializer write the bundle; no other route rewrites it | `grep predictions.json src/` |

With the flag on, a recalculation moves the previous `current` into `history` unchanged: a record written before activation stays unlinked until the one-time materialization; a record written after activation keeps its pointer.

## Owner GO/NO-GO packet

| Item | Content |
| --- | --- |
| Action | Add plain-text Worker variable `PREDICTION_VERSION_OBJECTS` = `on` (exactly; no spaces, lower case) on Worker `iptv`, production, via the Cloudflare dashboard or API. `wrangler.jsonc` has `keep_vars: true`, so later code deploys keep it. Nothing in the repository changes |
| Environment | Production Worker `iptv`, R2 bucket `iptv`. D1 is untouched |
| Not included | `PREDICTION_MATERIALIZATION` stays unset; no manual prediction run; no Scheduled Task edit; no Access change |
| Timing | Outside a running prediction batch: the hourly Task starts nominally at :00 Europe/Madrid and may run late. A read of `enrichment_status` just before the change showing no `running` run is enough; changing it mid-run is also safe (flag read per request), it only means some items of that run are linked and some not |
| Expected writes | Per committed prediction: one additional create-only R2 object of about 0.75 KB (the AIR-179 rehearsal measured 2,335 historical records at 1,786,040 bytes, ≈ 765 bytes each) and two extra fields in the bundle and view-index record. No other key family, no deletes |
| Cost | One extra R2 Class A operation (PUT) per committed prediction, plus one Class B GET only on the rare retry/conflict path; storage grows by ≈ 0.75 KB per prediction. Even a full recalculation of all ≈ 2,300 current predictions would add ≈ 2,300 PUTs and ≈ 1.8 MB: negligible against R2 free tier and pricing |
| Failure mode | A storage error or byte conflict on the version write fails that film and stops the current run with `storage_error` (as a bundle-write error does today); the bundle is unchanged; the film is retried by the ordinary schedule after backoff. A conflict means an existing object with other bytes under a checksum key, which should be impossible; if it appears: stop, investigate read-only, never overwrite |
| Interference with Scheduled Tasks | None by contract: the external ChatGPT Tasks call the same MCP tools with the same arguments and answers (the response shape of `prediction_submit` is unchanged). Latency per committed item grows by one R2 PUT. The daily programme Task does not write predictions. The live Task registry was **not** read here (no authorized access from this session); its state is **unknown** and must be checked by the owner before the change |
| Observability | No Worker log line names the prediction submit: Workers Observability shows only `POST /mcp` (1,709 requests in the 24 h before the read, every hour present), not which tool. Health is therefore read through the existing read-only MCP tools (`enrichment_status`, `prediction_queue_overview`, `prediction_pending`) and the completion Event: a `storage_error` stop is the signal to look at |
| Rollback | Delete the variable or set it to `off`. New submits write the bundle alone again. Version objects already written stay in R2 (referenced, valid bodies; the Worker never deletes) and are recognized by the offline importer and the materialization plan as linked. A code rollback behaves the same. Rollback does not need a data step |
| Residual risks | (1) Unknown live Task state; (2) no direct log of version writes, so verification needs an authorized R2 read (below); (3) during materialization the flag must not be turned off |
| Recommendation | **GO**, as a separate owner approval of exactly this action, after the owner confirms the hourly Task is enabled and healthy |

## Proposed read-only check at the next naturally scheduled submit

No manual run. After the first scheduled hourly run that reports `added + updated > 0` in its completion Event or in `enrichment_status`:

1. `enrichment_status` / completion Event: run `complete` or `partial` without `stopReason: storage_error`; `failed` not higher than usual.
2. With a separate owner approval for a read of production R2 (Cloudflare API `GET …/r2/buckets/iptv/objects/<key>`, or the read-only exporter): read `enrichment/latest-run.json`, take the films whose result is `created` or `recalculated`, read each `predictions.json`, and check that `current.r2Key` equals `enrichment/films/<id>/predictions/versions/<current.contentSha256>.json`, that the object exists, and that a local SHA-256 of its bytes equals `contentSha256`.
3. Record only aggregates (films checked, linked, mismatched) as dated evidence and a timestamped entry in the flag register. No film ids in public places.

Expected: every touched film linked, 0 mismatches. Any mismatch or a `storage_error` stop is NO-GO for the following stages and a reason to roll the flag back.

## Next stages (each a separate owner approval; none started)

1. **Flag change** `PREDICTION_VERSION_OBJECTS=on` (this packet). Register entry with the time.
2. **Observe one scheduled submit** with the check above; evidence entry.
3. **New fenced snapshot** of production R2 with the [read-only exporter](../../runbooks/r2-snapshot-export.md): status `consistent_fenced`, verified. It must be taken after step 2, so the plan sees the post-activation bundles. The AIR-175 snapshot is not reused.
4. **Offline materialization plan and rehearsal** on that snapshot (`prediction-versions-materialize.mjs plan` and `rehearse`), dated evidence with aggregates; `rehearse` must exit 0.
5. **Production `validate`** (dry run of every batch against the Worker; needs a scoped Access service token, itself a separate approval). Expect `would_materialize`; `bundle_changed` films go to a later plan.
6. **Apply**: owner sets `PREDICTION_MATERIALIZATION=on`, runs `apply`, sets it back to `off`. `PREDICTION_VERSION_OBJECTS` stays on.
7. **Reconcile** from another new fenced snapshot: `prediction-versions-plan.mjs` shows 0 pending outside films a later submit wrote with the writer on; the offline importer reports no `prediction_version_*` reasons for AIR-74.

The procedure for steps 3–7 is the [prediction versions runbook](../../runbooks/prediction-versions.md#2-one-time-materialization-of-historical-versions-implemented-no-production-execution-recorded-here).

## Limits

- The ChatGPT Scheduled Task registry and the live prediction queue were not read; their state is unknown here.
- The observability count is the Cloudflare aggregate for `POST /mcp` and cannot separate prediction tools from other MCP calls.
- The Cloudflare read shows the settings at 16:48 UTC on 2026-10-27; a later change is not covered.
