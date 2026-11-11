# Film/Person `open` handoff, `held` drill and forward fix (design only)

**This runbook authorizes nothing. Nothing in it has been executed. Every step below is a DESIGN that needs its own explicit, operation-specific owner GO; no GO is implied by this page, by a merge, or by a green CI.** Decisions: [ADR 0117](../adr/0117-film-person-d1-handoff-owner-decisions.md) (and [ADR 0099](../adr/0099-canonical-film-person-d1-authority.md), [ADR 0103](../adr/0103-projector-exclusive-window.md)). Card: [AIR-374](https://trello.com/c/ha7ais3w).

Counts and digests only in any evidence; no ids, titles, payloads or credentials.

## Preflight checklist (read-only; each item is evidence, not permission)

1. Marker is `prepared`/`open` at generation G; fence row ok; baseline `verified` with the recorded reference ([AIR-373 evidence](../evidence/d1-migration/air-373-baseline-prepared-2026-11-11.md)).
2. Schema version at least 16; migrations 0013 to 0016 triggers present.
3. The projector fence of decision 1 (marker and generation in every real projector batch, unconditional) is merged, deployed and its CI is green on the exact commit.
4. The bounded loader for the three empty classes (1,113 rows) has run with its own GO; receipts and readback match.
5. Every canonical producer is wired (P2/P3) but dormant at `prepared`; readers fail closed (P4); `handoffReadiness` is computed and ready (P6; today `GAPS` makes it never ready).
6. The frozen-mirror classification (ADR 0117 decision 3) is recorded object by object.
7. Receipts for cross-domain operations exist (ADR 0117 decision 4); no pending or failed receipt.
8. No live projector lease; `projector_window` idle; no EPG, Ratings or Discovery run in flight; the quiet window is agreed in Madrid time.
9. The `held` drill below passed on a safe copy.

## The `held` drill on a SAFE COPY (procedure and acceptance only)

A safe copy is a local sqlite file built from the repository migrations plus a bounded, count-only copy; it is never production D1 and never a Cloudflare database. The drill is not run by this page.

Procedure: (a) put the copy at `prepared`, run the handoff batch to `open`; (b) write at least one D1-only canonical change through a fenced writer; (c) move `open` to `held`; (d) confirm readers answer the fail-closed error and writers refuse; (e) apply the forward fix and move `held` to `open`; (f) readback.

Acceptance criteria: generation rises by exactly one per move; every writer attempt at `held` is refused with no row changed; no reader names R2 at `held`; the D1-only change from (b) survives unchanged; after the forward fix the writer route is `canonical` and one fenced write succeeds; the migration trigger refuses `d1` to `r2`; a stale-generation batch fails whole.

## Operator sequence at `open` (DESIGN, nothing executes)

Each numbered step is a separate owner GO and a holdpoint.

1. **GO-1 pre-flight reads** (read-only, fenced; emit counts).
2. **GO-2 lease and exclusive window** ([ADR 0103](../adr/0103-projector-exclusive-window.md)); stop if not granted.
3. **Final projector pass with an empty plan**; stop if any write is planned.
4. **GO-3 the single batch:** assert lease held and unexpired, assert marker `prepared`/`open`/G, assert baseline `verified` with the expected reference, guarded `UPDATE` to `d1`/`open`/G+1, CAS fence. All or nothing.
5. Readback: marker `d1`/`open`/G+1, writer route `canonical`, projector compare-only.
6. One catch-up canonical reconcile; confirm no pending receipt.
7. Release the window and the lease.
8. **GO-4 mirror freeze verification** and consumer check (readers on D1).

## STOP conditions

Any failed or ambiguous assertion; batch outcome unknown (read the marker, do not retry blindly); a live lease or window not ours; marker not `prepared`/`open`/G; baseline not `verified` or reference differs; a planned projector write in step 3; a pending receipt; a reader or consumer still on a frozen mirror; budget or time window exceeded. On STOP leave the marker where it is and hand the evidence to the owner.

## After `open`

Recovery is `open` to `held` (separate GO), then the forward fix `held` to `open` (separate GO), only with the drill passed. **Once D1-only writes exist, setting `r2` or a git revert is not a rollback.** The reverse reconciler is deferred.

## Not covered

The offline tool that emits the preflight reads, the batch and the readback is a follow-up (not shipped). Not verified: production state at the time of the GO.
