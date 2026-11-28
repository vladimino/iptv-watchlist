# AIR-636: activation of film metadata provenance, `off → enforce`, 28 November 2026

[AIR-636](https://trello.com/c/0jJADYxg) · [ADR 0214](../../adr/0214-film-metadata-per-field-provenance.md) (PVE, decision 15 as amended on 28 Nov 2026) · [runbook](../../runbooks/film-metadata-provenance-activation.md) · plan: [final preflight](air-636-provenance-enforce-final-preflight-2026-11-28.md) and the [candidate L3 plan](https://trello.com/c/0jJADYxg#comment-6b0a889396a5cd87bb03dc86).

## Result in one line

The control row moved `off`/1 → `enforce`/2 by exactly one guarded `UPDATE` (`changes = 1`) on the pinned deployment; an independent readback matched the statement, the token and the unchanged baselines. No flag, Scheduled Task, sync or other table was written.

## Authorization

The owner gave the L3 GO in the executor chat on 28 Nov 2026 (after the 08:54 Madrid candidate plan), confirming no conflicting owner request or operation in flight, for one `off → enforce` CAS on the pin below. The chat does not carry a Trello comment id, so the operator token uses the executor session id in place of the Controller's GO record id; the Controller should link the token to the owner's GO on the card.

## Recheck immediately before the statement (about 08:08 UTC, read-only)

| Item | Observed |
| --- | --- |
| Deployment pin | `887b41b7-d091-45ce-bc6f-c619c2e8d44c`, version `008eb6ab-a3e3-4da3-af94-fe42f75f22f2`, 100 %, `created_on` 2026-11-28T07:53:18.10594Z, commit `2eeaa715801a283ce33b791c1899e9dd89200e3c`; the newest deployment, equal to the plan |
| Interval | `T0` 2026-11-28T06:28:11.923Z; about 6,000 s at the recheck, over `B = 3,910 s` |
| Workflow inventory | `queued`, `running`, `waiting`, `paused`, `waitingForPause`, `rollingBack`: 0 for `iptv-epg`, `iptv-producer`, `iptv-catalog-enrichment`, `iptv-discovery`, `iptv-letterboxd`, `iptv-prediction-start` |
| CI/CD on `main` | newest push run `46122926576` completed `success`; none queued or in progress |
| Schema | `schema_contract` version 54; 0053 constraints present on `film_metadata_field` and `film_metadata_history` |
| Control | one row, `off`, revision 1, `updated_by migration:0049` |
| Release rows / baselines | `film_metadata_owner_release` 0; `film_metadata_field` 0, `film_metadata_history` 0, `film_metadata_owner_command` 0 |
| Authority | `film_person_authority` `d1` / `open` / generation 2 |
| Orchestration, lease, projector | mode `cloudflare`; lease `released: true`; `projector_window` `idle`, no owner |
| Receipts | `canonical_write_receipt` in `pending`, `failed`, `unknown`: 0; newest `updated_at` 2026-11-28T06:44:42.172Z |
| C1 | `catalog_enrichment_control` 0 rows (not activated) |

## The statement

```sql
UPDATE film_metadata_provenance_control
SET mode = 'enforce', revision = revision + 1, updated_at = '2026-11-28T08:10:00.000Z',
    updated_by = 'air636-pve:session_014nGEiYEakwDUaJ6ojtfKp2:2026-11-28T08:10:00.000Z'
WHERE id = 1 AND mode = 'off' AND revision = 1;
```

Outcome: `changes = 1`, `rows_written = 1`, no error. `:now` was fixed as 08:10:00.000Z before execution; the statement ran about two minutes earlier by wall clock (about 08:08–08:09 UTC), so `updated_at` is slightly ahead of the real write time. The flip time `Tf` for the acceptance below is the recorded `updated_at`, which is an upper bound on the real instant by that margin.

## Independent readback (a second, separate read)

- Control: `enforce`, revision 2, `updated_at` 2026-11-28T08:10:00.000Z, `updated_by` exactly the token above; one row.
- `film_metadata_owner_release` 0; `film_metadata_field` 0, `film_metadata_history` 0, `film_metadata_owner_command` 0 (equal to the baseline); `film_person_authority` `d1`/`open`/2; schema 54; newest receipt unchanged.
- Deployment list re-read: still `887b41b7…` at 100 %. Flags and Scheduled Tasks were not touched.

## Baseline for natural acceptance (runbook section 5)

`Tf = 2026-11-28T08:10:00.000Z`, revision 2. Criteria are read-only `SELECT`s later and are classed observed, fixture guarantee, no natural opportunity yet, or coverage missing; none is proven by this file. No writer, fetch, refresh or owner write is to be run to produce evidence. The card goes to `Верификация` after the PR delivery; `mark_done` only on accepted natural evidence.

## Not verified

- The owner attestation is the chat statement only.
- Whether the external HTTP/MCP metadata path really answers 409 was not exercised.
- Invocation logs were not used; absence in logs is not claimed as proof.
- Hold (`enforce → hold`) is a separate owner GO and was not exercised.
