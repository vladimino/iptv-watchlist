# AIR-325: retirement of the DISCOVERY_EXECUTOR selector (code)

Date: 2026-11-14 (UTC). Scope: code and documentation only.

- Removed `discoveryExecutorMode` and the `external | workflow | invalid` selector, the external Discovery chunk path in `POST /api/sync/epg` and `POST /api/enrichment/discovery/resolve`, and the `discovery_executor_invalid` monitor issue.
- Kept: the resolver and chunk engine used by the Workflow, the D1 admission gate, `DISCOVERY_WORKFLOW` binding check (fail closed), generation pin, lease, CAS, bounded chunks, backoff, TMDB budgets.
- Old external callers are delegated (`nextAction: wait`, `reason: delegated`) or, for an interrupted-recovery confirm, refused with `executor_workflow`, as production already behaved with `DISCOVERY_EXECUTOR=workflow`. No second writer exists.
- `feature_flags` reports `DISCOVERY_EXECUTOR` as retired.
- Not done and not authorized here: removing the Cloudflare variable. That is a separate holdpoint requiring an action-specific owner approval, rollback and a `feature_flags` readback (`absent`, `retired`).

## Mermaid visual QA (2026-11-14, headless Chromium on the rendered GitHub pages of PR head)

- `docs/architecture/runtime-topology.md`: the flowchart renders. `sync` -> Workflow (dotted, "queues the intent and delegates when admission passes"), Workflow -> chunk engine ("one chunk per durable step"), `cron` -> Workflow, engine <-> R2. Labels are legible; arrows point from caller to callee; no node still presents HTTP as the chunk executor.
- `docs/architecture/scheduling-and-orchestration.md` "Worker cron: R2-to-D1 enrichment projection": it showed GitHub's "Unable to render rich display" (parse error on the note text `(AIR-428); each attempt`; the same parse error exists on `main`, so it was pre-existing). The `;` was replaced by a comma and the diagram now renders with the `opt Workflow binding and D1 admission pass` block. The long yellow note under `reconcileDiscoveryWorkflow` was wider than the diagram and clipped at the right edge; it was shortened to "Reads only, or one create for a missing intent or dead instance. No chunk, no TMDB" (the AIR-428 retry detail stays in the prose below the diagram).
- No screenshot is committed.

- Re-check after the shortening (PR head `4ab2006`, GitHub-rendered page in headless Chromium): the diagram renders without a parse error, the `opt Workflow binding and D1 admission pass` block is intact, and the whole note is visible inside the diagram width. The runtime topology flowchart is unchanged since the first check.
