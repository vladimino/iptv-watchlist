# AIR-694: Letterboxd Sync Ratings interrupted event (27 November 2026)

## Established (read-only status of 27 November 2026, 22:04:43Z, `sideEffects` none)

- Slot `2026-11-27T2230`, run `4219ce2f-cf96-4afb-8519-74fc21c4a357`: started 21:31:03Z, last Diary step 21:31:09Z, cursor `lastSuccessAt` 21:31:13Z with `stopReason=lease_lost`, `resumePage` 2.
- The run was closed at 21:34:48Z as `state=unknown`, `cause=interrupted`, `interruptedPhase=diary`, checkpoint `diaryPagesRead 0`; the slot closed at 21:34:54Z with Ratings `error`.
- `LEASE_MS` is 180000 ms, so the step lease expired about 21:34:09Z: a step lost its lease, and no checkpoint was saved.

## Not established, and what could not be read

- Why the step stalled for about three minutes (Letterboxd fetch latency, facts/identity/settlement, clock, CAS, concurrency) is **not proven**; the available logs for the run id held no detail. No timeout or lease change is made on a guess, no fence is loosened and no new executor, schedule or forced run is added.
- **The stored historical Event payload was not read in this session.** The incident data above is the owner's read-only status copied on the card; the live Worker logs, the stored `ratings` Event object, the nine earlier successful runs, and the Worker/Workflow version and deployment overlap were **not** queried here (no authorized read path was available to this session: the Cloudflare API telemetry connector and an Access login are owner-side). The code shows the fallback shape the producer could freeze (`outcome`, `reason`, no `state`/`cause`) and the reader handles both that and the real pipeline contract; this is **not** proof of the historical payload. Controller or owner: record its bounded structural fields (`state`, `cause`, `outcome`, `reason`, `interruptedPhase`, presence of `diary`/`removal`) here when it is read.
- What existing telemetry can not tell apart: fetch vs facts/identity/settlement time, an expired clock vs a taken record vs CAS retries. This is why the bounded diagnostic below was added.

## Defect found in code (proven offline)

1. Producer: a lost lease was reported as `error` with no AIR-361 contract; an already `unknown` run was reported as `error/network_error`; the pipeline's own contract for an `unknown` run built zero `diary`/`removal` counters for work that was never confirmed and exported no `interruptedPhase`.
2. Consumer: `eventPresentationStatus` returned no status for the fallback shape (no badge, absent from the «Прервано» filter); the renderer defaulted its title to «прервана», showed a fictitious zero and let the generic cause hide the specific reason.

## Fix

- Interruption classification in the slot ports (Diary phase: `interrupted`; reconciliation: an `error` of the reconciliation with the interruption beside it); counters only from the slot's own run; a finished Diary outcome is never changed.
- The pipeline contract (`ratingsEventOf`) exports `interruptedPhase` and keeps unconfirmed groups `null`; the slot freezes its own honest fallback only when the pipeline gave no contract.
- Reader: legacy `outcome`/`reason` shape classified; title from the badge status; the specific reason before the generic cause. Stored events are not rewritten.
- Diagnostic (natural next occurrence): one bounded `ratings_step_lease_lost` line with `how`, `elapsedMs` and stage `marks`; no rows, URLs, titles or personal data.

## Proof

Offline: `tests/letterboxd-sync.mjs` (real chain closed `unknown` run → `ratingsEventOf` → ports → slot and outbox → stored Event → `eventHTML`/`eventMatchesFilters`; direct lease loss then stale closure; an already `unknown` run; interruption in removal after a finished Diary; exactly two Events), `tests/letterboxd-sync-ratings.mjs`, `tests/ratings-event-details.mjs` (diagnostic line and null groups), `tests/events-result-status.mjs`.

## Open

Natural next slot after deploy for operational acceptance, and a read-only look at the existing event's badge and filter; no forced run. The cause of the stalled step stays open until `ratings_step_lease_lost` is seen.
