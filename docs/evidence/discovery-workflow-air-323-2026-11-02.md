# AIR-323 Discovery Workflow — local tests only

**Captured:** 2026-11-02 (implementation session).  
**Source:** branch `cursor/air-323-discovery-workflow`, ADR 0083. Not a production snapshot.  
**Scope:** `node tests/discovery-workflow.mjs` and the ordinary repository suite. No Cloudflare API, no R2, no D1, no TMDB, no Scheduled Task, no flag write.  
**Verdict:** the absent flag still runs one explicit chunk; `workflow` delegates the request and continues a mocked series past 12 chunks without sleeping the hour; backoff and a live lease sleep instead of spinning; a duplicate or failed `create()` keeps one instance id; a stale generation does not run; overlapping chunks do not both commit the same decisions; a superseded series makes no TMDB call and no Discovery write; reconciliation during a recovery `dueAt` creates no further instance, and one eligible retry after that time can finish the backlog; a quarantined recovery creates nothing; pipeline status does not create a Workflow and reports a stalled, dead, or recovery-waiting owner as degraded. `wrangler.jsonc` has the binding and no `schedules`. The cron source does not call the reconciler. The Node.js 20 suite does not start Wrangler. `node scripts/check-discovery-workflow-bundle.mjs` on Node.js 22 runs `wrangler@4.151.1 deploy --dry-run`, bundles `dist/server/workflow-entry.js`, and does not deploy.

**Used by:** [ADR 0083](../adr/0083-inert-discovery-workflow.md) (Proposed) and [AIR-323](https://trello.com/c/SrWM43h0).  
**Superseded by:** none. This note does not authorize `DISCOVERY_EXECUTOR=workflow` or a production readback. The post-merge readback, if the owner later accepts the deploy, is a separate check and is not this file.  
**Uncertainty:** timestamps inside decision objects differ between the direct resolver and the Workflow loop; the test compares status, attempts and terminal reason. Platform step quotas were not measured.
