# FilmAggregateV1 internal route: pre-activation gates, activation plan, smoke, stop conditions and rollback (dormant; every live step needs its own owner GO)

Applies to [AIR-648](https://trello.com/c/zh0cfDWK). This page is a **plan and a checklist**. It authorizes nothing: not an apply, an activation, a route, a flag, a Scheduled Task, a live call of the aggregate, or an Access change ([authorization L0-L3](../process/authorization-and-escalation.md)). The route contract is [FilmAggregateV1](../reference/api/film-aggregate.md); the decision is [ADR 0216](../adr/0216-canonical-film-lifecycle-and-unified-read-contract.md); the readiness derivation is [ADR 0218](../adr/0218-film-lifecycle-dimensions-revision.md). **Present state is read live, never from this page or from a dated evidence page.**

## What is delivered, and what activation changes

Delivered dormant (scoped into the Worker bundle by `scopedFilmAggregate()`, unrouted, called by nothing): the Worker-compatible SHA-256, the typed resolver, the aggregate sections with the owner-evidence gate, the multi-alias history, the readiness derivation and the prediction-evidence reader (`predictionReader`). Activation is the first change that lets anything call them. It is **one code change plus its owner GO**, and nothing else:

- register `handleFilmAggregateRequest` (`GET` and `HEAD` of `/api/internal/film-aggregate`, one typed `id`) in the Worker router behind the existing Access protection of the whole Worker; no public permalink, strict bridge, writer permission or data authority changes;
- no new flag by default (a permanent flag needs an explicit disposition and an entry in the [feature flag contract](../reference/feature-flags.md));
- if the readiness is served, its trusted `predictionReader` (the registry digest and the prediction domain's own verdict rule) is bound in the same change; this page does not decide that binding, see the decisions below.

## Gates before the activation GO (each read live, on the day)

| # | Gate | How it is proved | A failure |
| --- | --- | --- | --- |
| G0 | `main`, the deployed Worker version and the migration head agree | Git blob and head of `migrations/`; the deployment record of the delivery of the code to be activated ([deployment runbook](deployment.md)) | stop; the GO names the exact commit |
| G1 | The schema chain is applied and the two indexes the statements need exist, **exactly** | the read-only preflight below: `schema_contract` is one row at the version the GO names, `tmdb_retirement_decision_movie ON tmdb_retirement_decision (movie_id)` (0040) and `film_redirect_by_target ON film_redirect (to_film_id)` (0043) read back non-unique, non-partial, one column | stop; an apply is a separate operation with its own GO under the [window runbook](d1-migration-window-v38-v54.md), never part of the activation |
| G2 | The authority markers the sections serve | the same preflight: Film/Person `open`; ratings `d1`/`open`; prediction `d1` with writes `open`; owner review `d1` (`open` or `held`); published EPG `d1`/`open`; Watchlist `d1`; one active prediction profile with a readable lineage | stop; a marker change is its own domain's owner operation |
| G3 | The size-only G1 evidence of the fact records | the same preflight: records, maximum parts and bytes, records over **8 parts / 480 000 bytes**, records with more than one etag, the link index against **40 parts / 2.4 MB** | an over-cap record is read as `discovery_cap` (coverage `incomplete`, never a wrong answer); it is an observation for the owner (see decisions), not a blocker |
| G4 | Unchanged before and after the migration window | the counts in the preflight (`tmdb_retirement_decision`, `film_redirect`, `film`, `film_external_id`, `owner_review_entry`) read against the before and after counts of the window evidence ([AIR-603 apply](../evidence/d1-migration/air-603-window-apply-2026-11-28.md)); a movement after the window is explained, not assumed | stop until explained; the window evidence is reused, nothing is re-applied |
| G5 | No retirement depends on the activation (AIR-666 stage 5 switch) | the scoped stage-5 switch evidence documented for AIR-666 before any production retirement | AIR-666 does not proceed |

### The read-only preflight (L0 observation; the run itself is named in the GO or in an owner message)

```bash
node scripts/film-aggregate-activation-preflight-production.mjs --expect-version <the version the GO names> [--rows <cap>]
```

Credentials are the owner's `D1_BACKFILL_ACCOUNT_ID` and `D1_BACKFILL_API_TOKEN` ([credentials skill](../../.claude/skills/iptv-credentials/SKILL.md)), behind a proxy with `NODE_USE_ENV_PROXY=1`; the target is pinned to the production account and database and its identity is read back before the first statement. Only one `SELECT` or `WITH ... SELECT` goes over the wire (a different statement, a batch, or an answer that reports a write stops the run). It captures twice and compares the captures, so a state that moves during the run stops it. The printed report holds counts, states, booleans, reasons and digests only: never a Film id, lid, movie id, fact key, rating or document body. The G1 measure counts the part rows over the primary-key range first and is not run over `--rows` (default 400 000, ceiling 2 000 000). Exit code 0 is `pass`, 1 is `stop` (with typed blockers), 2 is a controlled failure.

Not available over this transport: `EXPLAIN QUERY PLAN`. The plans of every aggregate and readiness statement are asserted offline on the real schema (`tests/film-aggregate.mjs`), and the live index definition is read back exactly instead. Where a separately authorized read path allows it, the plan of `SELECT from_id FROM film_redirect WHERE to_film_id IN (SELECT value FROM json_each('["film:x"]'))` may be added to the evidence (`SEARCH film_redirect USING COVERING INDEX film_redirect_by_target`).

The result is recorded as a dated evidence page under `docs/evidence/d1-migration/` (UTC), with the exact commit, the version, the report and the limitations. A `pass` is evidence for the GO, not the GO.

## Bounds the activation inherits (no new cap, no new ceiling)

- **Statements:** one request is at most **40** D1 statements shared by the identity reads, the reserved final fence and every section; the readiness evidence takes exactly **2** of them (reserved before the sections, the second capture after every section read). A section that cannot be paid is `unavailable` / `budget_exceeded`; the identity fence still runs.
- **Rows and bytes:** every list a statement returns is capped inside the statement (cap + 1 proves an overflow); ratings documents are measured and returned in one snapshot only within 40 parts / 2.4 MB (link index) and 8 parts / 480 000 bytes (a fact record).
- **Aliases:** at most 8 per scheme; more is never certified.
- **Cost of one request:** the number of statements is the measurement to record at the smoke; wall time per request is observed and recorded, not a threshold (a threshold needs a demonstrated problem and owner approval, [AGENTS.md](../../AGENTS.md)).
- **Error semantics:** `200` found or redirected; `400 invalid`; `404 absent`; `409 conflict|unverified|cycle`; `410 retired`; `503 unavailable|identity_moved`; `405` for other methods. Every non-`200` carries `contract` and `identity` only. Nothing is written, nothing is repaired, no R2, no network.

## Decisions the owner takes before the GO (recommendations in brackets)

1. **Consumers and Access.** Which caller may use the route (owner-only through the existing Worker Access, or an MCP read tool later). [Owner-only through the existing Access; no new consumer in the activation change; each consumer migration is its own card and acceptance (AIR-649, AIR-651, AIR-657).]
2. **Readiness in the first activation.** Whether the readiness (with `predictionReader`) is served now or the aggregate alone. [Aggregate alone first; readiness when the trusted verdict and registry binding is delivered and reviewed as its own change, because that binding touches the prediction domain's Worker scope.]
3. **Over-cap fact records (G3).** Whether records over 480 000 bytes stay `discovery_cap` (coverage `incomplete`) or the cap is raised with evidence. [Keep the accepted cap; raise only for a demonstrated need.]
4. **Flag disposition.** None, or a named temporary flag with its removal condition. [None: the route is read-only and rolls back by code.]
5. **Quiet window.** Whether the activation deploy needs one. [No: it adds a read-only route and writes nothing, so no Scheduled Task or writer needs to pause; the GO states it.]

## The smoke after the activation deploy (separate owner GO, read-only)

Scoped and named by the GO: a small set of Films the owner names, covering a `found` by `tmdb_<n>`, a `found` by lid, a `redirected` Film, an unknown id (`404`), a malformed id (`400`) and one non-`GET` method (`405`). For each: the HTTP status, the verdict, each section's `status` and `token` presence, the statement count, and that the response equals the offline reading of the same Film (the parity of bodies and tokens the dormant tests assert). Then the marker and identity fence readback (the Film/Person marker and generation unchanged), and the **GET audit**: no write, no repair, no R2 and no flag or Task change, with `tests/get-write-audit.mjs` and the [read side effects baseline](../reference/api/read-side-effects.md) already covering the route. The observations go into dated evidence (UTC), never into logs or GitHub with a production payload.

## Stop conditions

Stop and do not continue, write nothing, and ask the owner, if any of these holds: a gate above fails; the preflight reports `state_moved_between_captures`; the deployed version is not the commit the GO names; the smoke shows a section that is not `unavailable` where a marker is not served, any non-`SELECT` statement, an R2 or network touch, or a statement count above 40; an Access or flag change appears necessary.

## Rollback

Code only: revert the activation change and deploy, which returns the route to the previous dormant state (unrouted). It does **not** revert R2 or D1 data, authority markers, Cloudflare Access configuration, secrets or Task schedules, none of which the activation touches. There is no data to undo: the route writes nothing.

## Out of scope here

Any consumer migration (AIR-649, AIR-651, AIR-657), the history adapters (AIR-651), a migration apply (the window runbook), a marker or flag change, and the retirement of stored dimensions (AIR-666).
