# Watchlist authority in D1: states, read-only checks and boundaries (live: `d1`/`open`)

Status: **live.** [ADR 0186](../adr/0186-letterboxd-sync-and-independent-watchlist-authority.md) (Accepted) makes the Watchlist its own D1 authority behind `watchlist_authority`. Since the staged activation of 22 and 23 November 2026 the marker is `d1`, `open`, generation 3: the Letterboxd Sync Workflow writes the snapshot and the EPG run reads the last-good snapshot instead of fetching Letterboxd ([bootstrap and switch evidence](../evidence/d1-migration/air-571-watchlist-bootstrap-and-activation-2026-11-22.md), [activation evidence](../evidence/d1-migration/air-571-letterboxd-sync-activation-2026-11-22-23.md)). This page describes the states and the read-only checks and **authorizes no operation**: any change of the marker, the bootstrap, a rollback or a re-activation is a separate owner L3 operation with its own pins. Code rollback reverts none of the data.

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
