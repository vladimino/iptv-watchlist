# Letterboxd Sync runbook

The Letterboxd Sync Workflow runs one slot at 04:30, 10:30, 16:30 and 22:30 Europe/Madrid: Diary and Ratings, a complete Watchlist scan, then removal reconciliation, and writes exactly two Events per slot (`ratings`, `watchlist`). Design: [ADR 0186](../adr/0186-letterboxd-sync-and-independent-watchlist-authority.md); control plane: [scheduling and orchestration](../architecture/scheduling-and-orchestration.md); tables: [D1 schema](../reference/data/d1-schema.md).

## State today

The code is dormant. With the mode table empty or `external` nothing is created, no cron or binding exists, and the legacy Ratings writer and the EPG Watchlist fetch are unchanged. **Nothing on this page is authorized by a deploy or a green test run.** Every production step below is a separate owner-approved operation (L3).

## Observing (read-only)

- The read model of `LetterboxdSync.readModel` (mode, epoch, current and next slot, per-source `lastSuccessAt`, health, pending Events). It writes nothing.
- A slot row's `status` and its three outcomes; a pending `letterboxd_slot_event` row means an Event is owed, not that the scan failed.
- `late`: a due slot was never claimed (the `:30` tick did not run or `ensure` is refusing). `stalled`: a slot is unclosed past its window. `missed`: a slot was recorded `skipped_missed`. `failed`: the last closed slot errored in both sources. `watchlist_stale`: no complete scan for 24 hours.

## Activation order (for the cutover plan, not performed here)

1. Apply the migration (preflight, one apply, readback). The mode table stays empty.
2. Prove the handover: the Ratings writer is closed and drained, the legacy `ratings_sync_start` and `ratings_sync_step` entry is fenced, the Watchlist repository is ready and the ratings phase port is supplied. `complete` refuses with `handover_not_proven` and the list of what is missing until all four hold.
3. `close_admission` with target `cloudflare` (the epoch moves and the legacy Ratings entry is fenced at once), then `complete` once the drain is verified.
4. Add the Workflow binding and the `30 * * * *` cron in the deployment that the cutover approves; observe the first slot, never force one.

## Rollback

Close admission with target `external` and complete: the epoch moves, a stale instance is refused, and exactly one legacy Ratings writer is admitted again. Code rollback does not revert D1 rows, slots, outbox rows, the mode row or Events already written.

## Do not

Do not delete or edit a slot or outbox row to "retry" it; do not start a slot manually; do not set the Ratings mode to `external` and call that a fence. A pending Event is delivered by `ensure` and by the next run.
