# AIR-554: first real export of the auxiliary scope and the measured import size (22 Nov 2026)

Observation 20:46-21:10 UTC, 22 Nov 2026 (21:46-22:10 Madrid), under the owner GO "one bounded read-only export, `--scope prediction-aux`, no scratch D1" ([AIR-554](https://trello.com/c/UrS1gflv)). Counts, bytes, hashes, times and statuses only; no keys of private data, manifests, bodies, run ids or tokens. The snapshot, the converted tree and the outputs stayed in a private directory outside the repository of the executing session.

What was done: S3 `ListObjectsV2`, `HeadObject` and `GetObject` on bucket `iptv` with an owner-issued read-only, bucket-scoped credential taken from the environment (never printed), and D1 `SELECT` statements. No write to R2 or D1, no migration, marker, Task, Workflow, flag or Access change, no manual run. The credential is not used again; its revocation is the owner's action.

## Export (scope `prediction_aux`, concurrency 4, 3 of at most 5 attempts)

| Attempt | Start (UTC) | Result | Duration | Note |
| --- | --- | --- | --- | --- |
| 1 | 20:46:20 | NO-GO `inventory_changed`, `fence_changed` | 7 min 37 s | a scheduled Task run (slot `:45`) wrote one manifest, one source, one stop event, rewrote the held stage and changed both lease objects during the cut; the cold pass downloaded 1,941 objects |
| 2 | 20:54:21 | NO-GO `inventory_changed`, `fence_changed` | 2 min 19 s | the next Task run (slot `:00`) started and wrote one source and changed both leases; 1,943 verified checkpoints reused |
| 3 | 21:01:04 | **`consistent_fenced`** | 2 min 21 s | started right after a run finished (20:58:55, runner lease released); 1,943 of 1,947 objects reused from checkpoints, each with a conditional `HEAD` |

Attempt 3: 1,947 objects, 34,789,837 bytes, aggregate SHA-256 `478bfba55db567c48a5f57aff5da2a83d699f610ed72d4e0508633359440090e`, requests: list 8, head 1,959, get 4. The independent `--verify` returned the same status, counts, bytes and aggregate. Cold cut time is therefore about 7.6 min and warm cut time about 2.3 min on this session's network path at concurrency 4; concurrency 16 was not tried.

## Conversion and importer reports

- Converter: consistent fenced cut, scope `prediction_aux`, 1,947 of 1,947 objects copied, skipped 0. Families: sources 738 objects (15,136,661 bytes), manifests 468 (18,570,078 bytes), events 739 (1,082,994 bytes), stage 1 (51 bytes), outbox index 1 (53 bytes).
- Importer `report`: blockers 0, ignored objects 0, orphan or ignored index entries 0; stage 0 items; outbox total 739, all `delivered`, pending 0; sources 738 revisions; manifests 468 with 469 pieces. Digests: stage `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`, sources `0d46758662b32d7d62b1b7c058d045cc6b7c32929b4048f65e43cf644651931e`, manifests `0b6a0d3beefe932b14dd36fa173f42fb9cf376d462b0ada015c136bec370ad7f`, outbox `fd24da71d2ba7c50fc772390d3c3d5fb30bbabd2fdecf15fc630870812138952`.
- Run preflight (read-only `SELECT` on `prediction_run`): 738 run ids (729 UUID-shaped, 9 other), **all 738 have a run row**, no orphan; the table holds 746 rows from 4 Oct to 22 Nov 2026. The importer prints this preflight as eight separate `SELECT` statements of at most 100 ids; run as one request, D1 answers with several result sets and a client that reads only the first sees 100 rows, which is a client mistake, not an importer defect. Each statement is run on its own.

## Import size: it does not fit one batch

Operator `status --converted` (D1 read-only, hypothetical generation 1):

| Item | Statements | Bytes | Limits |
| --- | --- | --- | --- |
| Derived import SQL | 3,998 | 36,211,020 | 2,000 and 8,388,608 |
| Derived canonical verification | 5,948 | 36,717,514 | 2,000 and 8,388,608 |

The import is about twice over the statement limit and 4.3 times over the byte limit; the verification, which the flip carries inside its single atomic batch, is over by the same factors. The largest run (source plus manifest pieces) is 622,832 bytes, the median run 49,012 bytes, the largest statement 56,743 bytes (the 100 KiB statement limit is respected). At 1,500 statements and 6 MiB per batch the dataset needs 6 import batches and 6 verification batches. The proposal that follows from this is [ADR 0202](../../adr/0202-prediction-aux-resumable-import-with-receipts.md).

## State of the data at the cut

The held stage was empty and the whole outbox delivered, the cleanest state the cutover can meet. Production schema 33, no `prediction_aux_*` object, runner and writer leases released at the start of attempt 1 and between runs.

## Limits of this measurement

- D1 durations are unmeasured: the import and verification were not run on any D1; sizes come from the derived SQL, not from a run. The window budget of the [run sheet](../../runbooks/prediction-aux-cutover-run-sheet.md) cannot be fixed without a chunk duration.
- The cut times are those of one session's network path; the owner's machine will differ.
- One consistent cut is not the pair of cuts the flip needs, and the dataset keeps growing (new runs every few minutes).
- The residual of ADR 0196 is unchanged and not exercised by an export.
