# AIR-571: live read-only preflight (holdpoint P), owner GO packets B to F2 and the scratch QA proposal

**Prepared 22 Nov 2026 about 10:05 Madrid (09:05 UTC; Madrid is CET, UTC+01:00 on this date), BEFORE the natural 17:00 Madrid EPG of the day.** Only read-only observations were made (a D1 `SELECT`, the Cloudflare API `GET`s, the MCP status reads, the repository and Trello reads). No migration, bootstrap, marker or mode change, deploy, cron, Workflow, binding, Task, flag, R2 or D1 write, forced run, or scratch resource. No change is to be made between 16:30 and 17:00 Madrid. **This page authorizes nothing.** Every time-dependent pin and fact below is a placeholder with a rule: re-read it immediately before each future production action. It complements [the activation runbook](../../runbooks/letterboxd-activation.md) (the plan) and [the offline QA evidence](air-571-offline-qa-2026-11-22.md).

## 1. Live read-only preflight, holdpoint P

| Fact | Value read (09:03 to 09:05 UTC) | Reading |
| --- | --- | --- |
| Main and deploy | main `57aebf61` (the activation slice, #887); the deployed `iptv` version `1248708a-dbab-433c-8081-4800cf324b6a` since 08:58:54 UTC (deployment `62e2971e`); post-merge CI/CD 4 of 4 green per the card | matches the code of this plan |
| Newer code in main | `0034_prediction_aux_authority.sql` (AIR-553, dormant, merged 08:42 UTC) is in the repository and NOT applied | the chain is now 0001 to 0034; the operators accept schema 33 or higher, so an unapplied 0034 changes nothing for B to F; record the schema version at each GO |
| D1 schema | `schema_contract.version` = **33** | Letterboxd control plane (0033) applied |
| Watchlist authority | marker `epg`/`open`/generation **0**; pointer version **0** (no snapshot, 0 snapshots, 0 pending admissions) | dormant, bootstrap not done |
| Letterboxd mode | no row (`external`, epoch 0) | dormant |
| EPG checkpoint authority | `d1`/`open` | the checkpoint cutover is done (O4 part 1) |
| Published EPG | `d1`/`open`, generation **516**, run `7bce173c-2cfe-420d-baaf-efebced1b410` (the SAME run imported by AIR-551 H3/H4 on 21 Nov), certified (`finalized_run_id` = run) | the Watchlist source of B (note: the generation moved from 515 to 516 with the same run; the pin is re-read at B). **This is NOT H5**: a later generation of the same run is not a new natural daily EPG run |
| **O4 acceptance** | AIR-551 is in `Верификация`, NOT Done. The checkpoint authority is `d1`/`open` and a checkpoint observation (06:29 UTC) and published generation 516 are visible, but the post-cutover H5 natural daily EPG run (scheduled for 22 Nov 17:00 Madrid) has NOT happened yet: its completion, finalization and acceptance are **UNPROVEN** | **O4 is not satisfied until the owner accepts AIR-551 (Done + H5 with that natural run)**: blocker for B onward. Generation 516 must not be read as H5 |
| Discovery | `complete`, no live lease, executor stopped, backlog 0 | recorded as a FACT, not a blocker |
| Ratings | pipeline `idle`, D1 authority `open`, orchestration `cloudflare` epoch 1 revision per the status; last run 21 Nov 17:00 Madrid finished; next due **22 Nov 17:00 Madrid (16:00 UTC)** | the legacy writer is the daily Ratings Workflow; the D step waits until after that run |
| Letterboxd read model | `letterboxdSync: null` (dormant) | as expected |
| Crons (account) | exactly `0 * * * *` (8 Nov), `1-59/2 * * * *` (19 Nov), `24 3 * * *` (19 Nov); 3 in the whole account | phase "before E" matches |
| Workflows | `iptv-prediction-start`, `iptv-producer`, `iptv-epg`, `iptv-ratings`, `iptv-discovery`; no Letterboxd Workflow | phase "before E" matches |
| Flags | registry read: `MONITOR` on, `EPG_CHANNEL_POLICY` on, `MONITOR_TRANSPORT` telegram; no Letterboxd flag exists or is needed | no flag in this plan |

### Blockers and prerequisites (the open gates)

1. **O4**: AIR-551 `Верификация` to Done with H5 (the NATURAL daily EPG run of 22 Nov 17:00 Madrid after the checkpoint switch, which has not happened at the time of this page, and its acceptance by the owner). Until then NO production operation of B to F2 is requested.
2. **Owner GO per operation**, each naming the operation, the target, the pins, the window and the stop condition (this page is the request template).
3. **Window**: nothing between 16:30 and 17:00 Madrid; the D step also waits until after the daily Ratings run (17:00 Madrid, about 1 to 4 minutes) and the EPG run, and avoids any other cutover window.
4. **Canary slot** is chosen by the owner at D2 (not here).
5. **Scratch validation** (section 3) is a separate owner decision before the relevant production gate, not a prerequisite of B to D.
6. **Operator credentials**: the D1 operators need `D1_BACKFILL_*` (and R2 install/read credentials for the root-fence commands), loaded as in the iptv-credentials skill; the Worker routes need the owner's Cloudflare Access login (cloudflare-access-read skill). Never printed.

## 2. GO packets (each is one owner GO; no packet starts before the previous one is read back)

**Common to every packet.** Before: read the preflight above again (marker, pointer, schema, crons, Workflows, EPG liveness, Discovery as fact), a Time Travel bookmark, and the pins from the sources below. After: the operator's readback, a second bookmark, an independent read of the claimed facts. Outcome `write_uncertain` is never repeated: stop, read, ask a new GO with new pins. Placeholders in `<angle brackets>` are filled at the time of the GO.

### B: bootstrap import (marker `epg`, nothing else moves)

- **Window:** outside 16:30 to 17:00 and the 17:00 EPG run; after O4.
- **Fresh pins and where they come from:** `<run>` and `<epgGeneration>` from `node scripts/watchlist-bootstrap-production.mjs --target iptv` (status); `<count>`, `<sha256>` from the same status (the stored source); `<membersSha256>` from `node scripts/watchlist-bootstrap-production.mjs digest --file <saved GET /api/watchlist taken at the same generation>`.
- **Command:** `node scripts/watchlist-bootstrap-production.mjs --target iptv --bootstrap --confirm bootstrap --expect-run <run> --expect-epg-generation <epgGeneration> --expect-count <count> --expect-members-sha256 <membersSha256> --expect-sha256 <sha256>`.
- **Readback:** snapshot version 1; count, ordered ids, digests equal to the pins; no change, effect or ledger row; marker still `epg`/`open`/0; `already_applied` on a repeat.
- **Stop:** any pin difference; the generation moved; an EPG step live (control phase or step lease); `write_uncertain`.
- **Recovery:** none needed (the marker is `epg`; the import is idempotent by digest; a wrong import is ignored).

### C1: hold and fence the root

- **Window:** as B; no EPG step in flight (the operator refuses `writer_active`).
- **Pins:** the B receipt (`<snapshotId>`, count, both digests, run, EPG generation); the root etag read just before (`<rootEtag>` from the operator's status or an R2 head, read-only).
- **Commands (copyable; every `<...>` is a fresh-pin value read at the time of the GO, never a literal):**
  1. `node scripts/watchlist-cutover-production.mjs --target iptv --hold --confirm hold --expect-generation <G> --expect-run <run> --expect-epg-generation <epgGeneration> --expect-count <count> --expect-members-sha256 <membersSha256> --expect-sha256 <sha256> --expect-snapshot-id <snapshotId>`
  2. `node scripts/watchlist-cutover-production.mjs --target iptv --fence-root --confirm fence-root --expect-generation <G+1> --expect-root-etag <rootEtag>`
- **Readback:** marker `epg`/`held`/G+1; the root carries the fence of G+1 and the same list (the operator proves it by readback and returns the new etag).
- **Stop:** `liveness_unknown`, `writer_active`, `letterboxd_not_closed`, `checkpoint_not_d1`, a moved root.
- **Recovery:** `--release-abort` (`epg`/`held` back to `epg`/`open`).

### C2: switch and release

- **Pins:** the fence receipt: `<fencedRootEtag>`; the B pins; the generation G+1.
- **Commands (copyable; every `<...>` is a fresh-pin value read at the time of the GO, never a literal):**
  1. `node scripts/watchlist-cutover-production.mjs --target iptv --activate --confirm activate --expect-generation <G+1> --expect-run <run> --expect-epg-generation <epgGeneration> --expect-count <count> --expect-members-sha256 <membersSha256> --expect-sha256 <sha256> --expect-snapshot-id <snapshotId> --expect-root-etag <fencedRootEtag>`
  2. `node scripts/watchlist-cutover-production.mjs --target iptv --release --confirm release --expect-generation <G+2> --expect-run <run> --expect-count <count> --expect-members-sha256 <membersSha256> --expect-sha256 <sha256> --expect-snapshot-id <snapshotId>`
- **Readback:** `d1`/`held` then `d1`/`open`; `GET /api/watchlist` serves the snapshot; the next natural EPG reads it; the mirror delivery receipt is cleared; no second membership writer.
- **Stop:** `root_not_fenced`, `checkpoint_not_d1`, a digest failure.
- **Recovery:** the data rollback (section 4 of the activation runbook, `drain` is not needed here because no Letterboxd writer exists yet: `hold-rollback`, `export-rollback`, `fence-root-rollback`, `revert-authority`, `release-rolled-back`).

### D1: close the Ratings Cloudflare executor

- **Window:** after the daily Ratings run of the day finished and outside the embargo; no live Ratings instance or step lease.
- **Pins:** read the Ratings mode (`mode`, `epoch`) from `ratings_sync_status` (`orchestration`) immediately before; the route takes no pins, so the status read IS the precondition.
- **Commands:** the existing three-step switch on `POST /api/letterboxd/ratings/executor`: `{"action":"close_admission","target":"external"}`, wait for the drain (status: no live instance, lease released), then `{"action":"complete"}`.
- **Readback:** `orchestration.mode` = `external`; `drain` verified; no live instance.
- **Stop:** a live instance or step lease; `drain_not_verified`.
- **Recovery:** the same route back to `cloudflare` (its own step).

### D2: Letterboxd mode, completion WITH the canary slot

- **Pins:** `GET /api/letterboxd/sync/mode` immediately before each command: `mode`, `epoch`, `revision`; the five-part proof must be all true; the canary `<slot>` is chosen by the owner at that time (the first natural slot after E, outside 16:30 to 17:00; a daytime slot such as 10:30 is suggested for an attended observation).
- **Commands (each with `confirm` equal to the action and fresh `expectEpoch`, `expectRevision`):** `{"action":"close_admission","target":"cloudflare"}`; re-read; `{"action":"complete","slot":"<slot>"}`. The owner route requires the slot (`canary_required` otherwise) and writes the completion and the hold in ONE row write.
- **Readback:** `GET`: mode `cloudflare`, `canary: <slot>`, one admitted writer, `legacyFenced` true; the Ratings legacy entry answers `external_writer_fenced`.
- **Stop:** any false proof part (`handover_not_proven`), `handover_changed`, `canary_required`, `slot_in_past`.
- **Recovery:** `drain`, wait for the effects, `close_admission` (external), `complete`, then the rollback operators; an abort keeps the hold or ends in `canary:none`.

### E: the activation deployment (configuration only)

- **Window:** outside 16:30 to 17:00; not at minute 29 to 31 UTC; ONLY after D2 shows `canary: <slot>`; the deploy is NOT approved while the read model shows `cloudflare` without a `canary`.
- **Content (one reviewed PR, owner-approved before deploy):** `wrangler.jsonc` adds the Workflow registration `{"name":"iptv-letterboxd","binding":"LETTERBOXD_WORKFLOW","class_name":"LetterboxdWorkflow"}` and `"30 * * * *"` as the fourth `triggers.crons` entry, the three originals unchanged and in order; `tests/cron-schedule-simulation.mjs` updated to pin four; `docs/runbooks/deployment.md` and `docs/reference/feature-flags.md` notes. This PR is prepared AFTER the GO for E and merged and deployed only inside the GO's window.
- **Before/after reads (phase-specific):** schedules: exactly the three originals before; the same three (same `created_on`) plus `30 * * * *` after; Workflows: no Letterboxd Workflow before, `iptv-letterboxd` after.
- **Readback:** the first natural `ensure` tick answers `canary_hold` for every slot but the canary.
- **Stop:** any difference of the original three; a plan limit (4 of 5 or 1,000); the window.
- **Recovery:** redeploy the previous configuration (the three crons, no binding); the mode and rows stay.

### F1: the canary (nothing is run by hand)

- **Observed:** the named slot at its time (the `:30` tick at or after its due instant): slot closed, `ratings` and `watchlist` outcomes, exactly two Events, `delivery.mirror` delivered, the legacy Ratings entry fenced, the monitor quiet, the 17:00 EPG and Discovery unchanged. Reads only: `GET /api/letterboxd/sync/mode`, the Letterboxd read model in the Ratings status, `GET /api/events`.
- **Stop:** a failed or missed canary; a duplicate Event; an EPG or Discovery regression: `drain`, then the reverse order. A missed or failed canary is recovered by `canary` with a NEW slot (settled retarget), never by `open_schedule`.

### F2: open the schedule (a separate GO)

- **Command:** `{"action":"open_schedule"}` with `confirm` and fresh pins, only on a real canary hold (refused on `canary:none`).
- **Observed:** the four natural Madrid slots of a day, two Events each, the 24 h warning clear, EPG and Discovery healthy. Stop or recovery: `canary` with a new slot (hold) or `drain` and the reverse order. The old Ratings scheduling contract stays until acceptance (G is a separate decision).

## 3. Scratch QA proposal (for an owner decision; nothing is provisioned)

**What the offline evidence cannot show:** the real shape of `SELECT changes()` inside a D1 `batch()`; D1's real batch and statement limits with the 700-row promotion (308 statements in one batch, 17 batches); the CPU, wall time and memory of a complete workerd slot; the real D1 latency. The numbers in the offline QA evidence are a surrogate and must not be read as runtime.

**Tier 0: local workerd, no Cloudflare resource, no GO on a resource.** Run the real Worker bundle and the promotion in a local workerd (`wrangler dev --local` or Miniflare) with its local D1 (SQLite) in a private scratch directory, through a fake Letterboxd source and a fake R2, with NO production binding or credential. It checks the batch result shape of `SELECT changes()` (the affected-row decoder), the 100-parameter and batch behavior of the D1 binding API, and real workerd CPU and memory of the slot code. It is NOT D1's edge latency. Cost: the effort of one session, the use of `wrangler` or Miniflare as a dev tool only (not added to the repository's dependencies) which needs the owner's agreement. Risk: none to production; the config refuses any production database id (`3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb`), bucket `iptv` or account binding.

**Tier 1: a scratch Cloudflare environment (separate resources).** A separate Worker `iptv-scratch-qa`, a new D1 database with the migrations 0001 to 0034 applied, a scratch R2 bucket, a synthetic 700-film list, a fake source. Measures D1's real edge behavior, batch limits and latency, and the Worker CPU (Workers observability or analytics) and wall time of one full slot and of a promotion. **Operations that need an explicit owner GO (each separately):** create the D1 database, create the R2 bucket, deploy the scratch Worker, apply the migrations to the scratch database, trigger the measured run, delete all scratch resources afterwards. Cost: negligible (a scratch D1 counts one database against the account; D1 rows written for a few runs are far below the included amounts). Risks and mitigations: an accidental production binding (a config guard that rejects the production ids, a distinct Worker name, no shared secrets), billing (deleted after the run), account limits (databases per account).

**Go / No-Go criteria for the scratch result (proposed, the owner may change them):**

| Check | Go | No-Go |
| --- | --- | --- |
| `SELECT changes()` in a batch | the last result carries a numeric 0 or 1 for the conditional UPDATE | any other shape: the strict decoder fails safe (unproven) but the acknowledgement path is then unusable and needs a redesign |
| 700-row promotion, 300 ids added | no D1 error; at most about 30 queries; no statement above 100 bound parameters; the 308-statement batch accepted | `too many SQL variables`, a batch or statement size rejection, `Too many API requests by single Worker invocation` |
| Worker CPU of the promotion step | well under the step limit (suggested: under 10 s CPU, against `cpu_ms` 120,000 configured) | at or near the limit |
| Wall time of one slot step | within the Workflow step and the slot window (suggested: under 60 s per step) | a step that cannot finish inside the window |
| Memory | under 64 MiB peak (limit 128 MiB) | above 100 MiB |
| Rows written per promotion | at most about 1,500 | above 5,000 |

## 4. Decisions asked of the owner

1. Accept AIR-551 (Done, H5) when the natural 17:00 EPG evidence is in: the only blocker for B.
2. Approve the GO packets B to F2 as the request templates (one GO at a time, in order, each with its window).
3. Decide the scratch QA tier: Tier 0 (local workerd, no resource) before D, and whether Tier 1 (scratch Cloudflare) is required before E or F2.
4. Choose the canary slot at D2 time and the window for E (outside 16:30 to 17:00).
5. Confirm that the Ratings close (D1) is run after the daily 17:00 Madrid Ratings run and not before.
