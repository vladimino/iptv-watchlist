# EPG checkpoint D1 cutover: read-only preflight and proposed L3 plan

Date: 21 Nov 2026, 07:20-07:30 UTC (08:20-08:30 Madrid, UTC+01:00). All schedule statements below are anchored to UTC. Scope: [AIR-551](https://trello.com/c/YAVPlcAe) first deliverable. **Only L0 observation was made**: three production D1 `SELECT` statements (`changed_db=false`, `rows_written=0` on every one) and the read-only MCP tools `epg_status`, `epg_pipeline_status` and `feature_flags`. Nothing was applied, imported, held, switched, restarted or run. The plan below is a **proposal**; it authorizes nothing. Base: `main` at `28f6737` ([ADR 0185](../../adr/0185-epg-checkpoint-d1-authority.md) Accepted, dormant code from AIR-550 stage 2 deployed).

## 1. Preflight result (production, point in time)

| Fact | Observed | Source |
| --- | --- | --- |
| D1 schema version | **29**; `epg_checkpoint_*` and `epg_ingest_status` objects: **0** | `schema_contract`, `sqlite_master` |
| Checkpoint authority | none: `sync.json` and `watchlist-ingest.json` are **R2-authoritative**; the D1 code is dormant | absence of the marker table |
| EPG orchestration | `mode=cloudflare`, epoch 1, drain `verified`; `control.phase=done`, `runKey=2026-11-20`, `instanceId=epg_20261120_1` (liveness `finished`), `nextWakeAt=dueAt=2026-11-21T16:00:00Z` (17:00 Madrid) | `epg_orchestration_document`, `epg_status` |
| Step lease | `released=true` at 2026-11-20T16:11:56Z, no live holder | `epg_orchestration_document.lease` |
| Run checkpoint | `stage=complete`, run `984821d8-…`, `updatedAt=2026-11-20T16:11:45Z`, `remaining=0`, no error, `enrichmentQueueError=null` | `epg_status` (reads `sync.json` through the Worker) |
| Published EPG | `mode=d1`, `cutover=open`, generation 515; `finalized_run_id = programme_run_id = 984821d8-…`, certified 2026-11-20T16:11:46Z | `published_epg_authority` |
| Discovery EPG-priority pause | `state=clear`, no owed day | `discovery_epg_priority` |
| Discovery executor | stopped, `liveness=complete`, no lease | `epg_pipeline_status` |
| Flags | none registered for this domain (ADR 0185: the marker is the gate); `MONITOR=on` | `feature_flags` |
| Watchlist size proxy | 14,228 `published_epg_member` rows (published members, not the ingest watchlist) | D1 `SELECT` |

The current EPG day is therefore **complete and idle**, which is the boundary ADR 0185 decision 7 cuts at. The next natural EPG starts **today at 16:00 UTC**; a cutover cannot finish before it unless the tooling below already exists, so the realistic first cut is the `complete` boundary of **22 Nov 2026** (about 16:12 UTC) or later.

Not measured and not inferable from a deploy: the version of the code a *future* Workflow instance runs (the only instance observed is finished, so no pinned old instance exists today; the hourly `ensure` creates the next one on the deployed version, to be proven at H0), the byte size and checksum of `sync.json` and `watchlist-ingest.json` (no proven side-effect-free read path with the credentials of this session; the export credentials are the owner's, see the `iptv-credentials` skill), the size of the ingest watchlist and of one film entry (ADR 0185 open question O2).

## 2. Blocking gap: no executable tooling

[The runbook](../../runbooks/epg-checkpoint-d1.md) states that apply, hold, import, activation, rollback export and retirement have no tool. Earlier cutovers used a reviewed operator script with a read-only default and explicit `--apply`/`--confirm` (`scripts/published-epg-production.mjs`, `scripts/*-production.mjs`). The instruction of the card is explicit: **do not run the migration through a workaround API**. The plan therefore starts with an implementation PR (slice A) and its independent review; nothing in H1-H6 can run before it merges.

Slice A: `scripts/epg-checkpoint-production.mjs` plus its core test, read-only `status` by default, then one command per holdpoint, each refusing unless its precondition is read back:

| Command | Writes | Refuses unless |
| --- | --- | --- |
| `status` | none | always runs; reports schema, marker, run row, R2 identities, orchestration, lease, pause |
| `apply` | migration `0030` only | version is exactly 29, tables absent, no step lease live (the migration itself refuses anything but a complete v29) |
| `hold` | `writes open → held`, `generation+1` | the exact transition contracts of section 3a; expected generation and mode passed explicitly, CAS on both |
| `release` | `writes held → open`, generation unchanged | the exact transition contracts of section 3a; never a generic "release any held marker" |
| `import` | rows of the D1 checkpoint, from the **frozen** R2 objects | writes `held`, marker `r2`, run `stage=complete`, ETag and digest equal to the approved ones, tables empty |
| `activate` | `mode r2 → d1`, `generation+1` | rows read back with digest parity; still `held` |
| `export-rollback` | R2 `sync.json`, `watchlist-ingest.json` by conditional write against the frozen ETag | writes `held`; D1 rows read back first |

Also in slice A: confirm against real D1 (not sqlite) the points the offline evidence lists as unproven, through a **bounded scratch preflight that needs its own owner GO** (see H-1).

## 3. Proposed L3 execution plan (not approved; the Product Owner decides)

Every holdpoint is a separate owner decision. Each ends with a readback; a failed readback stops the plan, no retry, no lease reset, no Workflow restart or terminate.

- **H-0a L0 size measurement (prerequisite of H-1, before any decision on it).** A proven side-effect-free read of `sync.json` and `watchlist-ingest.json` identities: size, ETag, SHA-256, film count, maximum film-entry size, body size without the watchlist. It needs a reviewed read-only path with the owner's read-only export credentials (`iptv-credentials`). If that access is unavailable this is an explicit hold: H-1 and H2 do not start. A scratch run on guessed sizes is labelled **limited** and does not certify O2.
- **H-1 Scratch preflight (owner GO, optional but recommended, only after H-0a).** Apply `0030` to a throw-away D1 database (not `iptv`) and run, with synthetic data sized from the H-0a measurement: statement and row budgets of `createRun` staging (50-row batches), one metadata save (24 films), one `completeRun` batch, `loadRun` of the full list for CPU and memory, the `ON CONFLICT` upsert and triggers. Output: a dated evidence page. Without it the first natural `d1` run is the first real exercise of D1 limits, with no cheap rollback mid-run. Creating the scratch database is a Cloudflare write and is **not done here**.
- **H0 Drain proof (read-only).** Same day as the cut, at `complete`: `status` shows `stage=complete` for the current Madrid day, lease released, orchestration `phase=done`, instance finished, no instance on an older Worker version, deployed version equals `main` of the slice A merge, Discovery pause `clear`, no pending event on the checkpoint. Cut window must end at least 30 min before the next 16:00 UTC start; if it cannot, defer a day.
- **H1 Apply `0030`.** From v29 only; readback: version 30, marker `r2/open/0`, fence row present, tables empty. Behaviour stays R2 (ADR 0185: tables present + marker `r2` = today's code).
- **H2 Hold and freeze.** `hold` (marker `r2`, writes `held`, generation recorded); wait longer than the 2 s marker cache; re-capture the R2 source (ETag, size, SHA-256 of `sync.json` and `watchlist-ingest.json`; no raw payload in logs) and require equality with H-0a and with the approved values. Every write of either key is refused while held, so the R2 objects cannot move. A held window must not contain the hourly tick at :00 unless the tick is proven not to write these keys (`certifyComplete` does not write the checkpoint in `r2` mode; to be confirmed at H0).
- **H3 Import.** Bounded import of the complete run and the ingest status; the run stores `queue_attempted=1`, `watchlist_present=0`. Readback: typed columns against body, chunk count and digest, ingest columns, receipt, and equality of every field with the frozen R2 object.
- **H4 Activate.** `mode d1`, `generation+1` (writes still `held`), readback, then `release`. After release: the R2 objects are frozen and never read or written by new code. Stale-isolate window: at most 2 s of a cached `r2/held` view, which refuses writes (fail-closed).
- **H5 Natural verification** (no manual EPG, Discovery or Producer run): the 16:00 UTC run creates the run through `createRun`, passes metadata/seal, completes through `completeRun`, certifies and clears the pause in one batch; check `epg_checkpoint_run`, receipts, `epg_ingest_status`, `finalized_run_id`, `discovery_epg_priority`, and that the R2 `sync.json` ETag is unchanged. Card goes to `Верификация` until this natural run is read back and the owner accepts.
- **H6 Retire the R2 arm** (separate owner GO and PR): remove the `r2` branches, `EPG_CHECKPOINT_DB_OPTIONAL` production meaning stays local-only, update the maintained docs; afterwards recovery is roll-forward in D1.

### 3a. Exact transition contracts (fail-closed)

Each transition is one conditional statement on `epg_checkpoint_authority` whose predicate is the full expected state; zero changed rows aborts. The tool reads the marker first, passes the observed `(mode, writes, generation)` into the predicate, reads back, and never retries blind: after an unknown outcome it reads the marker and acts on what it finds. Every transition also requires the no-live-writer proof (step lease released or expired, orchestration `phase=done` or the instance finished, run `stage=complete`, no pending event).

| Transition | Predicate | Result | Extra evidence |
| --- | --- | --- | --- |
| (a1) `hold` before activation | `mode=r2, writes=open, generation=G` | `r2/held`, `G+1` | wait longer than the 2 s cache, then capture R2 |
| (a2) `release` on a pre-activation abort | `mode=r2, writes=held, generation=G`, tables hold no imported rows or the owner approved their removal | `r2/open`, `G` | readback equals today's R2 behaviour |
| (b) `release` after activation | `mode=d1, writes=held, generation=G` and import parity read back (typed columns, digests, ingest, receipt) and R2 ETags still equal the frozen ones | `d1/open`, `G` | the H4 evidence set |
| (c) `hold` to start a data rollback | `mode=d1, writes=open, generation=G` and the boundary rule below | `d1/held`, `G+1` | live D1 run read back |

`activate` is its own command (`r2/held, G` to `d1/held, G+1`, parity required). Any other state refuses.

**Rollback boundary.** A data rollback starts only at a verified idle `complete` boundary of a `d1` run with a valid certificate (`finalized_run_id = programme_run_id`) and no live lease; this is the same drain proof as H0. A mid-run export (an incomplete run with its watchlist and ingest status) is **not** designed here: it would need its own design, tests and owner decision, so it is out of scope and not available as a default. If an incident happens mid-run the plan is to hold writers (transition c is refused mid-run, so the owner decides between waiting for the run to reach `complete` and a separately designed export). A hold that spans the next natural due time (16:00 UTC) stops that run at start: `beginSync` fails closed, the ingest failure is dropped while held, and the Workflow budget records the failure classes; an expired or missed window is therefore owner-visible and is released only by transition (a2) or (b) after the rollback completes.

**Crash after each holdpoint.** After H1: nothing changed for runtime, re-run `status`. After H2: `r2/held`; transition (a2) returns to today's behaviour. After H3 before H4: rows exist but marker `r2`; the next `import` refuses non-empty tables, owner decides clean-up (delete of the imported rows is a separate L3 action). After H4 before release: `d1/held`, transition (b) completes it once parity is re-read. After release: D1 is the only writer.

**Rollback (data, not Git).** transition (c) at the boundary above → verify D1 rows → `export-rollback` with conditional write against the frozen ETag and byte/digest readback → marker `r2` with `generation+1` → transition (a2). A Worker version without the tables must not be deployed before this. Owner GO for each use.

## 4. Risks and open decisions for the owner

1. **Tooling first.** H1-H6 need slice A merged and independently reviewed; no date can be promised before that. Decision: approve slice A as the next step.
2. **H-1 scratch preflight.** Approve or decline the throw-away D1 database; declining accepts that D1 limits are first exercised by the live natural run.
3. **Size gap (O2).** H-0a is a prerequisite, not an option: the owner-credentialed read-only measurement runs before H-1 is decided; without it H-1 and H2 stay blocked.
4. **Window.** First complete boundary after the tooling merges, at least 30 min before 16:00 UTC; Madrid DST does not apply in November (UTC+1).
5. **AIR-547 coordination.** Maintained docs stay *R2-authoritative live* until H4; the switch updates `epg-and-availability.md` (Mermaid write path, with rendered QA), `persistence-and-migration.md`, `scheduling-and-orchestration.md`, `d1-schema.md`, `orchestration-reliability.md`, `deployment.md` and the checkpoint runbook in the cutover PR, not before.
6. **No material deviation from ADR 0185 is proposed**, so no new ADR is needed for this plan.

## Limits

Single point in time; the orchestration and pause rows can change at 16:00 UTC. The Workflow instance version was not read (instance finished, so not needed today, but H0 must prove it). R2 object identities were not read. D1 limits are unproven outside sqlite.
