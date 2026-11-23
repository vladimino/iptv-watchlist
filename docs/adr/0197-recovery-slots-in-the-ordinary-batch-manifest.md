# ADR 0197: A bounded share of each ordinary batch v2 manifest is reserved for owner-confirmed recovery intents

**Status:** Accepted (2026-11-22; Product Owner explicitly accepted the entire ADR, including decisions A–D, after independent technical review of PR #899)  
**Original decision date:** 2026-11-22  
**Recorded at:** 2026-11-22  
**Approval source:** The "Утверждённая политика" section and [explicit owner acceptance of all ADR 0197 decisions in AIR-577](https://trello.com/c/1fuEawPv), recorded in [PR #899](https://github.com/vladimino/iptv-watchlist/pull/899#issuecomment-7081946459), 22 Nov 2026 Europe/Madrid.  
**Related work:** [AIR-577](https://trello.com/c/1fuEawPv), [AIR-478](https://trello.com/c/IbsSCRce) (the recovery cohort and its canary), [AIR-477](https://trello.com/c/WhwaXRRl); [ADR 0165](0165-scoped-prediction-recovery-intent.md), [ADR 0035](0035-selective-fingerprint-transition-compatibility.md), [ADR 0195](0195-scheduled-task-id-as-run-owner-label.md)  
**Supersedes:** None. It adds to [ADR 0165](0165-scoped-prediction-recovery-intent.md) and does not replace any decision of it.  
**Superseded by:** None

## Context

ADR 0165 lets the owner confirm an exact set of films whose stored prediction the ordinary rule accepts as current; the ordinary queue rebuild then treats each as outstanding work with the ordinary lane, priority and retry budget. Selecting films for a batch v2 manifest stayed the ordinary rule: the hot lane while any hot film is ready, the cold lane only when no hot film is ready, and missing predictions before films that already have one at the same rank.

The first 72-hour canary of the recovery cohort showed what that does to a confirmed intent. Ten intents were active, two were re-scored and eight expired (the intent TTL is 72 hours) without being selected: recovery films that are cold, or that already have a prediction, are outranked by the ordinary hot flow for the whole window. This is not a defect of the intent capability; it is a starvation of confirmed work by the ordinary order.

## Decision

1. **A fixed share of each manifest is reserved for recovery.** `RECOVERY_BATCH_SHARE = 0.4` is a Worker constant. For a manifest of `N` films (the requested `manifestSize`, at most 100) the target number of recovery slots is `N >= 2 ? max(1, floor(N * 0.4)) : 0`, and never more than `N`: 5 gives 2 + 3, 7 gives 2 + 5, 10 gives 4 + 6, 15 gives 6 + 9, 20 gives 8 + 12; `N = 1` keeps the ordinary policy. This is a ceiling on the privileged slots, not a guaranteed throughput.
2. **Who may take a recovery slot.** A film with an active, unexpired intent of an active cohort (the overlay read of the same selection), queued in either lane (`hotPending` or `coldPending`, with its true lane kept for the manifest), not retry-exhausted, not in retry backoff and not excluded as already staged. Whether the intent is still unresolved is decided when the film is read: its stored current prediction must still be the exact version the intent denies. A film whose stored version moved on (the intent is satisfied), or that is current, or that has no admission, takes no recovery slot and is handled as before (settled out of the queue, or left to the ordinary order). The queue's `work` map is not used for this, because the queue keeps it only for hot and watchlist films. Recovery needs no new queue field, queue shape or migration.
3. **Order of recovery films.** The owner's confirmation time of the cohort, the oldest first; inside one cohort the film's position in the stored queue (hot lane, then cold lane); then the film id. The remaining slots are filled by the unchanged ordinary order, excluding the films already chosen.
4. **Composition with the fingerprint migration share (ADR 0035).** Recovery slots are filled first. The migration share (`FINGERPRINT_MIGRATION_SHARE = 0.5`, at most `ceil(slots * 0.5)` migration films) is then applied to the slots that are left to the ordinary queue. A recovery film carries no migration work, so it neither uses nor widens that share, and the migration share cannot take a recovery slot. The absolute migration ceiling of a manifest is therefore `ceil((N - recovery) * 0.5)`; migration is not starved because the ordinary slots keep the same fraction.
5. **The quota is a hard cap on recovery films in the whole manifest.** If fewer films are eligible than recovery slots, the free slots go back to the ordinary queue. Every candidate of decision 2 that did not take a recovery slot (read or not) is excluded from the ordinary fill, so no manifest holds more recovery films than its recovery slots, even when the ordinary queue offers nothing (a shorter manifest is the result) and even when a recovery film also sits in the ordinary lane. Only a film that was read and found not to be unresolved recovery work (its stored version moved on but it is still stale) is ordinary work again.
5a. **Recovery probing has its own scan bound.** Reading films for recovery slots is bounded by `RECOVERY_SCAN_LIMIT = 100` probes inside the shared `BATCH_SCAN_LIMIT = 300`, so candidates that never become manifest items (a moved pointer, a vanished admission) can never use the scan budget of the ordinary fill, which keeps at least 200 reads.
6. **Boundary.** The policy applies to an unpinned `batch_start` selection, including a dry run (so a dry run is the faithful preview of the real start) and the settlement window of the queue refresh. A call with a `pin` is never reordered and carries no recovery block. Nothing downstream of the manifest selection changes: the stored queue (membership, lane, priority, retries) is never written for recovery, the runner lease and epoch, the Task ownership label (ADR 0195), `batch_validate`, the durable hold, idempotent submit, the retry and backoff gates and the immutable R2 lineage are the ordinary ones. An intent revision change or a queue rebuild is handled by the existing gate (`recovery_changed`): a stale queue yields no manifest. A recovery store that cannot be read, or a partial table set, fails the caller closed and is never read as "no recovery".
7. **Read-only diagnostics.** When an active intent exists, the `batch_start` answer (and the dry run) carries a `recovery` block of counts only: `target`, `selected`, `probed`, `ordinary`, `active`, `eligible {hot, cold}`, `deferredByRetry`, `retryExhausted`, `notQueued`, `noCandidates`. It holds no film id and no payload; without an active intent the answer is unchanged. `active` counts active rows, which still include satisfied intents (an intent ends itself without a write); a satisfied film that left the queue is counted in `notQueued`.

Not decided here: which films form the recovery cohort, any confirmation, canary or bulk operation (each stays a separate owner decision), `manifestSize`, `generationSize`, `submitBatchSize`, the intent TTL, the Scheduled Task prompts and schedules, and the retention of films outside admission.

## Alternatives considered

- **A second physical queue, runner or Task for recovery.** Rejected by the owner: more state, a second writer path and a second lease.
- **Longer intent TTL.** Rejected by the owner: it lengthens the starvation without ending it.
- **Absolute priority for all recovery films.** Rejected: it would let a large cohort starve the ordinary queue; a share is both bounded and non-zero.
- **Take the privilege from `queue.work.reason = recovery_intent`.** Not adopted: the queue stores `work` only for hot and watchlist films, so the cold catalogue films that are the main case have no entry. The stored pointer, read with the film, is the authority.
- **Let recovery films that also sit in the ordinary lane fill free ordinary slots.** Not adopted (review of the delivery pull request): it widens the approved cap.
- **Apply the share to the whole manifest including migration (migration share of `N`).** Not adopted: a recovery film is not migration work and the fraction of the ordinary slots stays the one ADR 0035 describes.

## Consequences

- Confirmed recovery films are selected in every manifest of `N >= 2` while they are eligible, independent of hot or cold, in the cohort's confirmation order, with at most 40% of a manifest.
- The ordinary queue loses at most the recovery quota per manifest, and only while eligible recovery films exist. With no active intent nothing changes.
- A recovery film in retry backoff or with an exhausted budget is still not selected; the diagnostics show it.
- A manifest of the same size may now differ between a dry run before and after a policy deploy; a comparison of a pre-deploy baseline and a post-deploy run (for example the S5 and S7 comparison of the standing experiment) must use the same policy version.
- At most 100 extra film reads per manifest for recovery probing (inside the unchanged 300-read bound); no new D1 read: the overlay is the one the freshness rule already reads.
- Recovery candidates beyond the quota wait for a later manifest, even when the ordinary queue is empty; a hot or cold recovery film is never selected twice in one manifest.

## Recovery and migration boundary

- No migration, no new D1 table or column, no R2 object, no flag, no Scheduled Task change. A code rollback restores the ordinary order; intent rows stay and the queue is unchanged.
- Merging and deploying change what the next natural Task run selects. That is a production runtime change: its rollout and the pairing with any running experiment need the owner's separate approval. This ADR authorizes no production operation, no confirmation and no run.

## Evidence

- **Original decision:** [AIR-577](https://trello.com/c/1fuEawPv).
- **Implementation:** the pull request of the card (`src/enrichment.js`, `src/prediction-recovery-intent.js`, `tests/prediction-recovery-slots.mjs`).
- **Dated verification:** not recorded (synthetic D1/SQLite and in-memory R2 tests only; no production read or write).
- **Uncertainty:** the real share of recovery films that win a slot depends on the live queue and is not measured here; the effect on the cohort is established only by a later owner-approved canary.

## Follow-ups

- [AIR-478](https://trello.com/c/IbsSCRce): the canary and the bulk, each with its own owner decision, after this policy is deployed.
