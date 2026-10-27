# Evidence registry

[AIR-114](https://trello.com/c/ia9tnXbc) · 24 October 2026.

This is the canonical GitHub folder index; `index.md` is a compatibility link. **Every preserved report is historical and applies only to its pinned capture/code/generation.** Original NO-GO, GO or INSUFFICIENT conclusions are retained. A later owner-approved decision may supersede a *previous operating gate*, not the original measurements. Completed report delivery is not the same as permission to run a production operation.

| Area | Reports and decisions |
| --- | --- |
| [Scheduled Tasks](scheduled-tasks-audit-2026-10-25.md) | Two-task live registry snapshot, 25 October 2026; [hourly recovery prompt change](scheduled-tasks-prompt-recovery-2026-10-25.md), independently read from the live task registry; neither is evidence of a successful discovery run |
| [Scored resolver](scored-resolver/README.md) | Eleven dated shadow/parity/replay/rollout reports, separate verdicts; [AIR-68](https://trello.com/c/qbLDc6Ql) later authorized scored-only on |
| [Prediction](prediction/README.md) | AIR-82 partial queue RCA; exact original per-film cause unknown; AIR-179 version materialization plan and offline rehearsal on the AIR-175 snapshot (GO for review, no production run) |
| [Taxonomy](taxonomy/README.md) | AIR-47 accepted future v2 specification, separate from AIR-108 implementation |
| [D1](d1-migration/README.md) | AIR-73 offline replay against 19 October snapshot; AIR-74 live backfill readiness assessment (NO-GO for execution, plan only); AIR-167 synthetic generation unit size and staged rehearsal; AIR-168 staged import local rehearsal at 1.25×; AIR-174 scratch D1 G4 (GO, synthetic); AIR-178 scratch D1 G4 at 125% of the real scale (GO, synthetic, schema v3); AIR-175 production R2 snapshot attempts 1–2 (NO-GO, `source_changed`; exporter encoding defect) and attempt 3 (GO, `consistent_fenced`, verified); AIR-74 SQLite dry-run on that snapshot (NO-GO, `evidence_mismatch`) and the dry-runs after ADR-0022 (NO-GO for G5: duplicate candidate shows, 2.3× G4 scale, prediction version objects, 36 class C); AIR-177 schema v3 offline import (generation blocker resolved); AIR-190 G2 rating identity (class C 36 → 34); AIR-74 S1 executor dry-runs with the acknowledged list (NO-GO: stops on a redirected fingerprint before predictions and the generation); not a live cutover |
| [Letterboxd](letterboxd/README.md) | AIR-169 export reconciliation against the AIR-175 production snapshot: codes are stored ids (`supported`), 420 of 2,460 films accepted; no import. AIR-193 offline identity alternatives: no offline proof for the 2,040 unresolved, display-only Finds exclusion measured (503/560 strict) |
| [Film/Person](film-person/README.md) | AIR-42 Phase 0–3 audit and rollout, not production D1 authority |
| [Legacy R2](legacy-r2/README.md) | Archived old Sites export and R2 import evidence, not active restore instructions |

**Registry metadata contract:** each report entry must state capturedAt UTC/date, pinned source SHA/generation, exact scope/denominator, original verdict, evidence lifecycle, Used by (decision/Trello/PR or unconsumed), Superseded by (real successor gate only), uncertainty and operational authority. Details and direct links appear in each area's README and the underlying original report.

## Machine-readable files

[AIR-115](https://trello.com/c/TRp1oXpA) moved the four JSON samples next to their reports. The bytes are unchanged historical evidence. `scripts/air-97-rescore.mjs` and `tests/air-86-replay.mjs` only read them. `scripts/air-86-replay.mjs` and `scripts/air-99-detail.mjs` require an explicit output path and refuse any path that resolves to one of these four files, before calling TMDB. Ordinary tests do not call TMDB.

| Sample | Path |
| --- | --- |
| AIR-73 offline counts | [d1-migration/air-73-offline-run.json](d1-migration/air-73-offline-run.json) |
| AIR-86 replay manifest | [scored-resolver/air-86-replay-manifest.json](scored-resolver/air-86-replay-manifest.json) |
| AIR-86 replay results | [scored-resolver/air-86-replay-results.json](scored-resolver/air-86-replay-results.json) |
| AIR-99 detail cards | [scored-resolver/air-99-detail.json](scored-resolver/air-99-detail.json) |

See [current reference](../reference/README.md), [architectural decisions](../adr/README.md) and [operator runbooks](../runbooks/README.md). No production operations were performed for this registry.
