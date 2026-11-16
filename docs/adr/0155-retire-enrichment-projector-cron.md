# ADR 0155: Retire the hourly enrichment projector and ignore D1_ENRICHMENT_WRITE

**Status:** Accepted
**Original decision date:** 2026-11-16
**Recorded at:** 2026-11-16
**Approval source:** Owner disposition `retire now` on [AIR-308](https://trello.com/c/ul5CRroM), 16 Nov 2026 (Europe/Madrid): no plan to return canonical Film/Person writes to R2
**Related work:** [AIR-308](https://trello.com/c/ul5CRroM), [AIR-499](https://trello.com/c/8ifHCioP), [ADR 0056](0056-d1-enrichment-write-through.md), [ADR 0103](0103-projector-exclusive-window.md), [ADR 0106](0106-bulk-projector-write-path.md)
**Supersedes:** The cron-invocation and `D1_ENRICHMENT_WRITE` selector clauses of [ADR 0056](0056-d1-enrichment-write-through.md). ADR 0103 and ADR 0106 stay as the historical window and grouped-write decisions. Their flags are not deleted here.
**Superseded by:** None

## Context

Canonical Film/Person writes go through the fenced D1 adapters. The marker is `d1` / `open`. The hourly Worker cron still called `runD1EnrichmentProjection`, which took a lease and could request `projector_window` before the Film/Person guard. That work no longer has a writer to serve. `keep_vars: true` means a deploy does not delete the Cloudflare variable.

## Decision

1. The Worker cron (`0 * * * *`) does not call `runD1EnrichmentProjection`. Ratings `ensure`, EPG `ensure`, Discovery reconcile and the monitor stay on the same tick.
2. `D1_ENRICHMENT_WRITE` is retired. `feature_flags` reports a set value as `retired` with `effective` null. The function returns `{retired:true, skipped:'retired'}` before any lease, window, R2 read or D1 write. Production does not set the offline test global `D1_ENRICHMENT_TEST_HARNESS`.
3. `src/d1-enrichment.js` stays. `d1EnrichmentStatus` remains the read-only diagnostic on `/api/d1/status` and reports `retired: true`.
4. `D1_ENRICHMENT_WINDOW` and `D1_ENRICHMENT_BULK` have no production caller after this change. They stay registered. This decision does not change their Cloudflare values and does not remove Discovery's refusal of a held `projector_window` row.
5. Deleting the Cloudflare binding `D1_ENRICHMENT_WRITE` is a later owner-approved settings change with a readback of `state: absent`. It is not part of this decision's code delivery.

## Alternatives considered

Leaving the projector on the cron behind `off` still takes no lease only when the flag is off. Production is `on`, so that alternative keeps the lease and window work. Deleting `src/d1-enrichment.js` would drop the status diagnostic and the shared SQL helpers that other D1 readers still import.

## Consequences

The hourly tick no longer builds an enrichment diff or claims `projector_window`. A rollback to code that reads `D1_ENRICHMENT_WRITE` needs the binding restored before that deploy. Offline tests of the historical writer set `D1_ENRICHMENT_TEST_HARNESS` in their own vm.

## Recovery and migration boundary

This record authorizes no Cloudflare binding edit, no D1 or R2 write, and no Task or cron expression change. Code rollback does not delete or restore the binding.

## Evidence

- **Original decision:** [AIR-308](https://trello.com/c/ul5CRroM)
- **Implementation:** this delivery
- **Dated verification:** not recorded (binding removal is a later readback)
- **Uncertainty:** AIR-499 natural EPG acceptance is still open and is not a gate on this code change

## Follow-ups

Physical removal of `D1_ENRICHMENT_WRITE`, and any later disposition of `D1_ENRICHMENT_WINDOW` and `D1_ENRICHMENT_BULK`, stay on [AIR-308](https://trello.com/c/ul5CRroM) until a separate owner approval.
