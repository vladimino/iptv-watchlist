# AIR-636: final read-only preflight of the provenance `off → enforce` flip, 28 November 2026

[AIR-636](https://trello.com/c/0jJADYxg) · [ADR 0214](../../adr/0214-film-metadata-per-field-provenance.md) (PVE, decision 15 as amended on 28 Nov 2026) · [runbook](../../runbooks/film-metadata-provenance-activation.md) · supersedes the [preliminary observation](air-636-provenance-enforce-preflight-2026-11-28.md) for the drain proof, which it does not rewrite.

**Scope and limits.** One read-only (L0) preflight between 07:41 and about 07:46 UTC on 28 November 2026, run under the Controller's handoff "GO on the final L0 preflight" ([Trello comment](https://trello.com/c/0jJADYxg#comment-6b0a84ab76d74fff483c1f7e), 08:37 Madrid) after the delivery of PR #1067. Sources: D1 `SELECT`s on database `iptv` (`rows_written = 0`, `changed_db = false`), Cloudflare `GET`s of the Worker deployments and the Workflow instance lists, GitHub Actions run, job and log reads, and local `git` over `origin/main`. **No production write, flag, Scheduled Task, sync, fetch, refresh, forced run or deployment hold, and no flip.** This file is **not** the owner L3 GO and not an activation record. The state below is a snapshot; the runbook requires the recheck after the GO, immediately before the statement.

## Result in one line

Every condition of the accepted drain criterion that can be read was satisfied at the times below, with **no gap named** except the owner's attestation that no owner request or operation is in flight. A candidate final pin and the plan of the single statement follow. The flip itself needs a separate owner L3 GO.

## 1. The continuous compatible interval

Each deployment was taken from `GET /accounts/{id}/workers/scripts/iptv/deployments` (single version at 100 %, `created_on` is the start of its traffic) and tied to a commit by the **Version ID in the log of its `Deploy to Cloudflare` job**, not by timing alone.

| `created_on` (UTC) | Deployment | Version | Commit | CI/CD run / deploy job | Ancestry (PV1, PV3, PV2, AIR-693) | Assertion at commit in writers / mutations | Guard-file diff to the previous deployment |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 06:28:11.923 | `33110ffb…` | `06ba3b6b…` | `9e57bb3` | 46116470725 / 140892055119 | all four ok | 1 / 1 | start of the interval |
| 06:59:20.502 | `745a9167…` | `bbaea9cc…` | `bbae1d8` | 46118794413 / 140899306184 | all four ok | 1 / 1 | empty |
| 07:04:46.668 | `6f5b1ab4…` | `d2db1391…` | `949890f` | 46119181804 / 140900620463 | all four ok | 1 / 1 | empty |
| 07:17:29.663 | `efd586f2…` | `49079897…` | `6f210f8` | 46120188773 / 140903704287 | all four ok | 1 / 1 | empty |
| 07:28:32.286 | `ec50bfd6…` | `245bf0b3…` | `07c2153` | 46121098226 / 140906333432 | all four ok | 1 / 1 | empty |
| 07:36:33.881 | `271573fe…` | `5df34d6c…` | `2e44c61` | 46121628980 / 140908212319 | all four ok | 1 / 1 | empty |
| 07:40:13.670 | `4e46f882…` | `1ceadc86…` | `6682f72` | 46121991893 / 140909038762 | all four ok | 1 / 1 | empty |

- Ancestry is `git merge-base --is-ancestor` of `d5a1fe0` (PV1, #1039), `855d68e` (PV3, #1047), `4ce0074` (PV2, #1048) and `2b13828` (AIR-693, #1051) against each commit.
- The assertion is `git grep -c "film_metadata_provenance_control WHERE id=1 AND mode=? AND revision=?" <commit> -- <file>` in `src/canonical-film-writers.js` and in `src/canonical-mutations.js`.
- The guard-file diff is `git diff <previous> <commit> --` over `src/canonical-film-writers.js`, `src/canonical-mutations.js`, `src/film-metadata-provenance.js`, `src/catalog-enrichment-units.js`, `src/catalog-enrichment-producer.js`, `src/admin/film-metadata-route.js`, `migrations/0049_film_metadata_provenance.sql` and `migrations/0053_provenance_other_language.sql`: empty for every consecutive pair, so no guard was changed or reverted in the interval.
- Every deployment of the interval was a single version at 100 %: no split-traffic rollout and no deployment that could not be tied to a commit.

**`T0 = 2026-11-28T06:28:11.923Z`** (the deployment of `06ba3b6b…`). The interval at the last deployment read (07:42:30.991Z) is **4,459 s (74 min 19 s)**, longer than `B = 3,910 s` (the derivation is in the runbook; `B` measures the interval and adds no further wait). Deployments before 06:28 (01:16, 01:30 and the earlier ones) were **not** examined and are not needed: the interval already exceeds `B` from `T0`.

## 2. The candidate final pin (not a GO)

The newest deployment at 07:42:30.991Z: deployment `4e46f882-7cf5-4624-86e6-d5ca8f6828ee`, version `1ceadc86-5aec-4c2b-b86a-d896dec88fdc` (100 %), commit `6682f72fdae3596a997dde5fc3452702e974cc28`, `created_on` 2026-11-28T07:40:13.670352Z. The Controller's earlier pin `271573fe…` / `5df34d6c…` (commit `2e44c61`) was replaced by this deployment 3 min 40 s later; this shows why the pin is rechecked after the GO. At 07:42 UTC no `CI/CD` push run on `main` was queued or in progress. A later deployment that is proven compatible keeps `T0` and is a new pin (re-pin and replan), never permission to use either version.

## 3. The old-work inventory

- **Workflow instances** (`GET /accounts/{id}/workflows/<name>/instances?status=<status>&per_page=100`, read at 07:41:39Z, one page per call, `result_info.total_count` equal to the list length): `queued`, `running`, `waiting`, `paused`, `waitingForPause` and `rollingBack` are **0** for `iptv-epg`, `iptv-producer` and `iptv-catalog-enrichment` (the writer Workflows) and also 0 for `iptv-discovery`, `iptv-letterboxd` and `iptv-prediction-start`. No other status was returned.
- **Orchestration and HTTP/MCP fence.** `epg_orchestration_document` key `mode`: `cloudflare` (revision 2, epoch 1, `completedAt` 2026-11-08T12:44:04Z), so by `EpgOrchestration.externalGate` the external `POST /api/sync/metadata` path answers HTTP 409 `external_writer_fenced` and takes no lease (a code reading with the live mode; no request was sent). Key `lease` (revision 1305): `released: true`, `releasedAt` 2026-11-27T16:06:06.726Z, `expiresAt` 2026-11-27T16:10:38.417Z, so no step lease is live by an explicit release, not by an expired timestamp alone.
- **Projector window.** `projector_window` id 1: `state = idle`, `owner` null, `expires_at = 0`.
- **Authority marker.** `film_person_authority` id 1: `mode = d1`, `cutover = open`, `generation = 2`.
- **Receipts and units.** `canonical_write_receipt`: 4,325 rows, **0** in `pending`, `failed` or `unknown`, newest `updated_at` 2026-11-28T06:44:42.172Z. `canonical_producer_unit_result`: 0 rows in `open` or `refused_recoverable`. Newest `canonical_producer_chain`: `owner_state = complete`, `lease_expires_at` 2026-11-27T17:29:03.980Z (revision 119); newest `canonical_producer_run`: `pass_state = passed`, `n_failed = 0`, `open_at_completion = 0`. These are terminal control rows and are recorded **separately** from the instance inventory above.
- **C1.** `catalog_enrichment_control` and `catalog_enrichment_scope`: 0 rows each (not activated, so no C1 unit or lease exists). `enrichment_signal`: 6 rows, all `pending` with `cause_ref = film_external_id`, none `language_upgrade`.
- **Observation, not a blocker.** One historical chain row is not `complete` or `superseded`: programme run `d8dc6ec8…`, generation 518, `owner_state = stopped`, `stopped_by = producer_budget_infeasible`, `recovery_class = fail_closed`, lease expired 2026-11-24T02:10:07Z, last updated 2026-11-24T02:05:07Z. It is a closed fail-closed record four days old; the Workflow inventory is empty and no lease is live, so it is not read as running work. It is listed so the owner and the Controller can decide independently whether it matters.

## 4. The static preflight

| Item | Observation (snapshot ~07:43 UTC) |
| --- | --- |
| Schema | `schema_contract` has one row, id 1, version **54**; the five provenance tables exist |
| Migration 0053 | `film_metadata_field.language` carries `length(language) = 2` and no longer the `'ru','en'` list; `film_metadata_history.old_language` and `new_language` carry `length(...) = 2` and no `old_language IN` list |
| Control row | one row: `mode = off`, `revision = 1`, `updated_at = 2026-11-27T00:00:00.000Z`, `updated_by = migration:0049`; triggers `film_metadata_provenance_one_way` and `film_metadata_provenance_transition` present (2) |
| Release rows | `film_metadata_owner_release`: 0 |
| Baseline for acceptance | `film_metadata_field` 0, `film_metadata_history` 0, `film_metadata_owner_command` 0; `canonical_write_receipt` newest update 2026-11-28T06:44:42.172Z |
| Feature flags | not a flag; no flag involved (registry read earlier today) |

## 5. The plan of the single statement (for the owner GO)

The GO names the values below; nothing here has been executed.

- **Pin to name:** deployment `4e46f882-7cf5-4624-86e6-d5ca8f6828ee`, version `1ceadc86-5aec-4c2b-b86a-d896dec88fdc`, commit `6682f72fdae3596a997dde5fc3452702e974cc28`, `created_on` 2026-11-28T07:40:13.670352Z, `T0 = 2026-11-28T06:28:11.923Z`, interval 4,459 s at 07:42:30.991Z, control `revision` `R = 1`, authority `d1`/`open`/generation `2`, and the link to this file. If a newer deployment exists at the recheck, the GO must be re-pinned.
- **Token and time (fixed in the GO, compared exactly at readback).** `:operator = air636-pve:<Trello GO comment id>:<UTC time>` (the id is 24 hex characters, the time 24 characters, 60 characters in all, inside the 1 to 80 limit) and `:now` is that same UTC time (inside `length(updated_at) >= 20`).
- **The statement** (runbook section 4, the only one permitted):

```sql
UPDATE film_metadata_provenance_control
SET mode = 'enforce', revision = revision + 1, updated_at = :now, updated_by = :operator
WHERE id = 1 AND mode = 'off' AND revision = 1;
```

- **Recheck after the GO, immediately before it:** the deployment list equals the GO's pin; `now - T0 > B`; schema 54 and 0053; control `off`/1; release rows 0; authority `d1`/`open`/2; `mode = cloudflare`; step lease released or not live by the existing `leaseLive` rule including its 15 s boundary margin; projector `idle`; the six-status inventory 0 for the writer Workflows; receipts 0 unsettled; no queued or in-progress `Deploy to Cloudflare` job; the owner's attestation that no owner request or operation is in flight. The no-deploy and no-conflict window opens at this recheck and closes at the readback or at abort.
- **Outcomes.** `changes = 0` and the row still `off`/1: refused by the guard, nothing written, stop and replan. `changes = 1` and the readback shows `enforce`, `revision = 2` and exactly the token and time: committed. An error, a timeout or no response: unknown; read the row first; `off`/1 means not applied; `enforce`/2 with exactly the token and time means this statement applied; `enforce`/2 with another token or time means something else wrote it, claim nothing. **No blind retry.**
- **Independent readback** (a second read after the first): the control row; `film_metadata_owner_release` empty; field, history and command tables equal to the baseline except rows whose timestamps are after the flip; `film_person_authority` and the schema version unchanged; no flag or Scheduled Task changed. Then the window is released and the baseline (flip time `Tf`, revision 2) is recorded for the natural acceptance of runbook section 5.

## 6. Not verified (open, not implied)

- **Owner operations and owner HTTP requests in flight.** Not readable by a system check; the runbook requires the owner's attestation at the GO. This is the only gap, and it is the owner's to close.
- **Invocation logs.** Not used and not read; absence in logs is never claimed as proof.
- **`GET /api/admin/settings`.** No Access login was made; its `provenance` block was not read.
- **Whether the external HTTP/MCP metadata path really answers 409.** Read from code and the live mode, not exercised, because a request could have side effects.
- **Deployments before 06:28 UTC** were not examined.
- **Everything after this snapshot.** Another deployment or any state change after 07:46 UTC is outside this evidence and is exactly what the recheck after the GO covers.
- The prediction runner shows scheduled runs ending `interrupted` / `lease_expired` (noted in the preliminary file); a separate pipeline, not a provenance prerequisite.
