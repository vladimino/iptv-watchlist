# AIR-607: activation of the Catalog Enrichment producer for the rated scope, 28 November 2026

[AIR-607](https://trello.com/c/Daq02gYy) · [ADR 0219](../../adr/0219-discovery-film-enrichment-and-refresh.md) decisions 2, 3 and 6 · [ADR 0207](../../adr/0207-letterboxd-admissions-coordinated-in-d1-only.md) decision 7 (C2) · [runbook](../../runbooks/catalog-enrichment-producer.md#activating-the-rated-scope-c2-air-607) · deliveries: [PR 1062](https://github.com/vladimino/iptv-watchlist/pull/1062) (the dormant module) and [PR 1073](https://github.com/vladimino/iptv-watchlist/pull/1073) (the operator and the reconcile cron).

A dated measurement of one owner-authorized operation. It is not authority for any later operation, and it does not prove natural acceptance (see the last section).

## Result in one line

The reconcile cron was delivered, then one `--activate` of the reviewed operator inserted the `rated` scope with cutoff `2026-11-28T04:00:00.000Z`, bootstrapped the 6 qualifying admissions and activated the control (`inactive` to `active`, generation 1, revision 2), in a single call (`outcome: activated`). An independent readback matched, and the producer's first run started by itself and was progressing when this was recorded. No other scope, flag, Scheduled Task, pause, manual reconcile or manual enrichment was involved.

## Authorization

The owner gave the GO directly to the executor in the session chat on 28 Nov 2026, about 10:19 Madrid (09:19 UTC), and the executor recorded it verbatim on the card: [comment `6b0a9d0baee0481902190f0b`](https://trello.com/c/Daq02gYy#comment-6b0a9d0baee0481902190f0b), used as the operator's `--go` reference. The text: «GO на AIR-607: merge и deployment PR #1073 с добавлением reconcile cron 11-59/15 * * * *, активация исключительно rated scope с cutoff 2026-11-28T04:00:00.000Z, последующий readback и evidence PR.» The recorded scope excluded a pause, any other scope, a manual reconcile, a backfill, flags, Scheduled Tasks, Access, a repeat of the activation outside a confirmed partial state and any recovery outside the plan.

## Delivery of the cron

| Item | Observed |
| --- | --- |
| Reviewed code | PR 1073 head `734086bcc0a3b9cc5c6baff270c7d15372591f15`; independent re-review PASS; exact-HEAD CI [46127090363](https://github.com/vladimino/iptv-watchlist/actions/runs/46127090363) `Test and build` and both shards `success` |
| Merge | squash commit `e28302b2f05d50d13808f0791287f89d146c8b56` on `main`, about 09:21:31 UTC |
| Post-merge CI/CD of that commit | run [46130093242](https://github.com/vladimino/iptv-watchlist/actions/runs/46130093242) was `cancelled` by the concurrency group when the next pull request (#1079, evidence only) was merged on `main` about 40 seconds later; it is not a test failure |
| Post-merge CI/CD that covers it | run [46130147479](https://github.com/vladimino/iptv-watchlist/actions/runs/46130147479) on `ab40934a3bb2f909d75ba2783875c989ba2104ae`, which contains `e28302b`: `Test and build`, `Test shard 2 of 3`, `Test shard 3 of 3` and `Deploy to Cloudflare` all `success` (deploy step 09:27:07-09:27:23 UTC, before the `:30` tick of the Letterboxd Sync) |
| Deployment | `f1b98722-a2e3-41b3-924a-1a8a8431edb7`, version `34bdd443-a0c8-4f6a-acc7-bd62bf3adbc3`, 100 %, `created_on` 2026-11-28T09:27:21.326142Z (the previous one: `b347113e…`, version `3831d23e…`, 08:59:06 UTC) |
| Live trigger list after the deployment | five entries: `0 * * * *` (created 2026-11-08), `1-59/2 * * * *` (2026-11-19), `24 3 * * *` (2026-11-19), `30 * * * *` (2026-11-22), each with its earlier `created_on` unchanged, and the new `11-59/15 * * * *` (created 2026-11-28T09:27:22.337988Z) |

The activation waited for the `:30` Letterboxd Sync tick: the slot `2026-11-28T1030` started 09:31:00 and was closed at 09:35:38 UTC (pipeline `idle`, no lease, `health: healthy`; it added no rating).

## Preflight, from the delivered clean commit (read-only)

`--status --target iptv --cutoff 2026-11-28T04:00:00.000Z` at 2026-11-28T09:38:22Z, run from a detached clean checkout of `ab40934` (the delivered commit), over the real REST adapter, no secret in the output, no write request:

| Item | Observed |
| --- | --- |
| Decision | `ready`, no problem |
| Operator digest | `f94a469b66f752418ebbebc42c752a6e6024a80a896615490ab9b42dfdf8b3a5`, equal to the reviewed one (files `0e102149ba74…`, `f9c53503bea7…`, `8c72cf896c6c…`) |
| Schema | `schema_contract` 55, no missing table, rated trigger and `canonical_write_receipt.operation_key` present |
| Authority | Film/Person `d1` / `open` / generation 2; Letterboxd admission authority `r2` / generation 0 (A2 not done, so the cutoff is before the A2 flip) |
| Control, scope, lease, staged | control absent (inactive); no scope row; no live lease; no `staged` signal |

Census of `film_rated_admission` by D1 `SELECT` at about 09:38 UTC: 735 rows, of which 729 verified before the cutoff (the historical cohort, not part of the rated scope) and **6 at or after it**, the newest at 2026-11-28T09:34:21.696Z. The 6 newly qualifying admissions arrived after the earlier census (729 rows, last verified 03:32:10Z); as the review and the handoff required, the cutoff was not moved, and they are the cohort the bootstrap wrote.

## The operation

```bash
NODE_USE_ENV_PROXY=1 node scripts/catalog-enrichment-activation-production.mjs --activate --target iptv --cutoff 2026-11-28T04:00:00.000Z --by operator:AIR-607-executor --go https://trello.com/c/Daq02gYy#comment-6b0a9d0baee0481902190f0b --confirm activate --operator-sha256 f94a469b66f752418ebbebc42c752a6e6024a80a896615490ab9b42dfdf8b3a5
```

The credentials came from the session environment (`D1_BACKFILL_ACCOUNT_ID`, `D1_BACKFILL_API_TOKEN`), never printed. One call, exit 0, 09:38:41-09:38:47 UTC, `at` 2026-11-28T09:38:42.883Z:

| Item | Result |
| --- | --- |
| Outcome | `activated`; `writes: true`, `writeState: committed`, not partial |
| Effects | `scopeInserted: true`, `bootstrapRows: 6`, `bootstrapPages: 1`; transport `lastBatch: committed` |
| Bookmarks | before `0000141a-000000ba-00005131-10fa6c9c761a9bba05131abe2cea241e`, after `0000141a-000000c0-00005131-c374cd8f726f10f354d234ddd4b2848e` (recovery points; no restore) |
| Control | `active`, generation 1, revision 2, `updated_by` `operator:AIR-607-executor go:https://trello.com/c/Daq02gYy#comment-6b0a9d0baee0481902190f0b` |
| Scope | exactly `rated`: `activated` 1, `enabled` 1, cutoff `2026-11-28T04:00:00.000Z`, revision 1, bootstrap `done`, cursor `film:tmdb:756999` |
| Wake | `deferred` (`no_workflow_binding`), as designed: a REST binding has no Workflow, so the first wake is the reconcile or a causal kick |

## Independent readback

At 09:39:04Z the operator's `--status` read `already_active` (the very predicate of the activation's noop). Direct D1 `SELECT`s at about 09:40 UTC:

- control `active` generation 1 revision 2 with the exact `updated_by`; one scope row, none other than `rated`;
- 6 qualifying admissions and 6 rated `admitted` signals, **0 signals outside the cohort, 0 qualifying admissions without a signal, 0 duplicates**, every signal at version 1 and `pending`; no `c3a`, `c3b` or Discovery scope and none of the 729 historical admissions was touched;
- no member, state row, tick or lease yet: the drainer had not started.

## The first run (observed read-only, dated; not final)

The first drainer instance started by itself (no manual reconcile, no manual run). The evidence does not distinguish whether the 09:41 UTC tick of the reconcile cron or a causal kick started it. Observations:

- about 09:44-09:45 UTC: the 6 rated signals `consumed` and acknowledged, 6 members, 13 state rows, one tick, the run record and the lease present, the Workflow `iptv-catalog-enrichment` with one `running` instance; the shared upstream coordination mode was `observe` and a Wikidata cooldown was recorded (below);
- at 09:52:25 UTC: 50 state rows (`film` 6 active; `core` 12 complete; `localization` 6 complete, 6 due, 6 not applicable; `credits` 2 complete, 6 due, 6 not applicable), 5 tick rows (`ce-00000001-2` 09:47:26 to 09:50:11, `ce-00000001-3` 09:50:13 to 09:51:17, then the successor `ce-00000002-0` started 09:51:25 by handover), the lease held, Workflow instances 1 `running`, 1 `complete`, 0 `errored`; **no part in `needs_attention`, `deferred_repair` or `identity_disagreement`**; the six older `anchor_changed` signals were consumed once the memberships existed, and six `anchor_changed` signals remained `pending`.

**Wikidata `403`.** At 09:44:42 UTC the producer recorded a shared cooldown for `wikidata`, reason `forbidden`, until 09:59:42 UTC, `set_by catalog_enrichment`. Under ADR 0219 decision 7 a 403 is a transport outcome (no failure consumed, the 72 h fallback unchanged) and in mode `observe` nothing is skipped; the `tmdb` core and localization parts completed. It is an upstream condition to watch, not something this operation changed.

## What is not proven, and the limits

- **Natural acceptance is not proven.** The activated cohort is the 6 bootstrap admissions; the event-woken enrichment of a new admission on real A2 traffic is verified later, with A2 where it applies, without a circular prerequisite. An empty inbox or a started run is not evidence of an enriched Film, and the first run was still in progress when this was recorded (the `due` parts of the six Films were not yet final).
- The Wikidata `forbidden` cooldown above; whether it recurs, and the `credits` and `localization` parts that were `due` at the snapshot, are for the stabilization read.
- Not read: `GET /api/admin/settings` and the producer's Monitor stream (no Access token was obtained in the session); the readbacks are D1 `SELECT`s, the Cloudflare schedules, deployments and Workflow-instance `GET`s and the operator's `--status`.
- The operator digest pins three files, not every transitive dependency of the adapter; the operation ran from the exact delivered commit with a clean working tree.
- The cancelled run `46130093242` is not a failure, but the post-merge verification of `e28302b` rests on the covering run `46130147479` of `ab40934`.
- Times are UTC (Madrid is UTC+1 on this date).
