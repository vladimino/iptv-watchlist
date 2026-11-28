# Production schema drift in `canonical_producer_chain` and the one accepted alternate fingerprint (AIR-603, 28 Nov 2026)

Dated observation and decision record for the [D1 migration window runbook](../../runbooks/d1-migration-window-v38-v54.md). It is not a schema contract and authorizes no production operation.

## Observation (read-only, 27 Nov 2026 23:25-23:41 UTC)

- The standard `node scripts/d1-migration-window-production.mjs --target iptv --status` (operator SHA-256 `11337dbaab787226ddebd6990c53fb49552e9b49aab07757a9d35e3b71d89843`, reference `f8285519a07db8ae6e5d94a23c8fec91b4cf8da0c0214fb1125323e91b7eaa97`, main `698645d`) read schema 38 and `chain.verified=false` with exactly one difference: `changed: table:canonical_producer_chain` (`missing`, `extra` and `early` empty). The operator refused A and B as designed; the guard was not bypassed.
- Diagnosis by `SELECT ... FROM sqlite_master WHERE name='canonical_producer_chain'`: in the production stored text the `CHECK` of the `updated_at` column contains `substr(created_at, 11, 1) = 'T'` where migrations/0023 contains `substr(updated_at, 11, 1) = 'T'`. Normalized fingerprints: production `68a792a519e37cfe`, reference `068fdcaad8e8bc9d`. Replacing that single token in the production text yields the reference fingerprint (checked); the reference entry is identical at every version 38-54.
- No committed version of `migrations/0023_canonical_producer_chain.sql` (three versions on 15 Nov 2026 and the applied blob `5976714f4d91689bd9950ff858eab5e5dcf041fa` recorded by [the 0023 apply evidence](air-499-0023-apply-2026-11-16.md), identical to the current file) contains the observed text (searched with `git log -S`). **The origin is unknown** and was not investigated further without new evidence.
- Effect: the `updated_at` check is one condition weaker (the `T` at position 11 of `updated_at` is not tested there; `created_at` is tested by its own check). Read-only count on 27 Nov 2026 23:41 UTC: **13 rows, 0 violating the full canonical `updated_at` check** (including the `T` at position 11). No private data was printed.

## Decision

Owner decision of 28 Nov 2026 (Trello AIR-603, option A of the L0 report): keep the canonical reference and accept exactly one documented alternate fingerprint for `table:canonical_producer_chain`, versions 38-54. Not done, by decision: editing the historical 0023, rebuilding the production table, loosening the SQL normalization, a general allowlist of unknown drift.

## Tests (offline, scratch SQLite, `tests/d1-migration-window-production.mjs`)

The canonical and the observed form both verify, plan and apply the A chain (38 to 47), the whole chain (38 to 54) and a resume from 47 and 53, with a readback accepted after every file and the table not rewritten. The pinned hash equals the one-token change and nothing else; the reference holds exactly one alternate. Still fail closed with nothing sent: another literal or constraint on top of either form, a different token, the same token swap on another table (`canonical_producer_run`), and a change of the table to a non-accepted form between two files (the next file's readback ends `write_uncertain`, no further batch). The SQL files `0039`-`0054` are unchanged.
