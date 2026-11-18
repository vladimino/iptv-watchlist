# Film/Person `open` handoff operator

**Live production (16 Nov 2026 UTC):** `film_person_authority` is `mode=d1`, `cutover=open`, generation **2** after an owner L3 MCP `apply` ([evidence](../evidence/d1-migration/air-499-film-person-open-2026-11-16.md)). Do **not** repeat `mode: apply` with `expectedGeneration: 1`. Merging code, CI, or a `dry_run` is still not a GO for any later `held` recovery or reverse move. Decisions: [ADR 0117](../adr/0117-film-person-d1-handoff-owner-decisions.md), [ADR 0099](../adr/0099-canonical-film-person-d1-authority.md), [ADR 0103](../adr/0103-projector-exclusive-window.md). Card: [AIR-499](https://trello.com/c/8ifHCioP); parent design [AIR-374](https://trello.com/c/ha7ais3w).

**ADR 0162 (AIR-79 slice 7):** the operator is retained and deferred, not removed: production is already `open`, so no `prepared` marker can be served any more. The Worker's serving reader refuses an installed `r2` or `prepared` marker with `film_person_unavailable`; this operator and `transitionAuthority` use the non-serving `readMarker` to report and move the marker, so the `held` and `open` forward-fix path is unchanged. Retiring this operator needs its own approved card.

Counts and digests only in any evidence; no ids, titles, payloads or credentials.

## What exists

- `src/film-person-open-handoff.js` (bundled for MCP only): `activationReadiness`, `activateOpen`, `flipOpen`, `handleOpenHandoffTool`.
- MCP tool `film_person_open_handoff` on `/mcp` (Cloudflare Access JWT, owner-only). `mode: dry_run` writes nothing. `mode: apply` with `confirmGo: true` uses Worker `env.DB.batch()`. No public HTTP write, cron or Scheduled Task calls it.
- `scripts/film-person-open-handoff.mjs`: REST dry-run (SELECTs). `--apply` is refused (`transport_not_worker_batch`).
- Offline coverage: `tests/film-person-open-handoff.mjs`.

`handoffReadiness` in `src/canonical-producers.js` is **not** the activation gate and is not rewritten. `activationReadiness` is the operational gate **and** it promotes every `activationAudit()` residual to a blocker. Residuals are derived live: freeze-unmoved catalog consumers (ADR 0117 decision 4), unwired natural producers, and a `filmFactsOf` probe that requires `film_metadata` / `film_dimension` / `film_sync_state`. Five ADR 0117 exceptions (including the metadata-cache mirror) stay exceptions and are not residuals. **`--apply` STOPs while any residual remains.** The Producer Workflow `filmFactsOf` plans `film_metadata` and `film_sync_state` from real sealed clocks (`metadataAt` / synopsis / people clocks) and copies `film_dimension` only when the sealed Film already carries a lifecycle row with provenance; a lone `updatedAt` invents nothing. `epg_commit` is wired to the existing `film_facts` / `person_mutation` / `person_state` / `film_credits` operations. `metadataSync` / `epgSync` write frozen `titles.json` / `people.json` only through `saveJSON` → `putStoredJson`, which re-reads `canonicalMirrorsWritable` immediately before `BUCKET.put` (after `epgStepGuard` and any routing await). An exclusive `projector_window` in `held` also refuses those puts; a timeout or other failed window read is STOP (only a genuine missing `projector_window` table is treated as no window). A prepared→open flip during the guard cannot land a canonical R2 put. `GET /api/catalog/film/<id>`, `GET /api/catalog/available` and `ratingsFilmLabels` at `open` read bounded D1 facts (`catalogMetadataFromD1`: poster, year, Letterboxd URL, localization title, trusted TMDB claim) and never frozen `metadata.json` / `titles.json`; `legacy`/`r2`/`prepared` keep R2; `held` / unreadable / generation move are typed STOP. Footer `metadata.json` and `GET /api/enrichment/diagnostics/export?group=global` follow the same gate (bounded D1 of named ids at `open`, no frozen-key GET). Freeze residuals are 0. `metadata_sync` is wired (`src/canonical-metadata-sync-producer.js`, call site `metadataSync`: typed identity claims, durable `metadataSyncIntent` only for the unsettled current batch, cursor held until `metadataSyncSettled`). `rated_admission_retention` is wired (`src/canonical-rated-admission-producer.js`, call sites `commitVerified` / `commitBaselineChunk` after a successful link / `persistScan`). `persistScan` captures pre-scan watchlist membership only while the Film/Person writer route is `open`; at `prepared` it is the existing R2 facts scan with no cursor. At `open` it applies the facts scan once, then walks listed+departed Films with `UNIT_CAP` and a durable cursor. An unfinished successful slice answers seal `continue` (not an error). After the 16 Nov 2026 UTC apply, a further `dry_run` against generation 1 is expected to STOP (`marker_not_prepared`). This page authorizes no second apply and no `held` recovery.

The flip is one guarded `UPDATE` plus readback. SQL asserts schema ≥ 23, Discovery `d1`/`open`, verified `film_person_baseline.reference`, and this owner's unexpired window and leases against the **database clock**. Exclusive ownership is re-checked before and after `recordBaseline`.

## Dry-run (read-only)

```
node scripts/film-person-open-handoff.mjs --expected-generation=1 --expected-reference=<exact film_person_baseline.reference>
```

Needs D1 operator credentials (`D1_BACKFILL_*`). It writes nothing. `outcome: dry_run` plus `readiness.blockers` is evidence, not permission. `expectedReference` is the exact verified `film_person_baseline.reference` (a path-prefixed digest such as `cutover_accepted/v2:` plus 64 hex, 84 characters). The MCP argument cap is 96; a 64-hex digest alone does not match the recorded reference.

## Apply (executed 16 Nov 2026 UTC; do not repeat)

Production apply is the owner-only MCP tool on the deployed Worker (Access JWT). It never uses the REST `/query` adapter:

```
film_person_open_handoff
  mode: apply
  confirmGo: true
  expectedGeneration: 1
  expectedReference: <exact film_person_baseline.reference>
```

`confirmGo` false or omitted is refused. `expectedGeneration` and `expectedReference` are required. The production apply of 16 Nov 2026 UTC used generation 1 and the verified `cutover_accepted/v2:` reference ([evidence](../evidence/d1-migration/air-499-film-person-open-2026-11-16.md)). A second apply with those operands is refused. While `activationReadiness.ready` is false, apply STOPs at preflight and takes no lease. The REST CLI remains dry-run only:

```
node scripts/film-person-open-handoff.mjs --expected-generation=1 --expected-reference=<exact film_person_baseline.reference>
```

The sequence once those blockers are gone:

1. `activationReadiness` (H1 class counts 708 / 398 / 4, marker `prepared` at the expected generation, verified baseline reference, idle leases and window, Discovery `d1`/`open`, schema ≥ 23, writer route `projector`).
2. Take the enrichment projector lease as this owner only; STOP on a competing live lease.
3. `requestProjectorWindow` then `grantProjectorWindow` (ADR 0103, 300 s cap); STOP if not granted; Discovery lease moves onto this owner.
4. **One guarded UPDATE** plus readback, then grant/`recordBaseline` through **Worker `D1Database.batch()`** (Cloudflare-documented rollback). The REST `/query` CLI adapter is not that API: explicit `BEGIN`/`COMMIT` is unsupported on D1, and REST `{batch:[...]}` is not documented as transactional, so **`scripts/film-person-open-handoff.mjs --apply` STOPs with `transport_not_worker_batch`** and takes no lease. Dry-run stays REST SELECTs. The MCP `apply` path is the Worker binding. A lost read after a committed UPDATE is `unknown` (keep the exclusive window). Apply still requires the expected generation and baseline reference.
5. Re-check exclusive ownership on the database clock, then `recordBaseline` / `verifyBaseline` / `readUnreceipted` / `listAttention`. If the window or lease has expired, STOP and keep them. No producer write is allowed between flip and seal (`receipt_baseline_missing`). A Worker tick cannot use the projector: `projectorExpectation` is null at `d1`.
6. Readback: generation G+1, writer `canonical`, projector not writable, sealed/verified receipts, no unreceipted or attention rows.
7. Release **only** this owner's lease and window.

## STOP conditions

Any failed or unreadable preflight assertion; competing lease or window; stale generation or wrong baseline reference; flip batch that does not change the marker; **unknown** batch outcome (read the marker; if it is already `d1`/`open`/G+1 do **not** retry; if it is still `prepared`/G do not blind-retry either — hand the evidence to the owner); seal or readback failure (keep this owner's lease and window; do not release). On STOP leave the marker where it is.

## `held` drill on a SAFE COPY

Unchanged from the design: a local sqlite copy, never production D1. Procedure: (a) `activateOpen` on the copy; (b) one D1-only canonical change; (c) `open` to `held`; (d) readers and writers fail closed; (e) forward fix `held` to `open`; (f) readback. Not run by this page.

## After `open`

Recovery is `open` to `held`, then the forward fix; both need an explicit owner GO. **Once D1-only writes exist, setting `r2` or a git revert is not a rollback.**

## Cross-links

[Holdpoint decision pack](film-person-holdpoint-decision-pack.md). Migration 0023 is already applied ([procedure](film-person-0023-apply.md), [evidence](../evidence/d1-migration/air-499-0023-apply-2026-11-16.md)); that apply is not this flip.
