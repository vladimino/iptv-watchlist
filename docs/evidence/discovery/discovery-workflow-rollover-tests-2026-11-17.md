# Controlled Discovery Workflow rollover: offline test evidence, 17 November 2026

[AIR-524](https://trello.com/c/G32xYzLC), [ADR 0164](../../adr/0164-controlled-discovery-workflow-rollover.md). This is offline evidence only. The Worker sources run in a Node `vm` over an in-memory R2 with etag compare-and-swap and a stub Workflow binding (`tests/discovery-workflow-rollover.mjs`). The EPG-priority and projector-window reads run against a real Discovery authority on local sqlite D1 stand-ins (`tests/epg-priority-gate.mjs`, migrations to 0022). The Access gate is exercised over HTTP with signed test JWTs (`tests/mcp.mjs`). No production read or write, no Cloudflare call and no live `apply`.

## Method and results

| Acceptance case (AIR-524) | Test | Result |
| --- | --- | --- |
| Ordinary rollover after a deploy: eligible preflight with zero writes, one CAS swap to `series + 1`, one create, readback accepted | rollover §1, §5 | pass. `puts` empty after `dry_run`; one create of `discovery_<generation>_1` with `{programmeRunId, series: 1}` |
| Old sleeping instance; live lease; chunk in flight (`continuation.stage: running`); owner `running` | rollover §2 | each is `unsafe` (`wake_imminent`, `lease_live`, `checkpoint_unsaved`, `instance_active`); `apply` 409, record and objects byte-identical, zero creates |
| Old instance wakes after the handoff | rollover §6, §7 | owner gate `not_owner`, no chunk started, no write; `settleWorkflowIfOwner` → `other_instance`; it cannot record its version |
| Concurrent natural rollover | rollover §6, §16 | the old instance's `rolloverDiscoveryWorkflow` attaches to the named successor, no second create; the natural path still creates `series + 1` and carries report and receipt |
| Cron reconcile right after the swap | rollover §10 | `in_progress` on the successor, no second id |
| Two operator requests at once | rollover §9 | exactly one `ok`; the other `write_conflict`/`pin_mismatch`/`unsafe` with `writes: 0`; one create |
| Repeat of the same request, timeout after the CAS | rollover §8, §12, §13 | `replay: true`, no second swap; a `starting` record is created once by the repeat or by the reconcile; a lost answer of a stored swap proceeds as its own |
| Repeat after a crash, with a new generation published meanwhile; preflight slow enough to eat into the wake margin | rollover §12 additions | `replay_stale` with no create; `wake_imminent` refusal before the swap with zero writes |
| Instance step naming unchanged by the version step | rollover §12 additions | the step sequence starts `version`, `owner-0` |
| EPG publication between the preflight and the swap, executor revision untouched (review P1) | rollover §12 additions; gate test, real SQL | the swap is refused `stale_generation`: record, revision, report, continuation and authority generation unchanged, no create; each of the four moves (both pointers, EPG pointer only, Discovery pin only, Discovery programme only) refuses on real D1 by the pin or by the pause inside the same statement; the reconcile then starts series 0 of the new run, never the old run's successor; the swap never falls back to R2 |
| Failed or uncertain Cloudflare create | rollover §11 | `successor_uncertain` (202, not accepted); record `uncertain` with due time; reconcile waits, then recreates the same id; total successors: one id |
| Stale EPG generation; stale owner/version pins | rollover §2, §4 | `generation_handoff`, `generation_mismatch`, `continuation_foreign`; every stale pin `pin_mismatch` with zero writes; `already_current` for a recorded deployed version |
| Held authority, loading transfer, EPG priority, projector window (requested or held) | rollover §2, §14; gate test | preflight `unsafe`; a window or pause opening between preflight and swap is refused inside the record write with zero writes; `readDiscoveryGates` agrees with `writeWorkflow` on real SQL and writes no row or generation |
| Authorization refusal | `tests/mcp.mjs` | all 18 denied Access cases return 403 for `dry_run` and `apply`, and the operator is never reached; an unknown argument is refused before it |
| Unsaved checkpoint; report, outbox and `replayAfter` preserved | rollover §2, §5 | `checkpoint_unsaved` refuses; after the swap the continuation object and etag are unchanged, the status (with `replayAfter`) is unchanged, report counters, `seen` and outbox are carried |
| Unknown facts fail closed | rollover §2 | missing version binding, unreadable gates, priority or window, D1 error, owner status error, forged owner id: `unknown`, `apply` refused with zero writes |

Full local suite on the final checkout: `npm ci`, `npm run test:all`, `npm run build`; the result is recorded in the pull request.

## Verdict

Under this model the operator gives exactly one writer, loses no checkpoint, does no double progress and makes zero writes on an unsafe or unknown preflight. The natural handover is unchanged.

## Not proven

- No live run. Two platform behaviours are checked by the first live readback, not assumed: that Cloudflare runs a new instance on the version deployed at its creation, and that `CF_VERSION_METADATA` inside a Workflow step reports that instance's version.
- The in-memory R2 compare-and-swap stands in for the D1 `discovery_workflow` revision CAS; the D1 statement itself (window and priority guards) is covered by the gate test, not by the full apply.
