# D1 enrichment projector: L1 wall budget of 180 s behind the grouped-path flag (offline proof, inert delivery)

**Captured:** 2026-11-10, offline (the real projector code, the real migration chain on the `sqlite3` CLI stand-in and a fake clock) plus one read-only `feature_flags` readback at 04:58:50 UTC (05:58 Madrid): `D1_ENRICHMENT_BULK` **absent, effective `off`**; `D1_ENRICHMENT_WRITE` and `D1_ENRICHMENT_WINDOW` set to `on`. No manual projector, Discovery or EPG run, no flag, Task, cron, lease, window or budget change, no migration, no D1 or R2 write.
**Scope:** [AIR-403](https://trello.com/c/pBX5XmJh): the candidate L1 wall budget of [ADR 0106](../../adr/0106-bulk-projector-write-path.md), delivered **inert** behind `D1_ENRICHMENT_BULK`. It is not an activation of L1, not a natural acceptance and not a throughput claim. Context: [AIR-401](air-401-bulk-measurement-2026-11-10.md) measured one productive tick in four; the three others wrote nothing because the diff (42 to 49 s) left less than the 20 s the grouped path requires (15 s reserve plus 5 s first-group estimate) of the 60 s budget.
**Verdict:** **DELIVERED INERT AND PROVEN OFFLINE; HOLD: ACTIVATION REQUIRES A SEPARATE OWNER-APPROVED OPERATION AND SUBSEQUENT NATURAL ACCEPTANCE.** With the flag `on`, a held window and the planning marker, the write phase may last **180 s from the grant**; in every other case it is the **60 s** it always was; the deadline is always the earlier of that and the window's absolute expiry (300 s from the request, ADR 0103, **not raised**), a group starts only with the 15 s reserve and its expected latency left, and the 800-query budget, the statement caps, the lease, generation, marker and fail-closed paths are untouched. In the model, after a slow diff (49 s) the 60 s budget writes nothing and 180 s writes; no figure here is a production Films-an-hour estimate and **no claim of 500 Films an hour is made**.
**Used by:** [ADR 0106](../../adr/0106-bulk-projector-write-path.md) step (e) (and (f)); [AIR-401](air-401-bulk-measurement-2026-11-10.md); [AIR-399](air-399-grouped-projector-offline-2026-11-09.md).

## The policy, in one place

`d1EnrichmentWallPolicy` (`src/d1-enrichment.js`), a pure function of what the run has when its write phase starts:

| Condition | Wall budget from the budget clock's start | `bulkBudget.policy` |
| --- | --- | --- |
| The caller passed `wallMs` | that value | `explicit` |
| `D1_ENRICHMENT_BULK` not `on` (or the run is not a `D1_ENRICHMENT_WRITE=on` run) | **60,000 ms**, as before; no `bulkBudget` in the summary | `default` |
| The flag `on`, but no held window with a finite absolute expiry, or no planning marker | **60,000 ms** | `l1_unavailable` |
| The flag `on`, a held window **and** the marker read before the diff | **180,000 ms** (a value above 300,000 is clamped to it) | `l1` |

The budget clock starts at the window grant (without a window, at the run start), so the diff that follows the grant is inside the 180 s. The run summary then carries `bulkBudget {wallMs, policy, effectiveMs}`, where `effectiveMs` is the budget after the window's expiry. With the flag `on` the window's absolute expiry (less the reserve) also bounds the per-entity steps, which before only had the wall budget; without the flag nothing about them changes.

## Gate boundaries and worst-case stopping

A group is admitted while `min(wall, window expiry) - elapsed - reserve >= longest group seen so far` (5 s before any group, `firstGroupMs`), with the reserve at 15 s. Consequences, as arithmetic (wait for the grant 13 s, so the window expires 287 s after the grant):

| Diff after the grant | 60 s: time for writing | 180 s: time for writing | Window expiry 120 s after the grant (the shortest a grant allows): 180 s budget becomes |
| --- | --- | --- | --- |
| 19 s (fast) | 60 - 19 - 15 = **26 s** | 180 - 19 - 15 = **146 s** | 120 - 19 - 15 = 86 s |
| 42 s (AIR-401, shortest slow) | 60 - 42 - 15 = 3 s, **below the 5 s first group: none** | **123 s** | 63 s |
| 49 s (AIR-401, longest slow) | 60 - 49 - 15 < 0: **none** | **116 s** | 56 s |
| 160 s | none | 5 s (the last) | none |

- **When 60 s writes at all:** only when the diff is 40 s or less; **when 180 s writes:** until the diff is 160 s. The three silent ticks of AIR-401 (diffs of 42 to 49 s) fall in the gap.
- **A late grant** shortens it: a grant needs at least 120 s of the window left (ADR 0103), so the budget after the grant is `min(180, 300 - wait)`; it is the full 180 s while the wait for the grant is 120 s or less, and 120 s at the latest grant. It never runs past the expiry.
- **Worst-case stopping.** A group admitted at the last moment started with the reserve plus the longest seen group left, so it ends before `deadline - reserve + (its latency - the longest seen)`. A group slower than any before it can eat into the reserve (15 s) and, past it, meets the expiry: the next write batch of a window that has expired is refused by the window fence (`window_lost`) and nothing is written after it. The release of the window and the lease follows in the same invocation, so Discovery waits at most until the window's own absolute expiry, 300 s after the request, as ADR 0103 already allows.
- **The 800-query budget** is separate and untouched (a group is two queries); **the statement cap** per batch, the optional run statement budget (a hard cap before submission), the lanes, the group size and the fallback share latch are untouched.

## What the tests prove (`tests/projector-l1-budget.mjs`; Date.now is a fake clock that the D1 stand-in advances by a stated latency per batch)

- **The policy** (pure): off 60 s; the grouped path with a window and marker 180 s; without a window, with a non-finite expiry or without the marker 60 s; an explicit `wallMs` wins; `l1WallMs` is clamped to 300,000 and an invalid value ignored; the window constants (300 s deadline, 120 s minimum run) are asserted unchanged.
- **The write phase against the admission arithmetic**, a model of 6 s a group (1 s read batch, 5 s write batch) on a plan of seven Films (eight groups of work): fast diff, 60 s: 4 groups, 3 Films written, work left; fast diff, 180 s: 8 groups, all 7 Films; **slow diff, 60 s: 0 groups, nothing written (`stop: budget`)**; slow diff, 180 s: 8 groups, all 7 Films. The number of groups equals what the stated rule gives in every cell.
- **Expiry before 180 s**: with the window expiring 120, 100 and 60 s after the grant the run ends inside the window, no batch starts inside the reserve before the expiry, and the group count equals the rule's; a grant with the minimum run time left still writes after a slow diff.
- **Reserve and slow groups**: with a 30 s read batch, and with a first group slower than the estimate, no group starts without the reserve plus the longest group seen so far.
- **Inside a held window only**: every write batch finds the window held by this run and unexpired.
- **Losses inside a 180 s run**: the window expiring, the lease stolen and the marker moved each stop the run on the very next batch (`window_lost`, `lease_lost`, `authority_moved`), nothing is written after the loss and work is left; a batch that fails with an unknown outcome latches the grouped path off and the per-entity replay finishes the work inside the budget.
- **Whole runs through the real window protocol** (a window request and grant, the diff, the grouped write, release; a 49 s diff modelled): flag off: no `bulkBudget`, no `bulk`, and the legacy path ends on its 60 s budget with work left; flag on: `policy l1`, `wallMs` 180,000, `effectiveMs` 180,000, all three Films written, the window granted and released (`idle`), no fence row left; flag on with an explicit 60 s: **no group at all, `stop: budget`, outcome `budget`** (the AIR-401 failure, reproduced); flag on without a window: `l1_unavailable`, 60 s, and a fast diff still writes.
- The test fails when the L1 value is replaced by 60 s. The existing grouped-path, window, bucket and projector tests pass unchanged.

## What this does not show

- **No production throughput.** The clock is modelled: 6 s a group is an assumption, not a measurement (AIR-401's productive tick averaged 0.33 s a group over 75 groups). Nothing here predicts Films an hour, and the ADR's 500 an hour target is neither claimed nor approached.
- **No D1 behaviour under a longer hold.** A 180 s write phase keeps Discovery out of the window for longer than a 60 s one; its effect on Discovery and EPG, the latency of long runs of batches and the rate of `identity_collision` errors ([AIR-404](https://trello.com/c/rB2WlY9q), unclassified in AIR-401) are read only by the natural acceptance.
- **The diff itself** (the 42 to 49 s) is untouched here; AIR-402 addresses the CPU of the view build separately, and a faster diff only adds write time to either budget.
- **Activation** (setting `D1_ENRICHMENT_BULK`), the safe preflight of the markers, the absence of an open identity defect, the effect on Discovery and EPG and the exact rollback (flag off and readback; rows already written stay) are the owner's separate operation. This card does not set, change or request any of them.

## STOP and rollback

Nothing is applied. After the deploy only read-only sources are used: `feature_flags` must keep showing `D1_ENRICHMENT_BULK` absent and effective `off`; no manual projector, Discovery or EPG call. Rollback of the inert code is a revert PR and both jobs; rows written by any later run are not undone. For a future natural run with the flag on, the ADR's STOP conditions stand: a window overrun of the cap, a fallback share above 5 %, a dangling credit, a D1 error naming a batch size, or `authority_moved`.
