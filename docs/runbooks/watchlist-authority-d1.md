# Watchlist authority in D1: states, read-only checks and boundaries (dormant)

Status: **schema installed, activation dormant.** [ADR 0186](../adr/0186-letterboxd-sync-and-independent-watchlist-authority.md) (Accepted) makes the Watchlist its own D1 authority behind `watchlist_authority`. `migrations/0031_watchlist_authority.sql`, the repository `src/watchlist-d1.js`, the read composition and the EPG snapshot pin are in the repository ([AIR-569](https://trello.com/c/yaXv2oj6)); **the migration `0031` is installed in production D1 (21 Nov 2026, [evidence](../evidence/d1-migration/air-571-0031-apply-2026-11-21.md)) with the marker `epg` generation 0 `open`, the pointer at version 0 and no snapshot; the Worker still serves the membership from the EPG generation, and this page authorizes no operation.** The bootstrap import (snapshot version 1), the marker switch to `d1`, the handover from the Ratings writer, the Letterboxd Workflow and its cron are separate owner L3 operations under [AIR-571](https://trello.com/c/b6UrtwUG); the Workflow is [AIR-570](https://trello.com/c/JSXgFWzp). Code rollback reverts none of the data.

## What the Worker does in each state

| State | How it is seen | Behavior |
| --- | --- | --- |
| Tables absent, `schema_contract` below 31, or no D1 binding | no `watchlist_%` table | Today's behavior: the generation's `watchlist` document is the membership and the EPG run fetches Letterboxd. |
| Marker `epg` (writes `open` or `held`) | `SELECT mode, generation, writes FROM watchlist_authority` | The same as above. The repository serves and writes nothing. |
| Marker `d1`, writes `open` | same | The snapshot is the only membership. The EPG run copies one snapshot and makes no Letterboxd request. Readers compose snapshot membership with the generation's show rows. |
| Marker `d1`, writes `held` | same | Readers and the EPG run refuse (`watchlist_writes_held`, a typed 503); no fallback to the EPG generation and no mirror answer. The marker is read fresh at every request and re-checked before the answer. |
| Anything else | version 31 without the tables, a deleted or unknown marker, a missing fence row, an unreadable schema | **Closed**: refused (`watchlist_authority_closed`), never read from the EPG generation or R2. |

## Read-only checks (L0, `SELECT` only)

```sql
SELECT mode, generation, writes, (SELECT COUNT(*) FROM watchlist_cas) AS fence_rows FROM watchlist_authority;
SELECT version, snapshot_id, film_count, list_sha256, last_success_at, last_attempt_at, last_attempt_outcome, effects_drained_version, revision FROM watchlist_current;
SELECT version, snapshot_id, film_count, observed_at, committed_at, prev_version FROM watchlist_snapshot ORDER BY version DESC LIMIT 8;
SELECT s.version, e.effect, e.status, e.attempts FROM watchlist_effect e JOIN watchlist_snapshot s USING (snapshot_id) WHERE e.status = 'pending' ORDER BY s.version;
SELECT COUNT(*) AS staged_not_promoted FROM watchlist_staging WHERE snapshot_id NOT IN (SELECT snapshot_id FROM watchlist_snapshot);
SELECT state, COUNT(*) AS n FROM watchlist_admission_pending GROUP BY state;
```

Staged rows of an attempt that was never promoted are garbage of an interrupted scan; the next promotion removes those older than 30 minutes. A current pointer with a digest or count that does not match its member rows is `malformed`: readers and the EPG run refuse it and never serve a shortened list.

## Codes

| Code | Meaning | Action |
| --- | --- | --- |
| `watchlist_snapshot_absent` | marker `d1`, version 0 | The bootstrap import was not done. Stop; do not fall back to the EPG generation. |
| `watchlist_unavailable` | D1 fault, or a snapshot that fails its count/digest check | Read-only investigation first; never repair by hand. |
| `watchlist_writes_held` / `watchlist_authority_closed` | hold fence, or a contradicting marker state | Owner procedure only. |
| `storage_unavailable` / `watchlist_unavailable` (HTTP 503) | a temporary D1 fault with no eligible standalone Watchlist mirror, on `/api/watchlist`, `/api/programme` and `/api/catalog/available` | Typed refusal; never a generic 502 and never membership from a programme. |
| `watchlist_authority_moved` | the marker (state, writes or generation) changed between the read and the response | A retryable 409; the next request sees the new state. |
| `effects_pending` (repository) | a no-op scan found undrained causal effects | The Workflow drains them oldest version first and then advances success (AIR-570). |
| `admission_ledger_full` | `watchlist_admission_pending` at its cap | A visible hold, never a silent drop. Owner action on the pending ids. |

## Boundary

The EPG run of a `d1` cutover carries `watchlistSnapshot` and skips the scan, retention, removal hand-over and `watchlist` Event; a run created before a cutover finishes with today's tail because the decision is keyed on the run, not on the marker. With the marker `d1` the EPG no longer writes or compares the root `watchlist.json` mirror (a regression test pins it); the writer of that mirror, the Events and the Workflow stay with AIR-570 and AIR-571. A pinned run starts at the `epg` stage and never calls Letterboxd, and the prediction queue reads the current snapshot membership.

## Membership projection (schema 37, ADR 0203)

[ADR 0203](../adr/0203-watchlist-membership-letterboxd-single-writer-projection.md) is **Accepted** (contract A, [owner decision](https://trello.com/c/AdLQvzMe#comment-6b0482797e0ba3ff7c178da7)), but the code remains dormant until a separately authorized activation. **This runbook authorizes no operation.** Every step below needs its own operation-specific owner GO.

**Read-only checks (`SELECT` only).**

```sql
SELECT mode, generation, baseline_version FROM watchlist_membership_authority;      -- who writes watchlist_film
SELECT version, effects_drained_version FROM watchlist_current;                    -- drained = equal
SELECT state, COUNT(*) AS n FROM watchlist_membership_handoff GROUP BY state;      -- pending / settled / terminal
SELECT effect, status, COUNT(*) AS n FROM watchlist_effect GROUP BY effect, status; -- membership appears only in sync mode
SELECT COUNT(*) AS fenced FROM watchlist_film_fence;
```

**Sequence (each step is a separate GO; deploying the code performs none of them).**

1. Migration `0036`, then `0037` (marker `producer`, generation 0). Until the switch the Worker behaves as before: three effects per promotion, the EPG Producer (held by `PRODUCER_DELIVERY_HOLD`) owns membership.
2. Baseline: `membershipBaseline(...).dryRun` (read only: counts of add, remove, keep and unresolved), then `apply` repeatedly (25 Film changes per call, idempotent) until it records `baseline_version` equal to the current version. It refuses while effects of the current version are pending and writes membership only, never a Film, claim, show or rating. A new promotion invalidates the proof: rerun.
3. Switch: `activateMembershipSync` (guarded: marker `producer` at the expected generation, proof equal to the current drained version). The Producer must be held and have no non-terminal chain at that moment. It is roll-forward; there is no switch back here.
4. The hold lift is a separate, narrow PR of [AIR-572](https://trello.com/c/ugyHjnc4) with its own GO.

The production operator that wires `dryRun`, `apply` and the switch to an owner-only route is **not** part of this change (a follow-up card). When a step fails: `effects_pending` means drain first; `conflict` on the switch means the proof is stale or the generation moved, so re-read; a `terminal` handoff row means an id with no trusted Film after the bounded attempts and needs the baseline operator or an owner decision. Nothing here deletes a Film.
