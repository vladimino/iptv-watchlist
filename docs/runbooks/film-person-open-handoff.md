# Film/Person `open` handoff (retired operator) and `held` recovery

**Live production (16 Nov 2026 UTC):** `film_person_authority` is `mode=d1`, `cutover=open`, generation **2** after an owner L3 MCP `apply` ([evidence](../evidence/d1-migration/air-499-film-person-open-2026-11-16.md)). Decisions: [ADR 0117](../adr/0117-film-person-d1-handoff-owner-decisions.md), [ADR 0099](../adr/0099-canonical-film-person-d1-authority.md), [ADR 0103](../adr/0103-projector-exclusive-window.md), [ADR 0162](../adr/0162-d1-only-authority-retire-rollback-toolchain.md). Card: [AIR-499](https://trello.com/c/8ifHCioP); parent design [AIR-374](https://trello.com/c/ha7ais3w); retirement: [AIR-537](https://trello.com/c/wbe7jjNs).

## Status: the `prepared` to `open` operator is retired (AIR-537 slice 2)

The one-time `prepared` to `open` flip was executed on 16 Nov 2026 UTC and is not repeatable: the flip SQL required `mode='prepared'`, and production is `d1`/`open`. The operator has been **removed**, so nothing on this page is an executable handoff instruction:

- the owner-only MCP tool `film_person_open_handoff` (it no longer appears in `tools/list`, and `/mcp` answers it as an unknown tool);
- `src/film-person-open-handoff.js` (and its bundle entry in `build.mjs`), `scripts/film-person-open-handoff.mjs` and `tests/film-person-open-handoff.mjs`.

It never supported `held` to `open` or any reverse move, so no recovery path depended on it. The record of what it did is the [16 Nov 2026 evidence](../evidence/d1-migration/air-499-film-person-open-2026-11-16.md) and the [AIR-537 slice 2 ledger](../evidence/d1-migration/air-537-film-person-operator-tooling-retirement-2026-11-18.md); the procedure itself is in git history before slice 2 and is historical, not a runbook.

**Retained on purpose:** `readMarker`, `transitionAuthority` and the `open`/`held` state machine with its SQL triggers and fences (`src/film-person-authority.js`), the fenced canonical adapters, the projector window, and the `held` forward-fix below. The Worker's serving reader refuses an installed `r2` or `prepared` marker with `film_person_unavailable`; `held` and `unavailable` stop with no R2 fallback.

Counts and digests only in any evidence; no ids, titles, payloads or credentials.

## `held` drill on a SAFE COPY

A local sqlite copy, never production D1, through the retained `transitionAuthority` and the sqlite stand-in (`tests/film-person-authority.mjs` covers the transitions). Procedure: (a) a copy at `d1`/`open`; (b) one D1-only canonical change; (c) `open` to `held`; (d) readers and writers fail closed; (e) forward fix `held` to `open`; (f) readback. Not run by this page.

## After `open`

Recovery is `open` to `held`, then the forward fix; both need an explicit owner GO and an owner-approved operator procedure. **Once D1-only writes exist, setting `r2` or a git revert is not a rollback.** See [D1 authority and Time Travel recovery](recovery/d1-authority-and-time-travel.md).

## Cross-links

[Holdpoint decision pack](film-person-holdpoint-decision-pack.md) (historical). Migration 0023 is already applied ([procedure](film-person-0023-apply.md), [evidence](../evidence/d1-migration/air-499-0023-apply-2026-11-16.md)); that apply is not this flip.
