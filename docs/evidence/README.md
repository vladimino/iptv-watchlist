# Evidence registry

[AIR-114](https://trello.com/c/ia9tnXbc) · 24 October 2026.

This is the canonical GitHub folder index; `index.md` is a compatibility link. **Every preserved report is historical and applies only to its pinned capture/code/generation.** Original NO-GO, GO or INSUFFICIENT conclusions are retained. A later owner-approved decision may supersede a *previous operating gate*, not the original measurements. Completed report delivery is not the same as permission to run a production operation.

| Area | Reports and decisions |
| --- | --- |
| [Scored resolver](scored-resolver/README.md) | Eleven dated shadow/parity/replay/rollout reports, separate verdicts; [AIR-68](https://trello.com/c/qbLDc6Ql) later authorized scored-only on |
| [Prediction](prediction/README.md) | AIR-82 partial queue RCA; exact original per-film cause unknown |
| [Taxonomy](taxonomy/README.md) | AIR-47 accepted future v2 specification, separate from AIR-108 implementation |
| [D1](d1-migration/README.md) | AIR-73 offline replay against 19 October snapshot; not a live cutover |
| [Film/Person](film-person/README.md) | AIR-42 Phase 0–3 audit and rollout, not production D1 authority |
| [Legacy R2](legacy-r2/README.md) | Archived old Sites export and R2 import evidence, not active restore instructions |

**Registry metadata contract:** each report entry must state capturedAt UTC/date, pinned source SHA/generation, exact scope/denominator, original verdict, evidence lifecycle, Used by (decision/Trello/PR or unconsumed), Superseded by (real successor gate only), uncertainty and operational authority. Details and direct links appear in each area's README and the underlying original report.

## Machine-readable files (AIR-115 only)

The four JSON assets remain in `docs/`: [AIR-73 results](../air-73-offline-run.json), [AIR-86 manifest](../air-86-replay-manifest.json), [AIR-86 replay](../air-86-replay-results.json) and [AIR-99 detail](../air-99-detail.json). They have hardcoded script/test consumers; no move or rewrite is permitted under AIR-114.

See [current reference](../reference/README.md), [architectural decisions](../adr/README.md) and [operator runbooks](../runbooks/README.md). No production operations were performed for this registry.
