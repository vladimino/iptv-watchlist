# AIR-478: bulk recovery confirmed (265 films in six cohorts, 22 Nov 2026)

Date: 22 Nov 2026, about 19:15–19:30 UTC. Owner GO for bulk recovery in [AIR-478](https://trello.com/c/IbsSCRce) (comment of 22 Nov 2026, 19:11 UTC: six fixed allowlists, mode `fingerprint_and_prediction`, `ttlHours` 72, keys `air478-bulk-20261122-s5-01` … `-06`, at most 268 eligible) after the owner accepted the [second canary](air-478-s5-canary-confirm-2026-11-22.md). Capability: [ADR 0165](../../adr/0165-scoped-prediction-recovery-intent.md); recovery share of each batch v2 manifest: [AIR-577](https://trello.com/c/1fuEawPv). Database `iptv` (`3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb`). Film ids and counts only; no prediction payloads.

## Input check (read-only)

- The six allowlists hold 276 unique ids; sorted with `localeCompare('en')`, joined with LF and a final LF, their SHA-256 is `8c0c9b5647326c1567fb03dc230e5c7a41197e3e80065d943d718ccedd2cde99`, the value in the handoff.
- The same 276 ids are exactly the D1 films with a profile-v1 `prediction_lineage` row and no `prediction_recovery_intent` of any state (the frozen 288 minus the 12 films of both canaries).
- Before the first write: recovery revision 2, 10 live intents (the second canary), no `air478-bulk-*` cohort, prediction marker `d1`/`held`, Film/Person `d1`/`open`/2, schema 33.

## Deviation and owner decision (before any write)

The preview of chunk 1 showed `21XQ` as `blocked`/`not_admitted`, although it was eligible on 18 Nov 2026; the executor's check stopped before the confirm. Previews of chunks 2–6 (read-only) found two more: `q2CM` and `tmdb_101669`. All three have left the watchlist, the programme and the admitted catalog since 18 Nov. Total eligible: 265, not 268; no `conflict`, no `unchanged`. The owner decided in the session to confirm the 265 and to add the three to the `not_admitted` group for a separate decision. That group is now 11 films: `28Bi`, `FEGM`, `MwlA`, `SEXE`, `qIvo`, `tmdb_1212763`, `tmdb_443791`, `tmdb_710295`, `21XQ`, `q2CM`, `tmdb_101669`.

## Confirmations (owner Access session)

Per chunk, sequentially: a fresh `GET …/preview` (stopping on any outcome other than `eligible` or `blocked`/`not_admitted` for the 11 films above, or a non-confirmable answer), one `POST …/confirm` with the preview `scopeHash` and the chunk key, then `GET …/cohort`. No POST was repeated.

| Chunk | Cohort | Confirmed | Skipped (`not_admitted`) | Revision | Expires (UTC) |
| --- | --- | --- | --- | --- | --- |
| 1 | `pr_c61ff9cc354298ec1560c5b3` | 46 | `21XQ`, `28Bi`, `FEGM`, `MwlA` | 3 | 2026-11-25T19:21:59Z |
| 2 | `pr_d411a79997241720e3f03ab1` | 45 | `q2CM`, `qIvo`, `SEXE`, `tmdb_101669`, `tmdb_1212763` | 4 | 2026-11-25T19:22:35Z |
| 3 | `pr_205e1198311cc2024e5954a8` | 50 | — | 5 | 2026-11-25T19:23:15Z |
| 4 | `pr_a8fb9fbef38e20c1438ed270` | 49 | `tmdb_443791` | 6 | 2026-11-25T19:23:55Z |
| 5 | `pr_227d245e5513f12115f25aeb` | 49 | `tmdb_710295` | 7 | 2026-11-25T19:24:30Z |
| 6 | `pr_6ee5c8f4a7e872915251f499` | 26 | — | 8 | 2026-11-25T19:25:04Z |

Every confirm answered `201 confirmed`; every cohort read answered `active` with all films `pending`.

## Postflight (read-only D1)

- `prediction_recovery_revision` 8. Six `air478-bulk-*` cohorts with 265 films; 265 `active` intents, all with a `fingerprint_token`; all 265 `prediction_token` values equal the current pointer tokens (pending). None of the 11 `not_admitted` films has a bulk intent.
- 275 live intents over 275 distinct films (265 bulk plus the 10 of the second canary), below the cap of 300.
- `prediction_lineage` 299 rows (290 after the second canary confirm, plus 9 re-scores of that canary since). Prediction marker `d1`/`held`.

## Not done and not proved

No `batch/start`, reconcile, Scheduled Task, flag, lease or retry change; no manual prediction. The re-scores happen in later natural batch v2 runs (about 8 recovery films per hour at the 40 % share); 265 films in 72 hours is close to that rate, and expired intents are not renewed without a new owner decision. The 11 `not_admitted` films and the retained Film `SEXE` / `tmdb_1423191` are outside this operation.
