# Bounded discovery ledger: modes, verification and recovery authorization

**Recovery proportionality:** a failed or deferred **single discovery observation** is normally recovered by the published next eligible chunk, not by replaying the entire discovery archive, exporting a full R2 snapshot or rebuilding a global ledger. These expensive procedures below are reserved for actual archive corruption, authority rollback or bulk split. Preserve the resolver lease, generation fencing, owner authorization for explicit runs and the rule of one chunk per request; they prevent two writers from overwriting the same decision map. A safe status read is not a reason to reset a lease or force a whole chunk early. See [risk classification](../process/agent-workflow.md#risk-proportional-operational-safeguards).

This page describes how to operate the discovery ledger modes of [ADR 0034](../adr/0034-bounded-discovery-ledger.md), implemented in [AIR-220](https://trello.com/c/uPvMc5ww). It does not grant permission for anything. A deploy changes nothing by itself: the default `DISCOVERY_LEDGER_MODE` is `full`, the unchanged single growing ledger. Setting `bounded`, splitting the existing production ledger and any rollback are separate owner-approved operations ([AIR-221](https://trello.com/c/9ZiVygrd) rehearsal, [AIR-222](https://trello.com/c/9Y4G9DG6) rollout).

## What each mode does at the EPG commit

| `DISCOVERY_LEDGER_MODE` | Archive absent | Archive present (`epg/discovery-archive/v1/current.json` exists) |
| --- | --- | --- |
| unset or `full` | Single growing ledger, as before AIR-220 | Acts as `frozen`; never rebuilds the full ledger in the Worker |
| `frozen` | Same as `full` (no marker written) | No new archive write. Departures stay in the active ledger; re-entries and counts still use the archive |
| `bounded` | The first commit creates the archive from the departures of the previous ledger | Active ledger = the latest scan's candidates; departures go into new write-once segment versions, a manifest version, then a CAS of `current.json`; then the generation is published |

The commit runs this under the discovery lease. It stops without publishing if:

- the published generation pointer changed (its etag differs from the one read at the start);
- the lease was lost;
- `sync.json` no longer names the run in stage `epg`;
- the archive pointer CAS lost a race;
- the published EPG authority already names a programme run and that run's ledger object cannot be read;
- that authority's ledger, or the compatibility copy used in its place, names a different programme run.

Such a stop leaves either the previous archive with some unreferenced versions, or the new archive plus the previous published generation. Both are consistent (ADR 0034, section 3). A missing or mismatched ledger stops before those writes: the archive pointer, the generation files and the published pin stay put. An empty predecessor is only used when the authority has no programme run yet. Retrying the same run is safe.

A stored ledger that exposes `body` or `text` is folded one candidate at a time. The next generation document is written as bytes, pulled one chunk at a time, and is not parsed back into objects. Its UTF-8 length is counted on that same decision walk, and the generation put is the readable side of a fixed-length stream of that exact size. A short or long body fails the put and stops before the published pin moves. Copying a generation object onto its stable key uses the stored object size the same way; a missing size is not replaced by reading the object into a string. A string put already has a known length. A `json`-only object is still parsed whole. Bounded mode still holds departure records as objects until the archive write. The production split remains a separate approved operation and is not started by setting the mode on its own initiative.

In bounded mode no discovery chunk and no status read touches the archive. `POST /api/enrichment/discovery/scan` and `/reconcile` answer `409` whenever the mode is not `full` or an archive exists.

## Read-only verification (L0, no write)

Verified side-effect-free observations and SELECT-only preflight are standing-authorized L0; no per-read owner message is needed when connected with appropriate least-privilege credentials. GET routes with repair side effects, forced resolver chunks and any write remain outside L0. See [authorization](../process/authorization-and-escalation.md).

- `GET /api/enrichment/pipeline/status` (or MCP `epg_pipeline_status`):
  - **`full`**: no `archive` field.
  - **bounded or frozen:** `archive` = `{ledgerMode, activeItems, uniqueArchivedItems, manifestId, segments, items, bytes}`, and `ledgerTotal` = `activeItems + uniqueArchivedItems` (unique keys of active ∪ archive).
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
3. Read the receipt. **Записано** means the decision was written and the receipt was stored. The sentence under it says what the next ordinary chunk will do with shows. It does not mean the catalogue, search and detail were rewritten by this click. A rejection blocks that id on this decision only and clears that decision's terminal fence, so the next ordinary chunk may look for a different id and will not request the rejected movie card. **Решение прочитано обратно, но квитанция не сохранилась** means the decision landed and the receipt did not: the button then reads «Сохранить квитанцию». That stores the receipt and does not write the decision a second time. A later replay of the stored receipt says the decision was recorded. If the confirmation has expired, the panel says the decision is already written and the receipt will not be saved; do not send a rewritten confirmation. **Исход неизвестен** means do not start a new correction: the same confirmation replays the stored receipt. **Не записано** means the other writer kept the map. A refusal such as a year conflict or a television id writes nothing.
4. If the panel says the index was not refreshed, the list may still show the row until the next ordinary chunk. Do not start a chunk to hide the row.
5. **Undo is manual.** The record under `admin/actions/discovery_identity_correct/v1/` keeps the before-image. Restoring it is a separate owner-approved write. A code revert stops the route and leaves the decision and the record in place. The next ordinary chunk must not verify a rejected id and must not request its movie card. It may search for a different id.

## Rollback

- **R1 (operational):** set `DISCOVERY_LEDGER_MODE=frozen`. Nothing is rebuilt or deleted, and the active ledger grows again from the next commit. Removing the value has the same effect while an archive exists.
- **R2 (code revert to an archive-unaware Worker):** only after an offline, fenced reconstruction:
  1. take a consistent snapshot;
  2. rebuild the full ledger locally, checking payload parity against active ∪ archive;
  3. have a GO/NO-GO reviewed. GO requires the rebuilt ledger's measured commit and chunk memory to be within the proven Workers bound; otherwise R2 is NO-GO;
  4. write it only under a separate approval.

  A plain code revert without these steps drops archived history.
- Archive objects are never deleted by the Worker. Removing unreferenced versions is a separate, owner-approved maintenance decision.
- **Observation index, reconsideration and identity correction.** A code revert stops the index writes and both actions. Index objects already written stay under their generation and are ignored by an older reader. A decision already reconsidered or identity-corrected stays so. Action records stay. Restoring a before-image is a separate owner-approved write, not a revert.

## Offline split (AIR-221 rehearsal)

The production split replaces the Worker's own first bounded commit, which would parse today's full ledger once. An offline tool plans the split from a verified snapshot, and `applySplit` installs it. This page covers the offline rehearsal only: applying a plan to production is [AIR-222](https://trello.com/c/9Y4G9DG6), with its own approval, a fresh fenced snapshot and a writer that is not part of this tool.

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

## Stage 2 install (owner approval required for every run that writes)

`scripts/discovery-ledger-install.mjs` applies a plan from the section above to the production bucket through the S3 API. R2 evaluates `If-None-Match: *` and `If-Match` on `PutObject` atomically, so the create-once and compare-and-swap semantics of `applySplit` hold against production exactly as in the rehearsal; the Worker's own `applySplit`, fences and lease code run unchanged over an S3-backed store.

- **Dry run (default, read-only).** `node scripts/discovery-ledger-install.mjs --plan /abs/private/plan --output /abs/private/dir` uses the snapshot credential (`R2_SNAPSHOT_*`), sends `GET`/`HEAD` only and reports, per planned object, whether it is absent, already holds the planned bytes, still holds the source version (the ledger copies) or conflicts, plus the fence: the published pointer ETag and run, `sync.json` stage, the discovery lease and the archive pointer. Verdict `READY` (exit 0), `ALREADY-INSTALLED` (exit 0) or `NOT-READY` (exit 3). Nothing is written.
- **Apply.** `--apply --approved-production-writes` with a separate write credential in the environment, `R2_INSTALL_ACCESS_KEY_ID` / `R2_INSTALL_SECRET_ACCESS_KEY` (an R2 API token with Object Read & Write on bucket `iptv` only). It repeats the dry run, stops on `NOT-READY`, then runs `applySplit` under the discovery lease. The store refuses, before any request, a write to a key that is not in the plan (plus the lease) or a write without a precondition; it never deletes. Receipts (key, ETag, SHA-256, time) go to the private output directory. Afterwards the Worker's own `loadJSON` must return the installed active ledger (`INSTALLED`), or the report says `INSTALLED-UNVERIFIED`.
- **Preconditions for a production apply.** Both Scheduled Tasks paused by the owner and verified; no active lease; `sync.json` not in stage `epg`; a fresh `consistent_fenced` cut whose aggregate equals the one the plan was made from, or a new plan from the fresh cut; the dry run `READY`; the explicit owner approval for this run. The daily commit (17:00 Madrid) replaces the ledger, so a plan is void after it.
- **Stops and resume.** Any fence loss or lost CAS stops the apply with the receipts written so far; nothing is deleted, and the Worker reads the full ledger plus the archive losslessly from the moment the archive pointer exists. A rerun completes the same state; a rerun after success writes only the lease.
- **After the install.** The flag stays unset: the Worker acts as `frozen`. Resume the Scheduled Tasks (owner), then observe at least one hourly chunk and one daily commit through `epg_pipeline_status` (`archive` block, `ledgerTotal`) and Workers Observability (`exceededMemory`) before `DISCOVERY_LEDGER_MODE=bounded` is considered, which is its own approval.
- **Performed.** The production install of 28 October 2026 (two approved runs: a transport failure with an unknown outcome stopped the first after the segments, the dry run showed the manifest in place, the second run completed the pointer and the CAS swaps) is recorded in the [stage 2 evidence](../evidence/discovery-ledger-split-air-222-stage-2-2026-10-28.md).

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
- **A `wall_budget` stop.** `partial` with `error: wall_budget` means selection or the candidate phase ran out of budget with candidates waiting, and the chunk backed off for five minutes. It is not a TMDB failure and not a lost lease; the `timings` show which phase used the time. `pages` on a paged chunk is the number of selection queries, not a full-ledger page count. Repeated `wall_budget` with `checked: 0` and `cheapMs: 0` means no candidate was started; after the keyset change that should not repeat merely because the ledger is tens of thousands of rows.
- **`admission_identity_conflict`.** The chunk found a Film whose identity already belongs to another film id in the catalog and refused to merge them. It wrote no decision for that candidate and backed off one hour. Resolve the two Film ids through the owner identity review; do not edit admission rows by hand.
- **A slow D1.** The step diagnostic's `timings.writeMaxMs` is the slowest write batch the chunk saw. When it is large the chunk starts fewer units of work and may store `wall_budget`; the walk time (`walkMs`) and `cheapMs` say where the rest went. Do not repeat the step to observe it.
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

The hourly cron in the window between the committed ledger seal and the publish step (the authority names the new run, the pointer still the old one) does two things, both fail-closed: `reconcileDiscoveryWorkflow` answers `generation_handoff` and creates and writes nothing, and the D1 enrichment projector answers `deferred`/`generation_pending` and reads no catalog (a missing R2 copy of the old generation is not an input failure there). `input_missing: epg/generations/<run>/discovered-films.json` in a cron summary is the projector's own text; the reconcile never reads that object. After the publish both continue on their own. See [the RCA](../evidence/discovery/air-363-generation-handoff-input-missing-2026-11-07.md).

After the catalog, the publication runs as three `epg_sync_step` calls with `seal.phase` `publish`, `finalize` and `queue` ([ADR 0096](../adr/0096-bounded-seal-publication-steps.md), Accepted). Each answers `stage: seal` and `nextAction: continue`; the last answers `complete`. The per-phase wall times are in the Worker log as `epg_phase` events (`seal_publish`, `seal_finalize`, `finish_sync`, `seal_queue`, `queue_refresh`) and the request total as the `durationMs` of the `epg_continuation` event. A call that times out on the client is an unknown outcome: read back `epg_status` and `seal.phase` before the next call, do not repeat it blindly. A step is safe to repeat once it is known not to be running; a cancelled step can hold the discovery lease for up to 90 s, and a call during that time answers `busy`. That answer carries the holder's real expiry: `discovery.nextCatchUpAt` is the lease's `expires_at` plus 3 s (never more than one lease TTL plus 3 s from now), `discovery.retryAfterSec` is the same wait in whole seconds, and `discovery.busyKind` is `lease_held`. Wait until then and call the same `runId` once; do not call earlier (the answer is `busy` again) and do not reset the lease. `busyKind: lost_race` (the holder finished between the failed take and the read; no expiry is known) waits 5 s. A hard conflict is not a wait: `discovery_fence`, a different run or generation, or an error answer stops the attempt. Measurements: [AIR-362 evidence](../evidence/d1-migration/air-362-seal-busy-wait-2026-11-07.md).
