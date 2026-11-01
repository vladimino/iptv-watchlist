# Bounded discovery ledger: modes, verification and rollback (owner approval required)

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
- the archive pointer CAS lost a race.

Such a stop leaves either the previous archive with some unreferenced versions, or the new archive plus the previous published generation. Both are consistent (ADR 0034, section 3). Retrying the same run is safe.

**The first bounded commit over today's full ledger parses that full ledger once, as every `full` commit does now.** That has the same memory risk as today. The production split is therefore planned and rehearsed separately (AIR-221/AIR-222), possibly as an offline split, and is not started by setting the flag on its own initiative.

In bounded mode no discovery chunk and no status read touches the archive. `POST /api/enrichment/discovery/scan` and `/reconcile` answer `409` whenever the mode is not `full` or an archive exists.

## Read-only verification (no write)

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

1. **Read it, read-only.** Open `/admin/limbo?kind=observation` and press «Разобрать наблюдение» on the item: one `GET /api/admin/discovery-recovery` ([contract](../reference/api/admin.md#discovery-observation-recovery-get-apiadmindiscovery-recovery)). If the page says observations are unavailable, the generation's [observation index](../reference/domain/discovery-observation-index.md) is missing, torn or of another generation. The next ordinary resolver chunk writes it. Wait for it; a chunk run only to build the index is a series-level operation that needs the owner's approval.
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
4. **Reconsider, only as the owner.** This is a production write. Agents never run it without the owner's explicit approval of that run. When the panel offers «Повторно направить на проверку», it states the cost (no TMDB request, no resolver run, one decision written), the risk and the effect.
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

1. Open the same panel as above. Read the title, year, duration, airings, evidence key, decision, hypothesis and the coverage sentence. The hypothesis is not a choice. A radio exists only for a movie id the observation already confirmed. A typed id is checked against one catalogue object at confirm, not against a title search.
2. Choose «Подтвердить фильм» or «Отклонить совпадение», the one id, and a short basis. Tick the checkbox that names that key and that generation. Press «Подтвердить идентичность», then «Записать идентичность».
3. Read the receipt. **Записано** means the decision was written. The sentence under it says what the next ordinary chunk will do with shows. It does not mean the catalogue, search and detail were rewritten by this click. A rejection blocks that id on this decision only. **Исход неизвестен** means do not repeat: the same confirmation replays the receipt. **Не записано** means the other writer kept the map. A refusal such as a year conflict or a television id writes nothing.
4. If the panel says the index was not refreshed, the list may still show the row until the next ordinary chunk. Do not start a chunk to hide the row.
5. **Undo is manual.** The record under `admin/actions/discovery_identity_correct/v1/` keeps the before-image. Restoring it is a separate owner-approved write. A code revert stops the route and leaves the decision and the record in place. The next ordinary chunk must not verify a rejected id and must not request its movie card.

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

**Offline profile.** `npm run build`, then `node --expose-gc scripts/epg-memory-profile.mjs [--full] [--gc-at-markers] [--concurrency 2] [--scale 1]`.
- It replays the built Worker against synthetic objects of the production sizes from an R2 size listing. It makes no request and needs no data.
- It prints heap and RSS per phase. With `--gc-at-markers` the enter and exit figures are retained data; without it they include uncollected garbage.
- Node heap is not workerd's 128 MB isolate limit: the figures rank phases.
- The 30 October reading is in the [evidence](../evidence/epg-diary-oom-profile-2026-10-30.md).
