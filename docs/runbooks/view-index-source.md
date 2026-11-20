# View index read source: selector, switch, rollback and retirement

This runbook describes the temporary read selector `VIEW_INDEX_SOURCE` of `enrichment/view-index.json` ([ADR 0183](../adr/0183-view-index-membership-from-d1-rows.md), [contract](../reference/domain/view-index-read-model.md#read-source-selector), [flag register](../reference/feature-flags.md)). It grants **no authorization**: setting the binding, comparing production data, retiring the raw writers or deleting the raw object are separate owner-approved operations (L3, with holdpoints) under [authorization and escalation](../process/authorization-and-escalation.md). Deploying code never changes the selector.

## What the selector does

| Value | Reads | Raw object | Raw writers |
| --- | --- | --- | --- |
| absent, empty or anything but exactly `d1` | The raw object, then the D1 overlays (the long-standing behavior) | Read | Write |
| `d1` | D1 only: the union of the film ids of `prediction_pointer`, `prediction_fingerprint` and `ratings_view`, with each entry built by the overlay rule and the compiled seed laid over it afterwards | **Not read** | **Still write**, so the object stays current |

Because the raw writers are not behind the selector, the read path can be switched back at any time with no data to restore. Reads never write: every `d1` read is a `SELECT`, and the refusals below are not retried against the raw object.

## Preflight (read-only, L0)

1. Read the live binding with the MCP tool `feature_flags` (`VIEW_INDEX_SOURCE`: `state`, `raw`, `valid`, `effective`). A code default, an earlier comment or a deployment alone does not establish the binding.
2. Read the authority markers and the schema version with `SELECT` only: `prediction_domain_authority` must be `d1` (`writes` `open` or `held`), `ratings_domain_authority` must be `d1` and `open`, `schema_contract.version` at least the prediction and ratings contracts. Under `d1` any other state refuses.
3. Read the table sizes (`SELECT COUNT(*)` of the three tables). Each table is capped at 20,000 rows; a table above it refuses. Record the margin.
4. A fresh parity comparison of the raw object's key set against the three tables is a **new owner-authorized read-only operation** (the one approved in the ADR was used on a single instant): run `scripts/view-index-membership-parity.mjs` on the exported key sets and review `removedKeys`, `newKeys`, the forecast and feature gains and the seed categories with the owner before the switch.

## Switch (owner-approved L3 plan, holdpoints)

1. Record the before-state on permitted read-only routes: the footer counts (`collection`, `recommendations`, `coverage`), the number of Finds candidates and the Admin health `viewIndex.entries`.
2. Set the Worker binding `VIEW_INDEX_SOURCE` to exactly `d1` in the Cloudflare Worker settings (`keep_vars: true` keeps a dashboard variable across deploys, so the value stays until it is removed). Do not set it from a script or a request.
3. Verify the effective setting with `feature_flags` (`effective: d1`), then the same routes as in step 1 and compare. Differences must be exactly the classified ones. Watch the Worker's request outcomes, CPU and memory in Workers Observability for the routes that build the view (`/api/enrichment/view`, `/api/enrichment/footer/status`, `/api/catalog/available`, `/api/admin/limbo`, `/api/admin/health`); a `503` with `prediction_domain_*` or `ratings_domain_*` is a refusal, not an outage of the selector.
4. Hold for the stabilization the plan names before any retirement step.

## Rollback

Set `VIEW_INDEX_SOURCE` to `r2` or remove the binding, then read `feature_flags` again (`effective: r2`) and the routes above. The raw object was kept current by its writers, so there is nothing to restore and no cache to clear: the next request reads the raw object. A code rollback does not change the binding; the binding is restored explicitly. After the writers are retired (below) this rollback no longer exists, so that step has its own gate.

## Refusals under `d1`

| Code | Meaning | Action |
| --- | --- | --- |
| `prediction_domain_not_authoritative` | No database binding, or the prediction marker is not `d1` | Fix the authority or roll back; never read around it |
| `prediction_domain_unavailable` | Marker or schema unreadable, or a stored row is malformed | Read the marker; roll back if it persists |
| `prediction_domain_budget` (`guard: overlay_rows`) | A prediction table holds more than 20,000 rows | Roll back and review the cap |
| `ratings_domain_not_authoritative` | The ratings cutover is `held`, or the schema is not installed | Resolve the cutover or roll back |
| `ratings_domain_unavailable` | The ratings marker is unreadable or the table is over the cap | As above |

## Reads that are not behind the selector

- `GET /api/enrichment/diagnostics/export` returns the raw bytes and the ETag of the stored object as an audit record.
- The operator Letterboxd scripts and `scripts/r2-snapshot-export.mjs` read a snapshot of the raw object. It is current while the raw writers run. Before the writers are retired these tools need a defined input (a D1-derived key set, or no view-index source); retiring the writers first would leave them reading a stale object.

## Retirement (separately authorized, after stabilization)

In order, each with its own owner decision: (1) a code change that stops the raw writers (`updateViewIndex`, `ensureInitialRatings`, the mood and fingerprint backfills and the Letterboxd compare-and-swap writers) and removes the raw read path and the selector; (2) removal of the `VIEW_INDEX_SOURCE` binding from the Worker settings and a readback that it is absent (`feature_flags` `state: absent`); (3) retirement of the raw object under an owner-approved R2 operation. The flag-removal card links the rollout card as a native prerequisite, as the [feature flag lifecycle](../process/agent-workflow.md#feature-flag-lifecycle-plan-test-switch-remove) requires.
