# AIR-499 Film/Person marker `prepared` → `d1`/`open`, 16 November 2026

**Captured:** 2026-11-16 14:20:59.588Z (MCP apply start) through 14:21:06.242Z (receipt seal `takenAt`), plus a separate read-only D1 `SELECT` immediately after. Production D1 database `iptv`. Worker deploy `9e2dfcc2c64e8be3987d4746a26ee372b0fa7a16` (PR #688 on `main`). No R2 writes in this operation. Counts, marker fields and digests only; no Film/Person ids, titles or payloads.

**Scope:** owner L3 GO for `film_person_open_handoff` `mode: apply` with `confirmGo: true`, `expectedGeneration: 1`, `expectedReference` the exact verified baseline `cutover_accepted/v2:732b9768abcd3b0c2c460a9b0766b25aa1fbe472daed7a93393dbbe073a97cb5`. Authorizing chat GO after a passing MCP `dry_run` (`ready: true`, `blockers: []`) while `projector_window` was `idle`. Card [AIR-499](https://trello.com/c/8ifHCioP).

## Timeline

| UTC | Source | Result |
| --- | --- | --- |
| 14:20:47 | MCP `mode: dry_run`, generation 1, exact 84-character reference | HTTP 200, `outcome: dry_run`, `apply: false`, `readiness.ready: true`, `blockers: []`, schema 23 |
| 14:20:59 | MCP `mode: apply`, `confirmGo: true`, same operands | HTTP 200, `outcome: activated`, owner `air-499-open-handoff:2026-11-16T14:20:59.588Z` |
| 14:21:06 | Same apply, seal | `sealed.entries: 0`, generation 2, empty film/person receipt digests `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945` |
| ~14:21 | Cloudflare D1 `/query` SELECT (read-only; `rows_written: 0`, `changed_db: false`) | `film_person_authority` `mode=d1`, `cutover=open`, `generation=2`; baseline `verified`; `projector_window.state=idle`; `film_person_cas.ok=1`; `schema_contract.version=23` |

## MCP apply read-back (operator attestation)

Returned `proof.ok: true`, `reasons: []`.

| Check | Result |
| --- | --- |
| Gate | `state: open`, `r2Allowed: false`, `held: false`, `generation: 2`, `version: 23`, `baseline: verified` |
| Writer route | `writer: canonical`, `projector: compare_only`, `canonical: writes`, `state: open`, `generation: 2` |
| Receipts | `unreceipted: []`, `preReceiptBaseline: []`, `safe: true`, `attention: []` |
| Preflight snapshot on the apply payload | `readiness.generation: 1` (operand at flip); live marker after flip is generation 2 |

H1 class counts used by the operator remain 708 / 398 / 4. Freeze consumers in the audit were already `moved`. All four producer kinds (`epg_commit`, `metadata_sync`, `discovery_admission`, `rated_admission_retention`) reported `wired: true`. Audit `residuals: []`.

## Verdict

**Marker flip holds.** Canonical Film/Person writers are the fenced adapters (`writer: canonical`). The enrichment projector is compare-only for this domain. Catalog readers that already gate on `open` read D1. Canonical R2 `titles.json` / `people.json` mirrors are frozen. There is no SQL path back to `r2`; recovery is `held` plus a forward fix, each a separate owner GO. A git revert does not undo this marker.

**Not done by this activation.** No natural daily EPG / Producer Workflow pass has been observed at `open`. Part O (publication → `current`, Film/Person facts, D1 cost, Discovery interaction) is unproven. `sealed.entries: 0` is the empty receipts baseline at flip, not a producer run. Do not repeat `mode: apply` against generation 1.

**Limits.** Operator MCP JSON and one D1 inspect query. Same operator as the apply. No Time Travel restore. Independent review of this record is the docs PR, not a second production write.
