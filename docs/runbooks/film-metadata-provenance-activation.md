# Film metadata provenance: activation (`off → enforce`) and hold (`enforce → hold`)

[AIR-636](https://trello.com/c/0jJADYxg) (card PVE) · [ADR 0214](../adr/0214-film-metadata-per-field-provenance.md) decisions 11, 13 and 15 · language policy [ADR 0224](../adr/0224-russian-first-catalog-metadata.md).

**Nothing on this page authorizes a production operation.** Every transition below is an owner L3 production operation with its own GO and readback ([authorization](../process/authorization-and-escalation.md)). This page is a contract, not a status: read the present mode, revision, version and run state live. The dated preflight is in [evidence](../evidence/film-person/air-636-provenance-enforce-preflight-2026-11-28.md).

## What the control is

One durable row, `film_metadata_provenance_control(id = 1, mode, revision, updated_at, updated_by)`, created by migration `0049` at `off`. Triggers allow only `off → enforce`, `enforce → hold` and `hold → enforce`, each raising `revision` by exactly one; a return to `off` is impossible (`film_metadata_provenance_one_way`, `film_metadata_provenance_transition`). There is **no operator script and no flag**: the mode is not in the feature-flag registry. The transition is one `UPDATE` of this row.

## Preflight (read-only, all of it before asking for the GO)

Run every item live, on the day of the flip, and record the values in the evidence file. Use `SELECT` only.

1. **Schema.** The five tables `film_metadata_field`, `film_metadata_history`, `film_metadata_owner_command`, `film_metadata_owner_release` and `film_metadata_provenance_control` exist (schema 49 or later; `0053` is the other-language revision).
2. **Control row.** `SELECT id, mode, revision, updated_at, updated_by FROM film_metadata_provenance_control` returns exactly one row with `mode = 'off'`. Record the `revision`; the transition asserts it.
3. **Release rows empty.** `SELECT count(*) FROM film_metadata_owner_release` is 0.
4. **Deployed version.** The newest Worker deployment (`GET /accounts/{id}/workers/scripts/iptv/deployments`, read-only) is one version at 100 %, and that version was built from a `main` commit that contains PV1 (AIR-631), PV2 (AIR-633) and PV3 (AIR-634). Record the version id, its creation time and the commit.
5. **Drain** (the ADR 0207 A2 pattern; a deployed version does not prove that an older in-flight batch cannot commit later):
   - the version of item 4 has served at 100 % **longer than the longest unit or Workflow step bound**; every new deployment restarts this clock, so check again right before the GO;
   - no Workflow instance and no producer unit of an older version is running: `epg_pipeline_status` shows the Discovery executor `phase: stopped` and the programme run `complete`, and `canonical_producer_chain.owner_state` of the newest row is `complete` with no live lease;
   - no unsettled receipt planned by an older version: the Producer run's `open_at_completion` is 0 and `n_failed` is 0, and `SELECT count(*) FROM canonical_write_receipt WHERE state IN ('pending', 'failed', 'unknown')` is 0 (a receipt `applied` or `abandoned` is settled);
   - the C1 enrichment producer's state: `catalog_enrichment_control` and its newest run, read with `GET /api/admin/settings` or `SELECT`. An empty `catalog_enrichment_control` means C1 is not activated, so there is no C1 unit in flight.
6. **Quiet window.** Pick a time outside the daily EPG commit and Producer chain window (the Producer chain of the last days ran from about 17:00 UTC); do not start a manual sync, fetch or refresh to create the window.
7. **Nothing else in the way.** `film_person_fence` marker `d1`/`open`, no held projector window, no concurrent owner operation recorded in the dated evidence.

A failed or uncertain item is a stop, not a waiver.

## The flip (owner L3 GO required, one statement, no retry)

State the exact `revision` read in preflight item 2 in the GO. The only accepted statement:

```sql
UPDATE film_metadata_provenance_control
SET mode = 'enforce', revision = revision + 1, updated_at = :now, updated_by = :operator
WHERE id = 1 AND mode = 'off' AND revision = :expected_revision;
```

Exactly one row changes. After an ambiguous result **read the row before deciding anything**; never repeat the statement blindly.

### Readback

`SELECT mode, revision, updated_at, updated_by` returns `enforce` with `revision = :expected_revision + 1`; `film_metadata_field`, `film_metadata_history` and `film_metadata_owner_command` hold only rows written through real observations since the flip (none are backfilled), `film_metadata_owner_release` is empty, and the Film/Person marker, flags and Scheduled Tasks are unchanged. Record it in the dated evidence file.

## What the flip does and does not do

- It does not fetch, sync or refresh anything and enables no periodic policy; no bulk adoption. Values written before the flip, including the first C1 fills, start `unknown` and are adopted or replaced when C1 next fetches them through the triggers of ADR 0214 decision 10.
- Language upgrades waiting in the enrichment inbox (`languageUpgradesWaiting`) are held while the mode is `off` or `hold` and become runnable only in `enforce`; the existing reconcile starts the drainer. Do not reset or re-arm rows by hand.
- A pin (`tier = 'owner'`) and the dimension lock protect a value in every mode that is not `off`.

## Natural acceptance (card state `Верификация`)

Do not run a production writer to clear this queue. Evidence is the `provenance` block of `GET /api/admin/settings` (mode, revision, history, `languageUpgradesWaiting`, the per-field outcome totals and the coverage of that aggregation; `outcomes.unavailable` or `coverage.olderRunsNotSummed` means incomplete, not zero) and read-only `SELECT`s over the field, history and command tables. The criteria, from the card:

- actual fills, adoptions, replacements, refusals, conflicts and history rows;
- no overwrite of an `owner` pin;
- EPG-declared writes behave as undeclared (unknown) and C1 fallback fills blanks only;
- language-aware replacement ([ADR 0224](../adr/0224-russian-first-catalog-metadata.md)): a Russian or owner-pinned value is kept when an English fallback arrives (`language_kept`); an English value is replaced by a confirmed Russian one.

If there is no natural C1 traffic yet, wait for the ordinary event after C2 ([AIR-607](https://trello.com/c/Daq02gYy)); do not create one. Acceptance and `Готово` stay with the card's roles.

## Hold and rollback (separate owner GO)

`enforce → hold` stops every automatic replacement and clear at once, without a code revert; in-flight replacement batches fail on the control revision and replan as fills:

```sql
UPDATE film_metadata_provenance_control
SET mode = 'hold', revision = revision + 1, updated_at = :now, updated_by = :operator
WHERE id = 1 AND mode = 'enforce' AND revision = :expected_revision;
```

Read back the row. Pins, history and replaced values stay; there is no automatic replacement, no clear and no bulk rollback. A manual correction of one field is a separate owner action through the owner route (`revert` for the same identity, `set` for any identity). `hold → enforce` is the same statement with the modes swapped. A code revert past PV1 is not a rollback; it is an owner L3 operation with its own plan. The periodic refresh policy (PVT) and per-field EPG lineage (PV4) are separate owner decisions.
