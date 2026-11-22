# Runbook: batch_v2 auxiliary prediction state, checkpoint and outbox recovery and the AIR-554 handoff

[AIR-553](https://trello.com/c/ouMIBO00) delivers this state **dormant**; the cutover is [AIR-554](https://trello.com/c/UrS1gflv), a separate owner L3 plan. Contract: [ADR 0194](../adr/0194-prediction-auxiliary-state-d1-checkpoint-and-outbox.md) (Accepted). Schema: [d1-schema](../reference/data/d1-schema.md). Evidence: [AIR-553 offline evidence](../evidence/prediction/air-553-aux-state-d1-dormant-offline-2026-11-22.md). **Nothing in this runbook is authorized by merging the code.** Applying migration `0034`, importing, flipping the marker, retiring the R2 writers, changing a Scheduled Task, a flag, a binding, or starting a manual batch or Workflow each need their own owner GO.

## State today (code delivered, nothing activated)

- Marker `prediction_aux_authority`: inserted `r2` by migration `0034` (not applied to production by a deploy). With it at `r2`, or with a schema older than 34, the Worker runs the R2 objects exactly as before. A transient read error, a missing binding, a partial table set, a missing marker row or an unknown mode is `prediction_aux_unavailable` (HTTP 502 on the runner routes), **never** read as `r2`.
- With the marker at `closed` ([ADR 0196](../adr/0196-prediction-aux-admission-closed-state.md); a pre-activation window an owner opens for the cutover) every entry that would write one of the four R2 families answers `prediction_aux_closed` (HTTP 503) before it starts, the bucket of a request or Workflow step refuses a put or delete of those families after a **fresh** marker read, and reads still come from R2. `closed` is not `r2`, not unavailable and not an authority. The chain is `r2` → `closed` → `d1` and `closed` → `r2` (the reopen, only before an activation); `d1` cannot be reached except from `closed`. The import SQL asserts `closed` at the exact generation the plan names (`--generation N`).
- With the marker at `d1` (after an activation) stage, sources, manifest and outbox are served **only** from D1; the Worker never reads or writes the R2 objects of those families again (no silent fallback). The Events journal and the deferred-start receipts stay R2.

## Offline import and dry run (read-only until an owner applies the printed SQL)

`<converted-tree>` is the `tree` directory of the [converter output](#getting-the-importer-input-from-the-production-snapshot). `N` in `--generation N` is the generation of the **closed** marker this export belongs to: it is read from the marker by the separately reviewed owner-only operator after the close (it is never guessed, never assumed to be 1, and cannot be used before a close exists). Until then only the first three commands apply; `sql` is printed by the operator at the cutover, or by hand against a scratch database whose marker you closed yourself.

```bash
node scripts/prediction-aux-d1-import.mjs report <converted-tree>
```

```bash
node scripts/prediction-aux-d1-import.mjs digest <converted-tree>
```

```bash
node scripts/prediction-aux-d1-import.mjs preflight <converted-tree> > aux-preflight.sql
```

```bash
node scripts/prediction-aux-d1-import.mjs sql <converted-tree> --generation N > aux-import.sql
```

```bash
node scripts/prediction-aux-d1-import.mjs verify <converted-tree> > aux-verify.sql
```

The importer's input (`<converted-tree>` above; the usage text of the script calls it `<export>`) is a directory that mirrors the original R2 keys, or one JSON file of key to document. It is **not** the raw output of `scripts/r2-snapshot-export.mjs`, which stores `objects/<sha256 of the key>.bin` plus `manifest.json`. The script opens no database, bucket or network connection. `report` prints counts, bytes, per-state outbox counts, orphan index entries and per-family digests; a source the Worker could not read is a blocker: exit 2, no SQL (an unreadable or malformed pending index or index entry, which would otherwise silently lose attempts, quarantine and `since`; an object under an event prefix whose key is not one the Worker writes; a manifest without its source; a stage over its caps; an event record without a valid time; more than 256 active pending skipped records; a duplicate identity; and **any statement over the 100 KiB D1 statement budget, measured on the exact UTF-8 text** that would be sent: quotes double and multi-byte characters count their bytes). A non-event index entry is ignored by the legacy contract and only counted; an index entry without its record is reported and not imported. `sql <export> --generation N` prints guarded SQL whose first statement aborts the whole file unless the marker reads `closed` at **exactly** generation N (the closure the export belongs to; the cutover operator reads it from the marker after the close and passes it, it is never assumed to be 1 because a reopen `closed` → `r2` → `closed` raises it) and every auxiliary table is empty; without `--generation` nothing is printed (exit 2). A plan prepared for one closure therefore refuses under a later one, with the tables still empty. **Handoff, not an apply.** `sql` is ONE file meant to be applied as ONE all-or-nothing D1 batch (the same assumption as the other cutover SQL: a failing statement aborts the file through the fence row). Its first statement refuses non-empty tables and the history tables refuse update and delete, so a partial apply is not resumable and not undoable by SQL. `verify` prints SQL that checks the imported rows against the export byte by byte (stage items with their holder; source and manifest pieces by their actual text, the manifest also by its stored digest, `drained_json` and part index; every outbox column: identity, run id, state, attempts, `since`, last attempt, `settled_at`, payload digest, compaction flag and payload), the child totals per run (source revisions, source pieces, manifest pieces) and the totals of every family, and aborts on any difference or extra row, so a same-length corruption or an orphan child row cannot pass: run it after any apply and treat a difference as a stop for the AIR-554 plan (a restore is an owner operation; chunking is AIR-554's own decision). Mapping: stage rows keep their order; every run's sources become revision 1; every manifest a create-only manifest; every stop, start and skipped record one outbox row (delivered and superseded as settled with `settled_at` = the event's own time, so an old record is compactable at once and its identity stays; an undelivered record as pending, or quarantined with its attempts from the pending index; `since` from the index entry, else the event time).

