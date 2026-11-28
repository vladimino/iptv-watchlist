# AIR-603: production apply of the D1 migration window, schema 38 to 54 (28 Nov 2026)

Dated record of one owner-authorized, schema-only production operation on D1 `iptv` (UUID `3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb`) through the delivered operator of the [window runbook](../../runbooks/d1-migration-window-v38-v54.md). Times are UTC; Europe/Madrid is UTC+1 on that date. It records what happened, not what is true now: the present schema, markers and leases are read live.

## Authorization and holdpoints

- Owner L3 GO of 28 Nov 2026 00:14 UTC in [the AIR-603 card](https://trello.com/c/wc7pHJTB#comment-6b0a1d025422c34e4436c2c4): both packages (A = 0039-0047, then B = 0048-0054 only on a verified v47, a dormant baseline and a fresh `apply` decision), per-file atomic batches and readback, no blind retry, no downgrade or restore, the four Predictions Tasks paused and restored by the Coordinator only. The staged proposal is [the card comment of 00:10 UTC](https://trello.com/c/wc7pHJTB#comment-6b0a1bace7685446d7d8567b).
- Coordinator holdpoint released at 00:26:47 UTC ([holdpoint comment of 28 Nov 2026 01:26 Madrid](https://trello.com/c/wc7pHJTB#comment-6b0a1fc7f35f910f3b4a5f9d)): all four Predictions Tasks disabled (schedule and prompt checksum unchanged), the Predictions runner lease expired naturally at 00:26:15.482 UTC (it was not reset), six Workflows without a non-terminal instance, Worker `50020eb8-b89a-4abb-ad4f-65053253da7f` at 100 percent, EPG, Discovery, Ratings and Watchlist idle or complete. Those sources are the Coordinator's; the executor only read D1.
- Code: `main` `935404c65465419ae1df8d1096c94b6d54c72c69` (operator delivered by PR #1056 and #1059), checked out detached. Pins equal to the GO: manifest SHA-256 `5ef0a8bf05f46664c1203736aa18e924dec2b5ba256ad0ac8299ddcd2508125b`, operator `4d741f8a4fe29893ffea8de2ae0b01770204816cbb2753758803224aa804a1b7`, reference `a928a0c4eff606f280044b9eb447b6938681352c530c5f2a1224ba2c8ff6b3a3`, all 16 files by Git blob and SHA-256 (`filesPinned` true). The `canonical_producer_chain` alternate fingerprint is [documented separately](air-603-canonical-producer-chain-drift-2026-11-28.md); it was reported as `acceptedAlternates` in every status below.

## Preflight (read-only `--status`, immediately before each write)

| Before | UTC | Schema | Chain | Dormant | Quiet facts | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| A | 00:27:17 | 38 (one row) | verified, only the accepted alternate | yes | Producer chains 0, prediction lease 0, Discovery lease 0, loading transfer 0, projector idle | 47 and 54 `apply` |
| B | 00:29:33 | 47 | verified, only the accepted alternate | yes | same, import runs 0 | 47 `already_at_target`, 54 `apply`, remaining 48-54; the three retired tables 0, 0, 0 rows, no dependent or attached object |

## The operation (two invocations, no retry, no other write)

```
--target iptv --apply --through 47 --start 38 --confirm apply --manifest-sha256 <manifest> --operator-sha256 <operator>
--target iptv --apply --through 54 --start 47 --confirm apply --manifest-sha256 <manifest> --operator-sha256 <operator>
```

Both exited 0 with `writeState` `committed`. Each file was one atomic batch of its unchanged statements, with a fresh whole-state observation before it and a readback after it (version, the whole schema against the pinned reference, markers, writer control and history, preserved tables).

| Checkpoint | File | Committed (UTC) |
| --- | --- | --- |
| A | 0039_receipt_operation_key | 00:27:38.777 |
| A | 0040_tmdb_retirement_decision_movie_index | 00:27:49.924 |
| A | 0041_film_identity_evidence | 00:28:00.979 |
| A | 0042_identity_evidence_writer_control | 00:28:12.658 |
| A | 0043_film_redirect_by_target | 00:28:24.482 |
| A | 0044_identity_evidence_reconstruction_import | 00:28:37.213 |
| A | 0045_upstream_cooldown | 00:28:49.621 |
| A | 0046_letterboxd_admission_authority | 00:29:02.353 |
| A | 0047_catalog_enrichment | 00:29:15.544 |
| B | 0048_film_lid_admission | 00:29:56.500 |
| B | 0049_film_metadata_provenance | 00:30:12.816 |
| B | 0050_discovery_enrichment_scope | 00:30:29.678 |
| B | 0051_lid_recheck_intent | 00:30:46.194 |
| B | 0052_lid_tmdb_attach_writer | 00:31:03.482 |
| B | 0053_provenance_other_language | 00:31:20.746 |
| B | 0054_retire_legacy_identity_assertion_tables | 00:31:36.551 |

Time Travel bookmarks (recovery points, no restore was requested): before A `0000133d-00000000-00005131-65aec0ad78dba3a42e419ecfdb41a61d`, after A `0000133d-00000014-00005131-d3888b9611430315f935099764f6cfdf`; before B `0000133d-00000016-00005131-8b322a5560f615d93510c375af42b12e`, after B `0000133d-00000026-00005131-d76cad1d874cceaece608d35746cbb43`. No file refused, none ended unknown, `defer_0054` was not needed, no stop other than the planned end of each target.

## Independent readback (a new process and separate `SELECT`s, 00:31:55-00:31:56)

- `schema_contract`: one row, version **54**, the 0054 note. `--status`: `chain.verified` true, `plan.54` `already_at_target`, `filesPinned` true, quiet facts all 0.
- Dormant baseline after the window: `film_metadata_provenance_control` mode `off` (revision 1); `letterboxd_admission_authority` `r2` generation 0; `catalog_enrichment_scope` 0 rows; `catalog_enrichment_control` 0 rows; `identity_evidence_writer` and `identity_evidence_writer_change` 0 rows (every writer off or absent); `film_identity_evidence`, `film_lid_admission`, `lid_recheck_intent`, `enrichment_signal` 0 rows; `film_metadata_field`, `film_metadata_history`, `film_metadata_owner_command`, `film_metadata_owner_release` 0 rows; `identity_assertion`, `identity_rule_version`, `identity_application` no longer exist; no `*_hold` or `*_v53` table remained.
- Unchanged by the window: `film` 13867 rows, `film_metadata` 414, `film_external_id` 14701, `canonical_write_receipt` 4295 (all `applied`). The `prediction_domain_authority` and `discovery_authority` generations are higher than in the 27 Nov 2026 23:25 UTC status (48776 to 48825 and 339523 to 339525, live writers before the Tasks were paused); the operator's per-file invariant check found no marker change during the window.

## Coordinator safe stop and restore of the Predictions Tasks

Recorded from the Coordinator's [acceptance of 28 Nov 2026 00:36 UTC](https://trello.com/c/wc7pHJTB#comment-6b0a21f2117dac6169f84da4); the executor did not touch any Task. The executor's report was accepted as a safe stop: both checkpoints exited 0 and committed, 16 of 16 files, no retry, no unknown outcome, the window closed and the migration SQL is not to be run again.

- **Two different readbacks.** The full fingerprint verification (the whole schema against the pinned reference, markers, writer control and history, preserved tables) is the operator's `--status` run by the executor in a separate process. The Coordinator separately ran independent Cloudflare D1 `SELECT`s at 00:35:23 UTC and confirmed: `schema_contract` one row at 54; Letterboxd admission `r2` generation 0; provenance control `off` revision 1; enrichment scope and control 0 and 0 rows; identity evidence writer and change 0 and 0 rows; the three retired tables and every `*_v53` and `*_hold` table absent; `film` 13867, `film_metadata` 414, `film_external_id` 14701 and `canonical_write_receipt` 4295 unchanged; no live prediction lease. The Coordinator's `SELECT`s did not repeat the fingerprint comparison.
- **Tasks.** The four Predictions Tasks v2 (:00, :15, :30, :45) were restored as the owner GO required: all four read back `enabled` true, and their prompt and schedule are byte-identical to the state before the restore, with the control prompt checksums equal to the baseline recorded in the GO. Only the enabled flag was changed. No manual run was started and no other Task was touched. No prompt content is reproduced here.

## Not done

No C2 or A2 step, no scope or marker flip, no writer activation, no import or backfill, no flag, Access, lease or Task change by the executor (the Coordinator paused and restores the four Tasks; their restore is recorded by the Coordinator, not here), no historical enrichment, no cutover. The only production writes were the sixteen migration files.

## Limits

The offline tests and the 27-28 Nov 2026 L0 reads are the preparation record; this page proves the apply and the readback listed above and nothing about later behaviour. The Worker bundle was not changed. Rollback is forward-only: `schema_contract.version` never goes down and no restore was requested.
