# ADR 0036: The scored acceptance gate is the only EPG resolver

**Status:** Accepted (owner decision 2026-10-28)  
**Original decision date:** 2026-10-28  
**Recorded at:** 2026-10-28  
**Approval source:** [AIR-90 owner acceptance, 2026-10-28](https://trello.com/c/v9OH2Yhx) (explicitly accepted ADR-0036; architecture only, no production flag or write authorization)  
**Related work:** [AIR-43](https://trello.com/c/7NY6n1Az), [AIR-68](https://trello.com/c/qbLDc6Ql), [AIR-69](https://trello.com/c/FlcWZX7W), [AIR-90](https://trello.com/c/v9OH2Yhx); [ADR 0010](0010-scored-detail-verification.md), [ADR 0012](0012-scored-resolution-rollout.md)  
**Supersedes:** the operational boundary of [ADR 0012](0012-scored-resolution-rollout.md) (the `SCORED_RESOLUTION` runtime mode and its flag rollback); its rollout decision stays accepted history  
**Superseded by:** None

## Context

[ADR 0012](0012-scored-resolution-rollout.md) required a measured `shadow` phase and an explicit GO before the scored resolver could write production identity, and kept three resolver modes in `src/discovery.js` behind the Worker variable `SCORED_RESOLUTION`: `off` (legacy title/year/runtime matching with its own TMDB search and detail path), `shadow` (legacy writes, the scored gate only produces a comparison preview and deferred variant plans in `epg/discovery-variant-pending.json`) and `on` (the scored gate writes, after movie-detail verification, [ADR 0010](0010-scored-detail-verification.md)).

The gate was met: AIR-68 switched production to `on` on 24 October 2026 with an independent read-only confirmation, and AIR-69 accepted the stabilization on 26 October 2026 under an owner-approved accelerated gate (autonomous discovery and prediction cycles on the published generation; not two unattended EPG generations). Since then the legacy branch and the shadow comparison have been dead code that a configuration value could still bring back: a missing or malformed binding, or an explicit `off`, selected the legacy resolver, and `shadow` re-enabled the comparison writer. The two resolvers also had different TMDB cost and different decision shapes (`known_alias_*` without a detail read against `tmdb_detail` after one), so a mode flip would have changed identity behavior silently.

## Decision

The scored acceptance gate is the only EPG resolver.

- `src/discovery.js` runs the scored path on every resolver chunk: known aliases are scorer candidates, a non-exact title is searched once per language, an accepted score is verified only by the movie-detail check, and every other outcome is a candidate decision or a held observation. The legacy identity matching, the shadow comparison (`legacyStatus`, `comparison`), the deferred shadow variant plans and the `off`/`shadow`/`on` selection are removed.
- The `SCORED_RESOLUTION` variable is retired. The Worker does not read it; a stale binding of any value is inert. Nothing in source or configuration can select the legacy resolver.
- `CANDIDATE_DISCOVERY` keeps its role as the only optional switch of the path: exactly `on` adds the bounded variant searches to the scored writer; its former `shadow` value is gone with the preview it fed.
- The score preview `epg/discovery-score-preview.json` is written by every chunk and carries scored outcomes only. `scoringPreview.mode` and `scoringPreview.cutover` in the pipeline status stay in the response, fixed to `on`, so existing readers keep parsing.
- Unchanged: the AIR-48 candidate lifecycle (attempt caps, `retryAt`, terminal reasons, evidence keys), the resolver lease and its renewal fence, one chunk per explicit request, the generation pin and the `programme_changed` refusal, the EPG-to-watchlist title matching (a different path), and R2 as the production authority.

Not decided here: removal of the leftover Cloudflare binding (a separate owner-approved settings operation with a read-only check), any change to the scorer weights or the detail gate, and the D1 authority cutover.

## Alternatives considered

- **Keep the flag with `on` as the default.** Rejected: it keeps a second resolver with different cost and decision shapes reachable from configuration, which is the drift AIR-90 was opened to close.
- **Keep `shadow` as a diagnostic mode without the legacy writer.** Rejected: the comparison measured scored against legacy; without the legacy writer the labels have no meaning, and the stored evidence of the shadow phase remains available.

## Consequences

- One resolver, one TMDB budget model and one decision shape (`tmdb_detail` provenance, scored candidate decisions). A watchlist alias is verified by one detail read; it is never verified by the alias alone.
- The flag register, the resolution and candidate-discovery contracts and the architecture page describe a single path; the AIR-100 rollout and rollback runbook and the shadow evidence stay as history.
- Tests state the invariant: no value of `SCORED_RESOLUTION` changes a chunk's result; a leftover `epg/discovery-variant-pending.json` is ignored.

## Recovery and migration boundary

Rolling the resolver back means reverting the code, which does not revert R2: decisions and catalog rows written by the scored gate stay as written (this was already true for the `on` mode). No flag, Scheduled Task, Access, R2 or D1 operation is authorized by this record; removing the Worker binding needs its own owner approval.

## Evidence

- **Original decision:** [AIR-90](https://trello.com/c/v9OH2Yhx); prerequisites [AIR-68](https://trello.com/c/qbLDc6Ql) and [AIR-69](https://trello.com/c/FlcWZX7W)
- **Implementation:** the AIR-90 pull request
- **Dated verification:** the shadow and cutover measurements in the [scored resolver evidence](../evidence/scored-resolver/README.md); the AIR-69 acceptance comment of 2026-10-26 on the card
- **Uncertainty:** the AIR-69 gate was an owner-approved shortcut (one autonomous cycle on the published generation, not two unattended generations); whether the `SCORED_RESOLUTION` binding still exists on the Worker was not read for this record

## Follow-ups

Binding removal and its read-only verification under AIR-90 after separate owner approval; [AIR-79](https://trello.com/c/485tlGLA) retires legacy R2 operational persistence, which this record does not touch.
