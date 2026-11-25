# Bounded discovery ledger: modes, verification and recovery authorization

**Recovery proportionality:** a failed or deferred **single discovery observation** is normally recovered by the published next eligible chunk, not by replaying the entire discovery archive, exporting a full R2 snapshot or rebuilding a global ledger. These expensive procedures below are reserved for actual archive corruption, authority rollback or bulk split. Preserve the resolver lease, generation fencing, owner authorization for explicit runs and the rule of one chunk per request; they prevent two writers from overwriting the same decision map. A safe status read is not a reason to reset a lease or force a whole chunk early. See [risk classification](../process/agent-workflow.md#risk-proportional-operational-safeguards).

This page describes how to operate the bounded discovery archive of [ADR 0034](../adr/0034-bounded-discovery-ledger.md) after [ADR 0156](../adr/0156-retire-discovery-ledger-mode.md) retired the production `DISCOVERY_LEDGER_MODE` switch. It does not grant permission for anything. A deploy does not delete the leftover Cloudflare binding. The production EPG seal always archives as `bounded`. `full` and `frozen` remain only on the isolated EPG diagnostic canary and in offline fixtures.

**Status of the R2 ledger tools after [ADR 0162](../adr/0162-d1-only-authority-retire-rollback-toolchain.md) and AIR-537.** The ledger and its decisions are D1-owned; the R2 ledger object is a frozen legacy copy. `scripts/discovery-ledger-split.mjs` is an offline snapshot plan and rehearsal: it writes only to a private directory and is kept as historical analysis. `scripts/discovery-ledger-install.mjs` is **read-only since AIR-537**: its former `--apply --approved-production-writes` path (R2 `PutObject` of the plan and a resolver-lease write) is removed, and `--apply` is refused with exit 2 before any request. It remains only as a `GET`/`HEAD` dry-run re-check of a plan against a bucket. The shared S3 client (`createS3Store`, `readInstallCredentials`) now lives in `scripts/r2-s3-store.mjs`, which has no import side effects and is used by `scripts/prediction-domain-production.mjs`. The R2 ledger tools cannot return an authority or recover D1.

## What the EPG commit writes

Production always takes the **bounded** row. The other rows are historical rollback language of ADR 0034 and offline fixtures; no Worker binding selects them.

| Mode (diagnostic / historical) | Archive absent | Archive present (`epg/discovery-archive/v1/current.json` exists) |
| --- | --- | --- |
| `full` | Single growing ledger | Acts as `frozen`; never rebuilds the full ledger in the Worker |
| `frozen` | Same as `full` (no marker written) | No new archive write. Departures stay in the active ledger; re-entries and counts still use the archive |
| `bounded` (production) | The first commit creates the archive from the departures of the previous ledger | Active ledger = the latest scan's candidates **plus**, while a backlog remains, the part of it that this commit does not archive yet ([ADR 0112](../adr/0112-bounded-ledger-departure-budget.md): the daily flow is archived at once, at most 4,000 observations of the backlog a commit); departures go into new write-once segment versions, a manifest version, then a CAS of `current.json`; then the generation is published |

The commit runs this under the discovery lease. It stops without publishing if:

- the published generation pointer changed (its etag differs from the one read at the start);
- the lease was lost;
- `sync.json` no longer names the run in stage `epg`;
- the archive pointer CAS lost a race;
- the published EPG authority already names a programme run and that run's ledger object cannot be read;
- that authority's ledger, or the compatibility copy used in its place, names a different programme run.

Such a stop leaves either the previous archive with some unreferenced versions, or the new archive plus the previous published generation. Both are consistent (ADR 0034, section 3). A missing or mismatched ledger stops before those writes: the archive pointer, the generation files and the published pin stay put. An empty predecessor is only used when the authority has no programme run yet. Retrying the same run is safe.

A stored ledger that exposes `body` or `text` is folded one candidate at a time. The next generation document is written as bytes, pulled one chunk at a time, and is not parsed back into objects. Its UTF-8 length is counted on that same decision walk, and the generation put is the readable side of a fixed-length stream of that exact size. A short or long body fails the put and stops before the published pin moves. Copying a generation object onto its stable key uses the stored object size the same way; a missing size is not replaced by reading the object into a string. A string put already has a known length. A `json`-only object is still parsed whole. Bounded mode still holds departure records as objects until the archive write. Historical: the production split was a separate approved operation (AIR-222, performed 28 October 2026, see [Stage 2 install](#stage-2-install-historical-the-write-path-is-retired)). No production apply path remains: Discovery is D1-owned and the installer is read-only (AIR-537).

In bounded mode no discovery chunk and no status read touches the archive. `POST /api/enrichment/discovery/scan` and `/reconcile` answer `409` whenever the mode is not `full` or an archive exists.

## Read-only verification (L0, no write)

Verified side-effect-free observations and SELECT-only preflight are standing-authorized L0; no per-read owner message is needed when connected with appropriate least-privilege credentials. GET routes with repair side effects, forced resolver chunks and any write remain outside L0. See [authorization](../process/authorization-and-escalation.md).

- **Operational check first:** `GET /api/enrichment/pipeline/status?view=operational` (or MCP `epg_pipeline_status` with `view: "operational"`) answers from small records while Discovery commits: phase and next action, executor and lease liveness, the last checkpoint and its stored backlog with its own time. A `discovery_fence` from the detailed status during chunks is the expected outcome of a long scan under a snapshot fence, not a sign that the Workflow failed; read the operational view instead and ask for the detailed one only when its statistics are needed. User `GET /api/catalog/available` and `GET /api/enrichment/view` are not that scan: they should stay 200 while the Workflow runs. HTTP 502 `discovery_fence` on those two paths is an incident ([ADR 0147](../adr/0147-discovery-user-read-snapshot-fence.md)); HTTP 503 with the same `code` is a real pin, loading or held refusal. A `backlog` fact (`chunks` from the continuation, `ledger` from the last chunk's status) of `stale`, `foreign` or `unknown` is a statement about that record, not a count: read its own `observedAt` and `programmeRunId`. When `advanceDiscovery` catches a typed Authority error, the continuation checkpoint (operational `lastCheckpoint` and `discovery.reason`) keeps the allowlisted `error.code` (`discovery_conflict` is not classified as `unknown` from the Error message), plus `failedAt`, `failureKind` (`unique_constraint` | `input_invariant` | `fence` | `other`) and optional `failureConstraint` (`unique.<table>`). The cheap-pass `epg/discovery-status.json` is not rewritten, so `lastChunk` can still read `checkpoint: cheap_pass` with `error: null`. Read `lastCheckpoint`, not `lastChunk`, for the application-error class. `discovery_conflict` is a hard application wait (hourly successor), not a recoverable Workflow step retry. `discovery_workflow_step_failed` is a thrown step exception, not this catch.

- `GET /api/enrichment/pipeline/status` (or MCP `epg_pipeline_status`), the detailed view:
  - **`full`**: no `archive` field.
  - **bounded or frozen:** `archive` = `{ledgerMode, activeItems, uniqueArchivedItems, manifestId, segments, items, bytes}`, and `ledgerTotal` = `activeItems + uniqueArchivedItems` (unique keys of active ∪ archive).
  - **Under D1 discovery authority** the block also says where each figure comes from ([reference](../reference/api/enrichment.md)). `ledgerMode` is the mode recorded in the published generation's own R2 document, not the feature flag; `ledgerMode: "unknown"` with `ledgerModeReason` and `null` archive figures means the status could not prove them (for example the seal record names another generation, or the document changed), not that the ledger is bounded or the archive is empty. `archive.d1` counts rows D1 itself holds; a zero there says nothing about the R2 archive. To decide a move to `bounded`, read `ledgerMode` with `ledgerModeSource: "generation_document"` only.
- `GET /api/enrichment/status`: `ledgerTotal` has the same meaning, and `recognizedFilms` counts verified decisions among the **active** candidates only.
- A consistent offline read for audits:
  1. Take the published active ledger `epg/generations/<runId>/discovery-latest.json`.
  2. Read the manifest version its `archive.manifestId` names.
  3. Read exactly that manifest's segment versions, checking `sha256`.
  4. For a key in both the active ledger and the archive, the active record wins.

  Do not follow `current.json` for history.

## One stuck observation

There is no per-observation retry or lookup. The owner page explains one observation. It offers two guarded writes, and nothing else: sending one terminal observation back to the ordinary queue ([ADR 0061](../adr/0061-discovery-observation-index-and-reconsider.md)), and assigning or rejecting one movie id on one current observation ([ADR 0080](../adr/0080-discovery-identity-correction.md)). Do not improvise a third write.

1. **Read it, read-only.** A bare `/admin/limb` is the attention queue: only an observation the page has confirmed the owner can act on now. It is not the whole register, and an empty attention queue does not mean the limb is empty. Open `/admin/limb?kind=observation` for every unresolved observation of the published generation, including waits and a stale index, and press «Разобрать наблюдение» on the item: one `GET /api/admin/discovery-recovery` ([contract](../reference/api/admin.md#discovery-observation-recovery-get-apiadmindiscovery-recovery)). If the page says observations are unavailable, the generation's [observation index](../reference/domain/discovery-observation-index.md) is missing, torn or of another generation. The next ordinary resolver chunk writes it. Wait for it; a chunk run only to build the index is a series-level operation that needs the owner's approval. A stale index stays in that full list and offers only a reread. It is not an owner action and it is not fixed by opening the page. An unreadable continuation, discovery status, resolver lease or published-EPG marker is also not an owner action: the attention queue says those actions were not checked, and the empty list is not a verified absence.
2. **Read the series.** The panel names the series state; the same is in `GET /api/enrichment/pipeline/status` (or MCP `epg_pipeline_status`): `continuation`, `continuationHealth`, `lastBatch`. The [series states](../reference/domain/discovery-recovery.md#series-states):
   - `continuing` and `recovering`: the next scheduled step takes the queue.
   - `waiting` (TMDB throttling, chunk budget, error delay) and `live_writer` (a live resolver lease): the series moves after the gate or the lease expiry. These are fences that nothing may pass.
   - `stopped` for `missing_secret`: nothing moves until the owner restores `TMDB_API_READ_ACCESS_TOKEN` ([MCP connectivity](mcp-connectivity.md)). A new EPG commit stops the same way.
   - `interrupted` and every other `stopped`: nothing moves until the next EPG commit.
3. **Judge by the rules.** The [verdict table](../reference/domain/discovery-recovery.md#verdicts) gives the answer for each case:
   - An actionable observation is already queued.
   - A future `retryAt` is policy.
   - An `ambiguous` decision with no confirmed movie id and no id already on the decision has no identity form. The panel says that a choice from the title alone is not possible. Reconsideration stays unavailable for that case.
   - A candidate outside the EPG window cannot be resolved until it airs again.
   - A terminal decision on unchanged evidence (`no_more_evidence`) stays out of the resolver's work until new airings arrive. This is the one case the action addresses.
4. **Reconsider only within an approved execution plan.** This is a production write. Agents may run this write only under an existing owner-approved bounded plan or future operation-specific L2 contract; [AIR-358 authorization policy](../process/authorization-and-escalation.md) itself does not permit an autonomous writer. When the panel offers «Повторно направить на проверку», it states the cost (no TMDB request, no resolver run, one decision written), the risk and the effect.
   1. Tick the checkbox naming the exact observation, then press «Подтвердить». This issues a confirmation valid for 10 minutes and changes no decision.
   2. Press «Повторно направить на проверку» once.
   
   The action clears the terminal reason under the resolver lease and keeps the attempt count. The next ordinary chunk makes exactly one more attempt; an uncertain result on the same airings is terminal again at once.
5. **Read the receipt.**
   - **Записано** (`succeeded`): nothing else to do. The next ordinary chunk decides. The panel's fresh read shows the observation back in the ordinary queue.
   - **Резолвер занят** (`lease_held`) or **блокировка в непонятном состоянии** (`lease_unknown`): nothing was written, and the confirmation is kept. Press «Проверить заново» later and execute while it is valid. A malformed lease is replaced by the next ordinary chunk; never edit it.
   - **Отказ** (`refused`, for example `stale_pin` or `record_changed`): the data changed after the check. Check again and confirm anew.
   - **Не записано** (`failed`, a lost compare-and-swap): a chunk wrote the map at the same moment. Check again.
   - **Прервано** (`aborted`): the lease was lost before the write. Nothing was written. Check again.
   - **Исход неизвестен** (`unknown`, or `in_progress` for a key that started and left no receipt): do **not** repeat. Read the observation again. A decision with the `reconsidered` marker of that idempotency key landed. `GET /api/admin/discovery-recovery/receipt?idempotencyKey=…` returns the stored record with its before-image.
   - A warning that the receipt was not stored, or that the index was not refreshed: the write itself is as the receipt says. The index reads as stale until the next chunk, and the action is not offered meanwhile.
6. **Undo is manual.** The action record under `admin/actions/discovery_reconsider/v1/` keeps the previous decision. Restoring it is a separate owner-approved write and rarely needed, because the next uncertain attempt on the same airings makes the observation terminal again.
7. **Do not use a forced `POST /api/enrichment/discovery/resolve` as a targeted retry.** It runs a whole chunk over other observations, with TMDB calls. Running it is a separate owner-approved operation, decided at the series level.
8. **Never edit `epg/discovery-resolution.json`, the index or the resolver lease by hand.** A running chunk rewrites the whole decision map from its own copy, so a manual edit is lost or overwrites the chunk's decisions. The two guarded actions are the only single-decision writes, and each compare-and-swaps under the lease.

## One wrong identity

This is a production write of one decision. Agents do not run it. The owner does, on one real observation, after the code is deployed. [ADR 0080](../adr/0080-discovery-identity-correction.md). It does not start a chunk, call TMDB, or change another observation, a film title, a person name, or a past generation.

1. Open the panel on a limbo observation, or open the closed «Технический поиск проверенного совпадения» under the queue and use «Открыть наблюдение» with the exact observation key. The «Найти запись» field above the queue only compares titles of rows already shown; it does not read the verified index and it is not this key. Read the title, year, duration, airings, evidence key, decision, hypothesis and the coverage sentence. A verified row says which movie id is recorded now and what assign or reject will change. The hypothesis is not a choice. A radio exists only for a movie id the observation already confirmed. A typed id is checked against one catalogue object at confirm, not against a title search. A partial or stale index, and a published-EPG mode this action does not fence, writes nothing.
2. Choose «Подтвердить фильм» or «Отклонить совпадение», the one id, and a short basis. Tick the checkbox that names that key and that generation. Press «Подтвердить идентичность», then «Записать идентичность».
3. Read the receipt. **Записано** means the decision was written and the receipt was stored. The sentence under it says what the write did to shows. While Discovery authority is D1 and `cutover` is `open`, a reject of a currently verified movie assignment also deletes current-generation `published_epg_show` rows with `basis='discovery'` and this observation key in the same batch. A reject of a hypothesis that was not the verified assignment does not run that delete. It does not change EPG generation, catalog admission, fingerprints or the prediction queue. Other observations of the same Film keep their shows. A rejection blocks that id on this decision only and clears that decision's terminal fence, so the next ordinary chunk may look for a different id and will not request the rejected movie card. **Решение прочитано обратно, но квитанция не сохранилась** means the decision landed and the receipt did not: the button then reads «Сохранить квитанцию». That stores the receipt and does not write the decision a second time. A later replay of the stored receipt says the decision was recorded. If the confirmation has expired, the panel says the decision is already written and the receipt will not be saved; do not send a rewritten confirmation. **Исход неизвестен** means do not start a new correction: the same confirmation replays the stored receipt. **Не записано** means the other writer kept the map. A refusal such as a year conflict or a television id writes nothing.
4. If the panel says the index was not refreshed, the list may still show the row until the next ordinary chunk. Do not start a chunk to hide the row.
5. **Undo is manual.** The record under `admin/actions/discovery_identity_correct/v1/` keeps the before-image. Restoring it is a separate owner-approved write. A code revert stops the route and leaves the decision and the record in place. The next ordinary chunk must not verify a rejected id and must not request its movie card. It may search for a different id.

## Revoke one saved identity correction

A production write of one decision; agents do not run it. [ADR 0178](../adr/0178-identity-correction-revoke-event-contract.md). It needs schema 27 (`migrations/0027_discovery_intent_identity_revoke.sql`, applied to production D1 on 19-20 Nov 2026, [evidence](../evidence/d1-migration/air-132-0027-apply-2026-11-19.md)); on a database without it the page says `revoke_schema_not_ready`. The owner needs the original request id of the correction (its receipt).

1. Open the observation in the Limbo detail (or the closed technical search by key). For a saved owner action that the history proves, the identity section shows «Отозвать или заменить это действие»; it opens `/admin/identity/revoke?key=&requestId=` with both fields filled. An action the history does not prove shows the reason and no link. Press «Показать, что изменится». The preview reads the original action, the history of that observation and today's decision; it writes nothing.
2. If it says it cannot revoke, read the reason: `old_action_not_effective` means a later decision or owner action replaced it, `provenance_unproven` or `provenance_ambiguous` mean the history does not prove which action introduced the effect. Nothing is changed in those cases and nothing is restored by hand.
3. To revoke: write the basis, tick the box, press «Подготовить отзыв», then «Выполнить отзыв». To replace instead: use «Или заменить другим решением» (assign or reject another TMDB id, a basis, the box), «Подготовить замену», «Выполнить замену»; the original must still be the live action when you confirm and again when you execute. Read the receipt and the read-back verdict.
4. A revoked `assign` leaves a fence for that id on that observation. To use the id again the owner assigns it again; a new airing or rescore does not. A revoked `reject` removes only that rejection.
5. The ordinary Discovery chunk re-evaluates the observation. Do not start a chunk from this page. `in_progress` means the outcome is unknown: read the preview again, never resubmit blindly.
6. **Undo is a new owner action.** History and intents are append-only; code rollback does not revert D1 rows.

## Assign one movie to a group of observations

A production write of up to 10 decisions; agents do not run it. [ADR 0181](../adr/0181-owner-confirmed-group-assign-of-selected-observations.md). No migration is needed (schema 27).

1. Open «Открыть групповую идентификацию» at the top of `/admin/identity` (or a contextual link from a queue row or the Limbo identity section). You do not need a TMDB id: pick an EPG record from the bounded worklist, or search the catalogue by title, then press «Показать группу для этого фильма» on a Film that shows a trusted TMDB id. If you started from a worklist record, the page says whether that exact record is among the candidates, blocked (with the reason) or absent from the partial list; an absent record is not replaced by a similar one: choose another film or resolve that record on its own in «Лимб». Typing a numeric id is an optional path. Everything up to confirmation is a read and nothing is selected for you.
2. Read the partial candidate list: counts, `more`, `dropped`, and each row's before/after. Tick only the keys you have checked, write the basis, tick the box.
3. «Подготовить» shows the exact selected set with versions. «Подтвердить» issues all children at once; «Выполнить» writes them one by one.
4. Read the per-key receipts. `applied` is written; `conflict`, `refused`, `skipped`, `expired` and `not_attempted` wrote nothing for that key; `unknown` stops the run: read the receipt again, never resubmit blindly.
5. While a group is unfinished the page refuses a new confirmation, also after a reload. A receipt that is not proven is shown as unproven, never as success. The page keeps the group handle until every key is applied or you press «Забыть эту группу». If the answer is lost, partial or unknown (timeout, network, reload), press «Проверить результат записи»: it only reads the stored group. A group that was written but not executed offers the original scope to continue; one that was never stored says so and nothing was written. Never submit a different selection under the same expectation.
6. A partial result is valid. Replay finishes only children without a receipt and never adds keys.
7. Do not start a chunk from this page. **Undo is per key** through the revoke page; code rollback does not revert D1 rows.

## Owner evidence and a stuck owner intent (ADR 0215 decision 6, E2c)

While the `discovery_owner` writer is `pending` or `on`, an owner write (assign, reject, revoke, replacement) commits its `film_identity_evidence` rows in the same batch as the decision history row and the intent receipt ([contract](../reference/domain/film-person.md)). Operationally:

- **`conflict` with the intent still `approved`:** an eligible step could not yield a valid row (for example an issuance without `confirmedAt`) while the writer is active. Nothing was written; read the intent and its issuance, do not force the write. With the writer `off` the same step commits without a row.
- **`unknown`:** the caller does not know the outcome, and this is **not** proof that nothing landed. `ownerDecision` reports `unknown` for any error of the batch, including a lost response after D1 applied it. Read the durable state first: the intent (`state`, `receipt_json`), the current decision and its history revisions, and, while the writer was active, the evidence rows of the intent key. A `receipt` means the whole step committed (decision, history, receipt and its evidence rows are one batch); a replay of the same key returns that receipt and writes no second row. An intent still `running` with no receipt and an unchanged decision and history means the batch rolled back whole (fence, held authority, a stale revision, a commit-time schema guard after a migration or activation, or a row of another identity already stored under the same evidence key). Never retry blindly and never delete a ledger row (the table is append-only); follow [One stuck observation](#one-stuck-observation). A mismatching row is a data question for the evidence owner.
- A replay of a receipted intent returns its receipt and writes no second row.
- Activation, drain and a break are owner-approved operations of [identity evidence writer activation](identity-evidence-writer-activation.md); this runbook authorizes none of them.

## Rollback

- **R1 (stop archiving):** a code revert to a Worker that still reads `DISCOVERY_LEDGER_MODE`, with that binding restored to `frozen` (or absent while an archive exists). On the retired Worker a leftover `frozen` or `full` binding is ignored and the seal stays bounded ([ADR 0156](../adr/0156-retire-discovery-ledger-mode.md)). Nothing is rebuilt or deleted.
- **R2 (code revert to an archive-unaware Worker):** only after an offline, fenced reconstruction:
  1. take a consistent snapshot;
  2. rebuild the full ledger locally, checking payload parity against active ∪ archive;
  3. have a GO/NO-GO reviewed. GO requires the rebuilt ledger's measured commit and chunk memory to be within the proven Workers bound; otherwise R2 is NO-GO;
  4. write it only under a separate approval.

  A plain code revert without these steps drops archived history.
- Archive objects are never deleted by the Worker. Removing unreferenced versions is a separate, owner-approved maintenance decision.
- **Observation index, reconsideration, identity correction and policy exclusion.** A code revert stops the index writes and those actions. Index objects already written stay under their generation and are ignored by an older reader. A decision already reconsidered or identity-corrected stays so. A superseded policy-excluded admission stays superseded. Action records stay. Restoring a before-image or an admission is a separate owner-approved write, not a revert. Deploying `catalog_policy_exclude` does not exclude any production film.

## Offline split (AIR-221 rehearsal)

The production split replaces the Worker's own first bounded commit, which would parse today's full ledger once. An offline tool plans the split from a verified snapshot, and `applySplit` installs it into an offline store. This page covers the offline rehearsal only. Historical: the one production apply was [AIR-222](https://trello.com/c/9Y4G9DG6) on 28 October 2026, before Discovery became D1-owned. That writer is retired (AIR-537) and nothing here authorizes a production install.

- `node scripts/discovery-ledger-split.mjs plan --snapshot /abs/snapshot --output /abs/private/dir` reads a `consistent_fenced` snapshot ([export runbook](r2-snapshot-export.md)) and writes, in the private output directory:
  - `plan.json`: the ordered writes, each with its precondition;
  - `objects/`: the exact bytes of every write;
  - `plan-report.json`: aggregates only.

  It stops (verdict `NO-GO`, exit 3) on any of:
  - a duplicate key;
  - a record without `seenInLatestSnapshot`;
  - an active record of another run;
  - a root ledger that differs from its generation copy;
  - an existing archive;
  - an unpublished generation.
- **Write order and preconditions:**
  1. A write-once copy of the source ledger, `epg/discovery-archive/v1/sources/<manifestId>/discovery-latest.json`, byte for byte. It is the rollback copy, because both live copies are replaced below.
  2. Segment versions, then the manifest, all create-only. An object that already holds the planned bytes is skipped; any other object at that key stops the apply.
  3. The archive pointer `current.json`, create-only.
  4. The active ledger in the published generation's copy, `epg/generations/<P>/discovery-latest.json`, by a CAS on the snapshot's ETag of the full ledger. This is the copy every Worker reader and the next commit load: `loadJSON` pins `epg/discovery-latest.json` to the published generation.
  5. The same bytes at the root key `epg/discovery-latest.json`, by a CAS, so the two copies stay equal.

  AIR-221 (27 October) planned only the root key and kept the generation copy. The Worker would not have read that split: its first commit would still have parsed the full ledger. AIR-222 found and fixed this ([evidence](../evidence/discovery-ledger-split-air-222-stage-1-2026-10-28.md)).
- **Fence.** Before the first write, every precondition is checked. Before each write, the apply re-checks:
  - the published pointer ETag;
  - that no `sync.json` is in stage `epg`;
  - the discovery lease, which the apply holds throughout.

  The archive pointer moves before either ledger copy:
  - **A commit in between** publishes a new generation, so the pointer fence stops the apply. Any Worker that meets the archive pointer reads the full ledger plus the archive as `frozen` or `bounded`, without loss.
  - **Rerun.** A rerun after any stop completes the same state; a rerun after success writes nothing.
  - **Readers after a split.** Status and chunks read the active ledger immediately. Archived rows were never actionable, and a chunk keeps its progress per candidate, not by ledger index.
- **With the flag unset.** After the split, a Worker with `DISCOVERY_LEDGER_MODE` unset acts as `frozen`:
  - its commit starts from the active ledger and reads re-entries from the archive;
  - departures stay active, and nothing is archived.

  This is the intended first production state; `bounded` is a separate step.
- **Rehearsal.** `node scripts/discovery-ledger-split.mjs rehearse --snapshot /abs/snapshot --output /abs/private/dir --heap` plans, then proves the following on a copy-on-write store over the snapshot:
  - the install and its R2 reconstruction parity;
  - replay and resume;
  - six refused fences;
  - the next commit with the flag unset (frozen) and in `bounded` mode, and a chunk, against full mode;
  - that the Worker's own read path returns the installed active ledger;
  - with `--heap`, the commit and chunk memory in full, frozen and bounded mode.

  The verdict is in `report.json` (exit 0 GO, exit 3 NO-GO). On a production-sized snapshot it takes a few minutes, needs about 1.5 GB of RAM, and with `--heap` about 3 minutes more. See the dated [rehearsal evidence](../evidence/discovery-ledger-split-rehearsal-2026-10-27.md).
- **Privacy.** Keys, titles and object bytes stay in the private output directory. Only `report.json` aggregates go to the repository or Trello.

## Switching `frozen` to `bounded` under D1 authority (historical)

Production already seals as `bounded` and the Worker variable is retired ([ADR 0156](../adr/0156-retire-discovery-ledger-mode.md)). The steps below are the earlier owner-approved switch; they are not a current flag operation.

This is the plan for one operation, written so that it can be approved or refused as a whole. It granted nothing: setting `DISCOVERY_LEDGER_MODE=bounded` was a production writer change and needed its own operation-specific owner approval. The memory and drain figures are in the [AIR-429 evidence](../evidence/discovery/air-429-bounded-drain-2026-11-11.md); the earlier rehearsal is [AIR-426](../evidence/discovery/air-426-bounded-transition-rehearsal-2026-11-11.md); the rule is [ADR 0112](../adr/0112-bounded-ledger-departure-budget.md) (Accepted as a design; it does not authorize the switch).

**What it does.** Nothing is switched by a deploy. With the flag set, every EPG commit archives the observations that left the scan since the previous generation (the daily flow) and at most 4,000 of the backlog the `frozen` ledger collected (26,491 on 10 November), lowest keys first. The rest stay active and not seen. The generation document carries `"drain":{"backlog":N,"cap":4000}` until the backlog is gone, and the status reports it in `archive.drain`. The backlog of B drains in at most `ceil(B / 4000)` commits (7 for 26,491), one per natural EPG publication, whatever the daily flow. Nothing is deleted.

**Preconditions (read-only, all must hold):**

1. The change that sends every D1 ledger to the paged chunk and the change of ADR 0112 are deployed: `Test and build`, `Test shard 2 of 3`, `Test shard 3 of 3` and `Deploy to Cloudflare` succeeded on the merge commit.
2. `feature_flags` shows `DISCOVERY_LEDGER_MODE` absent or `frozen`; the archive pointer exists and the manifest it names is readable; the D1 transfer is `committed` and the seal is `done`; no EPG run is in stage `epg` or `seal`.
3. The last completed EPG run published, and its ledger phase ran with the packed batches (`epg_phase` exit event with `batches` and `writeMs`).
4. **The memory gate is decided by the owner.** The strict target of the card (not worse than the frozen commit) is not met by any cap: the floor, with only the daily flow departing, is 4-12 MB of Node old space above the frozen commit (see the evidence). The owner accepts that margin, or does not switch.
5. The owner is reachable around the next due time (17:00 Madrid).

**Holdpoints.**

1. **Owner GO**, naming the flag and its value, the time window and the rollback below. Set the Worker variable only after a published run and well before the next due time; a deploy does not set it.
2. **Read back** `feature_flags` (`bounded`, valid). Start nothing: the next natural run is the first bounded commit. No manual `epg_sync_start` or `epg_sync_step`.
3. **Watch each natural run** with `epg_status` and the `epg_phase` events, reads only: the commit stage, `orchestration.seal` moving, publication.
4. **Verify after every publication:** `ledgerMode: bounded` proven from the generation document; `archive.drain.backlog` fell by 4,000 (or to zero); active observations equal the scan plus the backlog; D1 archive rows grew by the departures; the manifest totals equal the archive before plus the departures. After the last one, `drain` is absent and active observations equal the scan.

**Stop conditions.** A commit ends with a memory or resource error, or the EPG run records a failure on the commit stage, or the backlog does not fall between two publications: do not retry by hand and do not reset a lease or transfer. Unset the flag (below) and read the state. A published generation stays valid throughout: the archive pointer is swapped only while the published pointer, the lease and the run are unchanged, and a stopped commit leaves the previous generation published with an archive it can read. The executor retries within its failure budget (5 consecutive, 12 total failures), after which the run stays failed until someone acts.

**Rollback.** Unset the flag (rollback R1 above): the next commit acts as `frozen`, writes no archive and archives no D1 row, and re-entry still reads the archive. A backlog still held stays active; nothing is rebuilt or deleted. A code rollback does not undo the archive, the D1 archive rows or the flag.

**Not known before the first run.** The isolate memory headroom against the Node-relative figures, the cost of a D1 archive batch and the D1 write quota left, and how long the ledger phase takes on the instance that runs it. These are what the watch measures; none is a reason to run a commit earlier than the owner decides.

## Stage 2 install (historical; the write path is retired)

The Stage 2 production install of 28 October 2026 (two owner-approved runs: a transport failure with an unknown outcome stopped the first after the segments, the dry run showed the manifest in place, the second run completed the pointer and the CAS swaps) is recorded in the [stage 2 evidence](../evidence/discovery-ledger-split-air-222-stage-2-2026-10-28.md). That record is historical and **not executable**: Discovery is D1-owned, so writing the R2 ledger objects would create a second authority, and the apply path was removed under AIR-537.

`node scripts/discovery-ledger-install.mjs --plan /abs/private/plan --output /abs/private/dir` is the only remaining mode. It uses the snapshot credential (`R2_SNAPSHOT_*`), sends `GET`/`HEAD` only and reports, per planned object, whether it is absent, already holds the planned bytes, still holds the source version or conflicts, plus the fence (published pointer ETag and run, `sync.json` stage, the discovery lease, the archive pointer). Verdict `READY` or `ALREADY-INSTALLED` exits 0, `NOT-READY` exits 3, `--apply` exits 2. Nothing is written and no write credential is read.

## Offline benchmark

`node scripts/discovery-ledger-benchmark.mjs --output /absolute/dir/outside/repo [--sizes 20,40,63,90]` builds synthetic stores and reports the active and archive sizes, plus the smallest Node old space at which the commit and a chunk complete in each mode. It is offline: no network, no R2, no production data. The numbers are relative to Node, not the Workers isolate limit. See the dated [benchmark evidence](../evidence/discovery-ledger-benchmark-2026-10-27.md).

## Chunk memory diagnostics (AIR-342)

- **Confirm the cause.** Telemetry of the resolve request or the `POST /mcp` step shows `outcome: exceededMemory`. A status left at `checkpoint: cheap_pass` with an `orphaned` continuation is a chunk that died after its cheap pass. Read it with `epg_pipeline_status`; never repeat the chunk to observe it.
- **Offline profile.** Run `npm run build`, then `node --expose-gc scripts/discovery-chunk-profile.mjs [--items 37000] [--films 3300] [--decisions 4400] [--call chunk|status|footer] [--interrupted]`.
  - It replays one chunk of the built Worker against a synthetic generation of production size. It makes no request and needs no data.
  - `--call status` and `--call footer` replay the two status reads. `--interrupted` stores the interrupted state, in which the pipeline status also evaluates the recovery permit ([AIR-344 evidence](../evidence/discovery/air-344-status-memory-2026-11-04.md)).
- **Status reads.** An `exceededMemory` end of `GET /api/enrichment/pipeline/status`, or an `epg_pipeline_status` slower than the client's 60 s, makes a recovery preflight unreadable. Do not confirm without a fresh `eligible`.
  - Compare the smallest `--max-old-space-size` a run completes in; the script header shows the loop.
- **Reading the figures.** Node heap ranks code versions; it is not workerd's 128 MB limit. The dated reading is in the [AIR-342 evidence](../evidence/discovery/air-342-chunk-memory-2026-11-04.md).

## D1 chunk timing, lease and client timeout

A D1 chunk has three clocks that must all fit: the MCP client's timeout (about 60 s for some clients, longer for others), the 90 s lease TTL, and the Workers invocation itself. A step that outlives its client ends as `canceled` in Workers telemetry with no HTTP status; a chunk that outlives its lease ends as `resolver lease lost`.

- **Tell them apart (read-only).** Workers telemetry for the step: outcome `canceled` with a wall time near the client's timeout is a disconnect; `exceededMemory` is memory ([chunk memory](#chunk-memory-diagnostics-air-342)); `ok` with HTTP 200 and a continuation `error` / `resolver lease lost` is a lost lease. The step diagnostic's `timings` (`failedAt`, `sinceStartMs`, `renewals`) says which phase found the lease gone.
- **A `wall_budget` stop.** `partial` with `error: wall_budget` and a status `retryAt` five minutes ahead means selection or the write budget ran out **before any TMDB candidate was started**, and the hop backs off. It is not a TMDB failure and not a lost lease; the `timings` show which phase used the time. `pages` on a paged chunk is the number of selection queries, not a full-ledger page count. `remaining` is the global SQL actionable set minus settled and deferred keys, not the selected page; `stage=complete` only when that remaining is 0 and cheap work is done. Repeated `wall_budget` with `checked: 0` and `cheapMs: 0` means no candidate was started; after the keyset change that should not repeat merely because the ledger is tens of thousands of rows. Repeated `wall_budget` with `checked: 0`, `tmdbCalls: 0` and **large `cheapMs` / `writeMaxMs` / `assignment.replayed`** was the 16 November 2026 starvation: replay and cheap writes used the TMDB window and multiplied the slowest batch into the checkpoint reserve. After the AIR-492 follow-up, cheap/replay leave room for one TMDB start while eligible candidates remain; Workflow/MCP diagnostics must show `wall_budget`, not `unknown`.
- **A per-candidate budget defer.** `deferred > 0` with `error: null` and no status `retryAt` means a candidate already made a TMDB call (or timed out) and could not be stored. That key has `retry_at` and payload `deferReason: wall_budget`; it is not `checked` and not `verified`. The Workflow continues the series so other eligible keys move. Do not treat this as a five-minute stall. When `remaining` is already 0 and only those waiters remain, `waitingRetry > 0` keeps the generation `partial` with a series `retryAt` until that fence; it is not `complete`. A repeating `0 checked / 1 TMDB / 5 min backoff` while `remaining` stays large is the pre-fix starvation; after the defer fix that pattern should not persist for hours. Do not run a chunk to observe it. A TMDB miss past `persistLimit` does not start a second defer write: the fairness fence is stored **before** the request. Two consecutive late hops must fence different eligible keys.
- **`admission_identity_conflict`.** The chunk found a Film whose identity already belongs to another film id in the catalog and refused to merge them. It wrote no decision for that candidate and backed off one hour. Resolve the two Film ids through the owner identity review; do not edit admission rows by hand.
- **A slow D1.** The step diagnostic's `timings.writeMaxMs` is the slowest write batch the chunk saw. When it is large the chunk starts fewer units of work and may store `wall_budget`; the walk time (`walkMs`) and `cheapMs` say where the rest went. Slot replay of already-verified keys is not allowed to exhaust the TMDB start window. Do not repeat the step to observe it.
- **`cheapRemaining`.** The cheap pass (screened non-films, known aliases, hot Film airings) writes a bounded part per chunk. A positive value is work the next chunk finds again, not a failure: the continuation keeps going while it is positive and completes only when it and `remaining` are both zero.
- **Never revive a lease.** An expired lease stays expired: the D1 renewal needs `expires_at` in the future, and nothing here lowers that condition, raises the TTL, or falls back to R2. A hop that finds its lease gone writes nothing.
- **Generation moves with every continuation write.** `discovery_authority.generation` rises by one for each fenced write and for each continuation write, so a series of three continuation writes moves it by three. A counter ahead of the rows' own `generation` (which keep the generation of the write that stored them) is expected.
- **Preflight before any chunk.** Read the marker, the continuation record, the lease row and `epg_pipeline_status` fresh. A `running` record with an expired lease is an orphan; an `error` / `resolver lease lost` record writes nothing and ordinary steps may run a new chunk. Do not repeat a step to observe it.
- **Evidence.** [Dated reproduction and timings](../evidence/d1-migration/air-352-chunk-budget-2026-11-05.md).

## A stalled D1 ledger seal (`discovery_transfer` is `loading`)

**Symptoms.** `epg_status` shows `stage: epg` with `error: discovery_incomplete`; `epg_pipeline_status` and every ledger reader fail with `discovery_incomplete`; no new EPG generation is published. Telemetry shows an EPG commit step (`generation_publish`) with outcome `canceled` after about two minutes and a high CPU time.

**Read-only L0 preflight (SELECT only).** `discovery_transfer` (`state`, `programme_run_id`, `batches`), `discovery_lease` (is it expired), `discovery_authority` (marker and programme), `discovery_observation` grouped by `residence` and `programme_run_id` (`retiring` against `active`), and the counts of decisions, admissions and history. A stalled seal has `retiring` rows of the previous run and a few `active` rows of the new one, and no decision, admission or history row changes.

**What is open.** The catalog, the status and the continuation are readable and marked `transfer: loading` ([reference](../reference/domain/candidate-discovery.md#reads-while-a-ledger-seal-is-loading)), so predictions and the EPG input scan can read. Ledger reads and every write stay closed.

**What not to do.** Do not repeat the EPG commit: a retry takes the expired lease and replays the seal from the first observation, so it is cancelled again and an interrupted attempt can leave less written than the one before. A killed attempt also holds its lease for the 90 s TTL. Do not reset the lease or the transfer, edit `discovery_observation`, or switch the marker. These are not ordinary retry tools; each would require its own specifically approved high-impact recovery plan, and none finishes the seal.

**Recovery order ([ADR 0092](../adr/0092-resumable-bounded-ledger-seal.md), Accepted; each remaining writer step needs its own owner approval).** Production already has migration `0012` ([apply record](../evidence/d1-migration/air-357-0012-apply-2026-11-05.md)): schema 12 and an idle `discovery_seal` row. Next is a fresh read-only preflight, then one EPG commit (a `loading` transfer without a job is taken over by the seal, which flips the previous ledger once); repeated `epg_sync_step` while `nextAction` is `continue` (stage `seal`: ledger, catalog, publish); a readback of the transfer, published pointer and counts; a Predictions check. A cancelled step is safe to repeat; the cursor and the rows agree. Do not run a commit or step before its approval.

**Earlier note.** The seal must finish in explicit bounded steps; that handoff is a separate delivery, and its production steps (a read-only preflight, a bounded recovery, a readback, one EPG commit, a prediction check) may be covered by one owner-approved bounded execution plan with explicit holdpoints, independent readbacks and the existing safety guards. No new autonomous recovery is authorized by this documentation. Evidence: [stalled seal](../evidence/d1-migration/air-355-incident-seal-loading-2026-11-05.md).

## Commit memory diagnostics (AIR-263)

**Phase markers.** Every EPG commit logs one `{"event":"epg_phase"}` line per phase edge (`enter`, `exit` or `error`). Each line holds `runId`, `phase`, `at`, `elapsedMs` on exit, and only counts or byte sizes the step already holds. It never holds titles, film ids, slugs, HTML or payloads.
- **Commit:** `epg_input_scan` (exit: `films`, `discovery`, `catalog`), `generation_publish`, and `generation_copy` (resume path).
- **Tail:** `finish_sync` and `queue_refresh`.
- **Diary stage:** each line adds `attemptId` and `sinceDiaryMs`. The phases are `diary_state_load`, `diary_page_fetch` (exit: `page`, `status`, `bytes`), `diary_page_parse` (exit: `rows`), `diary_history_merge` (exit: `entries`), `diary_facts_apply` with `diary_facts_result` (`films`, `written`, `skipped`), and `diary_state_save` (exit: `outcome`).
- **Removal lookup:** `removal`.
- **Ledger staging (`seal_stage`, AIR-444):** the one line `seal_stage` (enter, exit or error) and, inside it, `seal_stage_plan` (exit: `elapsedMs` of the planner before any archive write, `departures`, `backlog`), `seal_stage_archive` (exit, or error with a closed `reason` (`discovery_lease`, `step_lease_expired`, `step_fenced`, `fence_lost`, `version_exists`, `other`) when the loop stops; only when something departs: `elapsedMs`, `segments`, `fences`, `fencesSkipped`, `bytes` and three non-overlapping sums of waits: `fenceMs` (every full fence of the commit: segments, manifest, pointer), `readMs` (reads of existing segments) and `putMs` (the bucket puts of the segments alone); the rest of `elapsedMs` is serialization, hashing and the manifest and pointer puts) and `seal_stage_emit` (exit: `elapsedMs` of the generation document upload, `items`, `bytes`). Counts and milliseconds only.

**Reading a long `seal_stage`.** The step lease is 5 minutes and every archive fence renews it. Compare `seal_stage_plan.elapsedMs`, `seal_stage_archive.elapsedMs` (with `fenceMs` against `putMs`) and `seal_stage_emit.elapsedMs` with the `seal_stage` total. A step that runs past 300 s without a fence ends as `step_lease_expired` in the EPG control record, not as `epoch_mismatch`; the stored epoch (`epg_orchestration_document`, key `mode`) shows whether the epoch really moved. A `seal_stage` that errors after its archive pointer moved leaves the previous generation published with an archive that the next commit continues from (`alsoArchived`).

**Reading an `exceededMemory` end.**
1. In Workers Observability, filter the request id of the `exceededMemory` event.
2. The last `epg_phase` `enter` without its `exit` is the phase that died.
3. A missing `exit` is not evidence of a missing write. A phase logs its `exit` only after its write returned, so a request killed between the two leaves the write done and unlogged. Check what was persisted with a safe read-only read: the sync status, and `GET /api/letterboxd/diary` for the diary `state` and `entries`.
4. This is read-only; never repeat the commit to observe it.

**Offline profile.** `npm run build`, then `node --expose-gc scripts/epg-memory-profile.mjs [--full] [--gc-at-markers] [--concurrency 2] [--scale 1]`. The commit-sized replay, including a D1 publication stand-in, is `node --expose-gc scripts/epg-commit-memory-profile.mjs --child --mode stream` (and `--mode legacy` for the in-memory parse). Node heap is not the Workers isolate limit. The dated Node reading is in [the 3 November memory evidence](../evidence/epg-commit-memory-2026-11-03.md). The workerd check that a plain stream is refused and a fixed-length stream stores the counted size is in [the 3 November R2 length evidence](../evidence/epg-r2-known-length-2026-11-03.md).
- It replays the built Worker against synthetic objects of the production sizes from an R2 size listing. It makes no request and needs no data.
- It prints heap and RSS per phase. With `--gc-at-markers` the enter and exit figures are retained data; without it they include uncollected garbage.
- Node heap is not workerd's 128 MB isolate limit: the figures rank phases.
- The 30 October reading is in the [evidence](../evidence/epg-diary-oom-profile-2026-10-30.md).

## Wall time of the staged publication (AIR-353)

A recoverable Workflow stop (`step_cap` and the other `DISCOVERY_WORKFLOW_RECOVERABLE` reasons) is supposed to open `series+1` after `recovery.dueAt`. The hourly cron is the fallback. On 10 November 2026 the cron ran at 21:00, 22:00 and 23:00 Europe/Madrid with the projector window granted on the same tick, instance `_0` already `complete`, and no `_1`; the reconcile outcome was not logged ([AIR-428 evidence](../evidence/orchestration/air-428-discovery-step-cap-recovery-2026-11-10.md)). After that change a scheduled `projector_window` is retried in the same tick after the window expiry, and every attempt logs `discovery_workflow_reconcile`. Read those lines (reason, attempt, series) plus the Workflows instance list; do not treat a green cron as recovery. Do not manually create or retry a Workflow instance without a separate owner operation.

The hourly cron in the window between the committed ledger seal and the publish step (the authority names the new run, the pointer still the old one) does two things, both fail-closed: `reconcileDiscoveryWorkflow` answers `generation_handoff` and creates and writes nothing, and the D1 enrichment projector answers `deferred`/`generation_pending` and reads no catalog (a missing R2 copy of the old generation is not an input failure there). `input_missing: epg/generations/<run>/discovered-films.json` in a cron summary is the projector's own text; the reconcile never reads that object. After the publish both continue on their own. See [the RCA](../evidence/discovery/air-363-generation-handoff-input-missing-2026-11-07.md).

After the catalog, the publication runs as three `epg_sync_step` calls with `seal.phase` `publish`, `finalize` and `queue` ([ADR 0096](../adr/0096-bounded-seal-publication-steps.md), Accepted). Each answers `stage: seal` and `nextAction: continue`; the last answers `complete`. The per-phase wall times are in the Worker log as `epg_phase` events (`seal_publish`, `seal_finalize`, `finish_sync`, `seal_queue`, `queue_refresh`) and the request total as the `durationMs` of the `epg_continuation` event. A call that times out on the client is an unknown outcome: read back `epg_status` and `seal.phase` before the next call, do not repeat it blindly. A step is safe to repeat once it is known not to be running; a cancelled step can hold the discovery lease for up to 90 s, and a call during that time answers `busy`. That answer carries the holder's real expiry: `discovery.nextCatchUpAt` is the lease's `expires_at` plus 3 s (never more than one lease TTL plus 3 s from now), `discovery.retryAfterSec` is the same wait in whole seconds, and `discovery.busyKind` is `lease_held`. Wait until then and call the same `runId` once; do not call earlier (the answer is `busy` again) and do not reset the lease. `busyKind: lost_race` (the holder finished between the failed take and the read; no expiry is known) waits 5 s. A hard conflict is not a wait: `discovery_fence`, a different run or generation, or an error answer stops the attempt. Measurements: [AIR-362 evidence](../evidence/d1-migration/air-362-seal-busy-wait-2026-11-07.md).