**Orphan sources (read-only preflight, not reader parity).** A legacy start wrote the R2 `sources/<run>` object **before** the D1 `prediction_run` row, so a crash can leave a source with no run. The importer accepts such a source as history, but the Worker's source reader refuses a head whose run row is absent (`source_without_run`): the import is therefore **not** unconditional reader parity. `preflight` prints read-only SELECTs of the exported run ids (sources and manifests, 100 per statement) over `prediction_run`; run them against D1 before activation (no live check is made by the tooling here), take the ids missing from the answer as true orphans and classify each one: preserved as history outside the Worker's readers, or an activation blocker. Nothing is deleted.

## Getting the importer input from the production snapshot

`scripts/r2-snapshot-export.mjs` snapshots the **whole bucket**; the importer reads a key-mirrored tree. `scripts/prediction-aux-export-convert.mjs` is the bridge (offline, read-only on the snapshot, writes only inside its output directory, which must be absolute, outside the repository and new or empty). It refuses unless the snapshot verifies (every object re-hashed against the manifest) **and** is a `consistent_fenced` cut with no NO-GO reason, no change between the listings and a held fence; it re-hashes every object it copies at the moment of the copy; it copies exactly the stage, the outbox index, `enrichment/sources/*`, `enrichment/batch-manifest/*` and `enrichment/stop-events/*` / `start-events/*` (the same classification the importer uses, `auxExportFamily`), as stored bytes, never parsed or rewritten, so a malformed document reaches the importer and is a blocker there. A key inside those prefixes that the importer would not consume (an unknown name such as `run.backup.json`, a non-JSON file such as `run.bin`) is **refused by the converter** (`unconsumed_key`) and is also a **blocker in the importer** (`source_key_unknown`, `manifest_key_unknown`, `event_key_unknown`, never an ignored object), so a selected object is never silently lost. The output directory is judged by its **real location**: a symlink as the output, a link whose target is inside the repository, a dangling link or a path that resolves into the repository is refused before anything is created. A refusal removes what the run wrote.

```bash
node scripts/prediction-aux-export-convert.mjs /absolute/private/aux-snapshot /absolute/private/aux-converted
```

