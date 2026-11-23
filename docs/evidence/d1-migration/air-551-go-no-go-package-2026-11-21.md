# EPG checkpoint D1 cutover: GO/no-GO package for the owner

Date: 21 Nov 2026, 12:04 UTC (13:04 Madrid, UTC+01:00). Scope: [AIR-551](https://trello.com/c/YAVPlcAe), the decision pack requested after the H-0a/H-1 evidence ([measurements and scratch preflight](air-551-h0a-resource-measurements-2026-11-21.md), [plan](air-551-epg-checkpoint-preflight-and-l3-plan-2026-11-21.md)). **This page authorizes nothing.** Only L0 reads were made for it (the read-only `status` of the operator, D1 `SELECT`s, `epg_status`, a read of the Worker deployment list). Base: `main` at `9c01d3f`.

## 1. Where things stand (observed at 12:04 UTC)

| Fact | Value |
| --- | --- |
| D1 `iptv` schema | **29**; no `epg_checkpoint_*` table; the checkpoint is **R2-authoritative** |
| Checkpoint objects | `sync.json` 4,202 bytes (a completed run, no watchlist), `watchlist-ingest.json` 78 bytes; unchanged since the morning |
| EPG | run of 20 Nov complete, instance `epg_20261120_1` finished, lease released, Discovery pause clear, certificate matching |
| Next natural run | due 16:00 UTC (17:00 Madrid), about 12 minutes of run time |
| Deployed Worker version | `bc66e305-…`, the **tenth** deployment of the day (every merge to `main`, docs-only ones too, deploys) |
| Code on `main` | operator tooling (apply, hold, import, activate, release, rollback), the fixed splitter (migration 0030 = 15 statements), migration `0031_watchlist_authority.sql` (AIR-569, not applied, requires exactly v30) |

## 2. What is proven, what is a surrogate, what is unknown

| Item | Status | Basis |
| --- | --- | --- |
| Repository batches, fences, triggers, `ON CONFLICT` upsert, atomicity, orphan sweep, budget refusals on a real D1 | **proven** (synthetic data) | scratch D1, 395 to 1,000 films, entries up to 85,000 characters; all as designed |
| Request and statement sizes | **observed** | largest REST request 4.26 MB; `createRun` 438 statements in 16 requests for 395 films, 1,079 in 28 for 1,000; a metadata step is 57 statements in one batch |
| Body and ingest size | **observed** | 4,202 characters and 78 bytes (0.47% of the 900,000 cap) |
| Film count and largest film entry of the ingest watchlist (O2) | **UNPROVEN** | a completed run has no watchlist; proxy only: 395 published watchlist members, about 2,900 characters per published film. An observer of the natural run at 16:00 UTC was started and can still give the real figures; no manual run was or will be made |
| Worker CPU and memory of `loadRun` (whole list rehydrated) | **unproven** | not measurable over REST. Estimate, not a measurement: 1.2 MB of entries at the proxy size, 10 MB in the 85,000-character case, far below the 128 MB isolate limit |
| D1 queries a Worker invocation may issue | **unproven** | if every statement of a batch counts, `createRun` for 395 films (438) fits a limit of 1,000 and for 1,000 films (1,079) does not; if a batch counts once, both fit |
| Latency from a Worker in WEUR | **unproven** | the scratch was in ENAM, driven from a container |
| `--apply` against a live D1 | **not done** | the per-statement splitter test is sqlite; the scratch apply used a harness splitter |
| Live Workflow version and instance liveness at H0 | **not done** | needs the same-day proof (section 5) |

## 3. Findings that change the GO conditions

1. **The drain proof's "next start at least 30 minutes away" rule is vacuous on production data** (it concerns `--hold` and `--hold-rollback`; since section 8 the schema-only `--apply` no longer uses the proof). The operator reads the margin from `control.nextWakeAt`, which is `null` while `phase=done` (observed). The real due time (`dueAt`, 16:00 UTC) is visible only in `epg_status`. As built, the proof would pass at 15:55 UTC. **Superseded for H1 by section 8** (H1 does not use the proof and was executed on 21 Nov 2026; this remains a precondition of H2 and of `--hold-rollback`). The change it proposed: a small code change that takes the due time as explicit evidence (`--next-due-at`, copied from `epg_status.dueAt`) and refuses below 30 minutes, with a negative test. This is a code follow-up, not part of this page.
2. **Deployed version versus instance version.** H0 requires the Workflow instance to run the deployed version. With a deployment for every merge (ten today), any merge after the run starts makes the versions differ until the next day's instance. A cutover window therefore needs a **merge freeze from the start of the run until the cutover ends**, or H0 cannot pass.
3. **No mid-run rollback.** After activation the first natural run in `d1` mode creates a run with its watchlist rows. If that run fails mid-way, the plan has no safe hold or export (accepted limitation); recovery is the in-D1 behavior of ADR 0185 and owner escalation. The failure modes are closed (fenced, nothing silently written), but EPG for that day can stall.
4. **Migration order.** `0031` requires exactly v30 with the checkpoint tables, so `0030` (this card) must be applied first; `0031` and its own cutover belong to AIR-571 and are not part of this decision.

## 4. Recommendation

**NO-GO for H1 to H4 today, GO for a bounded measurement first.** The outstanding unknowns (O2 and the Worker budgets) all concern the first natural `d1` run, which is the one step without a safe rollback. Three ways forward, in the order I recommend:

- **A (recommended). Measure, then cut over in one window.** (a) Approve a scratch Worker experiment (below) and, in parallel, the small code fix of finding 1. (b) Take the real O2 figures from the natural run of 16:00 UTC (the observer exists; or the next day's). (c) With the numbers in hand, ask for H0 to H4 on a day with a merge freeze. Cost: one to two days. Risk left: only what the Worker experiment cannot show.
- **B. Accept the surrogate and cut over tonight.** After the run completes (about 16:12 UTC) and before 23:00 UTC (the Madrid day boundary), with finding 1 fixed and a merge freeze from 16:00 UTC. Risk: the first `d1` run tomorrow at 16:00 UTC meets real sizes and Worker limits unmeasured; if it fails mid-run, finding 3 applies.
- **C. Do nothing now.** Keep R2 as the checkpoint authority; no risk, no progress on AIR-551.

**Scratch Worker experiment (needs its own owner GO; not created).** One throw-away Worker (no route, no cron, no workflow) with one throw-away D1 binding, deployed to the scratch account namespace only, with an endpoint that runs `createRun`, `loadRun` and a metadata save at the tested sizes inside a real invocation and returns CPU time, wall time, memory estimate and the number of D1 queries issued; deleted afterwards together with its D1. It must be launched from the repository's module (bundled) with synthetic data and must not bind or name `iptv`. It answers the CPU, memory, queries-per-invocation and WEUR-latency rows of section 2; it does not answer O2.

## 5. If the owner chooses to proceed: the holdpoints, exactly

Every step needs its own GO. Each command is `scripts/epg-checkpoint-production.mjs --target iptv --confirm <command> ...` with the credentials of the [credentials skill](../../../.claude/skills/iptv-credentials/SKILL.md); each reads state first, changes one thing, reads back, and never retries. Placeholders: `G` the expected generation, `E` the H0 evidence flags (`--workflow-instance-id`, `--workflow-liveness finished`, `--deployed-version-id`), `I` the fresh identity flags (`--sync-etag`, `--sync-sha256`, `--ingest-etag`, `--ingest-sha256`).

| Step | Command | State change | Stop and read back if |
| --- | --- | --- | --- |
| H0 (read only) | `status` with `E` | none | any drain failure: run not of today's Madrid day, lease live, `phase` not `done`, pause not clear, certificate or run id mismatch, event debt, workflow evidence missing or not terminal, version mismatch; due time under 30 minutes (after finding 1 is fixed) |
| H1 | `--apply` (no evidence flags; see section 8) | schema 29 to 30, marker `r2/open/0`, tables empty | schema not exactly 29, checkpoint tables already present, an executing EPG step (`writer_active`), any failure; the batch is atomic and inert |
| H2 | `--hold --expect-generation 0 E` | `r2/open/0` to `r2/held/1`; wait longer than 2 s; capture identities `I` | a record moved after the proof (the batch aborts); identities differ from H0 |
| H3 | `--import --expect-generation 1 I` | rows imported from the frozen objects | non-empty tables, an identity differs, a missing key, parity mismatch |
| H4a | `--activate --expect-generation 1 I` | `r2/held/1` to `d1/held/2` | parity mismatch, a changed object |
| H4b | `--release --expect-generation 2 I` | `d1/held/2` to `d1/open/2` | parity or identity mismatch; writes stay held |
| H5 | none (observation only) | none | the natural run of the next day: queue before completion, certificate, pause clear, ingest status, no R2 write; the card then goes to the verification queue, not to done |
| H6 | separate PR and GO | retire the R2 arm | not before H5 and owner acceptance |

**Recovery after each step.** After H1 nothing changed at runtime (re-run `status`). After H2 `--release-abort` returns to today's behavior. After H3 before H4a the rows exist and the marker is `r2/held`; a repeat of `--import` refuses, and the owner decides on the rows. After H4a before H4b the marker is `d1/held` and `--release` finishes it. After H4b the data rollback is `--hold-rollback`, `--export-rollback`, `--revert-authority`, `--release-rolled-back`, only at an idle complete boundary with a certificate (the [runbook](../../runbooks/epg-checkpoint-d1.md) has the exact gates); the D1 rows are kept.

## 6. Decision requested

1. Choose A, B or C.
2. If A: approve the scratch Worker experiment (one Worker and one D1, both deleted afterwards) and the small code fix of finding 1; say whether the 16:00 UTC observation (or tomorrow's) should be awaited.
3. If B: confirm the merge freeze from 16:00 UTC and the code fix of finding 1 first.
4. In every case H1 to H6 stay individually gated; nothing in this page is a GO.

## 7. Limits

Single point in time (12:04 UTC); the EPG state changes at 16:00 UTC. The queries-per-invocation row depends on how D1 counts a batch, which was not verified against the Cloudflare documentation or a Worker. The recommendation weighs the first natural `d1` run as the main risk because the plan has no mid-run rollback; if the owner prefers to accept that limitation, B is acceptable once finding 1 is fixed.

## 8. Update of 21 Nov 2026, 14:40 UTC: H1 is schema-only and no longer needs the H0 proof

The first attempt of the schema-only apply (14:10 UTC, owner GO of 14:03 UTC) was refused by the drain proof before any write (`run_not_current_day`, `control_not_current_day`, `workflow_version_mismatch`; schema stayed 29, bookmark `000009e1-00000000-0000512a-acdc404f64b8fb301be925469b4f5d83`). The coordinator's review of that refusal concluded that these cutover conditions do not belong to an apply that only creates inert tables and a marker that keeps R2 serving, and prescribed a focused code change. It is delivered in this PR: `--apply` now requires only the exact production target, schema exactly 29, the checkpoint tables absent, no executing EPG step (a live step lease or a control phase of `starting`, `running` or `waiting`), the migration's own guards, one atomic batch and a strict read-back; it needs no Workflow evidence flags, no run of today, no version match and reads no R2 object. `--hold`, `--hold-rollback` and the other transitions keep the full H0 proof; the tests cover both sides.

Consequences for sections 3 to 5: in section 5 the H1 row was corrected in a follow-up edit to read `--apply` without the evidence flags `E` (the original text of this page, `--apply E`, was the pre-change command), and the merge freeze of finding 2 applies from H2 onward (the version proof belongs to `--hold`), not to H1. Finding 1 (the vacuous next-start rule) still applies to `--hold` and `--hold-rollback`, so the code fix proposed for it is no longer a precondition of H1 (sections 4 and 6 mention it as a precondition of the cutover only); for H1 the next start is checked by hand from `epg_status.dueAt`, as the owner's GO requires. (Historical guidance written before the apply: H1 then still needed a fresh operation-specific GO. That GO was given and H1 was executed on 21 Nov 2026 at 15:13:58 UTC; see [the apply evidence](air-551-0030-apply-2026-11-21.md).)
