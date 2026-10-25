# Runtime feature flags

**Maintained contract; dated observations, not a live configuration dashboard.** Reviewed against GitHub `main` and Trello evidence on 2026-10-25 for [AIR-146](https://trello.com/c/qfqYibFB). All four flags below are Cloudflare Worker **environment variables**, not switches managed by GitHub. [`wrangler.jsonc`](../../wrangler.jsonc) uses `keep_vars: true` and deliberately does not declare their production values. A code deploy does not reset these variables. The currently deployed value must be read from authorized Cloudflare settings (or a verified read-only diagnostic that actually exposes that setting) before making operational decisions.

Do **not** interpret a source default, a dated Trello comment, or a prior deployment as proof of the live value. This page does not authorize toggling flags, launching EPG/resolver/prediction jobs, or editing R2/D1, schedules or Access. Consult the [deployment runbook](../runbooks/deployment.md) and obtain action-specific owner approval.

## Configuration contract

| Flag | Permitted effective modes | Absent / malformed value | Consumer and effect |
| --- | --- | --- | --- |
| `SCORED_RESOLUTION` | `off`, `shadow`, `on` | `off`; accepts only exact `shadow` or `on` after trimming surrounding whitespace; case-sensitive | [`scoredResolutionMode` in `src/discovery.js`](../../src/discovery.js), [resolution reference](domain/scored-resolution.md). `off`: legacy resolver; `shadow`: legacy remains writer, scored comparison/preview; `on`: scored acceptance gate is writer, with detail verification before catalog writes. |
| `CANDIDATE_DISCOVERY` | `off`, `shadow`, `on` | `off`; accepts only exact `shadow` or `on` after trimming; case-sensitive | [`candidateDiscoveryMode` in `src/discovery.js`](../../src/discovery.js), [candidate reference](domain/candidate-discovery.md). Optional bounded TMDB variant searches: `shadow` previews candidates without replacing legacy decisions, `on` provides variants to the scored writer. |
| `LIFECYCLE_LOCALIZATION` | Independently `off`, `shadow`, `on` for each path: `metadata`, `epg`, `programme`, `watchlist` | Each path defaults `off`. Recognized comma-delimited tokens are `on:<path>` or `shadow:<path>`; unknown tokens are ignored, and **last recognized token for the same path wins**. Bare `on` does nothing. | [`lifecycleMode` in `src/sources.js`](../../src/sources.js), [Film/Person reference](domain/film-person.md). Selects new domain localization vs legacy behavior/diagnostic comparison per call path; it is **not** a persistent Film/Person or D1 cutover. |
| `RATINGS_REFRESH` | `off`, `on` | Only literal `on` enables the independent refresh; absent/other values disable it. | [Letterboxd ratings reference](integrations/letterboxd-ratings.md), [enrichment API](api/enrichment.md). Gates the independently owner-triggered `POST /api/enrichment/ratings/refresh`; disabled requests return HTTP 409, without fetching Letterboxd. Even `on` **does not schedule or automatically invoke** refresh. |

The explicit `off` values in this table describe **effective behavior**, not necessarily accepted textual configuration tokens. For `LIFECYCLE_LOCALIZATION`, write `on:epg` or `shadow:epg`, not `on`. To disable one path while retaining other paths, omit that path's token rather than deleting the whole variable.

### Interactions and operational safeguards

- Variant discovery is independently gated: useful `shadow` comparison pairs `CANDIDATE_DISCOVERY=shadow` with `SCORED_RESOLUTION=shadow`; live variant searching requires both `CANDIDATE_DISCOVERY=on` and `SCORED_RESOLUTION=on`. Changing one alone does not enable the intended variant search. Optional searches consume TMDB budget and carry distinct throttling/defer counters; see [candidate discovery](domain/candidate-discovery.md).
- `SCORED_RESOLUTION=on` changes which resolver may write **authoritative candidate decisions and catalog identity**. Switching back affects **future execution**, not already committed R2 objects. Rollback needs separate owner approval and read-only verification; no implicit R2 data rollback.
- Localization modes can affect persisted content on a subsequent EPG/metadata run or presentation on reads. A mode switch is not evidence that the next scheduled sync actually ran. Preserve all separately approved path tokens when adjusting one path.
- `RATINGS_REFRESH=on` only removes an endpoint gate; a manual refresh remains a separately authorized operation. A Letterboxd 403 retains the last good ratings generation and imposes backoff; see [ratings reference](integrations/letterboxd-ratings.md).
- These switches are **not** Cloudflare Worker Cron settings, external ChatGPT Scheduled Tasks, secrets, API tokens or `wrangler.jsonc` deployment/binding parameters. `BUCKET`, `TMDB_API_READ_ACCESS_TOKEN`, `LETTERBOXD_USERNAME`, and `EPG_XML_URL` are dependencies/configuration, not feature flags.

## Production configuration evidence ledger

**Current live snapshot (2026-10-25): not independently read.** No authorized Cloudflare settings read was performed for this documentation task. The values below are **last documented observations**, not asserted live settings. Consult latest card comments and the deployed Worker binding before using them.

| Flag | Last documented effective value | Observed/recorded (UTC) | Evidence and limitations |
| --- | --- | --- | --- |
| `SCORED_RESOLUTION` | `on` | 2026-10-24 10:23 (acceptance comment); subsequently cited in AIR-69 on 2026-10-24 10:34 | [AIR-68 production cutover](https://trello.com/c/qbLDc6Ql): Cloudflare settings deploy `a6e732f7-7858-4f72-bb39-45875254dfd9` and independent MCP confirmation of mode `on`; [AIR-69 checkpoint](https://trello.com/c/FlcWZX7W). |
| `CANDIDATE_DISCOVERY` | unset (effective `off`) | 2026-10-24 10:23 | [AIR-68](https://trello.com/c/qbLDc6Ql) explicitly left the independent optional search unset; [AIR-69](https://trello.com/c/FlcWZX7W) cites the same baseline. |
| `LIFECYCLE_LOCALIZATION` | `on:programme,on:watchlist,on:epg`; `metadata` off | 2026-10-23 15:49, reconfirmed in 2026-10-24 AIR-69 baseline | [AIR-42](https://trello.com/c/drLBuWjl) recorded ordinary EPG `on:epg` write path with published generation; [AIR-69](https://trello.com/c/FlcWZX7W) lists the complete binding. |
| `RATINGS_REFRESH` | unset (effective `off`) | 2026-10-23 (AIR-64 review); no newer verified binding in this audit | [AIR-64](https://trello.com/c/WTnyO8bX) records disabled production state and no authorized ratings-only run; [ratings reference](integrations/letterboxd-ratings.md) also warns that this is a dated observation. |

### Historical state transitions

| Date (UTC) | Flag and transition | Authority / evidence |
| --- | --- | --- |
| 2026-10-22 to 2026-10-23 | `LIFECYCLE_LOCALIZATION`: staged shadow rollout followed by `on:programme,on:watchlist,on:epg`; `metadata` not enabled. | [AIR-42 rollout and final ordinary-EPG acceptance](https://trello.com/c/drLBuWjl), [historical lifecycle log](../evidence/film-person/lifecycle-audit-and-rollout.md). Exact Cloudflare toggle timestamp is not established here. |
| By 2026-10-23 01:37 UTC | `SCORED_RESOLUTION=shadow`, legacy writer remains authoritative. | [AIR-66 acceptance](https://trello.com/c/z5Ndcll9); 12 controlled chunks, 79 observations. This is an acceptance-comment timestamp, not necessarily the settings-change timestamp. |
| 2026-10-23 (bounded experiment) | `CANDIDATE_DISCOVERY=shadow` was tried and then removed; no approval for `on`. | [AIR-84](https://trello.com/c/E7wlg7uV), [historical shadow evidence](../evidence/scored-resolver/air-84-shadow.md). |
| 2026-10-24 by 10:23 UTC | `SCORED_RESOLUTION`: `shadow → on`; `CANDIDATE_DISCOVERY` stayed unset. | [AIR-68 explicit owner approval and acceptance](https://trello.com/c/qbLDc6Ql), [ADR 0012](../adr/0012-scored-resolution-rollout.md). One manual resolver chunk was authorized; this does not authorize another. |
| 2026-10-24 | `SCORED_RESOLUTION=on` remained the recorded baseline during the first subsequent ordinary EPG generation; stabilization still pending. | [AIR-69](https://trello.com/c/FlcWZX7W). Generation publication alone is not confirmation of a complete scored resolver cycle. |
| 2026-10-23 through AIR-64 acceptance | `RATINGS_REFRESH` unset; code shipped behind off-by-default gate. | [AIR-64](https://trello.com/c/WTnyO8bX), [ratings reference](integrations/letterboxd-ratings.md). No documented on-transition. |

## Updating this register

Update **contract** rows whenever relevant Worker code changes, with tests/source links in the same delivery. Append or revise an **evidence** entry only after a documented observation: exact setting value (redact secrets), observation timestamp/timezone, source (Cloudflare binding or read-only diagnostic), deployment/version where known, authorizing Trello card, and any confidence limits. Preserve earlier changes as history. Never silently turn a previous observation into a current assertion; never store credentials or confidential runtime payloads here.
