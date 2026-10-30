# Film/Person lifecycle evidence

| Report | Captured | Finding | Used by | Authority |
| --- | --- | --- | --- | --- |
| [AIR-42 Phase 0–3 audit and rollout](lifecycle-audit-and-rollout.md) | 21–23 Oct 2026, source implementation, offline parity and historical localization rollout | **PHASE AUDIT / ACCEPTED PHASE EVIDENCE** — not a canonical D1 writer cutover | [AIR-42](https://trello.com/c/drLBuWjl), [maintained Film/Person contract](../../reference/domain/film-person.md) | Historical only, live flags must be checked separately |
| [AIR-44 canonical Person on production D1](air-44-canonical-person-2026-10-30.md) | 30 Oct 2026, read-only D1 SELECT, contract run in Node | **Reproduces the coCredit queue** (all 2,782 pairs joined) plus 70 humans through name folding; 0 ambiguous or conflicting evidence; 16,184 humans from 19,189 records | [AIR-44](https://trello.com/c/ojtZjVc9), [ADR 0058](../../adr/0058-canonical-person-grouping.md), [canonical Person contract](../../reference/domain/canonical-person.md) | Read model only; nothing persisted; owner paths synthetic only |

This audit is a preserved dated source; do not rewrite historic measurements. [Evidence registry](../README.md).
