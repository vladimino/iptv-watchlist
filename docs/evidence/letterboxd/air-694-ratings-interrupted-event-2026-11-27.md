# AIR-694: Letterboxd Sync Ratings interrupted event (27 November 2026)

## Established (read-only status of 27 November 2026, 22:04:43Z, `sideEffects` none)

- Slot `2026-11-27T2230`, run `4219ce2f-cf96-4afb-8519-74fc21c4a357`: started 21:31:03Z, last Diary step 21:31:09Z, cursor `lastSuccessAt` 21:31:13Z with `stopReason=lease_lost`, `resumePage` 2.
- The run was closed at 21:34:48Z as `state=unknown`, `cause=interrupted`, `interruptedPhase=diary`, checkpoint `diaryPagesRead 0`; the slot closed at 21:34:54Z with Ratings `error`.
- `LEASE_MS` is 180000 ms, so the step lease expired about 21:34:09Z: a step lost its lease, and no checkpoint was saved.

## Not established

Why the step stalled for about three minutes (Letterboxd fetch latency, facts/identity settlement, clock or concurrency) is **not proven**: the available logs for the run id held no detail. No timeout or lease change is made on a guess, and no fence is loosened.

## Defect found in code (proven offline)

1. Producer: `ratingsSlotPhase` returned `outcome=error, reason=lease_lost` with no AIR-361 contract, so the slot Event was frozen without `state`/`cause`.
2. Consumer: `eventPresentationStatus` returned no status for that shape (no badge, absent from the «Прервано» filter), while the renderer defaulted its title to «прервана» and showed a fictitious zero «Удалений обработано».

## Fix

- A lost lease or an unrecognised run is an interrupted phase (`outcome=interrupted`, `reason`, `phase`, checkpoint counts); the frozen Event carries `state=unknown`, `cause=interrupted`, `interruptedPhase` and null `diary`/`removal`. A pipeline-built contract is never overwritten. One slot event and the outbox/idempotency are unchanged.
- The reader classifies a stored event without `state`/`cause` from `outcome`/`reason`; no stored event is rewritten. The renderer derives its title from the badge status and shows no counters for an unknown result.
- Blocked, rate-limited and confirmed errors keep their warning and error statuses.

## Proof

Offline: `tests/letterboxd-sync-ratings.mjs`, `tests/letterboxd-sync.mjs`, `tests/events-result-status.mjs`.

## Open

Natural next slot after deploy for operational acceptance; read-only badge and filter check of the existing event after deploy. No forced run. The root cause of the stalled step remains undiagnosed; a future occurrence should be analysed with this RCA.
