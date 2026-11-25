# AIR-664: offline preparation of the Film localization reconciliation operation

Date: **25 November 2026**. Scope: **offline only** (repository code and its tests). No production read, no write, no flag, no Task. Card: [AIR-664](https://trello.com/c/Og9XxXfy); upstream [AIR-663](https://trello.com/c/UP10l6Js) ([ADR 0218](../../adr/0218-film-lifecycle-dimensions-revision.md) decision 3, stage 4). Code at `main` `a7c8828`.

| Check | Result |
| --- | --- |
| `node tests/film-localization-reconciler.mjs` on a clean checkout | `ok` |
| Callers of `src/film-localization-reconciler.js` outside tests | none: only `tests/*` and `scripts/test-classification.mjs` (classification) import it |
| Entry point available to run a production dry run | **none** |
| Durable checkpoint store required by `applyLocalizationReconcile` | **none exists** |
| Shipped caps | 50 examined and 25 written per call (defaults 20 and 10) |
| Live counts (Films, stale, held) | **not read; unknown** |

**Verdict.** A production dry run and an apply are blocked by two named gaps (entry point, checkpoint store). The operation plan, cohort rule, waves, stop conditions, readback, restore and the proposed GO text are in the [runbook](../../runbooks/film-localization-reconciliation.md#production-operation-plan-air-664-draft-awaiting-plan-review-authorizes-nothing). This report grants no authorization and starts nothing.
