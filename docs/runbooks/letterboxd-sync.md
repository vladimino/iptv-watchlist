# Letterboxd Sync runbook

The Letterboxd Sync Workflow runs one slot at 04:30, 10:30, 16:30 and 22:30 Europe/Madrid: Diary and Ratings, a complete Watchlist scan, then removal reconciliation, and writes exactly two Events per slot (`ratings`, `watchlist`). Design: [ADR 0186](../adr/0186-letterboxd-sync-and-independent-watchlist-authority.md); control plane: [scheduling and orchestration](../architecture/scheduling-and-orchestration.md); tables: [D1 schema](../reference/data/d1-schema.md).

## State today

The code is dormant. With the mode table empty or `external` nothing is created, no cron or binding exists, and the legacy Ratings writer and the EPG Watchlist fetch are unchanged. **Nothing on this page is authorized by a deploy or a green test run.** Every production step below is a separate owner-approved operation (L3).

## Observing (read-only)

- `status().letterboxdSync` of the Ratings status and the `letterboxd` monitor stream (the read model: mode, epoch, current and next slot, overdue slots, per-source `lastSuccessAt`, health, pending Events). Both are absent while no mode row exists. They write nothing.
- A slot row's `status` and its three outcomes; a pending `letterboxd_slot_event` row means an Event is owed, not that the scan failed.
- `late`: a due slot was never claimed (the `:30` tick did not run or `ensure` is refusing). `stalled`: an earlier slot is still unclosed after its own window ended. `missed`: a slot was recorded `skipped_missed`. `failed`: the last closed slot errored in both sources. `watchlist_stale`: no complete scan for 24 hours; `watchlist_never_succeeded`: none at all since the executor started 24 hours ago.

## Activation order (for the cutover plan, not performed here)

1. Apply the migration `0033_letterboxd_sync_control.sql` (schema 33, after `0031` and `0032`, both applied). The owner-run operator is `node scripts/letterboxd-sync-control-production.mjs --target iptv` (read-only `status` by default); `--apply --target iptv --confirm apply` makes one atomic batch and an independent readback, and needs its own owner GO. The mode table stays empty.
2. The handover proof is read from live state by `letterboxdHandover`: the Ratings executor is closed and drained, the legacy `ratings_sync_start` and `ratings_sync_step` entry is fenced (true while the Letterboxd mode is `switching`), the Watchlist authority is an open `d1`, and the three phase ports exist. `complete` refuses with `handover_not_proven` and the list of what is missing until all hold. The switch has no HTTP route yet; the cutover plan names how it is invoked.
3. `close_admission` with target `cloudflare` (the epoch moves and the legacy Ratings entry is fenced at once), then `complete` once the drain is verified.
4. Add the Workflow binding and the `30 * * * *` cron in the deployment that the cutover approves; observe the first slot, never force one.

## Holdpoint (c): the bootstrap import (prepared, not performed)

The operator `scripts/watchlist-bootstrap-production.mjs` imports the current published watchlist into snapshot version 1 while the Watchlist marker is still `epg` ([ADR 0186](../adr/0186-letterboxd-sync-and-independent-watchlist-authority.md) decision 8.2(c)). It is an import, not a scan: one atomic D1 batch writes the staging row, the ordered member rows, the snapshot row and the pointer, and nothing else (no change, effect or pending-admission row, no fact, no marker move). It needs its own owner GO and the prerequisite O4 (the EPG checkpoint cutover verified by a natural EPG run).

- **Read-only first:** `node scripts/watchlist-bootstrap-production.mjs --target iptv` (`status`, the default) prints the decision (`ready` or the refusal), the marker, the pointer, the published generation and its certificate, and the source count and digest. It writes nothing.
- **Pins.** The owner reads `GET /api/watchlist` (Access-protected) at the same generation and derives the count and the digest of the ordered list: SHA-256 of the lines `ordinal<TAB>id<TAB>title<TAB>year<TAB>url<NEWLINE>` (`year` empty when absent, ordinal from 0). `bootstrap` refuses unless the run id, the count and the digest equal the stored source (`pin_mismatch`).
- **The write:** `node scripts/watchlist-bootstrap-production.mjs --bootstrap --target iptv --confirm bootstrap --expect-run <programmeRunId> --expect-count <n> --expect-sha256 <digest> [--expect-epg-generation <n>]`.
- **Preflight (fail closed):** the marker is `epg`, writes `open`; the pointer is version 0 with no snapshot; every watchlist table is empty; the published generation is `d1`/`open` and certified complete (`finalized_run_id` equals `programme_run_id`) and equals the pin; the source normalizes (unique ids, shape, order) and its member rows agree with the document; no executing EPG step.
- **Readback (independent):** pointer version 1 with the snapshot id, digest, count and `effects_drained_version` 1; one staging and one snapshot row, the pinned number of members, zero change, effect and admission rows; the member rows in order reproduce the digest; the marker is unchanged; the published generation did not move; the stable fields (mode, cutover, writes) of the other domains are unchanged (live counters are never compared). A Time Travel bookmark is read before and after.
- **Stop conditions:** any refusal changes nothing. A transport or unproven outcome is `write_uncertain` (writeState `unknown`, `retry:false`) even when the readback looks untouched; only a proven rejected statement with an untouched readback is `statement_failed`. Nothing is retried or repaired without a separate GO. An equal import answers `already_applied` and writes nothing; a different one is refused.
- **Rollback:** none by code. The snapshot is inert while the marker is `epg`; there is no delete path (immutability triggers). A wrong import is handled by the owner-approved data procedure, not by this operator.

## Rollback

Close admission with target `external` and complete: the epoch moves, a stale instance is refused, and exactly one legacy Ratings writer is admitted again. Code rollback does not revert D1 rows, slots, outbox rows, the mode row or Events already written.

## Do not

Do not delete or edit a slot or outbox row to "retry" it; do not start a slot manually; do not set the Ratings mode to `external` and call that a fence. A pending Event is delivered by `ensure` and by the next run.

The dated read-only preflight, the gap analysis and the proposed holdpoints of the production cutover are in the [cutover GO/no-GO package](../evidence/d1-migration/air-571-go-no-go-package-2026-11-21.md). It authorizes nothing: every holdpoint needs its own owner GO.
