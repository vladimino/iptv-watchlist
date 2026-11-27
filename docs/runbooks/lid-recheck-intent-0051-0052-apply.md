# Lid re-check intent and attach writer, migrations 0051 and 0052: prerequisites, window, readback, activation and forward-only rollback (each apply and the activation need their own owner GO)

**Status:** prepared on 27 Nov 2026 under [AIR-675](https://trello.com/c/8k4DjDpv) (step 6 of [ADR 0217](../adr/0217-source-independent-film-admission.md), step 7b of its delivery graph). Both files are in the repository and **not applied**; a deploy applies nothing and activates nothing. Whether they have been applied, and the state of the writer, are read live (`schema_contract`, `sqlite_master`, `identity_evidence_writer`), never from this paragraph.

## Why

ADR 0217 (Accepted) lets the owner ask for one verification of a lid-only Film (`POST /api/admin/letterboxd/lid-recheck {lid, requestId}`). A fresh verified TMDB movie is attached to the same Film (its id never changes) in one fenced batch together with its evidence row. The durable record of one request is `lid_recheck_intent` (`0051`). The evidence row needs the identity evidence writer `lid_tmdb_attach`, which the delivered control (`0042`, never edited) does not admit; `0052` extends it. The code (`LetterboxdLidAttach`, the route, the Ratings link handoff) is delivered dormant: it refuses before its first effect (no source request, no write, no intent row) unless the admission marker is `d1`, `0048`, `0051` and `0052` are applied, and the writer is `on`.

## What each apply does, and does not

- **`0051`:** the empty STRICT table `lid_recheck_intent`, its `lid` index, four triggers, and the version change 48 to 49.
- **`0052`:** rebuilds the two writer-control tables with the writer CHECK extended by `lid_tmdb_attach` (every control row and the whole change history are copied back unchanged; the eight triggers and the unique index of `0042` are recreated verbatim), and the version change 49 to 50.
- **Neither** writes a Film, claim, receipt, evidence or intent row, changes a marker, a flag, a Task, any Worker code or any other table, or **activates the writer** (a writer with no control row is `off`). Offline proof: `tests/lid-attach-migrations.mjs`, `tests/lid-tmdb-attach-d1.mjs`.

## Prerequisites (checked immediately before each GO is used, not remembered)

1. `0051`: exactly one `schema_contract` row, `id` 1, `version` `48`, so `0048` and every earlier file are applied, each under its own GO. `0052`: version `49`.
2. The objects each file's guard checks are present, read from `sqlite_master`. `0051`: the tables `film_lid_admission`, `canonical_write_receipt`, `film_external_id`, `film_redirect`, `identity_evidence_writer`, `identity_evidence_writer_change`, `film_identity_evidence`, the trigger `schema_contract_no_downgrade`, and no object named `lid_recheck_intent%`. `0052`: additionally `lid_recheck_intent`, all eight writer-control triggers and the unique index `identity_evidence_writer_change_writer`, and no `*_hold` staging table.
3. The GO names the live Git blob and SHA-256 of each file on `main`, the production D1 `iptv` and the exact execution path. If another migration landed first, the file was renumbered and re-pinned before merge; the GO names the merged number and predecessor version.
4. No other migration, import or cutover is in flight, and the apply of `0042` (card ECM, [AIR-638](https://trello.com/c/JyQ3UkbR)) is done: `0052` rebuilds its tables.
5. Before-state captured in the same window (read-only `SELECT`s): the `schema_contract` row; every `identity_evidence_writer` row; `SELECT COUNT(*), MAX(seq) FROM identity_evidence_writer_change`; the admission marker mode and generation; the Film/Person marker.

## Expected cost (a measurement, not a threshold)

`0051`: one table, one index, four triggers and the version update, all empty. `0052`: the number of rows of the two control tables written twice (hold copy and rebuilt table), both tiny; the control tables hold at most one row per writer and the change history is append-only per transition.

## The step

Execute each unchanged file once, in order, as **one** atomic batch (a transaction: a failure rolls the whole rebuild back and leaves the previous version). Do not edit, split or blindly retry it. After a failed or unclear execution read the state back first and do not re-run: neither file can run twice (each refuses anything but its predecessor version, and `0052` also refuses leftover `*_hold` tables).

## Readback (all must hold; record it in a dated evidence page under `docs/evidence/`)

- `schema_contract`: one row, `version` `49` (then `50`), the matching note.
- `lid_recheck_intent` exists, is empty, and `sqlite_master` lists its four triggers and index.
- After `0052`: `identity_evidence_writer` and `identity_evidence_writer_change` hold exactly the before-state rows (same values, same `seq` values, same `MAX(seq)`), the eight triggers and the unique index exist, no `*_hold` table remains, and `SELECT sql FROM sqlite_master` of both tables names `lid_tmdb_attach`.
- The markers equal the before-state.

## Activation of the writer (a separate L3 operation; never automatic)

The attach needs the writer actually `on`; it is **not** enabled by the apply, by a deploy or by the route. The owner-approved sequence is the one of [ADR 0215](../adr/0215-identity-evidence-full-model.md) decision 4 and the [identity evidence writer activation runbook](identity-evidence-writer-activation.md), run with the existing `changeWriter` operation for `lid_tmdb_attach`: `activate` (`off` to `pending`), then `drain_complete` with the **drain evidence** that no Worker version older than the attach (and none that can mint a duplicate `film:tmdb:<n>`, ADR 0217 decision 8d) serves traffic and no Workflow instance of such a version runs, then (`pending` to `on`, coverage starts at that flip). `deactivate` (`pending|on` to `off`) and `break` (a rollback to a version without the writer) end coverage; both are recorded in the append-only history. The attach asserts `on` and the generation it read inside its own batch, so a change of state between the read and the write fails the batch. This runbook does not authorize the activation.

Activation precondition on the evidence encodings: no Worker older than the change that introduced the common attach root (AIR-675) may write evidence rows after the ledger (`0041`) is applied; the drain evidence of the writers names it. A legacy-rooted row written by such a Worker could not be folded into the common root without rewriting history (see [Letterboxd ratings](../reference/integrations/letterboxd-ratings.md)).

## Rollback

Forward-only. While `lid_recheck_intent` is empty it may be dropped (with its triggers) by a separately approved step; a populated table is never dropped. The `0052` rebuild is not reverted: the sixth value in the CHECK is harmless without a control row, and the old five writers behave as before. A code revert is safe before and after the applies: the route and the attach are dormant until the writer is `on`, and an older Worker neither reads nor writes the sixth writer. Rolling the code back after attaches landed leaves the attached Films and their evidence in place (the attach is canonical data; a wrong attach is corrected by an owner action under a later decision, never by a delete); the writer is then marked with a `break`.

## Stop conditions

A wrong predecessor version or a missing guarded object (the file refuses and creates nothing), a second apply, a non-empty `lid_recheck_intent` found before the first activation, a changed control row or `seq` after `0052`, or any in-flight migration.