The output holds `tree/` (the importer's `<converted-tree>`), `identity.json` (`key`, `etag`, `size`, `sha256` of each object: the identity `auxFlipRefusal` compares at every boundary) and `converter-report.json` (counts, bytes and digests, written last). Only the report's numbers and digests may leave the machine; the tree and the identity file are private and are never committed, uploaded, logged or attached.

**Owner action for the read-only export (needs its own authorization; the agent has no production credential and runs none of this).** The scope is the one of the [snapshot runbook](r2-snapshot-export.md): a read-only, bucket-scoped R2 token placed in the shell environment of the machine that runs it, no write, no Task change, no flag. In order:

```bash
node scripts/r2-snapshot-export.mjs --plan --output /absolute/private/aux-snapshot
```

```bash
node scripts/r2-snapshot-export.mjs --output /absolute/private/aux-snapshot --concurrency 4
```

```bash
node scripts/r2-snapshot-export.mjs --output /absolute/private/aux-snapshot --verify
```

```bash
node scripts/prediction-aux-export-convert.mjs /absolute/private/aux-snapshot /absolute/private/aux-converted
```

Exit 0 of the export is a fenced consistent cut; exit 3 is a NO-GO to read in `report.json` (do not convert; the converter refuses it anyway). The rehearsal on a scratch database needs this export once, taken at any time; the cutover needs a **fresh** one taken after the close (the identity file is then the listing the flip is compared against). Limit: the exporter reads the whole bucket, so a periodic writer elsewhere (EPG, Discovery) can make the cut NO-GO; a prefix-scoped export would remove that dependency and is not built here.

## The owner-only cutover operator (dormant: nothing here is authorized by merging it)

`scripts/prediction-aux-cutover-production.mjs` is the one tool of the cutover steps that write. It follows the pattern of the verified 0033 operator: the default is a read-only `status`; every write needs `--target iptv --confirm <command>`; the production database identity is read and pinned before anything is sent; an unknown outcome is read back and reported as `write_uncertain` and is **never retried**; and it changes **only** the aux domain (the tables of migration `0034`): no R2, no flag, no Scheduled Task, no Access, no other authority marker. The other domains are compared by `mode` and `cutover` only, never by their counters (a live generation counter is not a stop condition). Each write command needs its own bounded owner GO from the L3 plan; the commands below are what the plan names.

| Command | Preconditions (all read first) | Effect | Pins |
| --- | --- | --- | --- |
| `status` | none | prints the schema version, the aux tables, the marker, the exact row counts of the four families, the live runner lease, the other domains' mode, the next decision of each step; with `--sql-file` also the sizing of an import file against the measured D1 batch limits | none |
| `--apply` | schema exactly 33, none of the `0034` objects, prediction domain `d1` | ONE atomic D1 batch of `migrations/0034`, then an independent readback (schema 34, marker `r2` at generation 0, empty tables, no other mode changed) | `--migration-sha256` (printed by `status`) |
| `--close` | marker `r2` at exactly `--generation G`, empty aux tables | marker `closed` at G+1; prints the **import generation** N | `--generation` |
| `--import` | marker `closed` at exactly N, empty aux tables, the SQL file's hash, its first statement pinned to N, every statement inside the aux tables | the importer's guarded SQL as ONE atomic batch. A file over the measured D1 batch limits (2,000 statements, 8 MiB) is **refused with the numbers** (`import_too_large`); no chunking is attempted | `--generation`, `--sql-file`, `--sql-sha256` |
| `--verify` | marker `closed` at N | the importer's verification SQL: aborts on any difference between the rows and the export (idempotent) | `--generation`, `--sql-file`, `--sql-sha256` |
| `--flip` | marker `closed` at N; the D1 counts and the outbox states equal the importer's `report` (`--report`); the listing identity right before the flip (`--listing-now`) equal to the one at the close (`--listing-before`), both the converter's `identity.json` (key, ETag, size); and the **release** | marker `d1` at N+1 with `activated_at`, in ONE guarded batch (the counts are re-asserted inside it). **Irreversible** | `--generation`, `--report`, `--listing-before`, `--listing-now`, `--release` |
| `--reopen` | marker `closed` at N and the aux tables still **empty** | marker `r2` at N+1 (the abort path before an import). Refused once an import exists: the tables refuse delete and update, so that is an owner restore, never this command | `--generation` |

**The release.** Without `--release` the flip refuses (`release_required`) and prints the exact release string; it binds the closure generation, the listing identity of that moment and the verified counts, so it cannot be reused for another state. The owner passes it back only after reading the readbacks: this is the separate release before the irreversible flip. A wrong release is `release_mismatch`.

**What the flip refuses.** A changed, added or removed object between the two listings (`listing_changed`, by key, ETag **and** size, so a rewrite of an existing object counts); counts or outbox states that differ from the report; a marker that is not `closed` at N; a malformed listing or report. After `d1` every command is refused (`marker_is_d1`) and the schema itself refuses the marker moving back.

**What this does not prove** (the stated limit of ADR 0196): a PUT already past its marker read when the close landed cannot be recalled; the identity comparison detects it only if it lands before the last listing, and a clean listing after the flip is a detection, not proof that no late write existed. There is no delta import.

**Import size.** The synthetic scratch import of one run is 7 statements and 16 KB. A history of up to 489 runs with 39 KB manifests is, by extrapolation only, thousands of statements and tens of MB, likely over the measured limits: the real number comes only from the real private export (`status --sql-file`), and if it does not fit, a resumable import is a separate reviewed contract (importer fence, operator and tests), not a silent chunking.

## Cutover handoff for AIR-554 (the invariant, not the procedure)

AIR-554 chooses the bounded procedure and its holdpoints under its own owner plan; the proposed (not approved) plan is the [AIR-554 preflight and L3 plan](../evidence/prediction/air-554-aux-cutover-plan-2026-11-22.md). The invariant it must meet ([ADR 0194](../adr/0194-prediction-auxiliary-state-d1-checkpoint-and-outbox.md) decision 1): a marker pre-read is not a cross-store fence, and D1 cannot fence an R2 object. So, before the marker flips:

1. admission of **all** legacy auxiliary writers is closed: the runner and the deferred Workflow instances, but also the lease-free writers (the skipped-event park, index entry, delivery and acknowledgement of an ordinary HTTP request) and every request that read `r2` earlier;
2. in-flight old-authority mutations are drained or proven unable to land (a live runner lease, a deferred instance in `preparing`, pending outbox records and the held stage are preconditions to list, drain or preserve);
3. the import and its verification (counts and digests of `report`, then a read of the rows through the Worker's own readers) run under that exclusion;
4. only then the marker flips, and the admitted writer afterwards is proven to be the new one;
5. a **paused R2 write across the handover** is tested (a write started before the close and completed after the flip must not change the imported state or be acknowledged as delivered).

**The mechanism for 1 and 2 (ADR 0196).** The marker state `closed` is the admission close: the owner-only cutover operator (AIR-554 Phase A, not yet built) sets it, and from then on the Worker refuses, for every caller, each entry and each R2 put or delete of the four families. It does not recall a PUT that passed its marker read before the close, and the platform sets no time limit on such a subrequest, so the residual is bounded by evidence, not removed: listings of the four families at the close (after a drain wait), at the export, immediately before the flip and after the flip must be identical, **any difference refuses the flip** and a late object found before it is answered by the reopen (`closed` → `r2`) and a fresh export; there is **no delta import**. The owner accepts or rejects the remaining residual (a PUT in flight longer than the whole pre-flip interval) before releasing the flip.

Also for AIR-554: capture a comparable natural production baseline before the cutover and compare normal Task runs after it (same prompt, model and batch configuration; incident, EPG, catalog-hold and recovery cohorts separate; sample counts, successful films per hour, completed/interrupted/skipped ratios, stage latency p50/p95, storage cost per successful prediction; preparation headroom against the 180 s claim TTL). No new Tasks, no manual model runs, no change of the claim TTL.

## Recovery

- **Stage.** Rows are the transferable held results; a stale row (profile or contract drift) is dropped by the next drain and reported; a digest conflict is `hold_conflict`. The head (`item_count`, `total_bytes`) is the aggregate cap; if it disagrees with the rows the next merge fails closed on the revision, never silently.
- **Sources.** Every revision is kept; the head names the current one. A piece that fails its hash is `prediction_aux_corrupt`, never data.
- **Manifest.** Create-only. A part that fails its piece digest, or a manifest whose hash does not match the durable run, answers `manifest_unavailable` (fail closed); the readiness edit and the manifest rows are one batch, so a run is never ready without a durable manifest.
- **Outbox.** A pending row is retried by the next authorized start (at most 20, three journal attempts each, oldest first, the latest run's records first); the 8th failed attempt quarantines it (visible in the status read, never taking a slot). A settled row's payload is compacted 14 days after settlement; a compacted row is never rebuilt or re-enqueued. Status counts: `eventOutboxStatus` (pending, quarantined, oldest pending, skipped active count and cap, cap refusals). A cap refusal never changes the refused request's answer.
- **Rollback.** Code rollback is not state rollback. After the flip a marker restored to `r2` is refused; the R2 objects are a frozen pre-flip copy, not a fallback. Restoring a database backup to a pre-activation state is an owner recovery operation, not a runtime path.
