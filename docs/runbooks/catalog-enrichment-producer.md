# Catalog Enrichment Producer runbook

Operational reference for the [Catalog Enrichment Producer](../reference/domain/catalog-enrichment.md). The producer is **dormant**: this page describes what an operator checks and does, and which steps are separate owner operations. It authorizes none of them. Present runtime state (schema version, control row, scopes, run and lease state, feature flags) is read live, never from this page: use the authorized read-only tools and `GET /api/admin/settings`.

## Operations and their gates

| Operation | Gate |
| --- | --- |
| Apply `migrations/0047_catalog_enrichment.sql` | Owner production operation with its own preflight and readback; follows the operation-key schema apply. A deploy never applies it |
| Apply `migrations/0050_discovery_enrichment_scope.sql` (Discovery scope intake) | Separate owner production operation ([AIR-685](https://trello.com/c/kfks9T3n)) with its own readback, after 0047; a deploy never applies it, and the code before the apply is the former code |
| Activate the Discovery scope (C3c-A) | Separate owner production operation: sets `activated` and `enabled` in one batch only after `CatalogEnrichmentDiscovery.activationPreflight` reports no problem (schema applied, no `loading` transfer, no staged signal) and a compatible version is deployed; the cutoff is that activation, there is no bootstrap |
| Activate the control and the rated scope (C2, [AIR-607](https://trello.com/c/Daq02gYy)) | Owner production operation under an exact owner GO that names the cutoff, run with `activateRated` of `src/catalog-enrichment-activation.js` (below). Not reachable from the admin route, and no other scope is enabled by it |
| Pause, resume | Owner, through `POST /api/admin/settings/catalog-enrichment` |
| Retry a blocked or deferred part | Owner, through the same route, on the rows the owner saw |
| Deliver the reconcile cron expression (`CatalogEnrichmentRunner.CRON`, `11-59/15 * * * *`) | The AIR-607 `wrangler.jsonc` change, merged and deployed only under the owner's GO and **before** the activation; idle while the control is not `active` |
| Change the upstream coordination mode | Separate owner operation; the producer works at every mode (an absent table or an unreadable mode is `off`) |

## Preflight before any activation

1. The schema version is at least 47 and every table of the [schema section](../reference/data/d1-schema.md#catalog-enrichment-producer-schema-v47-dormant) exists. The producer refuses to run without them.
2. The operation-key schema (`canonical_write_receipt.operation_key`) is applied: every unit is keyed.
3. The Film/Person authority marker is open (`d1`): a closed marker defers every unit; the producer never falls back.
4. The control row is absent or `inactive`, and `enrichment_signal` holds no stale `staged` row.
5. The canonical credit reader can serve a Film with more credits than its current whole-read cap before any Film with more than 200 credits is written.

## Activating the rated scope (C2, AIR-607)

The operator is `activateRated(env, {cutoffAt, by, at, goReference}, deps?)` in `src/catalog-enrichment-activation.js`. It is delivered dormant: no route, Worker module, flag or Scheduled Task calls it, a deploy never runs it, and it starts no instance of its own. It is executed once, by the owner's production operation, with the exact GO.

**Inputs.** `cutoffAt` is the approved cutoff (a real ISO instant with milliseconds, not later than the A2 flip and not in the future); it is a GO input and is never defaulted. `goReference` is the HTTPS link of the recorded owner GO and `by` identifies the operator; both are written, untruncated, to the control's `updated_by` as `<by> go:<link>`, so a combination longer than the 200-character column is refused (`actor_too_long`). An impossible calendar instant, a missing link or a malformed input refuses before the database is read.

**Preflight (`ratedActivationPreflight`, read-only).** It refuses (`refused`, nothing written) on:

| Problem | Meaning |
| --- | --- |
| `schema_not_applied` | schema below 47, or a missing table of the whole relevant schema (the producer tables including `catalog_enrichment_unit_generation` and `catalog_enrichment_tick`, `film_rated_admission`, `upstream_cooldown`, `upstream_coordination`, `projection_run`, `canonical_write_receipt`), the rated emitter trigger, or the `canonical_write_receipt.operation_key` column; `facts.missingTables` names them |
| `film_person_marker_not_open` | the Film/Person authority is not actually `open`: a valid `d1`/`held` marker, an `r2` or `prepared` marker, or an unreadable one; `facts.filmPersonMarker` reports the real state and generation |
| `lease_held` | a live `catalog_enrichment` drainer lease: an actually live owner, not an invented quiet window; an expired lease is not an owner |
| `control_not_inactive`, `other_scope_present`, `scope_cutoff_mismatch`, `scope_already_present` | the control is not `inactive`, a scope other than `rated` exists, or the rated scope has another cutoff |
| `stale_staged_signals` | a `staged` signal exists |

Credit-reader compatibility for Films with more than 200 credits is proven by the delivered reader, not by a database read.

**The approved envelope is read once and asserted inside every write.** The cutoff, the scope revision, the authority generation read by the preflight, no other scope, no `staged` signal, no live lease and the control revision are conditions of the writes themselves, not only of the preflight, and they are never replaced by a later read:

1. **Scope insert.** One statement inserts the `rated` scope row (`activated=1`, `enabled=1`, the cutoff, revision 1) only while authority is still `open` at that generation, no staged signal or live lease exists, no scope row exists and the control revision is the one read. From here the live `film_rated_admission` trigger emits for admissions at or after the cutoff. The insert's own result is judged by a readback: the row must be exactly what this call inserted (revision 1, untouched bootstrap, its own timestamp, the only scope). No row is `refused` / `scope_not_written`; any other matching or changed row is `stopped` / `scope_changed_after_insert` with `effects.scopeInserted` `unknown`, never adopted and never attributed to this call; a lost reply of an insert that did commit is recognized as this call's row (`scopeNote: scope_insert_reply_lost`). On a resume the scope revision must still be the one read by the preflight.
2. **Bootstrap.** The bounded, revision-fenced bootstrap writes `admitted` signals for the qualifying existing admissions, **pinned** to the approved revision and cutoff (a page that finds another revision or cutoff stops with `configuration_changed`, or `revision_moved` when it moves during the page, and adopts nothing) and with the readiness conditions (authority `open` at the approved generation, no staged signal, no live lease, exactly one scope) inside the fence of **every** write of every page: a marker held after the scope insert or between pages stops the operator's writes at once, not only the final flip (`cursor_moved`). The cursor compare-and-swap and the live-tail deduplication of the existing mechanism are unchanged.
3. **Control commit.** One guarded batch (initializing an absent control row in the same batch) sets the control `inactive` to `active` only while the same envelope holds, against the control revision read at the start, **and** the rated scope is still enabled with the approved cutoff and revision and a done bootstrap, with no other scope. A change at this boundary, including another writer's activation, leaves the control as it is (`stopped` / `control_guard_failed`) and is never reported as this call's activation.

**Outcomes are never rounded up.** `refused`: nothing was written by this call. `stopped`: scope and/or bootstrap effects exist (reported in `effects`) and the control is still `inactive`; nothing was adopted and the same call resumes. `uncertain`: the control commit was sent and its outcome could not be read back, so read the state before acting again. `activated`: the control is active under this operator's own write (a lost reply of an applied commit is read back and reported with `note: commit_reply_lost`). `noop`: already active under the same enabled, rated-only configuration with the same cutoff and a done bootstrap. Any other active configuration, including an unfinished bootstrap (which a correct commit, that requires a done bootstrap, never produces), is `refused` (`active_configuration_mismatch`) with no write at all, whatever the authority or schema say: it is an inconsistency to investigate, not something this operator repairs.

**Wake of already-runnable work.** Signals written while the control was inactive are not woken by any later writer, and `kick` refuses an inactive control. After the control commit is confirmed, the operator wakes the drainer through the existing protocol only (`hasRunnable`, then `kick`, creating or kicking the one instance of the existing run record). The result carries `wake`: `kicked`, `nothing_runnable`, `not_kicked`, `failed` or `deferred` (`no_workflow_binding`). A failed or deferred wake never undoes the activation, and repeating the same call is a `noop` that wakes again. A `deferred` wake is **not** natural acceptance: it only means the work waits for the producer's own reconcile.

**Invocation path and why the reconcile cron comes first.** The Workflow binding exists only inside the Worker, and no Worker route calls this module. The invocation is the thin operator `scripts/catalog-enrichment-activation-production.mjs`, which adds no activation SQL: it runs `ratedActivationPreflight`, `activateRated` and `readActivation` over the existing strict D1 REST adapter pattern of `scripts/upstream-cooldown-mode-production.mjs`, `scripts/d1-migration-window-production.mjs` and `scripts/published-epg-production.mjs` (pinned account and database `iptv`, the owner's `D1_BACKFILL_*` credentials from the environment and never printed, zero retries, strict reads, one atomic D1 batch per write unit, a Time Travel bookmark before and after, an independent readback). A REST binding has no Workflow, so an activation run that way always ends with `wake: deferred`, and the first wake can only come from the reconcile. The reconcile cron `11-59/15 * * * *` (minutes 11, 26, 41 and 56 UTC; `CatalogEnrichmentRunner.CRON`) is therefore delivered and verified **before** the activation: the Worker dispatches that exact expression first, and its body returns `not_active` and does nothing while the control is inactive, so delivering it first starts nothing. The cron is declared in `wrangler.jsonc` by the AIR-607 delivery; the merge of that change is itself the deployment and is made only under the owner's GO.

**Operator commands.** Load the owner's credential file into the command only (see the credentials procedure of the repository skills) and add `NODE_USE_ENV_PROXY=1` behind a proxy.

```bash
set -a; . ~/.config/iptv/d1-backfill.env; set +a; NODE_USE_ENV_PROXY=1 node scripts/catalog-enrichment-activation-production.mjs --status --target iptv --cutoff <cutoffAt>
```

`--status` is strictly read-only (no write, no bookmark, no request to any upstream). It prints the digest of the bytes that run (the operator and the two modules it uses), the schema and authority facts, the control, the scope rows, the inbox counts and a `decision`: `ready`, `resume` (the same cutoff, an interrupted activation), `already_active` or `blocked` with the problem codes.

```bash
set -a; . ~/.config/iptv/d1-backfill.env; set +a; NODE_USE_ENV_PROXY=1 node scripts/catalog-enrichment-activation-production.mjs --activate --target iptv --cutoff <cutoffAt> --by <operator id> --go <HTTPS link of the recorded owner GO> --confirm activate --operator-sha256 <digest printed by --status>
```

`--cutoff` is the exact value the owner confirmed in the GO; it is never defaulted, and a missing, malformed or future value refuses. Exit 0 is only `activated` or `noop`. Exit 3 is `refused` (nothing written), `stopped` (partial effects in `effects`, reported with `partial: true`) or `uncertain`, always with `retry: false`; a lost reply of an applied commit is read back and reported as `activated` with `note: commit_reply_lost`. After any exit other than 0, reconcile the real state read-only with `--status` before anything else: a repeat of the same call with the same cutoff is allowed only after a confirmed `stopped` partial state, with an unchanged permitted configuration and within the GO, never as a blind retry and never to bypass a guard. The operator never resets a cursor, lease or receipt.

**Sequence under the GO.** (1) Read the present state live: the operator's `--status`, `GET /api/admin/settings` and the read-only IPTV MCP tools, plus the Cloudflare schedules readout. (2) Merge and deploy the reviewed change that declares the reconcile cron, and verify after the deployment that the live trigger list holds the new expression and every earlier one unchanged and that the deployed version is the merged one; with the control inactive it is idle and no manual reconcile is run. (3) Run `--activate` and record its result as the activation evidence (control, the rated-only scope row, the inbox counts, qualifying admissions against rated signals, the wake, the bookmarks). (4) Read back, after the next reconcile tick at the latest, that a run started and the pending signals are consumed, with no manual run forced: with no eligible work nothing is imitated, and an empty inbox is not evidence of an enriched Film. Natural acceptance (new admissions enriched through the event-woken drainer on real admission traffic) is observed afterwards, together with A2 where it applies, and is not produced by this operation.

**Not part of this operation.** It enables no Discovery, `c3a` or `c3b` scope, sets no flag, creates no Scheduled Task, runs no manual enrichment, no legacy backfill and no instance outside the existing protocol.

**Rollback.** Pause through `POST /api/admin/settings/catalog-enrichment`; disabling the scope holds its signals while its emitter keeps recording. A code revert changes neither the control row nor the scope row.

## Reading the state

- The owner page `/admin/settings` shows the same effective state: the pause/resume checkbox (disabled while the producer is not activated), the drain status with the run lease expiry, the pending and due counts, the active cooldowns and the rows that need attention with their retry. It reads on open and after every action, and its controls stay disabled until a valid read succeeds (a stale snapshot is labelled with its own read time). An unknown outcome means the change may or may not be stored; the later state does not settle that for this request, so decide deliberately before acting again. An empty cooldown or attention list does not prove completeness, because the route returns `[]` when that read fails. A retry button resets exactly the one row shown under it. Revert the page alone by removing it; the durable control is unaffected.

- `GET /api/admin/settings`: the control, the newest run and its stop reason, whether a run is still draining after a pause, the pending signals, the due Films, the cooldowns and the Films that need attention.
- The `provenance` block of the same read (mode, revision, history, waiting language upgrades, the per-field outcome totals and the coverage of that aggregation) is the natural-acceptance evidence for the provenance activation: replacements, refusals, conflicts and history. `languageUpgradesWaiting` above zero while the mode is `off` or `hold` is expected: those inbox signals are held, and become runnable only in `enforce` (the existing reconcile then starts the drainer; there is no wake to run by hand). Do not reset or re-arm rows by hand; `hold` stops further replacements. `outcomes.unavailable` or `coverage.olderRunsNotSummed` means the totals are incomplete, not zero.
- A run ends with one of `idle`, `parked` (with the earliest due time), `handover` (the statement budget; the next run continues at once), `paused`, `generation_moved`, `lease_held`, `yield` or `error_backoff`. `yield` means a progressing EPG publication (a loading or validated stage with a live publisher claim, or the EPG-held lease; the held cutover marker is not a hold) holds the writes at a write boundary: the run parks for a short re-check (15 seconds at the latest) and resumes when the publication ends. `error_backoff` means three Films failed on storage or an authority fence in one run; each failed Film is deferred durably with a short backoff, and the run parks by the 1, 5, 15 minute and hourly tiers.
- A `film_person_fence` failure of a unit right after the Film/Person marker moved is the expected, fail-closed result of the 5-second writer gate snapshot of a drain (AIR-688): the batch asserted the marker inside its own transaction, wrote nothing, dropped the snapshot, and the unit is retried from its receipt with a fresh read. It is not a fault of the unit. Rollback of the optimisation is a code revert (`drain(..., {gateReuse:false})` is the measured baseline); no data, flag or schedule is involved.
- A part in `deferred_repair` is rechecked after 1, 6 and then every 24 hours and is set runnable again by a new code version, a source recovery or a changed response digest. It is never terminal.

## Pause

A pause raises the control generation. No request starts after it; a request already sent may complete, and **nothing it returns is written**: every write asserts the generation. The newest run reports `draining` until it writes its stop entry. A code revert stops future runs but does not cancel a running one: the pause is the stop control. Resume keeps all pending work and the cutoff.

## Owner retry

Use it for a Film in `identity_disagreement` after the claim is corrected or the page was a transient fault, for a part in `needs_attention` (a verified conflict or an ambiguous translation) after the owner decision, and to hasten a `deferred_repair` part. It writes no metadata. A part that lists `written_under_superseded_anchor` or is held as `superseded_credits` keeps its listed values: correct them through the existing owner routes before releasing the hold.

## Rollback

Written values are valid canonical data under fill-only and add-only and are corrected by the owner and review routes. A code rollback does not revert D1 data, the control row or the scope rows. The stop control is a pause; disabling a scope stops its work and holds its signals while its emitter keeps recording.
