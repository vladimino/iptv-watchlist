# EPG run certificate migration 0026: owner GO, apply preconditions, readback and rollback contract (not applied)

**Status:** the migration file and the code are in the repository ([AIR-539](https://trello.com/c/2eYDrWBS), [ADR 0175](../adr/0175-epg-priority-holds-until-run-complete.md), Accepted). `0026` is **not applied** to production D1 `iptv`. Applying it is a separate, action-specific owner GO; a merge, a deploy or the acceptance of ADR 0175 is not that GO.

## What the migration is, and is not

- One file: a refuse-insert unless the schema is a complete version 25 with `published_epg_authority`, `discovery_epg_priority`, `epg_orchestration_document` and `film_retention_scan`; then `ALTER TABLE published_epg_authority ADD COLUMN finalized_run_id TEXT` and `finalized_at TEXT` (both NULL); version 26.
- It writes no row and moves no pointer, pin, marker or pause row. It does not publish, certify or clear anything.
- **The invariant is not active on code deploy alone.** With the columns absent the Worker keeps the ADR 0135 behaviour (the pause lifts at the pointer). It is active from the apply, once the new code is the deployed version.

## Preconditions (checked before the owner GO is used)

1. `SELECT version FROM schema_contract WHERE id = 1` is 25, and `main` contains `PublishedEpg.certifyRun` and `EpgOrchestration.certifyComplete` (the code ships first, dormant).
2. Read-only preflight of the deployed version: the deployed Worker is the one that contains the certificate code, and no gradual rollout or older instance is live. An older Worker would lift the pause at the pointer and never certify.
3. No EPG run is in flight: `epg_status` shows no live `seal` step lease, and it is not between 16:55 and the publication of the day (apply outside the daily EPG window).
4. The signed GO names the live git blob of the file on `main`, the production D1 id and the exact statement (one execution).

## Readback after the apply

`SELECT version, note FROM schema_contract WHERE id = 1` is 26 with the v26 note; `SELECT finalized_run_id, finalized_at FROM published_epg_authority WHERE id = 1` is `NULL, NULL`; the pointer, `madrid_run_key`, the Discovery pin and the pause row are unchanged.

## What happens right after the apply

The columns are present, so "published for the day" now needs `finalized_run_id = programme_run_id`. The run that is already published has no certificate, so a new Discovery chunk is refused as `epg_priority` / `awaiting_complete` until the next hourly `ensure` runs `certifyComplete` and certifies that completed run from `sync.json`. This is expected, bounded by one hourly tick, and is not a failure. The EPG role is not affected. Confirm in the first tick after the apply that the certificate was written (`finalized_run_id` equals `programme_run_id`).

## Natural-run acceptance (no manual run)

On the first natural EPG after the apply: the pointer batch leaves the pause closed and resets the certificate; Discovery waits as `awaiting_complete`; the run reaches `stage=complete`; the certify batch writes `finalized_run_id`, clears the pause and Discovery resumes on the new generation. Record the separate times (pointer publish, complete, certificate, first admitted chunk), the `holderKind`/`waitMs`/`sealPhase` of any `seal_busy`, and `scanOutcome`. Do not run EPG, Discovery, a lease reset or a Task to speed this up.

## Rollback contract after the apply

- A code revert to a Worker that does not know the columns is **allowed only as an owner-approved step**: schema-compatible, but it lifts the pause at the pointer again and never certifies. Starvation risk returns; there is no data risk. Detection: pointer published, pause row `clear`, `finalized_run_id` not equal to `programme_run_id` (see the [monitoring runbook](monitoring.md)).
- Rolling forward again certifies a run an old Worker left uncertified, through the `certifyComplete` repair; the owner override is the backstop for a stuck pause.
- A rollback of the migration itself (dropping the columns, lowering the version) is not provided: `schema_contract_no_downgrade` forbids it. A stuck pause is cleared by the owner override, not by a lease reset or a TTL.
- Any data repair, override, hold or re-apply is a separate owner GO.
