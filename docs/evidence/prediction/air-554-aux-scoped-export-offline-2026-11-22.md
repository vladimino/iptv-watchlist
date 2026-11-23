# AIR-554: scoped export of the auxiliary state, offline tests (22 Nov 2026)

Offline only: a fake S3-compatible bucket over loopback, a scratch sqlite D1 stand-in and the real exporter, converter, importer, operator and Worker code. No production bucket, credential, D1, Task, Workflow or flag was touched. This page records what the tests prove and what they do not; it approves no production export.

Design: [ADR 0200](../../adr/0200-prediction-aux-scoped-export-proof.md); contract: the scope section of the [run sheet](../../runbooks/prediction-aux-cutover-run-sheet.md#scope-contract-of-the-scoped-export-implemented-offline-adr-0200-used-only-if-the-owner-selects-it-at-p4). Code: `scripts/prediction-aux-scope.mjs`, `scripts/r2-snapshot-export.mjs` (`--scope prediction-aux`), `scripts/prediction-aux-export-convert.mjs`, `scripts/prediction-aux-cutover-production.mjs`.

## What the tests show

`tests/r2-snapshot-export-scoped.mjs` (core):

- **Coverage.** The scope equals the importer's families (`auxExportFamily`, `auxConsumableKey`) and the Worker's closed-gate key sets (a source-level tie), holds the four prefixes and two exact keys, and its fence is the two batch leases only (no EPG or Discovery coordination key).
- **Scoped cut over a bucket full of unrelated objects.** Only the four prefixes are listed (never the empty prefix), no object outside the scope and its two lease keys is read, the manifest holds exactly the auxiliary objects and records the scope, pagination is exhausted for every prefix, `--verify` returns the scope, and the converter takes it whole with nothing skipped.
- **Unrelated writers.** One object of every unrelated writer (monitor state, Discovery segment, Letterboxd diary, EPG lease and generation, `sync.json`) changes during the export: the scoped cut stays `consistent_fenced`; the whole-bucket mode keeps its old NO-GO under the same writer.
- **Changes inside the scope.** A record added under the event, source or manifest prefix, a downloaded manifest rewritten or deleted, the outbox index or the held stage rewritten after its download, a singleton appearing during the cut, a source rewritten or an object deleted before its download, a runner lease changed and a writer lease created: each is a NO-GO with the expected reason.
- **Documented boundary.** A PUT that lands after the closing inventory is **not** seen by that cut (the residual of ADR 0196, asserted, not hidden); the next cut sees another ETag and hash for the same key, which is exactly the difference the operator refuses a flip on.
- **Output and resume.** A directory taken with one scope is refused for the other, a resume of the same scope reuses verified checkpoints, an unknown scope and `full_bucket` as a scope are configuration errors, a server that answers a prefixed listing with keys outside the prefix is a protocol error.
- **Tampering.** A widened scope, swapped fence keys, an unknown scope kind and a whole-bucket snapshot relabelled as scoped (objects outside the scope) are refused by verification and by the converter, with nothing left behind; the CLI refuses a `--verify --scope` that names another scope.
- **Compatibility.** A whole-bucket manifest is unchanged (no scope field), verifies as `full_bucket`, and converts as before (unrelated objects still skipped).

`tests/prediction-aux-cutover-production.mjs` section 4e (core): two scoped captures drive the flip through to `committed` after unrelated objects changed between the cuts; a scoped capture next to a whole-bucket one is refused whichever way round (`capture_scope_mismatch`); an edited digest or an unknown scope is refused (`capture_scope_unsupported`); a capture without a scope field is the whole-bucket cut; the release differs between the two proof kinds.

## Mutation checks (each fails a test)

The scope mismatch check removed; an unsupported scope accepted; the release not bound to the proof kind; the scoped cut using the whole-bucket fence; the prefix guard removed (after a test was added for a misbehaving server); an out-of-scope object accepted by verification; the closing inventory skipped; the singletons not inventoried; a family prefix dropped from the scope.

## Limits

- Not run against production and not proof of any production behaviour; the fake bucket orders objects and tokens simply.
- The scoped proof covers the scope's objects at two moments; it is not atomic with D1 and does not see a PUT after the closing inventory.
- The exporter cannot verify the closed marker; the operator does at the flip.
- Real bucket size, the real import size and the duration of a cut remain unknown until an owner-approved export.
