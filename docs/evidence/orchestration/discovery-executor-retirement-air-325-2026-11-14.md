# AIR-325: retirement of the DISCOVERY_EXECUTOR selector (code)

Date: 2026-11-14 (UTC). Scope: code and documentation only.

- Removed `discoveryExecutorMode` and the `external | workflow | invalid` selector, the external Discovery chunk path in `POST /api/sync/epg` and `POST /api/enrichment/discovery/resolve`, and the `discovery_executor_invalid` monitor issue.
- Kept: the resolver and chunk engine used by the Workflow, the D1 admission gate, `DISCOVERY_WORKFLOW` binding check (fail closed), generation pin, lease, CAS, bounded chunks, backoff, TMDB budgets.
- Old external callers are delegated (`nextAction: wait`, `reason: delegated`) or, for an interrupted-recovery confirm, refused with `executor_workflow`, as production already behaved with `DISCOVERY_EXECUTOR=workflow`. No second writer exists.
- `feature_flags` reports `DISCOVERY_EXECUTOR` as retired.
- Not done and not authorized here: removing the Cloudflare variable. That is a separate holdpoint requiring an action-specific owner approval, rollback and a `feature_flags` readback (`absent`, `retired`).

## Mermaid visual QA (2026-11-14, headless Chromium on the rendered GitHub pages of PR head)

- `docs/architecture/runtime-topology.md`: the flowchart renders. `sync` -> Workflow (dotted, "queues the intent and delegates when admission passes"), Workflow -> chunk engine ("one chunk per durable step"), `cron` -> Workflow, engine <-> R2. Labels are legible; arrows point from caller to callee; no node still presents HTTP as the chunk executor.
- `docs/architecture/scheduling-and-orchestration.md` "Worker cron: R2-to-D1 enrichment projection": it showed GitHub's "Unable to render rich display" (parse error on the note text `(AIR-428); each attempt`; the same parse error exists on `main`, so it was pre-existing). The `;` was replaced by a comma and the diagram now renders with the `opt Workflow binding and D1 admission pass` block. Limitation: the long yellow note under `reconcileDiscoveryWorkflow` is wider than the diagram and is clipped at the right edge on GitHub (pre-existing note length); the text remains in the source.
- No screenshot is committed.
