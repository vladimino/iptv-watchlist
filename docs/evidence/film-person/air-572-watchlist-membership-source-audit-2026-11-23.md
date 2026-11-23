# AIR-572: canonical Watchlist membership source/read/write audit

**Date:** 2026-11-23 (UTC)  
**Evidence type:** Repository-source audit and architecture decision record; **not** a production readback or an implementation.  
**Scope:** [AIR-572](https://trello.com/c/ugyHjnc4), [PR #934](https://github.com/vladimino/iptv-watchlist/pull/934).  
**Inspected baseline:** Executor's `main` at `e59d8fb` (2026-11-23), independently checked against the source files listed below. PR #934's initial reviewed HEAD was `0919514e`; its static producer delivery hold is not a membership fix.  
**Decision:** The Product Owner approved **option C**, a Letterboxd-owned, version-aware derived `watchlist_film` projection. This approves the direction, **not** the detailed race protocol, a PR merge, schema deployment, a D1 mutation, or producer activation. The decision is documented in the PR conversation.

## User-visible invariant

A successful four-slot Letterboxd Watchlist sync must be visible without waiting for the next daily EPG. `GET /api/watchlist` and `GET /api/programme` already source membership and order from the current authoritative Watchlist snapshot through `src/domain/watchlist-composition.js` and `src/worker.js::composeWatchlistRead`. A newly added member is composed with existing confirmed show rows of the pinned published EPG generation when its Letterboxd-to-TMDB identity is trusted. If no confirmed row can be joined, the member remains visible with `scheduleKnown: false` and no invented shows. Removing a member does not remove its canonical Film, its confirmed shows, its rating, or any reviewed fact.

This working read-time composition must be retained; the audit gap is **not** a missing four-slot membership update on the primary Watchlist screen. See `tests/watchlist-routes.mjs`, `tests/watchlist-composition.mjs` and [ADR 0186](../../adr/0186-letterboxd-sync-and-independent-watchlist-authority.md).

## Writer and reader map

| Data / path | Actual owner and source | Consequence |
| --- | --- | --- |
| `watchlist_current`, `watchlist_member`, `watchlist_change`, `watchlist_effect` | Letterboxd Sync publishes an ordered snapshot by version and the durable added/removed change rows | Source of truth for current membership and order; EPG reads a pinned copy |
| Published EPG `watchlist` document / member rows | EPG copies its start-time Watchlist pin into its own immutable published generation | Generation consistency, **not** current membership authority after another Letterboxd slot |
| `watchlist_film` (`inWatchlist`) | Existing canonical EPG Producer writes `film_facts.watchlist=true/false` and departed membership from its EPG-sealed Watchlist; PR #934 holds both Producer entrypoints by default | Only active source of this canonical membership projection prior to the approved change; a late Producer pass can restore stale membership |
| Identity merge / redirect | Canonical mutation code can transfer existing membership when consolidating Film identity | Maintenance of ownership, not a second incoming Watchlist source |
| Old `canonical-repository.js` projector | No live source callsite established by the executor's code search | Historical path; do not count it as a live authoritative writer without fresh evidence |
| Letterboxd `scan_facts`, `retention`, `removal_enqueue` | Existing independent effect writers update facts, `film_retention`, and Ratings removal queue | **None** currently projects canonical `watchlist_film` membership |
| Film admission | Resolves trusted identity for new lids, bounded and asynchronous | Deliberately does not write canonical Watchlist membership today |
| `src/catalog-d1.js` | Reads `watchlist_film` for film `inWatchlist`, watchlist/catalog surfaces and co-credit person selection | May lag a newly committed Watchlist snapshot |
| `src/canonical-read-model.js` | Reads `watchlist_film` for `inWatchlist` | Same lag |
| `GET /api/watchlist`, `GET /api/programme` | Read-time composition of current Watchlist membership and pinned EPG confirmed shows | Already current at each completed Watchlist sync; do not duplicate or change |

**Identified inconsistency:** `watchlist_film` can lag `watchlist_current` even while primary Watchlist reads are correct. A Producer pass based on an earlier EPG generation can also regress the projection. Reopening Producer on EPG `P:g` alone cannot provide four Watchlist updates per day (`src/canonical-producer-chain.js::reopenChain`).

## Alternatives considered

- **A: Daily EPG-derived membership with a snapshot guard.** Rejected by the owner: bounded stale data until the next EPG is not the expected product behavior.
- **B: Producer reads the current Watchlist snapshot when planning.** Rejected as a complete solution: a current plan is still triggered by EPG generation and does not refresh after every Letterboxd slot.
- **C: Derived membership projection from Letterboxd Sync. APPROVED DIRECTION.** Reuse versioned, durable Watchlist changes, canonical Film identity resolution and the existing fenced writers. Stop the EPG Producer from issuing membership mutations in D1 mode, including departed release and receipt replay. Retain the Producer's unrelated Film, Person and credit responsibilities.
- **D: Remove the projection and compute canonical membership from the current Watchlist on read.** Deferred: it would change multiple D1 reader queries and identity joins, with unmeasured impact in the presence of the prior D1 read-cost incident.

## Proposed design boundary for option C

The executor proposed one additional `membership` effect in `watchlist_effect`, handled by the existing four-slot Letterboxd Sync rather than by another Workflow, cron or Task. The input is the durable `watchlist_change` rows of a version, not a diff reconstructed later. Only verified canonical Film owners may be updated; use the canonical `writeFilmFacts` path with `requireExisting: true`, stable request/receipt identity, and in-batch trusted-claim/redirect guards. No Film is created from title/year guesses or a bare lid. An unresolved lid remains in the durable admission inventory and must be reconciled against **current** membership after identity is verified. A removal changes membership only.

The following are **implementation design issues**, not yet accepted solutions:

1. **Protect the independent scan cadence.** `src/letterboxd-sync-watchlist.js::run` drains causal effects *before* the next scan; a pending or failed fourth effect can block subsequent successful four-slot scans. A missing Film, ambiguous claim, unavailable canonical writer or exhausted projection budget must not silently make the Watchlist authority unusable. Specify bounded nonblocking handling of unresolved entries, retry/degraded observability, and what a successful `committed` snapshot means while the projection is catching up. Do not disguise failed projection as completed delivery.
2. **Prove concurrent-version safety.** `watchlist-d1.js::publishSnapshot` does not assert `effects_drained_version=version` in the changed-snapshot promotion batch. Normal workflow predrain does not alone prove that another publication cannot occur while an older effect writes. A single in-batch `watchlist_current.version = V` condition would reject legitimate late V writes after V+1 and could leave a pending effect stuck forever. Define monotonic per-version/per-Film semantics or a safe reconciliation to the latest snapshot and test added/removed/re-added identities and write-versus-promotion races.
3. **Account for schema and resource caps.** `migrations/0031_watchlist_authority.sql` restricts the effect discriminator via a `CHECK` of exactly `scan_facts`, `retention`, `removal_enqueue`; `src/watchlist-d1.js::EFFECTS`, `pendingEffects`, `completeEffect`, and the `letterboxd-sync-repository.js::drainEffects` eight-iteration budget assume that set. A new effect requires a forward migration and coordinated expand/deploy sequence, not a JavaScript-only change. Use the next free migration number from current main and a separate authorized D1 apply.
4. **Keep the writer single and recovery durable.** The EPG Producer must stop both positive and negative membership writes in D1 mode, including delayed batches and receipt replay, before or atomically with enabling the new source. Do not remove its Film, Person or credits maintenance. Identity merge/redirect remains a guarded ownership transform. Late admission after the corresponding snapshot effect has been completed needs its own idempotent current-membership handoff; it must not wait for tomorrow's EPG.
5. **Reconcile pre-existing drift.** Plan a bounded, resumable baseline comparison/backfill from the authoritative current snapshot into canonical `watchlist_film`, using trusted claims, without dropping retained Film facts and without operating production absent the owner's specific GO.
6. **Keep show semantics unchanged.** Confirmed shows are attached by the existing read-time composition. Adding a member does not retroactively create an EPG match that was never confirmed. Additional `unknown` reason labels are optional diagnostics, not prerequisites to correct membership.

### Acceptance evidence for future implementation

Tests must cover existing/new/removed/re-added lids; trusted identity and collision/redirect races; unknown versus already-confirmed shows; admission after snapshot promotion; two overlapping Watchlist versions and a failure/restart between the writer batch and receipt; EPG `P:g` rollover and a late Producer pass; successful next Letterboxd slot despite an unresolved Film; no shadow Films or deletion of ratings/credits/metadata; and `catalog-d1` / `canonical-read-model` parity. Use bounded D1 reads and writes and measure the actual changed-row and batch costs. Monitor projection lag separately from the freshness of the authoritative snapshot.

## Delivery and decision boundaries

This is a source audit, **not** implementation. Preserve [ADR 0186](../../adr/0186-letterboxd-sync-and-independent-watchlist-authority.md) as accepted history. Create a new numbered ADR documenting option C, the rejected alternatives, precise version/replay/identity semantics and rollout. Record the explicit owner option-C decision in that ADR and its registry row with a direct durable link. Implement the membership effect, schema evolution and any authorized one-time reconciliation as independently closeable integration work; avoid expanding the P1 scope of [AIR-572](https://trello.com/c/ugyHjnc4), which covers Producer RPC repair, identity safety and monitoring. [PR #934](https://github.com/vladimino/iptv-watchlist/pull/934) retains its static default-DENY Producer delivery hold until a separately authorized activation change.

Source of the initial source/read/write map: [AIR-572 executor report](https://trello.com/c/ugyHjnc4#comment-6b042fab829c5b9783e44891). Independent design caveats: [AIR-572 coordinator review](https://trello.com/c/ugyHjnc4#comment-6b0434199f6a574025adee36). No live data mutation, Workflow invocation, D1 migration or production acceptance was performed for this report.
