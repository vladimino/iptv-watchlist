# Operational runbooks

These pages describe maintained operational boundaries under [authorization levels L0–L3](../process/authorization-and-escalation.md). Proven L0 reads and scoped L1 delivery need no repeated owner prompt; no new automatic L2 production writer is authorized by the policy change, and L3 retains owner-approved plans and holdpoints. Check each operation-specific runbook and accepted safeguards.

- [Deployment and Cloudflare operations](deployment.md)
- [L3 draft: Discovery pause window for the D1 enrichment projector](d1-projector-discovery-freeze.md) (AIR-383, not executed)
- [L3 draft: activating the D1 projector exclusive window](d1-projector-window-activation.md) (AIR-383, not executed)
- [Film/Person schema 13–16: read-only preflight and apply sequence](film-person-schema-preflight.md)
- [Film/Person baseline: parity ledger, bounded import and the `prepared` gate](film-person-baseline.md)
- [Film/Person `prepared` loader: rated admission, retention and TMDB retirement](film-person-prepared-loader.md) (AIR-374 P5, offline, not executed)
- [Production monitor and incident response](monitoring.md)
- [Local development setup](local-setup.md)
- [Recovery procedures](recovery/README.md)
- [MCP connection and read-only smoke](mcp-connectivity.md)
- [Prediction Scheduled Tasks and safe diagnostics](prediction-operations.md)
- [Batch runner v2 dry-run A/B procedure](prediction-batch-v2-dry-run-ab.md) (proposed, owner-gated)
- [Scheduled Task drift monitor: triage and owner gates](scheduled-task-drift.md)
- [Taste-profile publication procedure (owner approval required)](taste-profile-publication.md)
- [Production R2 snapshot export, read-only (owner approval required)](r2-snapshot-export.md)
- [Letterboxd baseline import (owner approval required)](letterboxd-baseline-import.md)
- [Letterboxd Diary viewing history: activation, observation and rollback (owner approval required to switch on)](letterboxd-diary-history.md)
- [Finds display-only title exclusion: build, placement and switch (owner approval required)](finds-display-exclusion.md)
- [Immutable prediction versions: the writer and the completed historical materialization](prediction-versions.md)
- [Catalog poster hydration for records stored without a poster (owner approval required)](catalog-poster-hydration.md)
- [D1 backfill execution and recovery (owner approval required)](d1-backfill.md)
- [TMDB credits for watchlist Films in D1 (owner approval required)](tmdb-watchlist-credits.md)
- [TMDB TV identity correction for four retired movie ids: offline plan and production steps (owner approval required)](tmdb-tv-identity-correction.md)
- [EPG diagnostic canary: operating, retention, cleanup and rollback (owner GO per operation)](epg-diagnostic-canary.md)
- [Bounded discovery ledger: modes, verification and rollback (owner approval required)](discovery-ledger.md); also [one stuck observation](discovery-ledger.md#one-stuck-observation): the owner page read and the guarded reconsideration
- [Letterboxd export reconciliation, offline (complete matching needs an approved R2 snapshot), and identity from film pages (network run needs owner approval)](letterboxd-export-reconciliation.md)
- [Film/Person `open` handoff, `held` and forward fix: design only, authorizes nothing](film-person-open-handoff.md) (AIR-374, not executed)
- [Film/Person migration 0019: owner GO and apply procedure](film-person-0019-apply.md) (AIR-374 H0, applied to production on 12 Nov 2026: [apply record](../evidence/d1-migration/air-374-0019-apply-2026-11-12.md); the page stays the procedure and its GO text)
- [Film/Person E6: read-only budget measurement for the EPG producer](film-person-e6-budget-measurement.md) (AIR-374, prepared GO package, offline tool, not executed; a production read needs its own owner GO)
- [Film/Person activation: owner decision pack for the production holdpoints](film-person-holdpoint-decision-pack.md) (AIR-374 H0 to H4: H0/H1 prepared future GOs, H2 to H4 blocked; design, not executed)
- [Film retention: watchlist-fact admission, projector effect and recovery](film-retention.md)

Historical, non-authoritative Sites and R2 migration steps are in [archive](../archive/README.md). Contracts, ADRs and dated experiments have separate roles in the [documentation index](../README.md).
