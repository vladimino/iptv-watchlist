# Film/Person `open` handoff operator (code shipped, production not authorized)

**This runbook authorizes no production flip.** Merging the operator, a green CI, or a dry-run of `activationReadiness` is not a GO. The live marker stays `prepared` until a separate owner L3 GO names the exact commit, generation and baseline reference. Decisions: [ADR 0117](../adr/0117-film-person-d1-handoff-owner-decisions.md), [ADR 0099](../adr/0099-canonical-film-person-d1-authority.md), [ADR 0103](../adr/0103-projector-exclusive-window.md). Card: [AIR-499](https://trello.com/c/8ifHCioP) (tooling); parent design [AIR-374](https://trello.com/c/ha7ais3w).

Counts and digests only in any evidence; no ids, titles, payloads or credentials.

## What exists

- `src/film-person-open-handoff.js` (bundled for MCP only): `activationReadiness`, `activateOpen`, `flipOpen`, `handleOpenHandoffTool`.
- MCP tool `film_person_open_handoff` on `/mcp` (Cloudflare Access JWT, owner-only). `mode: dry_run` writes nothing. `mode: apply` with `confirmGo: true` uses Worker `env.DB.batch()`. No public HTTP write, cron or Scheduled Task calls it.
- `scripts/film-person-open-handoff.mjs`: REST dry-run (SELECTs). `--apply` is refused (`transport_not_worker_batch`).
- Offline coverage: `tests/film-person-open-handoff.mjs`.

`handoffReadiness` in `src/canonical-producers.js` is **not** the activation gate and is not rewritten. `activationReadiness` is the operational gate **and** it promotes every `activationAudit()` residual to a blocker. Residuals are derived live: freeze-unmoved catalog consumers (ADR 0117 decision 4), unwired natural producers, and a `filmFactsOf` probe that requires `film_metadata` / `film_dimension` / `film_sync_state`. Five ADR 0117 exceptions (including the metadata-cache mirror) stay exceptions and are not residuals. **`--apply` STOPs while any residual remains.** The Producer Workflow `filmFactsOf` plans `film_metadata` and `film_sync_state` from real sealed clocks (`metadataAt` / synopsis / people clocks) and copies `film_dimension` only when the sealed Film already carries a lifecycle row with provenance; a lone `updatedAt` invents nothing. `epg_commit` is wired to the existing `film_facts` / `person_mutation` / `person_state` / `film_credits` operations. `metadataSync` / `epgSync` write frozen `titles.json` / `people.json` only through `saveJSON` → `putStoredJson`, which re-reads `canonicalMirrorsWritable` immediately before `BUCKET.put` (after `epgStepGuard` and any routing await). An exclusive `projector_window` in `held` also refuses those puts. A prepared→open flip during the guard cannot land a canonical R2 put. Remaining freeze readers (admin dictionaries, catalog `metadata.json` fallbacks, footer, migration export) and `metadata_sync` / `rated_admission_retention` still block. This change authorizes no production apply.

The flip is one guarded `UPDATE` plus readback. SQL asserts schema ≥ 23, Discovery `d1`/`open`, verified `film_person_baseline.reference`, and this owner's unexpired window and leases against the **database clock**. Exclusive ownership is re-checked before and after `recordBaseline`.

## Dry-run (read-only)

```
node scripts/film-person-open-handoff.mjs --expected-generation=1 --expected-reference=<64-hex>
```

Needs D1 operator credentials (`D1_BACKFILL_*`). It writes nothing. `outcome: dry_run` plus `readiness.blockers` is evidence, not permission.

## Apply (still needs a named L3 GO)

Production apply is the owner-only MCP tool on the deployed Worker (Access JWT). It never uses the REST `/query` adapter:

```
film_person_open_handoff
  mode: apply
  confirmGo: true
  expectedGeneration: 1
  expectedReference: <64-hex>
```

`confirmGo` false or omitted is refused. `expectedGeneration` and `expectedReference` are required. While `activationReadiness.ready` is false (current residuals), apply STOPs at preflight and takes no lease. The REST CLI remains dry-run only:

```
node scripts/film-person-open-handoff.mjs --expected-generation=1 --expected-reference=<64-hex>
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

## After a future `open`

Recovery is `open` to `held`, then the forward fix; both need an explicit owner GO. **Once D1-only writes exist, setting `r2` or a git revert is not a rollback.**

## Cross-links

[Holdpoint decision pack](film-person-holdpoint-decision-pack.md). Migration 0023 is already applied ([procedure](film-person-0023-apply.md), [evidence](../evidence/d1-migration/air-499-0023-apply-2026-11-16.md)); that apply is not this flip.
