# AIR-549 stage 1: Filter presets D1 contract, offline evidence

Date: 20 Nov 2026 (UTC). Scope: repository change only. **No production D1, R2, flag, binding, Scheduled Task or Access was read or written**, no migration was applied, nothing was imported and no authority was switched. Source base: `main` at `30d11b4d2a6ebb601d74d12495664f0ccd5b8523` (the PR HEAD is recorded in the pull request). Owner decision: [AIR-546 inventory](air-546-mutable-r2-inventory-2026-11-20.md). Procedure: [runbook](../../runbooks/filter-presets-cutover.md).

## What changed

| Artifact | Content |
| --- | --- |
| `migrations/0028_filter_preset_authority.sql` | Schema v28: `filter_preset_authority` (marker inserted as `r2`, generation 0, writes `open`), `filter_preset_cas`, `filter_preset`. Follows a complete v27, refuses anything else before a table is created, version never goes down. Free number: no open pull request touched `migrations/` at the base commit. |
| `src/filter-presets-d1.js` | Storage only: marker read (`legacy` / `r2` / `d1` / `closed`), fenced read (marker, rows, marker, one retry), fenced commit (generation compare-and-swap plus a fence statement, rows replaced in one batch), import, activation. |
| `src/filter-presets.js` | The route chooses one store per request from the marker. R2 branch unchanged. A marker that cannot be read answers `503`, never R2. |
| `scripts/filter-presets-d1-sql.mjs` | Offline generator of the guarded `hold`, `import`, `activate`, `release` SQL and a `digest`, from a local export of the R2 object. Opens nothing. |
| `build.mjs` | The Worker bundle scopes the module as `FilterPresetsD1`. |

API, `schemaVersion:1`, record fields, normalization, the limit of 30, statuses and UX are unchanged; there is no `PUT`.

## Contract points proved offline (`tests/filter-presets-d1.mjs`, core suite)

- Migration: refused on v26 with nothing created; v28 after the chain; marker `r2`/0/`open`; no rows; second apply refused; no downgrade; constrained marker.
- Dormant: no binding and no schema serve R2 and create nothing; marker `r2` serves R2 and writes no D1 row; writes `held` in `r2` keeps R2 reads and refuses writes with `503` and no R2 put; a missing or unknown marker row and a storage error answer `503` with zero R2 gets or puts.
- Import and activation: refused while writers are not held; more than 30 refused; rows loaded at generation 1 with the marker still `r2` (R2 keeps serving); retry idempotent; a different or reordered document never overwrites; activation refused without row-by-row parity; after activation the same document in the same order, ETag `"d1:1"`, no R2 read or write in D1 mode; no second import or activation.
- Revision tokens: stale R2 token and `"none"` after a non-empty import are `412` with the current document and ETag; `428` without `If-Match`; empty-state creation; create, rename, query update and delete advance one revision each and stamp every row with it.
- Concurrency: three simultaneous writers from one token give exactly one success and two `412`s carrying the winner's state; two simultaneous module commits from one generation leave one winner and no loser row; removing the fence statement fails that test (mutation checked locally). A lost reply after a commit is reported as success, a lost reply without a commit as unavailable and writes nothing.
- Validation: invalid names, queries, empty updates and unknown ids write nothing and do not advance the revision; the 31st preset is refused; positions stay `0..29`.
- Reads: repeated GET issues no batch; a legacy query with `token=secret` and an unknown execution value is sanitized on read; an unreadable row is `500`; rows of another generation are never served.
- Generator: refuses (exit 2, no SQL) a non-JSON file, a document without `presets`, a bare array, one unreadable record and 31 presets; imports quotes correctly; its import and the module import agree; a document that differs from the rows cannot activate; an empty but real R2 document becomes an empty D1 document with `"d1:1"`; `release` restores the pre-hold marker.

Existing tests changed only where they pinned "the last migration is 0027 / schema 27": `tests/canonical-producer-chain.mjs`, `tests/canonical-producer-schema.mjs`, `tests/canonical-rated-admission-bundle.mjs`, `tests/canonical-rated-admission-producer.mjs`, `tests/discovery-intent-migration-0027.mjs`, `tests/migration-pattern-limit.mjs`.

## Independent review corrections (same pull request)

Three P1 and one P2 finding were reproduced and fixed, each with a regression in `tests/filter-presets-d1.mjs` (two of them mutation checked):

- **Hold did not fence an in-flight R2 writer.** The R2 branch now re-reads the marker right before its PUT, and the runbook adds a fence write on the R2 object (step 2b) so that any writer holding an older ETag fails its conditional PUT. Tests: a writer suspended after its R2 read (hold plus fence, PUT fails with 412), one suspended before its R2 read (stopped by the marker re-read, `503`; fails without the re-read), one resuming after activation (R2 stays untouched).
- **Lost reply claimed a competitor's commit.** Success after a failed batch needs the stored rows to equal this request's document at the new generation; otherwise `conflict`, which the route answers with `412` and the winner's state. Tests: competitor commits and our batch never reaches D1, at module and route level (fails when the check is removed).
- **Absent binding or schema reopened R2.** `legacy` now needs the database to prove it is pre-migration (tables absent and `schema_contract` below 28) or the explicit stand-in. After activation: no binding, an empty database and version 28 without the tables answer `503` with zero R2 access. Residual limit: a binding to a different database below version 28 looks like the true pre-migration state.
- **Activation SQL could exceed 100,000 bytes.** One short parity statement per preset plus one short guarded switch. A fixture of 30 near-limit presets (about 22 KB percent-encoded each) generates a file far above 100,000 bytes in total with every statement below it; a mismatch in the last preset stops the file before the switch.

## Second review correction: the fence must change the bytes

The first fence rewrote the stored content as `JSON.stringify(await object.json())`. R2 ETags are content-derived, so the Worker's compact output could be reproduced byte for byte and the old ETag stayed valid, leaving a pre-hold writer able to land after the fence. The test mock hid it by assigning a new ETag on every PUT. The mock now derives the ETag from the raw bytes (MD5), the test shows that an identical-bytes rewrite keeps the ETag and a pre-existing conditional PUT still succeeds, and the fence is now the stored bytes plus one trailing newline with a mandatory check that the ETag changed; the old-ETag writer then fails and the fenced object still reads as the same list. The runbook states the residual limit explicitly: a binding to a different but valid database below version 28 is not detected by the marker and needs a binding identity check before every cutover (an unconditional post-activation gate is an owner decision).

## Not done, not claimed

- Migration 0028 is not applied; no row is imported; the marker is not `d1`; R2 `ui/filter-presets.json` is the production authority and was not read.
- The production R2 object has not been inspected, so its real size, ETag and content are unknown to this report.
- No browser or UI check was needed: no client file changed.
- Started marks are untouched (stage 2, separate pull request and handoff).
- The Access-protected live `GET` readback after activation is part of the runbook and has not been exercised.
