# AIR-325: retirement of the DISCOVERY_EXECUTOR selector (code)

Date: 2026-11-14 (UTC). Scope: code and documentation only.

- Removed `discoveryExecutorMode` and the `external | workflow | invalid` selector, the external Discovery chunk path in `POST /api/sync/epg` and `POST /api/enrichment/discovery/resolve`, and the `discovery_executor_invalid` monitor issue.
- Kept: the resolver and chunk engine used by the Workflow, the D1 admission gate, `DISCOVERY_WORKFLOW` binding check (fail closed), generation pin, lease, CAS, bounded chunks, backoff, TMDB budgets.
- Old external callers are delegated (`nextAction: wait`, `reason: delegated`) or, for an interrupted-recovery confirm, refused with `executor_workflow`, as production already behaved with `DISCOVERY_EXECUTOR=workflow`. No second writer exists.
- `feature_flags` reports `DISCOVERY_EXECUTOR` as retired.
- Not done and not authorized here: removing the Cloudflare variable. That is a separate holdpoint requiring an action-specific owner approval, rollback and a `feature_flags` readback (`absent`, `retired`).
