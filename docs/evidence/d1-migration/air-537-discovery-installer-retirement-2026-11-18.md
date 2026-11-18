# AIR-537 slice 1: Discovery R2 installer write path retired, 18 November 2026

**Trello:** [AIR-537](https://trello.com/c/wbe7jjNs). **Basis:** [AIR-79 final retirement audit](air-79-final-retirement-audit-2026-11-18.md), scope item 1. **Captured:** 18 November 2026 (UTC) on `main` `4804767`. Static code change; no production read or write, no installer run.

## Ledger rows (scope item 1)

| Candidate | Disposition | Caller and safety reason | Tests | Rollback |
| --- | --- | --- | --- | --- |
| `scripts/discovery-ledger-install.mjs` `--apply --approved-production-writes` (R2 `PutObject` of the plan and the resolver lease, Worker `applySplit` over an S3 store) | **Removed.** `--apply` is refused with exit 2 before a plan is read or a request built. | No live caller. It ignored the `discovery_authority` marker and could write legacy Discovery R2 authority objects while Discovery is D1 `open`. Removal, not a marker guard, because no writer is needed. | `tests/discovery-ledger-install.mjs`: every `apply`/`approved`/credential combination is refused with zero bucket PUTs; the CLI exits 2. | Revert the PR; the data it could have written is not restored by a revert. |
| `scripts/discovery-ledger-install.mjs` dry run | **Retained**, read-only (`GET`/`HEAD`, snapshot credential only). | Offline plan re-check against a bucket; offline analysis, writes nothing. | Same test: `READY`, `NOT-READY` on a moved pointer, zero PUTs. | n/a |
| `createS3Store`, `readInstallCredentials`, `InstallError` | **Retained, moved** to `scripts/r2-s3-store.mjs` (no import side effects). | Imported by `scripts/prediction-domain-production.mjs`; writes and deletes exist only for keys in `allowedWrites` / `allowedDeletes`, preconditions mandatory. | `tests/discovery-ledger-install.mjs` (store guards, 403 read-only credential), `tests/prediction-domain-production.mjs`. | Revert. |
| `scripts/discovery-ledger-split.mjs` and other read-only offline utilities | **Retained** (default per the card). | Offline snapshot plan and rehearsal; private output directory. | existing | n/a |

R2 key families touched: none at runtime. Production R2 and D1 were not read or written.
