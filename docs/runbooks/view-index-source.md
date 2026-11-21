# View index read source: retired selector, binding removal and recovery boundary

This page is **no longer an operating runbook for a selector**. The temporary read selector `VIEW_INDEX_SOURCE` of the view index ([ADR 0183](../adr/0183-view-index-membership-from-d1-rows.md)) is retired by [ADR 0192](../adr/0192-retire-view-index-selector-and-raw-object.md): the view index is always derived from D1 ([contract](../reference/domain/view-index-read-model.md), [flag register](../reference/feature-flags.md)). The page is kept for its name, which other documents link to. It grants **no authorization**: removing the Cloudflare binding, deleting the raw R2 object or running any production read is a separate owner-approved operation under [authorization and escalation](../process/authorization-and-escalation.md).

## History in brief

ADR 0183 made the view index derivable from `prediction_pointer`, `prediction_fingerprint` and `ratings_view` and added the selector (`r2` by default, `d1` optional) while every raw writer kept the R2 object `enrichment/view-index.json` current, so `r2` was a complete rollback. After the owner's acceptance of the D1 read source, ADR 0192 retired the selector, the raw read paths and the raw writers in code. The dated verification of the rollout and of the retirement is in the [evidence note](../evidence/d1-migration/air-558-view-index-selector-retirement-2026-11-21.md); this page does not assert the production value of the binding.

## Outcome of the retirement

| Aspect | State |
| --- | --- |
| Reads | D1 only (`derivedViewIndex`). A prediction domain that is not `d1`, a ratings domain that is not `d1` and open, a missing database binding or a table above 20,000 rows refuses with the domain's own code (503); there is no raw fallback |
| Raw writers | Removed: `updateViewIndex`, `ensureInitialRatings`, the mood backfill, the fingerprint-view backfill and the Letterboxd compare-and-swap writers. `POST /api/enrichment/moods/backfill` and `POST /api/enrichment/fingerprint-view/backfill` answer `410 Gone` |
| `VIEW_INDEX_SOURCE` | Retired in the `feature_flags` registry (`retired: true`, `effective: null`). A set binding is inert; absence is the target state; `r2` is **no rollback** |
| Raw object `enrichment/view-index.json` | Not deleted by the code change, and not used. It is stale from the first deploy of the retirement on |
| Operator Letterboxd scripts | Require `--view-index-d1 <file>` from `scripts/view-index-d1-export.mjs`; no raw fallback |

## Binding removal (owner-approved settings change)

Preflight (read-only):

1. Read `feature_flags` (`VIEW_INDEX_SOURCE`): `state`, `raw`, `valid`, `issue`, `effective`. While the binding is set it reads `issue: retired` and `effective: null`. A code default, a comment or a deployment does not establish the binding.
2. Confirm the deployed version is one that carries the retirement (the registry entry is `retired: true`), so that a stale binding changes nothing.

Removal is a Cloudflare Worker settings change by the owner (`keep_vars: true` keeps a dashboard variable across deploys, so it stays until it is removed). Readback: `feature_flags` returns `state: absent`, `raw: null`, `effective: null`. The removal changes no behavior, because the Worker already ignores the binding. Record the observation in the [feature flag ledger](../reference/feature-flags.md) with the authorizing card.

## Loss of the simple rollback and the recovery boundary

Setting `VIEW_INDEX_SOURCE` to `r2` or removing the binding no longer restores anything; there is no longer a raw read path to switch back to. A code rollback to a version that reads the selector finds a raw object that is stale from the first deploy of the retirement on, and it must not be used as a source unless it is rebuilt from D1. Returning to the raw object is not a routine: it needs an **owner-approved plan** that restores the code, sets the binding and rebuilds the object from D1 (a D1 to R2 export), none of which exists as a script or a procedure today. Code rollback does not revert R2 or D1 data ([deployment runbook](deployment.md)).

## Refusals

The refusals of the D1 derivation are the former `d1` ones and are the only failure modes of the read path:

| Code | Meaning | Action |
| --- | --- | --- |
| `prediction_domain_not_authoritative` | No database binding, or the prediction marker is not `d1` | Fix the authority; never read around it |
| `prediction_domain_unavailable` | Marker or schema unreadable, or a stored row is malformed | Read the marker; investigate |
| `prediction_domain_budget` (`guard: overlay_rows`) | A prediction table holds more than 20,000 rows | Review the cap |
| `ratings_domain_not_authoritative` | The ratings cutover is `held`, or the schema is not installed | Resolve the cutover |
| `ratings_domain_unavailable` | The ratings marker is unreadable or the table is over the cap | As above |

## Remaining separate owner decisions

- Removal of the `VIEW_INDEX_SOURCE` binding, with the `feature_flags` readback above.
- Retirement of the raw object under an owner-approved R2 operation (the object and snapshot copies of it remain until then).
- Running `scripts/view-index-d1-export.mjs` against production is a separate owner-approved read operation, like the snapshot export; the script and its tests grant nothing.
