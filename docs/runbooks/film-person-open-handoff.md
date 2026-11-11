# Film/Person `open` handoff, `held` drill and forward fix (design only)

**This runbook authorizes nothing. Nothing in it has been executed. It is a DESIGN of one concrete activation plan; the plan must be separately approved by the owner (L3 staged plan) before anything runs, and no approval is implied by this page, by a merge, or by a green CI.** Decisions: [ADR 0117](../adr/0117-film-person-d1-handoff-owner-decisions.md) (and [ADR 0099](../adr/0099-canonical-film-person-d1-authority.md), [ADR 0103](../adr/0103-projector-exclusive-window.md)). Card: [AIR-374](https://trello.com/c/ha7ais3w).

Counts and digests only in any evidence; no ids, titles, payloads or credentials.

## Preflight checklist (read-only; each item is evidence, not permission)

1. Marker is `prepared`/`open` at generation G; fence row ok; baseline `verified` with the recorded reference ([AIR-373 evidence](../evidence/d1-migration/air-373-baseline-prepared-2026-11-11.md)).
2. Schema version at least 16; migrations 0013 to 0016 triggers present.
3. The projector fence of [ADR 0116](../adr/0116-projector-marker-and-generation-fence-on-every-batch.md) / PR #524 (marker and generation in every real projector batch, unconditional) is implemented; confirm it is the deployed code on the exact commit before activation.
4. The bounded loader for the three empty classes (1,113 rows) has run with its own GO ([loader runbook](film-person-prepared-loader.md)); receipts and readback match.
5. Every canonical producer is wired (P2/P3) but dormant at `prepared`; readers fail closed (P4); `handoffReadiness` is computed and ready (P6; today `GAPS` makes it never ready).
6. The frozen-mirror classification (ADR 0117 decision 3) is recorded object by object.
7. Receipts for cross-domain operations exist (ADR 0117 decision 4); no pending or failed receipt.
8. No live projector lease; `projector_window` idle; no EPG, Ratings or Discovery run in flight; the quiet window is agreed in Madrid time.
9. The `held` drill below passed on a safe copy.

## The `held` drill on a SAFE COPY (procedure and acceptance only)

A safe copy is a local sqlite file built from the repository migrations plus a bounded, count-only copy; it is never production D1 and never a Cloudflare database. The drill is not run by this page.

Procedure: (a) put the copy at `prepared`, run the handoff batch to `open`; (b) write at least one D1-only canonical change through a fenced writer; (c) move `open` to `held`; (d) confirm readers answer the fail-closed error and writers refuse; (e) apply the forward fix and move `held` to `open`; (f) readback.

Acceptance criteria: generation rises by exactly one per move; every writer attempt at `held` is refused with no row changed; no reader names R2 at `held`; the D1-only change from (b) survives unchanged; after the forward fix the writer route is `canonical` and one fenced write succeeds; the migration trigger refuses `d1` to `r2`; a stale-generation batch fails whole.

## Operator sequence at `open` (DESIGN: ONE owner-approved activation plan, nothing executes)

Once the owner approves this single plan, its bounded preflight reads, the lease and exclusive window, the final empty-plan projector pass, the readback, the catch-up and the release are executed within it and need no separate approval each. The **holdpoints** are explicit owner GOs: (H1) the P5 live load of the three empty classes, (H2) the batch `prepared` to `open`, (H3) any live write probe, (H4) `held`, recovery or rollback and any repair.

1. Bounded fenced preflight reads (counts only).
2. Lease and exclusive window ([ADR 0103](../adr/0103-projector-exclusive-window.md)); stop if not granted. Producers are parked while it is held; cross-domain operations queue as durable receipts.
3. Final projector pass with an empty plan; stop if any write is planned.
4. **Holdpoint H2, the single batch:** assert lease held and unexpired, assert marker `prepared`/`open`/G, assert baseline `verified` with the expected reference, guarded `UPDATE` to `d1`/`open`/G+1, CAS fence. All or nothing.
5. Readback: marker `d1`/`open`/G+1, writer route `canonical`, projector compare-only.
6. Bounded catch-up canonical reconcile (not atomic with the marker); settle pending and unknown receipts by readback and same-request-id replay.
7. Release the window and the lease.
8. Mirror freeze and consumer verification (reads only).

## STOP conditions

Any failed or ambiguous assertion; batch outcome unknown (read the marker, do not retry blindly); a live lease or window not ours; marker not `prepared`/`open`/G; baseline not `verified` or reference differs; a planned projector write in step 3; a pending receipt; a reader or consumer still on a frozen mirror; budget or time window exceeded. On STOP leave the marker where it is and hand the evidence to the owner.

## After `open`

Recovery is `open` to `held`, then the forward fix `held` to `open`; both are holdpoint H4 and need an explicit owner GO, and only with the drill passed. **Once D1-only writes exist, setting `r2` or a git revert is not a rollback.** The reverse reconciler is deferred.

## Dated note, 11 Nov 2026 (P6, offline): `handoffReadiness` is computed

Preflight item 5 is now checkable by code. `handoffReadiness` (read-only, unbundled) lists a blocker for each of: a former producer gap without a registered fenced writer and a differential entry; a named projector-versus-canonical difference not accepted by the owner (`exception_not_accepted:<id>`); `receipts_schema_missing` and `receipts_protocol_unregistered` (ADR 0117 decision 5, migration 0019 not applied or introduced); `producer_not_wired:<name>` for EPG commit, metadata sync, Discovery admission and rated admission/retention; `reader_not_moved:<name>`; `empty_class_not_loaded:<class>:<found>/<expected>` (708, 401, 4); a live projector lease; a window that is not idle; and the marker and baseline. It does not replace the owner's holdpoints and authorizes nothing. With the repository at the time of this note it is NOT ready. The registries are data; the PRs that wire a producer or move a reader update their entry, and the owner accepting a named difference changes its `status` in its list. This note adds to the design above and rewrites no accepted text.

## Not covered

The offline tool that emits the preflight reads, the batch and the readback is a follow-up (not shipped). Not verified: production state at the time of the GO.
