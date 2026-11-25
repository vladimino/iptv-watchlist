# ADR 0221: The shared Letterboxd check state (entries and backlog) lives in one D1-owned Ratings document, and a check's effect is owned by a reservation

**Status:** Accepted  
**Original decision date:** 2026-11-25  
**Recorded at:** 2026-11-25  
**Approval source:** [Product Owner decision of 25 Nov 2026 on PR #1009](https://github.com/vladimino/iptv-watchlist/pull/1009#issuecomment-7170630750): option A approved (combine the documents), with a formal record of the architectural change and an explicit reference to the superseded part of ADR 0207 decision 4b. This is architecture approval only, not a review PASS and not a production GO.  
**Related work:** [AIR-599](https://trello.com/c/vj7WPo27), [PR #1009](https://github.com/vladimino/iptv-watchlist/pull/1009) (card D0 of the [ADR 0207](0207-letterboxd-admissions-coordinated-in-d1-only.md) delivery graph)  
**Supersedes:** In part [ADR 0207](0207-letterboxd-admissions-coordinated-in-d1-only.md) decision 4b, [«Refused ids stay recoverable»](0207-letterboxd-admissions-coordinated-in-d1-only.md#4b-both-callers-of-the-diary-check-one-retry-policy-fences-and-visibility-0207-u3--b): only the storage layout it requires (a **second** bounded document, `diary-identity-backlog`) and the atomic-transition and compare-and-swap-token wording of the same decision that presumes two documents (the owner `requeue` / `dismiss` tokens «the Diary document's stored version for an entry or a backlog id»). Everything else in 4b stays binding and ADR 0207 stays Accepted, its text preserved.  
**Superseded by:** None

## Context

ADR 0207 decision 4b gives both automatic callers of the Diary check (the Ratings Diary phase and the Watchlist admission step) one retry policy over one shared document, `letterboxd/facts/scans/diary-identity.json` (at most 200 entries), and names a **second** bounded document, `diary-identity-backlog.json` (at most 2,000 ids), for ids the full first document may not take. The Watchlist caller also keeps its own D1 ledger row per id, `watchlist_admission_pending`.

Implementing D0 on that layout and three independent reviews of PR #1009 showed that the check state of one id then lives in **three places** (the entry, the backlog record, the ledger row) with no single owner, and that each pair of them has a race that no per-document compare-and-swap can close:

- an owner `requeue` or `dismiss` resets some of the places and not the others, so the next step re-seeds the old budget from the one left behind;
- an id moves between the entry and the backlog in two separate writes, so an owner action or another caller's write between them is overwritten or resurrected;
- two callers can both start a source check, or an admission can still land after an owner action was reported as committed, because nothing owns the check between the step's read and its write;
- a budget read from a ledger row can be installed after an owner reset of that row.

The same reviews established the constraints a design must meet: bounds 200 and 2,000 stay; no migration; no production writer; the Ratings document store is already D1-owned (`ratings_document`, parts of at most 60 KB, one fenced batch per write) and can carry caller statements in the same batch.

## Decision

The owner approved option A. The part of ADR 0207 decision 4b superseded here is exactly: the sentence «It records the id (lid, slug and `queued_at` only) in a second bounded document, `diary-identity-backlog`. That document sits in the same Ratings document store, so it needs no migration, and it holds at most 2,000 ids» and the owner-action token wording that distinguishes the Diary document's version for an entry from that for a backlog id. All other guarantees of 4b remain binding: the classes and the no-charge transport rule, the cap of six counting only gone and definite outcomes, the shared check budget, the queue order, `cap_refused` / `backlog_full` and recovery from the Diary facts, `diary_cap` for the Watchlist caller, the visibility, the owner `requeue` / `dismiss` route and its Access verification, the legacy report and the producer fence. The backlog keeps its bound of 2,000 ids and the entry cap its bound of 200.

1. **One document.** `letterboxd/facts/scans/diary-identity.json` holds `films` (at most 200 entries, only `owner_dismissed` evictable) and `backlog` (at most 2,000 ids, each `{slug, queuedAt, attempts, requeued?}`), plus `lastCheckAt` and `ownerActionAt`. An id is in exactly one of the two and moves between them only inside one compare-and-swap. There is no `diary-identity-backlog.json`. The entry cap is also enforced by the compare-and-swap itself.
2. **Writes are bound to what the writer read.** Every write installs a change for an id only while the stored entry and backlog record still equal what the writer read of both; otherwise nothing is done for that id (`entry_changed`: not now, no attempt).
3. **A reservation owns an effect.** Before a step does anything with an effect for an id (a source check, a link made from a trusted bridge, the completion of a confirmed admission's link) it reserves the id in one compare-and-swap: a `reservation {checkId, until, route}` on the entry, expiring after five minutes, created together with the entry and the removal of its backlog record when the id comes from the backlog. Another step skips a reserved id (`in_flight`). The reservation stays through the link intent and is released by the holder's final write; a step that was cut off leaves one that expires. The holder's every write, including the intent that precedes each non-atomic effect, is bound to the entry it reserved and fails closed.
4. **An owner action is atomic across the three places and refused while an effect is in flight.** `requeue` and `dismiss` change the entry, the backlog record and the ledger row of the same ids in ONE D1 batch (the ledger statements ride as caller statements of the document write, each with the row's token and a fence). A moved document version or row token refuses the whole request (`stale_revision`); an id with a live reservation refuses it as well (`check_in_flight`, nothing written). The readback covers all three places.
5. **A ledger row's budget is applied only under its token.** Every write of the shared document that applies a row's seed carries a guard statement of the row's token (`attempts`, `updated_at`, `state = pending`) in the same batch, and every ledger settle carries the same token as a fence, so an owner reset between a step's read and its write is never undone from either side.
6. **The cap applies to the effective count** (entry, the caller's row budget, backlog record) before any check, and the count is held on the entry at the cap.
7. **Bounds of the serialized document.** At 200 entries and 2,000 backlog records with every field at its maximum length, with the owner audit stored as at most 100 characters of `by` and 200 of `why` (a backlog record keeps only `by` and `at`), the document is about 1.0 to 1.3 MB, at most 30 parts of 60 KB in one batch; a typical full document is about 0.25 MB. A test pins these bounds.

Not decided or authorized: any migration, flag, Scheduled Task, production recovery or the legacy recovery of old entries (card DR, owner L2 contract). The ADR does not change the retry classes, the attempt cap, the queue order or the visibility rules of decision 4b.

## Alternatives considered

- **A. One document (this decision).** Entry, backlog and reservation are one compare-and-swap; the owner action needs one document batch plus the ledger statements. Cost: every write rewrites the document (up to 30 part rows in the worst case, typically 5); the layout differs from ADR 0207's text.
- **B. Two documents and a fenced handoff protocol (rejected by the owner).** Keeps ADR 0207's layout. Needs a second compare-and-swap and a handoff record so an id never sits in both documents or neither across a crash, and every owner action and intake must fence both documents. It reintroduces exactly the multi-location interleavings the reviews found, with an additional protocol to prove and test.
- **C. No backlog (not selected).** A refused id is simply not checked and stays in the ledger (Watchlist) or is recovered by the read-only report of Diary facts without an entry that ADR 0207 already describes. State is in two places instead of three and the document stays near 0.26 MB, but the "waits for a place" behaviour and `backlog_full` of decision 4b disappear, a Diary page id that left page 1 depends on the report, and it is also a change to ADR 0207.

## Consequences

- One authority for entry, backlog and reservation; the three-location races of the reviews are closed by construction and covered by tests on a real D1 (owner action in every combination, a stale seed across a snapshot read, an owner action during intake, during a source check and after the intent, a foreign write in flight).
- An owner action can be refused for up to five minutes while a check is in flight; the owner retries. A crashed holder never blocks longer than the reservation.
- Larger writes: every ordinary step writes the document once per checked id (reservation) plus once at the end. Typical size 0.25 MB, worst case about 1.3 MB.
- Rollback is a code revert: older code ignores the new fields (`class`, `streak`, `queuedAt`, `checkId`, `route`, `reservation`, `lastCheckAt`, `backlog`, `ownerActionAt`); a `backlog` map would sit unread. The backlog never existed in production before PR #1009.
- The owner `requeue` and `dismiss` route stays closed (503) until the dashboard variables `ADMIN_ACCESS_AUD` and `ADMIN_OWNER_EMAIL` are set.

## Recovery and migration boundary

No migration. Nothing here authorizes a flag change, a data write, a Scheduled Task or a cutover. Reverting the code does not revert documents already written. Legacy entries that the old rules exhausted or aged out are recovered only by the owner's bounded `requeue` under an L2 contract naming the ids.

## Evidence

- **Original decision:** [Product Owner decision, 25 Nov 2026](https://github.com/vladimino/iptv-watchlist/pull/1009#issuecomment-7170630750), prepared from the three independent reviews of [PR #1009](https://github.com/vladimino/iptv-watchlist/pull/1009).
- **Implementation:** [PR #1009](https://github.com/vladimino/iptv-watchlist/pull/1009) (`src/letterboxd-facts.js`, `src/letterboxd-diary-identity.js`, `src/letterboxd-sync-admission.js`, `src/watchlist-d1.js`, `src/admin/identity-owner-action.js`); tests `tests/letterboxd-diary-identity.mjs`, `tests/letterboxd-owner-action-atomic.mjs`, `tests/letterboxd-owner-race-d1.mjs` and the mutation harness `tests/letterboxd-diary-identity-mutation.mjs`.
- **Dated verification:** not recorded; no production read or writer was run.
- **Uncertainty:** the worst-case document size is a bound from the field limits, not a production measurement; production has no backlog yet.

## Follow-ups

- The dated L0 legacy report and the bounded recovery of legacy entries (card DR) remain separate gates of AIR-599 and ADR 0207.
- PR #1009 still needs an independent review PASS, green exact-HEAD CI and the technical gates before merge; this ADR is architecture approval of the storage layout only ([ADR merge gate](../process/agent-workflow.md#adr-merge-gate): owner decision linked above).
