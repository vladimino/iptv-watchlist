# ADR 0208: Where the durable evidence of a Canonical Producer outcome lives until its Events Log entry is delivered

**Status:** Proposed  
**Original decision date:** pending (owner decision required)  
**Recorded at:** 2026-11-24  
**Approval source:** not documented (pending)  
**Related work:** [AIR-594](https://trello.com/c/iPaLDfzP), [PR #976](https://github.com/vladimino/iptv-watchlist/pull/976), [independent review of `d1ca719c`](https://github.com/vladimino/iptv-watchlist/pull/976#pullrequestreview-6037146819)  
**Supersedes:** None  
**Superseded by:** None

## Context

AIR-594 adds the Events Log type `canonical_producer` («Обогащение каталога»): one report per logical Producer outcome. An outcome is a completed pass `P:g` (chain `complete`, written in the same batch as the run's `passed` claim), a recorded stop `(P, owner epoch)` (chain `stopped`), or an in-flight chain (`pending`, `active`, `released`) superseded by a newer publication. The event identities, fields, run-versus-chain semantics and display are in the [events reference](../reference/domain/events.md#canonical-producer-outcome-report-canonical_producer) and are not what this ADR decides.

The difficulty is the evidence. The chain row (`canonical_producer_chain`, [ADR 0141](0141-producer-workflow-chain-protocol.md)) holds an outcome only until the next transition: the hourly reconcile recovers a stopped chain into a new epoch (`stopped_by` cleared), reopens a completed one for a new generation, and supersedes every chain of an older programme run. The Events Log is R2 (`events/items/`), D1 is the Producer's store, and the two are never written atomically.

The first implementation at `d1ca719c` (PR #976) read the chain in the hourly reconcile, put the event create-only into the journal before moving the chain, queued a refused put in a new mutable R2 ledger `events/canonical-producer-outbox.json` (etag compare-and-swap, `baselineAt`, bounded `pending` and `settled`, a `lost` counter), and reported a superseded chain after the supersede commit. The independent review found, and this ADR accepts as facts:

1. **Supersede window.** The supersede is committed before the event is offered. A Worker that dies between the two, or a commit whose response or readback fails, leaves a superseded chain that no later tick lists (`listNonterminalChains` excludes it), and its in-flight state is gone. The outcome is lost permanently.
2. **Ledger read window.** An unreadable ledger (a transient R2 GET failure) makes the tick skip reporting while it still recovers, reopens or supersedes the chain, so the only durable evidence is erased. An invalid existing ledger was treated as absent: a new baseline replaced it and its queued events.
3. **Recovery promise clock.** The frozen `recovery: automatic` was computed at the stop time; `recoverChain` applies its 24-hour streak window at the reconcile time, so a stop just before the window ends is described as resuming while the reconcile holds it for the owner.

These are not corner cases of one implementation: any design that keeps the outcome only on a mutable row and copies it out afterwards has a window between the transition and the copy. Paid Workers is the cost baseline (AGENTS.md); write counts here are a few rows a day and are not a decision driver.

## Decision (proposed; option B is recommended)

**Option B — a D1 outcome outbox written in the same batch as the transition.** Pending the owner's choice between A and B below.

1. **One additive table** (migration `0038`, inert until applied; applying it is a separate owner GO): `canonical_producer_outcome`, primary key the event id (`canonical_producer-<P>-g<g>-passed`, `-e<epoch>-stopped`, `-e<epoch>-superseded`, `-e<epoch>-held`), with the outcome, `at`, the programme run id and generation, the counters snapshot and the chain counts as typed columns (no free text), and delivery columns `state` (`pending`, `delivered`), `attempts`, `next_attempt_at`, `delivered_at`. Writable only while the Film/Person marker is `d1`/`open` (the same trigger pattern as 0020 and 0023). No backfill: rows exist only for transitions committed after the code that writes them runs against the migrated schema.
2. **The row is written in the batch that creates the outcome**, as one `INSERT OR IGNORE … SELECT` that reads the run row of the same `P:g` inside that batch, so the snapshot and the transition commit together or not at all:
   - `commitPassComplete` with the chain completion, and `completeChain` (the `already_complete` path): `passed`;
   - every `stopChain` (Workflow and reconcile-side stops): `stopped`;
   - `supersedeChain` from the hourly reconcile, only when the stored state before the update is `pending`, `active` or `released`: `superseded` (a complete or stopped chain that is superseded adds nothing; the owner path of `producer_chain_operator` adds none);
   - the hourly reconcile, when `recoverChain` or `reopenChain` answers `held` for a stopped chain whose stop row said it was eligible for automatic recovery: one `held` row for that `(P, epoch)`, so the frozen stop report never stays the last word when the automatic recovery did not happen (finding 3).
3. **Budget.** Inside a Workflow instance each terminal batch gains one statement. It is charged to the existing ceilings (`CHAIN_COST.complete`, `CHAIN_COST.end`), and `tests/canonical-producer-budget*.mjs` must keep proving every admitted operation within its ceiling. The reconcile's writes are outside the instance budget.
4. **Delivery** belongs to the hourly reconcile only: at most 8 pending rows a tick, oldest first (indexed), each put create-only to `events/items/<reverse-timestamp>-<id>.json` (a put that finds the key counts as delivered), then marked `delivered` by a compare-and-swap on `attempts`. A failed put increments `attempts` and sets `next_attempt_at` (hourly, no give-up); the pending count and the oldest pending age are read by the Monitor stream `canonical_producer` as a visible fact, never as a Producer failure. A delivered row is kept 30 days and then deleted by the drain, at most 8 a tick. `GET /api/events` stays read-only.
5. **Recovery wording.** A stop report states eligibility at the stop (`recovery: eligible` when the class and the counters then allowed an automatic restart, else `owner`), with the caps in the sentence; the later `held` report states the actual hold.
6. **Before the migration is applied** the code writes no outcome row and reports nothing (the table is detected once per invocation and per tick; an absent table is today's behaviour, never a failed transition). The R2 ledger of `d1ca719c` is not shipped.

**Option A — keep the R2 ledger and close the windows inside it** (not recommended): write a supersede **intent** to the ledger before the supersede and confirm it from the chain revision afterwards; distinguish absent, invalid and unreadable ledgers (an invalid one is preserved under a quarantine key and stops reporting, visible in the Monitor, never replaced); when the ledger is unreadable, still put the event create-only and accept the residual loss when both the journal and the ledger are unreachable at the moment of a transition; compute the recovery wording at the reconcile tick that decides.

**Not decided here:** the event fields and display (events reference), any change to the Producer protocol of ADR 0141 beyond the extra statement in the terminal batches, any production apply, activation, backfill or manual run.

## Alternatives considered

| Criterion | A: R2 ledger (PR #976, fixed) | B: D1 outcome outbox (recommended) |
| --- | --- | --- |
| Atomicity with the outcome | None: the copy follows the transition; windows closed by intents and ordering, not by a transaction | The row commits in the same D1 batch as the transition: no window |
| Residual loss | A tick with the journal **and** the ledger unreachable while it moves a chain; a Worker death between an intent and its confirmation needs a later reconciliation | None by construction; a journal outage delays delivery only |
| Supersede in flight | Intent before, confirmation after (two extra R2 writes per supersede) | Same statement as the supersede |
| Recovery promise (finding 3) | Wording computed at the deciding tick | Eligibility at the stop plus a durable `held` report |
| Instance budget (ADR 0141 D5) | Untouched (reconcile only) | +1 statement per terminal batch, inside existing ceilings, proven by the budget tests |
| Store consistency | A second mutable R2 ledger with its own CAS, baseline and validity rules | Same store and fences as the chain and run rows; follows ADR 0194 (the prediction event outbox moved from R2 to D1 for the same reasons) |
| Bounded retention | 32 pending, 64 settled ids, overflow counted lost | Rows per outcome (a few a day), delivered rows deleted after 30 days |
| Loss visibility | `lost` counter and log line | Pending count and age in the Monitor; nothing to lose |
| No backfill | Needs `baselineAt` and its own validity rules | Structural: no row before the code and schema exist |
| Rollout | Code deploy only | Migration `0038` apply (owner GO), then the code; code before the apply is inert |
| Rollback | Code revert; the ledger object stays | Code revert; the additive table and its rows stay; events already in the journal stay |

A third option, writing the event from inside the Workflow straight to R2 after each commit, was rejected without further work: it spends unmetered subrequests inside the instance and still has the window between the D1 commit and the put.

## Consequences

- **B:** no outcome can be lost between the transition and the report; the Producer never waits for or fails on the journal. New: one migration, one statement in five batch builders, a drain in the reconcile, a Monitor fact, and a retention delete. The schema checks of `tests/canonical-producer-schema.mjs` and the budget proofs grow accordingly. Activation is two steps with an owner gate in between.
- **A:** no migration, but a second mutable store with its own validity, CAS and quarantine rules, a documented residual loss, and more R2 operations per transition.
- Either way the user-visible contract of the events reference holds, and a code rollback leaves every delivered event in place; old clients ignore the unknown type.

## Recovery and migration boundary

This ADR authorizes nothing in production. Under B, applying `0038` is a separate owner-approved L2/L3 operation with its own evidence; the code that writes the table is inert before it. Neither option backfills an outcome that ended before its code ran (P518 included). Reverting the code stops new rows and new events; the table, its rows and the journal entries remain and are harmless. Dropping the table would itself need a migration and a decision.

## Evidence

- **Original decision:** pending.
- **Implementation:** [PR #976](https://github.com/vladimino/iptv-watchlist/pull/976) at `d1ca719c` implements the R2 ledger that this ADR replaces with option A or B.
- **Dated verification:** not recorded (offline design; nothing applied).
- **Uncertainty:** the exact statement count each terminal batch gains under B is to be measured by the budget tests in the implementation; the Monitor wording of the pending-delivery fact is to be settled there.

## Follow-ups

- Owner decision on A or B (and on the 30-day retention and the `held` report under B).
- Implementation of the chosen option in PR #976 (B: migration file, inert until applied; writers; drain; Monitor fact; tests), then a separate owner GO to apply `0038` under B.
- Natural-run acceptance of AIR-594 after activation.
