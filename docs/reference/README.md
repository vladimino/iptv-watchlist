# Maintained technical reference

This section describes **currently implemented contracts**, not historical rollout verdicts or action approvals. Source and authorized runtime must be rechecked before operational claims.

- [Production Scheduled Tasks](scheduled-tasks.md) — expected external task schedules, MCP permissions, sequencing and validation; check live registry for current settings. Draft post-cutover Daily and Hourly texts and the proposed single-Task Drift text: [scheduled-task-prompts](scheduled-task-prompts/daily-epg-no-discovery.md), [drift-hourly-only](scheduled-task-prompts/drift-hourly-only.md) (not the live registry).
- [Orchestration reliability](orchestration-reliability.md) — proposed shared contract for Cloudflare-executed EPG, Discovery and Ratings: failure classes, budgets, ownership elements, read model and negative tests; not implemented in production.
- [Runtime feature flags](feature-flags.md) — effective modes, defaults, interactions and dated production evidence.
- [API](api/README.md) — MCP, enrichment, prediction runner, diagnostics.
- [Domain](domain/README.md) — Film/Person identity, scored acceptance, candidate discovery, the data health issue model and the derived taxonomy.
- [Data](data/README.md) — staged D1 schema and R2 mapping.
- [Integrations](integrations/README.md) — Letterboxd ratings, the account export and the proposed user-facts contract.

For operator instructions see [runbooks](../runbooks/README.md). For historical audit evidence see [evidence](../evidence/README.md).
