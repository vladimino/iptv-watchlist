# AIR-463: client `manifestSize` and normal `manifest_spent` complete (offline)

**Capture:** 13 November 2026 (UTC), offline Worker code over a sqlite D1 stand-in and an in-memory R2.  
**Scope:** Contract and regression proof for [ADR 0136](../../adr/0136-prediction-batch-manifest-size-and-spent-complete.md) / [AIR-463](https://trello.com/c/7pGBGSh0). No production read or write, no Scheduled Task operation, no live model run.  
**Verdict:** Offline PASS for the delivered contract. Production Task enablement remains [AIR-451](https://trello.com/c/NN3N6kRp).

## What was checked

| Check | Result |
| --- | --- |
| `manifestSize` omitted / 1 / 5 / 10 / 100; short eligible queue | Selects min(requested, eligible); echoes `manifestSize` and `filmsSelected`; `limits.maxManifestFilms` stays 100 |
| Invalid `manifestSize` (0, negative, fraction, string, >100) | HTTP 400, zero D1/R2 domain writes |
| `pin.filmIds` longer than explicit `manifestSize` | 400; default-100 pin of 100 still accepted |
| Same five films → same `manifestHash` via size or pin; next start takes the next five | Hash identity and queue advance hold |
| Complete after five committed with remaining>0 | `status: complete`, `stopReason: manifest_spent`, lease released, no «Прогнозы приостановлены»; replay does not create a partial stop Event |
| Unsubmitted slots / reasonless complete with ready films | `409 manifest_not_spent` / `Queue not empty`; `time_budget` still partial for legacy callers |
| MCP parity | Tool schema accepts `manifestSize`; pin over size fails at the tool; `manifest_spent` through MCP |
| Prompt template | `hourly-predictions-batch-v2.md` parameterized (`manifestSize=5`, `generationSize=1`, `submitBatchSize=5`); steps 4–6 byte-identical with dry-run; SHA header matches |

## Commands (local)

```
node --test tests/prediction-manifest-size.mjs
node --test tests/scheduled-task-prompt-v2.mjs
```

## Not claimed

- Live prediction throughput, first-pass validity or accuracy under four hourly Tasks
- Any Scheduled Task create / enable / disable / run
- Production deploy acceptance (post-merge CI/deploy is separate)
