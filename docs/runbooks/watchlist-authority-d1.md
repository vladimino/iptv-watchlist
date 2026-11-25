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
| ledger row `terminal` (AIR-599) | the shared check's attempt cap (six `gone`/`definite` outcomes; transport failures never count), or `owner_dismissed`; rows written before AIR-599 may say `age_exceeded` | Owner review on `/admin/identity` (lanes `watchlist_admission` and `diary_identity`); `requeue` or `dismiss` through [`POST /api/admin/identity-work/owner-action`](../reference/api/admin.md#owner-requeue-and-dismiss-of-the-shared-letterboxd-check-post-apiadminidentity-workowner-action). A bulk recovery of legacy rows is an L2 contract naming the ids (card DR), never a manual SQL reset. |
| `letterboxd_admission_overdue` with unknown age (AIR-599) | a legacy ledger row whose first-seen snapshot was pruned before AIR-599 | Reported, never terminated. Owner review on `/admin/identity`; the legacy report lists them. New rows keep their snapshot header, so they cannot become unknown. |
| `diary_cap` / backlog (AIR-599) | the 200-entry Diary check document holds no evictable entry | Not now: the id waits in the backlog and enters first when a place returns; Monitor `letterboxd_identity_cap_refused`. Free places by resolving or dismissing entries, never by deleting the document. |

## Boundary

The EPG run of a `d1` cutover carries `watchlistSnapshot` and skips the scan, retention, removal hand-over and `watchlist` Event; a run created before a cutover finishes with today's tail because the decision is keyed on the run, not on the marker. With the marker `d1` the EPG no longer writes or compares the root `watchlist.json` mirror (a regression test pins it); the writer of that mirror, the Events and the Workflow stay with AIR-570 and AIR-571. A pinned run starts at the `epg` stage and never calls Letterboxd, and the prediction queue reads the current snapshot membership.

## Membership projection (schema 37, ADR 0203)

[ADR 0203](../adr/0203-watchlist-membership-letterboxd-single-writer-projection.md) is **Accepted** (contract A, [owner decision](https://trello.com/c/AdLQvzMe#comment-6b0482797e0ba3ff7c178da7)). Activation was performed step by step with owner GOs on 23 Nov 2026 UTC (production record under step 4): membership is written by the Letterboxd Sync (marker `sync`, generation 1), and the Producer runs again once the AIR-572 hold lift is deployed. **This runbook authorizes no operation.** Every step below needs its own operation-specific owner GO.

**Read-only checks (`SELECT` only).**

```sql
SELECT mode, generation, baseline_version FROM watchlist_membership_authority;      -- who writes watchlist_film
SELECT version, effects_drained_version FROM watchlist_current;                    -- drained = equal
SELECT state, COUNT(*) AS n FROM watchlist_membership_handoff GROUP BY state;      -- pending / settled / terminal
SELECT effect, status, COUNT(*) AS n FROM watchlist_effect GROUP BY effect, status; -- membership appears only in sync mode
SELECT COUNT(*) AS fenced FROM watchlist_film_fence;
```

**Sequence (each step is a separate GO; deploying the code performs none of them).**

1. Migration `0036`, then `0037` (marker `producer`, generation 0) through the owner-only operator `scripts/watchlist-membership-0037-production.mjs` ([runbook](watchlist-membership-0037-apply.md)). Until the switch the Worker behaves as before: three effects per promotion, the EPG Producer (held by `PRODUCER_DELIVERY_HOLD`) owns membership.
2. Baseline: `membershipBaseline(...).dryRun` (read only: counts of add, remove, keep and unresolved; `--baseline-dry-run` of the migration operator, or `mode: baseline_dry_run` of the MCP tool below), then `apply` repeatedly through the owner-only MCP tool `watchlist_membership_operator` (`mode: baseline_apply`, `confirmGo: true`, `expectedVersion`, `expectedMarkerGeneration` from `mode: status`) (25 Film changes per call, idempotent) until it records `baseline_version` equal to the current version. It refuses while effects of the current version are pending and writes membership only, never a Film, claim, show or rating. A new promotion invalidates the proof: rerun.
3. Switch: `activateMembershipSync` through the same tool (`mode: switch`; guarded: marker `producer` at the expected generation, proof equal to the current drained version; the tool also refuses unless the Producer delivery hold is on and no Producer chain is non-terminal, i.e. pending, active, released, or stopped with a recoverable class). The Producer must be held and have no non-terminal chain at that moment. It is roll-forward; there is no switch back here.
   A chain that stays open under the hold blocks this step (`producer_chain_open`): with the hold on, the hourly reconcile returns before it supersedes the chain of a run that is no longer published. Close it first with the owner-only MCP tool `producer_chain_operator` ([MCP reference](../reference/api/mcp.md)), a separate GO per chain: `mode: status` (read only) lists the open chains with `eligible` or a `reason` and the `expect` pins; `mode: supersede` with `confirmGo: true`, `expectedProgrammeRunId` and `expectedRevision` makes exactly the reconcile's transition through the existing `supersedeChain` (Film/Person marker fence, revision CAS, one row). Its batch also pins the published run and generation it read. It refuses with `writes: 0` while the hold is off, for the chain of the published run (`current_published_run`, that one belongs to the reconcile after the hold lift), while an owner lease is live (`lease_live`), when the revision moved (`revision_moved` or `producer_cas_lost`: re-read) and when a publication landed between its read and its write (`published_moved`: re-read). HTTP 202 `write_uncertain` or `readback_unproven` (`writes: null`) means the outcome is not proven: do not repeat blindly; call `status` (and `watchlist_membership_operator` `status`) and, only if the chain is still listed, repeat with the fresh pins (the revision CAS admits at most one transition). Readback: the chain is `superseded` at revision + 1, `nonTerminalChains` of `watchlist_membership_operator` `status` is 0, and no run, receipt, Film or Watchlist row changed. There is no rollback and none is needed: `superseded` is terminal and is what the reconcile itself would write; after the hold lift the reconcile launches a fresh chain for the published run.
4. The hold lift is a separate, narrow PR of [AIR-572](https://trello.com/c/ugyHjnc4) with its own GO. After it deploys, the next hourly reconcile supersedes chains of runs that are no longer published and launches the chain of the published run, so the owner path of step 3 is no longer needed and `producer_chain_operator` `supersede` refuses with `producer_not_held` (its `status` still reads).

**Production record (23 Nov 2026 UTC):** steps 1 to 3 are done (stale chain superseded, baseline recorded at version 4, marker `sync` generation 1); [evidence](../evidence/d1-migration/air-572-membership-switch-2026-11-23.md).

The migration operator ([runbook](watchlist-membership-0037-apply.md)) and the owner-only MCP tool `watchlist_membership_operator` ([MCP reference](../reference/api/mcp.md)) exist. The tool runs inside the Worker, reads the Letterboxd Sync epoch (`letterboxd_sync_mode`, mode `cloudflare`) and passes it to the same fence the effects use, so a mode change between its read and a write fails the batch. Nothing calls it but the owner, and each production use needs its own GO; after the switch only `status` and `baseline_dry_run` remain useful (both read only). When a step fails: `effects_pending` means drain first; `conflict` on the switch means the proof is stale or the generation moved, so re-read; a `terminal` handoff row means an id with no trusted Film after the bounded attempts and needs the baseline operator or an owner decision. Nothing here deletes a Film.
