# AIR-554: the production R2 snapshot to importer converter, offline evidence

22 November 2026 (Europe/Madrid) · [AIR-554](https://trello.com/c/UrS1gflv) Phase A, second line of the owner-approved preparation. Offline only: the **real** exporter (`scripts/r2-snapshot-export.mjs`) against a fake S3-compatible bucket, the four families written by the **real** Worker on its legacy R2 path, a sqlite D1 stand-in. **No production R2 export, no credential, no production call.**

## The gap it closes

The exporter stores the whole bucket as `objects/<sha256 of the key>.bin` plus `manifest.json`; the importer read only a key-mirrored directory or a key-to-document map. Nothing bridged them and nothing showed the exporter's output passing `report`, `sql` and `verify` (review of the proposed plan, PR 889).

## What was built

- `scripts/prediction-aux-export-convert.mjs`: refuses unless `verifyProductionSnapshot` passes and the status is `consistent_fenced` (no NO-GO reason, no change between listings, fence held); selects exactly the objects of the four families and the pending index through `auxExportFamily` (one classification shared with the importer); checks each entry (metadata names the same key and size, a strong ETag, a safe path); re-hashes each object at the moment of the copy; writes the exact bytes into `tree/`, plus `identity.json` (key, ETag, size, SHA-256) and `converter-report.json` last; the output directory is absolute, outside the repository and new or empty; a refused run removes what it wrote.
- `scripts/prediction-aux-d1-import.mjs`: exports `auxExportFamily`, the single source of the family classification.
- `tests/r2-fake-bucket-lib.mjs`: the fake bucket of the exporter test, now shared (the exporter test passes unchanged in behaviour).

## Tests (`tests/prediction-aux-export-convert.mjs`, core)

| Claim | Result |
| --- | --- |
| Real exporter → converter: exactly the four families are copied, byte for byte (including a large Unicode document), no noise, no fence key, no Events journal item; private modes | pass |
| `identity.json` equals the snapshot's ETag, size and SHA-256 and feeds `auxFlipRefusal` | pass |
| The importer's plan from the converted tree equals the plan from the original export: **no count and no digest changes** | pass |
| `report`, `digest`, `preflight` run on the tree; `sql` needs `--generation`; the SQL imports into an empty database at the named closure, a plan of another closure refuses, and `verify` passes on the rows | pass |
| Stage and outbox state, a skipped record, a delivered stop record, an orphan source (no run row; `preflight` answers without it) | pass |
| Refused, with nothing left behind: no manifest, no-go status, a change between listings, a fence that did not hold, a missing object file, a changed object (same length, other bytes), a truncated object, a duplicated entry, a weak or missing ETag, metadata naming another key or size | pass (12 cases) |
| Hashed again AT the copy: a file changed (same length and shorter) after the snapshot verified is refused and removed | pass |
| Path guards: relative, inside the repository, overlapping the snapshot, a non-empty output directory (untouched); an existing empty directory is accepted and left empty on a refusal; unsafe key segments (`..`, `.`, empty, backslash, NUL) | pass |
| **Real location (review of PR 896, P1):** an output that is a symlink (to an empty directory of the repository, to a directory outside it, or dangling), a symlinked parent that leads into the repository (new target, deep new target), a snapshot reached through a link into the repository: all refused, **nothing written into the repository**; a parent link that stays outside the repository is accepted; the CLI refuses the same way | pass |
| **No silent loss (review, P1):** `enrichment/sources/run.backup.json`, `sources/run.bin`, `sources/sub/run.json`, `batch-manifest/run.v2.json`, `batch-manifest/run.bin`, `stop-events/x.bin`, an unknown event name, `start-events/y.json.bak` are refused by the converter (`unconsumed_key`) and, in a plain tree without the converter, are importer blockers (`*_key_unknown`, non-JSON files included), `ignoredObjects` stays 0 and no SQL is printed | pass |
| A malformed document and an unknown event key are handed over unchanged; the importer blocks (exit 2, no SQL) | pass |
| The converter names no network, credential, database or bucket binding; its stdout carries counts and digests, never a document body | pass |

Mutation checks (each makes the test fail, restoring it passes): no consistency check; no hash at the copy; copying every object; accepting unconsumed keys in the converter; ignoring unknown family keys in the importer; a lexical-only path check.

## Not covered, on purpose

A real private export (needs its own owner authorization; the owner instruction is in the [runbook](../../runbooks/prediction-aux-state-cutover.md#getting-the-importer-input-from-the-production-snapshot)); the size and batching of the real import (scratch rehearsal on that export); the cutover operator. A prefix-scoped export would remove the dependency on a whole-bucket fenced cut and is not built. Nothing here authorizes a production read, export, import or Task change.
