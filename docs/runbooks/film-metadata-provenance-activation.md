# Film metadata provenance: activation (`off → enforce`) and hold (`enforce → hold`)

[AIR-636](https://trello.com/c/0jJADYxg) (card PVE) · [ADR 0214](../adr/0214-film-metadata-per-field-provenance.md) decisions 11, 13 and 15 · language policy [ADR 0224](../adr/0224-russian-first-catalog-metadata.md).

**Nothing on this page authorizes a production operation.** Each transition is an owner L3 production operation with its own GO and readback ([authorization](../process/authorization-and-escalation.md)). This page is a contract, not a status: read the present mode, revision, deployment and instance state live. This runbook implements the accepted ADR 0214 decision 15 and adds no policy, writer, flag, Task or control infrastructure. If a required condition cannot be established, **stop the activation, name the exact gap, and let every other branch, PR, review and unrelated operation continue**; a change to the accepted drain criterion itself is a narrow owner decision, never a silent relaxation.

## What the control is

One durable row, `film_metadata_provenance_control(id = 1, mode, revision, updated_at, updated_by)`, created by migration `0049` at `off`. Triggers (`film_metadata_provenance_one_way`, `film_metadata_provenance_transition`) allow only `off → enforce`, `enforce → hold` and `hold → enforce`, each raising `revision` by exactly one; `off` is unreachable afterwards. There is no operator script and no flag; the mode is not in the feature-flag registry. A transition is one `UPDATE` of this row, guarded by its current mode and revision.

## 1. The compatible set and the drain rule

ADR 0214 decision 15 requires: a **compatible deployed version at 100 %** for **longer than the longest unit or Workflow step bound**, no Workflow instance or producer unit of an older version still running, and no unsettled receipt planned by an older version (the [ADR 0207](../adr/0207-letterboxd-admissions-coordinated-in-d1-only.md) A2 drain; [ADR 0189](../adr/0189-h0-checks-compatible-deployment-not-version-equality.md) and the [EPG checkpoint runbook](epg-checkpoint-d1.md) give the inventory and ancestry technique). "Older" means code that predates the writer rule: a pre-PV1 or schema-absent batch is still harmless (invalidation triggers make its changed values `unknown`, lock triggers stop it at pins), but it must not be left in flight.

**Compatible deployment.** A deployed commit that contains all of: PV1 `d5a1fe0` ([AIR-631](https://trello.com/c/i8td3wu0), #1039), PV3 `855d68e` ([AIR-634](https://trello.com/c/tznjf1v6), #1047), PV2 `4ce0074` ([AIR-633](https://trello.com/c/z6MFlDvW), #1048) and the language-aware writer `2b13828` (AIR-693, #1051; needed because migration `0053` is applied and ADR 0224 is the current contract). Check by `git merge-base --is-ancestor <commit> <deployed commit>` for each. **A later deployment that is also compatible does not restart the drain clock**; only a deployment that is not compatible (or a rollback to one) does.

### Deriving the wall-time bound `B`

Use wall time, never CPU time or an observed successful duration. The writers that reach `writeFilmFacts` (and so write `film_metadata`), their entry points and the bounds that the code and the platform actually impose:

| Writer path | Entry point | Bound used |
| --- | --- | --- |
| EPG metadata sync (`metadata_sync`, producer adapters, localization projection) | `iptv-epg` Workflow, `EpgOrchestration.run` `step.do` (`src/epg-orchestration.js`), `metadataSyncStep` (`src/worker.js`); also the hourly cron `scheduled` handler | no `step.do` config in the repo, so the platform default applies: per attempt **timeout 10 min**, 5 retries, 10 s delay, exponential backoff ([Cloudflare: Sleeping and retrying](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/), recorded in [the M1 limits evidence](../evidence/d1-migration/air-374-m1-workflow-limits-2026-11-14.md)). A cron invocation is bounded at 15 min of wall time ([ADR 0219](../adr/0219-discovery-film-enrichment-and-refresh.md)) |
| EPG Producer (`film_facts`, dictionary units) | `iptv-producer` Workflow, `runProducerWorkflow`, `work` step (`src/canonical-producer-workflow.js`) | the same default step config. In code: chain lease `CHAIN_LEASE_MS` 300 s plus `CHAIN_BOUNDARY_MARGIN_MS` 15 s, slice deadline `CHAIN_SLICE_DEADLINE_MS` 270 s (`src/canonical-producer-fence.js`), and a re-run `work` step stops the chain (`producer_work_replayed`) instead of redoing work |
| C1 Catalog Enrichment | `iptv-catalog-enrichment` Workflow, `drain-<round>` steps (`src/catalog-enrichment-workflow.js`, `catalog-enrichment-units.js`) | the same default step config; a write needs a live lease `LEASE_TTL_MS` 300 s (`src/catalog-enrichment-store.js`) and the control generation. Waits (`waitForEvent`, up to `MAX_WAIT_MS` 24 h) are parked, not writing |
| Owner route | HTTP `/api/admin/films/<id>/metadata` (`src/admin/film-metadata-route.js`) | one request, one batch; no repository constant. The owner states that no owner request or operation is in flight (see section 3) |

The bound of one Workflow step including every retry, from the documented default, is **`B = 6 attempts × 600 s + (10 + 20 + 40 + 80 + 160) s = 3,910 s` (about 65 min 10 s)**. The cron bound (900 s) and the lease bounds (315 s) are smaller, so `B = 3,910 s`. This is the platform default recorded in the repository; the Cloudflare limits page also says a step has "unlimited wall time" subject to CPU, so the configured default timeout is the only wall-time bound and it is **not enforced by repository code**. Therefore the time bound is never used alone: it is paired with the instance inventory below, which proves directly that nothing old is running. **Gap rule:** if the deployed Workflow classes pass a `step.do` configuration (they did not at the last read) the bound is recomputed from it; if the platform default cannot be confirmed against the current Cloudflare page on the day, or the inventory cannot be read in full, activation stops there.

### The earliest eligible flip

1. List `GET /accounts/{id}/workers/scripts/iptv/deployments` (read-only). Take the **deployment `created_on`** of each deployment (the start of its 100 % traffic; not the version's creation time).
2. For each deployment find the CI/CD push run on `main` whose `Deploy to Cloudflare` job produced it (completion within the same minute; the job log is expected to show the Version ID, and a deployment that cannot be tied to a commit this way is treated as not provably compatible). That run's `head_sha` is the deployed commit. Run the four ancestry checks of the compatible set on it.
3. Walk back from the newest deployment while each deployment is single-version at 100 % **and compatible**. `T0` is the `created_on` of the earliest deployment of that unbroken compatible run. An incompatible deployment or a split-traffic deployment ends the walk; `T0` is then the next one after it.
4. **`earliest eligible = T0 + B`.** If the newest deployment is a rollout in progress (more than one version, or a percentage under 100), the flip is not eligible.
5. Only the final recheck of section 3 can make the flip eligible; the earlier calculation is a forecast.

Normal merges and deployments of compatible code are not blocked by this rule and no global freeze or deploy hold is requested. The only coordinated interval is the short no-deploy window of section 3.

### The instance and unit inventory (read-only)

Run after the calculation, for the writer Workflows `iptv-epg`, `iptv-producer` and `iptv-catalog-enrichment` (and, for completeness, read the other three, `iptv-discovery`, `iptv-letterboxd` and `iptv-prediction-start`: no writer path to `film_metadata` was found in them, and any non-zero count there is recorded, not ignored):

- `GET /accounts/{id}/workflows/<name>/instances?status=<status>&per_page=100` for each nonterminal status of the repository technique, **`queued`, `running`, `waiting`, `paused`, `waitingForPause`, `rollingBack`**, every page until `result_info` says all were read, summing `total_count`. A step in retry backoff is expected to belong to an instance in one of these statuses; if an instance is seen in a step retry under any other status, that is a stop. Terminal `complete`, `errored` and `terminated` instances are history. Any other status returned by the API is a stop, recorded verbatim.
- Every instance found is described (`.../instances/<id>`) and its start time compared with `T0`; one that started before `T0` is older code by definition and makes the answer not eligible until it ends. **Do not terminate, restart, roll over or force anything**, and do not create a Task.
- Older units and receipts: `SELECT count(*) FROM canonical_write_receipt WHERE state IN ('pending','failed','unknown')` is 0 (`applied` and `abandoned` are settled); the newest `canonical_producer_chain` rows are `owner_state = 'complete'` with an expired lease (`lease_expires_at` in the past), and `canonical_producer_run` rows that are not `passed` are explained; C1: `catalog_enrichment_control` (no row means not activated and no C1 unit can exist) and, if it exists, the newest tick and an unexpired `lease_until`; the discovery and EPG statuses from `epg_pipeline_status`.
- **A terminal control row is not proof of no live instance.** The inventory is; record both separately.
- Worker `iptv` logs for the window `T0 … now` (the `cloudflare-observability-read` skill, read-only) are read for writer invocations still running or erroring; where the log carries no version field, record that the version of an invocation is **not verified** by the logs. The owner states that no owner route request or operation is in flight.

## 2. Static preflight (read-only, with expected values)

All by `SELECT`. Record each value.

1. **Schema.** `SELECT id, version FROM schema_contract` returns `1` and a version at least `53`; the five tables exist: `film_metadata_field`, `film_metadata_history`, `film_metadata_owner_command`, `film_metadata_owner_release`, `film_metadata_provenance_control`.
2. **Migration 0053 constraints.** `SELECT instr(sql, 'length(language) = 2') > 0 FROM sqlite_master WHERE name = 'film_metadata_field'` is `1` and `instr(sql, 'language IN (''ru'', ''en'')') > 0` is `0`; for `film_metadata_history` both `instr(sql, 'length(old_language) = 2') > 0` and `instr(sql, 'length(new_language) = 2') > 0` are `1`. Version 49 alone is not enough.
3. **Control row.** exactly one row, `mode = 'off'`; record `revision` (`R`), `updated_at` and `updated_by`.
4. **Release rows.** `SELECT count(*) FROM film_metadata_owner_release` is `0`.
5. **Authority marker and leases.** The Film/Person marker is the `film_person_authority` row: `SELECT mode, cutover, generation FROM film_person_authority` is `d1`, `open` and a generation that the GO records. The ADR 0211 control generation is `catalog_enrichment_control.generation` (no row: C1 not activated). The Producer chain lease is `canonical_producer_chain.lease_expires_at` with `owner_state`. Also read whether a projector window is held and whether any owner operation is recorded as running; what is **not** read is stated in the dated evidence as not verified, not implied.
6. **Baseline for acceptance.** `SELECT count(*) …` of `film_metadata_field`, `film_metadata_history`, `film_metadata_owner_command` and the newest `canonical_write_receipt.updated_at`, to be compared after the flip.

## 3. The GO and the final pinned recheck

The owner GO names: the control `revision` `R`, the **deployment version id and the deployed commit** from the calculation, `T0`, the earliest-eligible time, the authority generation, and the link to the dated preflight evidence. A GO that does not name them is not a GO for this operation.

**After the GO and immediately before the statement**, repeat on live state: the deployment list (the pinned version still the single 100 % version, or a newer deployment that is also compatible by the ancestry checks), schema and 0053 constraints, control `off`/`R`, release rows 0, the authority marker and generation equal to the GO, the six-status inventory at 0 for the writer Workflows and the receipts clean, no owner operation. **A changed pin, an incompatible or split-traffic deployment, or `now < T0 + B` means stop and replan**, not a retry of the statement. The control revision CAS protects only the control row; it does not replace this recheck.

**The no-deploy and no-conflict window** runs from that recheck to the readback and is released the moment the readback succeeds or the operation is abandoned. During it the Delivery Controller holds only merges to `main` that would deploy, and no owner operation on Film metadata, the Film/Person marker or a projector window is started. Everything else continues. The window is minutes, not a freeze of normal tasks.

## 4. The flip (one statement)

The only statement permitted:

```sql
UPDATE film_metadata_provenance_control
SET mode = 'enforce', revision = revision + 1, updated_at = :now, updated_by = :operator
WHERE id = 1 AND mode = 'off' AND revision = :R;
```

- **Zero rows changed** (`changes = 0`) and the row still `off` at `R`: the guard refused it; nothing was written; stop and replan.
- **One row changed** and the readback shows `mode = 'enforce'`, `revision = R + 1`, `updated_by = :operator`: committed.
- **An error, a timeout or no response:** the outcome is unknown. **Read the row before anything else.** `off` at `R` means not applied; `enforce` at `R + 1` means applied. There is **no blind retry**.

**Independent readback**, by a second read after the first: the control row as above; `film_metadata_owner_release` is empty; `film_metadata_field`, `film_metadata_history` and `film_metadata_owner_command` differ from the baseline only by rows whose timestamps are after the flip (none are backfilled, so the immediate counts are the baseline); `film_person_authority` and the schema version are unchanged; flags and Scheduled Tasks are unchanged. Only this one statement is written: no other table's baseline moved because of it.

## 5. Natural acceptance, attributable to this activation (card state `Верификация`)

Do not run a production writer, fetch, refresh, owner write or monitoring job to produce evidence. The evidence is a **bounded post-flip readback** against the flip time `Tf` and revision `R + 1`, by read-only `SELECT`s over the existing tables, with each criterion classed as one of: **observed** (an actual natural case), **fixture guarantee** (proven by offline tests only, not by production), **no natural opportunity yet**, or **coverage missing**. A criterion with no natural case stays unproven in `Верификация`; it is never inferred from a zero.

- **Settings endpoint is corroboration, not proof.** `GET /api/admin/settings` `provenance` is a retained aggregate of the newest 500 finished or stopped C1 ticks (`src/admin/settings.js`); it skips ticks without valid provenance counts, is capped, and cannot say which counts happened after `Tf`. `runsWithCounts` below `finishedRunsSummed`, `capped`, `olderRunsNotSummed` or `unavailable` means incomplete coverage, not zero.
- **History** (`film_metadata_history WHERE at >= :Tf`): `replaced`, `cleared`, `owner_*` rows by `reason`, `new_source`, and `old_language` → `new_language` (a `ru` replacing an `en`, observed per row with its `write_key`).
- **Fields** (`film_metadata_field WHERE updated_at >= :Tf`): fills and adoptions by `source`, `tier`, `agreement`, `language`, `origin`; `written_revision` and `write_key` tie a row to a batch.
- **Receipts and ticks:** `canonical_write_receipt` rows created after `Tf` and, when C1 is active, `catalog_enrichment_tick` rows started after `Tf` (their `counts_json.provenance` carries the refusals, `language_kept` and conflicts that leave no history row; durable history records only changes).
- **EPG callers are undeclared (decision: unknown).** Witness: an applied EPG `film_facts` unit after `Tf` (`canonical_producer_run`, `canonical_producer_unit_result`) that changed a field value leaves that field with no field row (reads `unknown`); it does not become attributed.
- **C1 fallback fills blanks only; Russian or owner value kept against an English fallback** ([ADR 0224](../adr/0224-russian-first-catalog-metadata.md)): witnessed by tick counts (`language_kept`, `source_absent`, `superseded_kept`) and history language transitions of a real C1 write.
- **No overwrite of an `owner` pin:** needs both a pin (`tier = 'owner'`) and a conflicting automatic attempt after `Tf`. A zero overwrite count with no pin or no conflicting attempt is **no natural opportunity**, not proof; the trigger guarantees are fixtures.
- If C1 is not activated or has no natural traffic yet, that is **not** an activation blocker: keep the C1 criteria in `Верификация` until the ordinary event after C2 ([AIR-607](https://trello.com/c/Daq02gYy)), and do not create it.

## 6. Hold and rollback (separate owner GO)

`enforce → hold` stops every automatic replacement and clear at once, without a code revert; in-flight replacement batches fail on the control revision and replan as fills:

```sql
UPDATE film_metadata_provenance_control
SET mode = 'hold', revision = revision + 1, updated_at = :now, updated_by = :operator
WHERE id = 1 AND mode = 'enforce' AND revision = :R;
```

The same outcome classes and no-blind-retry rule apply. `hold` preserves values, history and pins, and still permits **fills and adoptions**; it permits no automatic replacement or clear. Owner commands stay available under their own authorization; a manual correction of one field is a separate owner action (`revert` for the same identity, `set` for any identity). `hold → enforce` is the same statement with the modes swapped. There is no bulk rollback; a code revert past PV1 is not a rollback but an owner L3 operation with its own plan. The periodic refresh policy (PVT) and per-field EPG lineage (PV4) are separate owner decisions.
