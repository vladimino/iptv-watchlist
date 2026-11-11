# AIR-374 holdpoint decision pack and migration 0019 apply procedure: verification record

**Captured:** 2026-11-11, code and document reading on `origin/main` `dfd1a51` (the P1 to P7 offline PRs merged). **Method:** reading only; no production read, no connector, Cloudflare, R2, D1, Trello or GitHub write other than this documentation PR. Two local read-only `node` evaluations of data constants (the exception lists and the producer wiring registry) and the repository's own test commands. This file holds counts and digests only.

**Result:** the two runbooks ([0019 apply](../../runbooks/film-person-0019-apply.md), [holdpoint decision pack](../../runbooks/film-person-holdpoint-decision-pack.md)) were written against the merged code. They authorize nothing and nothing in them was executed.

## What was verified, against which files

| Claim | Source read | Result |
| --- | --- | --- |
| 0019 is 28 statements: 1 refuse-insert, 4 tables, 2 indexes, 20 triggers (19 new plus the shared `IF NOT EXISTS`), 1 update | `migrations/0019_canonical_write_receipt.sql`; counts of `CREATE TABLE` 4 and `CREATE TRIGGER` 20 | confirmed; file blob `275cbcf`, sha256 `75acd55e`, 15,398 bytes |
| The refuse-insert aborts on anything but a complete v18 (primary key `id=1`) | the same file; `migrations/0001_schema_v1.sql` `schema_contract` | confirmed |
| No trigger of 0019 is attached to an existing table; new tables are write-refused unless the marker is `d1`/`open` | the same file | confirmed |
| `film_person_authority_needs_baseline` checks the baseline only when leaving `r2`; `prepared` to `d1` is not baseline-checked in SQL | `migrations/0013_film_person_authority.sql` | confirmed |
| `transitionAuthority` asserts neither lease, window nor baseline; moves are generation-guarded and the CAS fence follows | `src/film-person-authority.js` | confirmed |
| The projector defers at `d1`/`held`; each real batch asserts marker and generation | `src/film-person-authority.js` (`PROJECTOR_*`), `src/d1-enrichment.js` (reason strings), [ADR 0116](../../adr/0116-projector-marker-and-generation-fence-on-every-batch.md) | confirmed in code and ADR; the deployed version was not checked |
| `SCHEMA_EXPECTED=18` in the capture gate; three test fixtures filter migrations `<=18`; the readiness test lowers the contract to 18 | `scripts/film-person-capture.mjs` line 33, `tests/film-person-capture.mjs`, `tests/film-person-connector.mjs`, `tests/film-person-cutover-run.mjs`, `tests/canonical-handoff-readiness.mjs` | confirmed (line numbers in the apply runbook) |
| `recordBaseline` runs only at `d1`/`open`, copies `canonical_revision` in one fenced batch, then seals; cap 5,000 | `src/canonical-receipts.js`, migration 0019 comments | confirmed; no operator emitter or CLI exists for it |
| `handoffReadiness` returns 30 blockers today: 10 + 1 + 1 + 4 + 11 + 3 | `src/canonical-producers.js`, a local evaluation of `P6_DIFFERENTIAL_EXCEPTIONS` (5) and `EXTRA_EXCEPTIONS` (7): 12 entries, 2 accepted, 10 draft; `PRODUCER_WIRING` 4 entries; `CANONICAL_READER_REGISTRY` 11 `freeze` entries with `moved:false`; [P6 evidence](air-374-p6-differential-harness-offline-2026-11-11.md) | confirmed; consistent with the P6 evidence |
| The loader refuses below schema 16, loads exactly 708/401/4 in 30 batches of at most 40 rows, and writes only the three tables | `scripts/film-person-prepared-loader.mjs`, [loader runbook](../../runbooks/film-person-prepared-loader.md) | confirmed from the code header, constants and runbook; not re-run |
| `tmdb_retirement_decision` is append-only by trigger; the other two loaded tables have no marker trigger | `migrations/0015_film_admission.sql`, `migrations/0016_tmdb_retirement_decision.sql` | confirmed |
| The connector D1 write path of 11 Nov 2026 was `d1_database_query`, the API connector `execute` having no D1 write permission | [baseline runbook](../../runbooks/film-person-baseline.md) and [AIR-373 evidence](air-373-baseline-prepared-2026-11-11.md) | taken from those documents |
| Apply precedents: one `{sql}` body of the exact file, then a readback | [0012 apply](air-357-0012-apply-2026-11-05.md), [0013 apply](air-373-0013-apply-2026-11-08.md) | taken from those documents |
| The activation tool `scripts/film-person-open-handoff.mjs` does not exist | `ls scripts`, [ADR 0117](../../adr/0117-film-person-d1-handoff-owner-decisions.md) follow-ups | confirmed absent |
| `scripts/schema-preflight.mjs` knows only 0013 to 0016 | its `SEQUENCE` constant | confirmed |

## Not verified

- Production state of any kind after the 11 Nov 2026 baseline record (schema 18, marker, lease, window, flag values, counts of 0 rows in the new tables): every value is carried from earlier dated evidence and must be re-read live.
- That D1 runs a multi-statement `query` body atomically on the connector, and how a mid-file failure leaves the schema.
- That the connector accepts the 20 trigger bodies of 0019 as it accepted the six of 0013.
- The `wrangler` route for any step and the Time Travel read through a connector.
- The deployed Worker version and whether the ADR 0116 fence is the deployed code.
- Whether an operator can request the exclusive projector window; the exact times of the Predictions, Discovery and EPG runs.
- Whether a PR is planned for the eleven `reader_not_moved` readers, and the form of the activation, drill and receipt-baseline tooling.
- Effort estimates in the summary table (author's estimates, not measurements).
- That the full test suite stays green after the SCHEMA_EXPECTED bump; that belongs to the PR which makes it.
