# D1 migration evidence

| Report | Capture and scope | Verdict | Used by | Later / authority |
| --- | --- | --- | --- | --- |
| [AIR-73 offline parity](air-73-offline-run.md) | 24 Oct 2026, verified historical 19 Oct Sites snapshot loaded into isolated SQLite | **OFFLINE PARITY ONLY** — not live D1 | [AIR-73](https://trello.com/c/gX2xdQAz), preparation for [AIR-74](https://trello.com/c/5AdAmKPe) | R2 remains production authority until separate owner-approved migration |
| [AIR-74 readiness assessment](air-74-backfill-readiness-2026-10-26.md) | 26 Oct 2026, code reading at `main` 27263d9 plus two read-only status reads; no production write | **NO-GO for execution, GO for the plan** — nine gaps and a GO/NO-GO checklist | [AIR-74](https://trello.com/c/5AdAmKPe), [ADR-0019](../../adr/0019-live-d1-backfill-boundaries.md) (Accepted 2026-10-26 as a design decision) | Each gate is a separate owner approval; D1 stays unbound and unapplied |

[Paired JSON](air-73-offline-run.json) sits beside the report. [AIR-115](https://trello.com/c/TRp1oXpA) moved it from `docs/air-73-offline-run.json`. [Registry](../README.md).
