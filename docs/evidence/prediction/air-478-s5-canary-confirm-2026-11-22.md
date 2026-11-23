# AIR-478: second recovery canary confirmed (10 films, 22 Nov 2026)

Date: 22 Nov 2026, about 17:15–17:45 UTC. Owner GO in [AIR-478](https://trello.com/c/IbsSCRce) (comment of 22 Nov 2026, 17:07 UTC: exact cohort, mode `fingerprint_and_prediction`, `ttlHours` 72, idempotency key `air478-canary-20261122-s5-01`). Capability: [ADR 0165](../../adr/0165-scoped-prediction-recovery-intent.md) (Accepted), migration `0024` ([apply evidence](../d1-migration/air-478-0024-apply-2026-11-18.md)); queue share for recovery intents: [AIR-577](https://trello.com/c/1fuEawPv). Database `iptv` (`3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb`). Film ids and counts only; no prediction payloads.

## Context

The first canary (cohort `pr_4c7fcab68eb39d02afd0c7a4`, confirmed 18 Nov 2026, 10 films) expired on 21 Nov 2026 12:56 UTC with 2 of 10 re-scored (`tmdb_475961`, `tmdb_1251717`); the other 8 were never reached behind the hot backlog. This second canary repeats those 8 and adds 2 films from the frozen 288 cohort, after AIR-577 gave confirmed recovery intents a reserved share of each batch v2 manifest.

## Cohort

`Ozne`, `RTVm`, `tmdb_1100782`, `tmdb_1180894`, `tmdb_1519168`, `tmdb_461992`, `tmdb_463821`, `tmdb_833149` (from the first canary), `tmdb_1089123`, `tmdb_1151031` (new). All are sparse-fingerprint films of the frozen 288 cohort.

## Before-image (read-only D1, about 17:15 UTC)

- Each of the 10 films: `prediction_pointer` on profile version 2, `generatedAt` on 28 Oct 2026, one `prediction_lineage` row, no live (unexpired active) recovery intent. Fingerprints generated 8–21 Oct 2026.
- `schema_contract` version 33; `prediction_recovery_revision` 1; one cohort row (the first canary, `active`, expired 21 Nov 2026 12:56 UTC); prediction marker `d1`/`held`; Film/Person `d1`/`open`/2; leases `runner:0`, `writer:0`.

## Preview (owner Access session, GET)

`GET /api/admin/prediction-recovery-intent/preview?films=<10 ids>&mode=fingerprint_and_prediction&ttlHours=72` → `200`: `schema.ready` true, revision 1, `authority.prediction` `d1`/`held`, `filmPerson` `open`/2, `counts` eligible 10 (blocked, unchanged, conflict 0), `confirmable` true, runner lease not live, queue refreshed 17:30:20 UTC with `recoveryRevision` 1 (3654 hot, 3397 cold remaining), `scopeHash` `c7006458af0ac922a25f0ade56f4ce7cde64f9f4e5beefa813413988e72d7dfb`. The 8 repeated films showed the expired intent of the first cohort as `activeIntent`, which the confirmation settles.

A first owner login attempt produced no token (the waiting `cloudflared` process had stopped between turns); no request was sent with it. The second login succeeded.

## Confirm (owner Access session, POST, once)

`POST /api/admin/prediction-recovery-intent/confirm` with the 10 films, mode, `ttlHours` 72, the preview `scopeHash` and key `air478-canary-20261122-s5-01` → `201 confirmed`: cohort `pr_c1f34f1e8b8390fd3df89228`, 10 films, 0 skipped, created 2026-11-22T17:40:45.411Z, expires 2026-11-25T17:40:45.411Z, revision 2, effect `queued_on_next_rebuild`.

## Readback (read-only)

- `GET /api/admin/prediction-recovery-intent/cohort?id=pr_c1f34f1e8b8390fd3df89228` → `200`: `active`, mode `fingerprint_and_prediction`, 10 films, 10 `pending`.
- D1: `prediction_recovery_revision` 2. New cohort: 10 `active` intents, all with a `fingerprint_token`, and all 10 `prediction_token` values equal the current D1 pointer tokens (pending). First cohort: 8 intents `settled` by this confirmation, 2 still `active` (`tmdb_475961`, `tmdb_1251717`; both already re-scored, so their tokens no longer match and they deny nothing). `prediction_lineage` 290 rows (288 plus those two re-scores).

## Not done and not proved

No `batch/start`, reconcile, Scheduled Task, flag, lease or retry change; no manual prediction. The re-scores themselves happen in later natural batch v2 runs and are not part of this record. Bulk recovery of the remaining 268 eligible films, the 8 `not_admitted` films and the retained Film `SEXE` / `tmdb_1423191` are out of scope and not authorized here.
