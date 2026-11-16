# Film/Person `open` handoff operator (code shipped, production not authorized)

**This runbook authorizes no production flip.** Merging the operator, a green CI, or a dry-run of `activationReadiness` is not a GO. The live marker stays `prepared` until a separate owner L3 GO names the exact commit, generation and baseline reference. Decisions: [ADR 0117](../adr/0117-film-person-d1-handoff-owner-decisions.md), [ADR 0099](../adr/0099-canonical-film-person-d1-authority.md), [ADR 0103](../adr/0103-projector-exclusive-window.md). Card: [AIR-499](https://trello.com/c/8ifHCioP) (tooling); parent design [AIR-374](https://trello.com/c/ha7ais3w).

Counts and digests only in any evidence; no ids, titles, payloads or credentials.

## What exists

- `src/film-person-open-handoff.js` (unbundled): `activationReadiness`, `activateOpen`, `flipOpen`.
- `scripts/film-person-open-handoff.mjs`: default dry-run; writes only with `--apply --confirm-go` together.
- Offline coverage: `tests/film-person-open-handoff.mjs`.

`handoffReadiness` in `src/canonical-producers.js` is **not** the activation gate and is not rewritten. `activationReadiness` is the operational gate. `activationAudit()` classifies every `CANONICAL_READER_REGISTRY` row: the four `moved:true` freeze readers (programme/watchlist titles, `/api/d1/*`, catalog rated-archive fallback) are D1 at `open`; eleven freeze-unmoved consumers stay frozen R2 readers or writers (not dual D1 writers, and not D1-authoritative); five ADR 0117 exceptions stay as they are, including the metadata-cache mirror. The audit also records Producer Workflow `filmFactsOf` (watchlist, canonicalIdentity, originalTitle only — not metadata, dimensions or sync clocks) and that the projector is not writable at `open`. Residuals are listed, not hidden.

The flip is one guarded `UPDATE` plus readback. SQL asserts schema ≥ 23, Discovery `d1`/`open`, verified `film_person_baseline.reference`, and this owner's unexpired window and leases against the **database clock**. Exclusive ownership is re-checked before and after `recordBaseline`.

## Dry-run (read-only)

```
node scripts/film-person-open-handoff.mjs --expected-generation=1 --expected-reference=<64-hex>
```

Needs D1 operator credentials (`D1_BACKFILL_*`). It writes nothing. `outcome: dry_run` plus `readiness.blockers` is evidence, not permission.

## Apply (still needs a named L3 GO)

```
node scripts/film-person-open-handoff.mjs --expected-generation=1 --expected-reference=<64-hex> --apply --confirm-go
```

`--apply` without `--confirm-go` is refused. The sequence:

1. `activationReadiness` (H1 class counts 708 / 398 / 4, marker `prepared` at the expected generation, verified baseline reference, idle leases and window, Discovery `d1`/`open`, schema ≥ 23, writer route `projector`).
2. Take the enrichment projector lease as this owner only; STOP on a competing live lease.
3. `requestProjectorWindow` then `grantProjectorWindow` (ADR 0103, 300 s cap); STOP if not granted; Discovery lease moves onto this owner.
4. **One guarded UPDATE** (`prepared`/`open`/G → `d1`/`open`/G+1) plus readback. Window and lease expiry are compared with the database clock (`strftime('%s','now')`), not the preflight timestamp. There is no REST `{batch}` pair that depends on `changes()` from a previous statement. All or nothing; unknown → STOP, no retry. `--apply` first proves D1 `iptv` UUID `3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb` via `describe()` and refuses an endpoint override.
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
