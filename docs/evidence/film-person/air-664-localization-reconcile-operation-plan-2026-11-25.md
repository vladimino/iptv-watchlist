# AIR-664: offline preparation of the Film localization reconciliation operation

Date: **25 November 2026**. Scope: **offline only** (repository code and its tests). No production read, no write, no flag, no Task. Card: [AIR-664](https://trello.com/c/Og9XxXfy); upstream [AIR-663](https://trello.com/c/UP10l6Js) ([ADR 0218](../../adr/0218-film-lifecycle-dimensions-revision.md) decision 3, stage 4). Code at `main` `a7c8828`.

| Check | Result |
| --- | --- |
| `node tests/film-localization-reconciler.mjs` on a clean checkout | `ok` |
| Callers of `src/film-localization-reconciler.js` outside tests | none: only `tests/*` and `scripts/test-classification.mjs` (classification) import it |
| Entry point available to run a production dry run | **none** (the only blocker of the read-only dry run) |
| Durable checkpoint store required by `applyLocalizationReconcile`, `resume` and `restore` | **none exists** (blocks mutation, not the dry run) |
| Dry run output | a report without intents or digests; apply replans at a fresh `at`, so an approved set needs a new exact-intent derivation (runbook §2) |
| Shipped caps | 50 examined and 25 written per call (defaults 20 and 10) |
| Live counts (Films, stale, held) | **not read; unknown** |

**Verdict.** The **read-only dry run** is blocked only by the missing callable entry point and needs no checkpoint store. **Mutation** is blocked by that entry point, the approved durable checkpoint store, an owner-only recovery operator and an exact-intent wave path the shipped API lacks. The revised plan (bounded waves of exact intents, operator modes, a proposed R2 versus D1 decision brief, effects and readback, one L3 plan with holdpoints and proposed prerequisite cards) is in the [runbook](../../runbooks/film-localization-reconciliation.md#production-operation-plan-air-664-draft-awaiting-plan-review-authorizes-nothing). This report grants no authorization, accepts no storage option and starts nothing.
