# Film/Person `open` handoff operator (code shipped, production not authorized)

**This runbook authorizes no production flip.** Merging the operator, a green CI, or a dry-run of `activationReadiness` is not a GO. The live marker stays `prepared` until a separate owner L3 GO names the exact commit, generation and baseline reference. Decisions: [ADR 0117](../adr/0117-film-person-d1-handoff-owner-decisions.md), [ADR 0099](../adr/0099-canonical-film-person-d1-authority.md), [ADR 0103](../adr/0103-projector-exclusive-window.md). Card: [AIR-499](https://trello.com/c/8ifHCioP) (tooling); parent design [AIR-374](https://trello.com/c/ha7ais3w).

Counts and digests only in any evidence; no ids, titles, payloads or credentials.

## What exists

- `src/film-person-open-handoff.js` (unbundled): `activationReadiness`, `activateOpen`, `flipOpen`.
- `scripts/film-person-open-handoff.mjs`: default dry-run; writes only with `--apply --confirm-go` together.
- Offline coverage: `tests/film-person-open-handoff.mjs`.

`handoffReadiness` in `src/canonical-producers.js` is **not** the activation gate. It still reports `producer_not_wired` and `reader_not_moved` for freeze writers that remain R2 mirrors. `activationReadiness` is the gate this operator uses: GET `/api/programme` and GET `/api/watchlist` already read D1 at `open`; `epgSync` / `metadataSync` `saveJSON` of `titles.json` / `people.json` are frozen-mirror drift, not a second D1 writer.

`transitionAuthority` still only CAS-es the marker and `film_person_cas`. The operator's flip batch also asserts: schema ≥ 23, Discovery `d1`/`open`, verified `film_person_baseline.reference`, this owner's held projector window, this owner's live enrichment lease, and this owner's Discovery lease.

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
4. **One flip batch** (`prepared`/`open`/G → `d1`/`open`/G+1) with the assertions above and the CAS fence. All or nothing.
5. Immediately `recordBaseline` then `verifyBaseline`, `readUnreceipted`, `listAttention`. No producer write is allowed between flip and seal (`receipt_baseline_missing`). A Worker tick cannot use the projector: `projectorExpectation` is null at `d1`.
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
