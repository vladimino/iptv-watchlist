# Film dimension retirement: guarded deletion of legacy `film_dimension` copies, with a pre-image

Stage 6 of [ADR 0218](../adr/0218-film-lifecycle-dimensions-revision.md) decision 7 ([AIR-666](https://trello.com/c/xKdDurOY), code only). **Delivering this code deletes nothing and authorizes nothing.** The production retirement is a separate L3 operation: it needs the holdpoint evidence [below](#holdpoint-of-the-separate-operation), a fresh bounded preflight, an exact allowlist and an operation-specific owner GO that names that exact allowlist. A code revert is not a data rollback.

## What may be retired

Only a `film_dimension` row that the stage-1 [parity reader](film-dimension-parity.md) classifies `stale_copy` **with proof `complete`**, in exactly three dimensions:

| Dimension | Rule | ADR choice |
| --- | --- | --- |
| `fingerprint`, `prediction` | a copy whose truth is the prediction domain (`prediction_fingerprint`, `prediction_pointer`, immutable R2 bodies) | A1 |
| `metadata` | an **unlocked** copy: not `reviewed`, authority not `owner` (the ADR 0214 lock predicate), no `titleSource`, a known status, no authority | B1 |

Everything else is retained, and the dry run reports it by reason: `identity` (the `titleSource` and owner/reviewed carrier, C1) and `localization` (the effective projection, D1) are never retired here; `control` and `unknown_legacy` rows stay; a redirected Film stays; a `stale_copy` whose proof is not `complete` stays (`proof_incomplete`, `proof_unavailable`); a fingerprint or prediction row whose coverage verdict comes without guards stays (`coverage_unguarded`). The SQL twin of the rule is `SAFE_DELETE_SQL`, the importer's `PROTECTED_ROW_SQL` negated NULL-safely (`COALESCE(PROTECTED_ROW_SQL,0)=0`: that predicate is `NULL`, not `0`, for a row with no authority whose other terms are false, and `NOT NULL` would never match). A test compares the JS and SQL twins over 900 rows.

## What it is

| Part | Path | Role |
| --- | --- | --- |
| Retirement | `src/film-dimension-retirement.js` | `dryRunDimensionRetirement`, `applyDimensionRetirement`, `recoverDimensionRetirement`, `resumeDimensionRetirement`, `restoreDimensionRetirement`, the pure `retirementDecision`, `checkAllowlist`, `allowlistDigest`, `rowDigest`, the fenced writers (private) and the registry spec |
| Parity reader | `src/film-dimension-parity.js` | the classification; gains the option `ids` (classify exactly these Films) and returns `pins`, the marker generations it read under |
| Receipt kind | `src/canonical-receipts.js` | `film_dimension_retire` joins the closed operation kinds; the SQL column is unchanged, so there is no migration |
| Tests | `tests/film-dimension-retirement.mjs` | real SQLite fixtures built from every migration, adversarial intents and a file-backed checkpoint |

Dormant: nothing in `src`, `scripts` or the build imports the module (asserted by its test), and no route, MCP tool, Workflow, cron tick, flag, Scheduled Task, migration, table, index or column exists for it.

## Contract

- **Dry run is read only.** One keyset page of raw Film ids, the parity reader's own page (default 100, at most 200). The page is the scope: the approved operation chooses how many pages and which rows form its allowlist. It opens no receipt and bumps no revision, and returns the eligible rows (`id`, `dimension`, `rowDigest`, Film `revision`), the proposed `allowlist` and its `allowlistDigest`, and the **retained** rows counted by reason and dimension.
- **Exact allowlist and GO.** `[{id, dimension, rowDigest}]`, only the three dimensions, unique. The apply takes `go: {reference, allowlistDigest}` (an `https` link to the recorded owner GO and the digest of exactly this allowlist): a GO for another allowlist is `retire_go_mismatch` and nothing is read for writing. A row that is not listed is never read for deletion. A listed row whose stored bytes (`rowDigest`), classification or proof moved since the dry run is skipped and reported as `moved`; a new dry run and a new GO replan it. There is no blind retry.
- **The proof is fenced through the delete.** Classification reads several domains, but the Film revision and the row image fence only the target Film. Every part of the read-set the proof stood on is therefore carried in the intent as a **token** and asserted again inside the deleting batch, so a change in any of them after the classification (after the checkpoint, before the commit) rolls the Film back whole:
  - the **Film/Person marker generation** the parity page was read under (`pins.filmPerson`); the writer refuses to build a batch under another epoch (`film_person_fence`);
  - the **identity read-set of the target**: its own external-id claims, the TMDB retirement decisions of its tmdb ids, and that no other Film claims one of its tmdb/letterboxd values (scoped to this Film; JSON tokens, not delimiter strings);
  - for a `metadata` row, the six **core fields** of `film_metadata`;
  - for a `fingerprint` or `prediction` row, the **prediction-domain marker generation** (`mode='d1'`, writes `open`, the generation read; every prediction write advances it) and the **guards of the coverage supplier**.
  
  Only the domains the intent's rows stood on are asserted: a metadata-only intent is not held back by a prediction write.
- **Coverage supplier.** `coverage(filmId, aliases)` returns `{status, reason?, guards}`. Its verdict (`complete`) is what lets a fingerprint or prediction be proved present or absent; its `guards` are its own proof as SQL conditions over rows of this database (each one boolean with its bound params, internal code only, at most 8; the AIR-559 `guards` of `mutateFilm` are the model). They ride in the intent and in the batch. Without guards no fingerprint or prediction row is eligible, and on a resume the supplier is asked again and its guards must equal the intent's.
- **Read order.** The Film revision, the stored rows and the proof tokens are read **before** the parity classification, and the batch asserts everything it read there.
- **Pre-image before delete.** The per-Film immutable intent is `{version, id, runId, requestId, digest, at, plannedRevision, postRevision, approval, proof, rows: [{dimension, preImage}]}`; every column of every row is in it, and the digest binds the rule, the approval, the proof, the images, the stable time `at` and the planned revision. `applyDimensionRetirement` **requires the full durable `checkpoint` port** `{record, settle, lookup}` at entry (a port that cannot return what it recorded could never satisfy recovery or resume, so a port without `lookup` is refused before anything is read) and fails closed: `checkpoint.record(intent)` must resolve **and `checkpoint.lookup(requestId)` must return exactly that intent** before the delete is permitted. A record that throws (`retire_checkpoint_failed`), a lookup that finds nothing, returns another or a malformed intent (`retire_intent_unrecorded`) or throws stops the pass with nothing deleted and no receipt. Then ONE receipted, atomic, fenced batch, then `checkpoint.settle(intent, {state})` with `applied`, `not_applied` or `unknown`. The operation chooses the storage; this module owns the contract. A failed settlement stops the pass (`retire_checkpoint_settle_failed`).
- **One fenced batch per Film** (at most 3 rows, well under the 60-statement cap): the pinned marker generation and the Film revision CAS in the head, no redirect, the proof tokens, the exact pre-image, the `DELETE` repeated under `SAFE_DELETE_SQL`, the slot asserted empty afterwards, the revision bump, and the receipt applied in the same batch. A failed assertion (a row that moved, a lock that appeared inside the window, a protected row, a moved token) rolls the whole Film back; nothing is half retired.
- **Post-delete revision.** `postRevision = plannedRevision + 1`: the bump of the retirement's own write is part of the recorded revision, and the applied receipt is checked against it.
- **Own receipts.** Kind `film_dimension_retire`, origin `dimension_retirement`, a fresh request id per run, Film, action and digest. A receipt stores no payload, so the registry spec abandons an unsettled one (`retire_intent_required`) and only the recorded intent settles it.

## Scope, limits and accounting

The module sets **no Film-count ceiling**: the approved allowlist is the scope, and the per-Film batch and per-Film checkpoint do not imply any aggregate bound. The only bounds are real ones:

- the parity reader's own page (at most 200 Films per call), the one-batch statement cap, and the D1 provider limit of 1,000 queries per Worker invocation. **The budget covers every D1 execution of a pass** (the authority read, the parity read, the proof reads, the receipts and the batches; a `db.batch()` counts once, as D1 does) and **it is enforced, not only metered**: the shared meter (`countedEnv` with a `limit`) refuses an execution that would exceed the budget locally, before it reaches the binding, so no query beyond the budget is ever sent. `queryBudget` can only lower the provider limit. The 16-query per-Film and 100-query per-chunk figures are **planning margins** (a fixture measured at most 13 per Film): they only decide when to stop before a Film that would not fit; the refusal is the bound. A pass whose budget cannot cover its first read ends with `stopped: 'd1_query_budget'` and everything in `remaining`; a refusal inside a Film's own write is an **unknown** outcome (the intent is `uncertain`, never a guess; recover it). The result reports `d1Queries` and `d1QueryLimit`; a test compares them with the executions the binding actually received;
- the optional `maxFilms` that the approved operation chooses for itself (`stopped: 'films_limit'`).

Nothing is skipped silently, and **accounting is by row**. Every allowlist entry is in **exactly one** bucket of the pass result: `written`, `uncertain`, `moved`, `remaining` (the rows of a stopped pass that have no disposition) or `beforeCursor` (Films at or before the `after` the pass was given). A row already reported `moved` stays `moved` when another row of the same Film then fails to be issued (a checkpoint that refuses the record, an intent that cannot be built): only the rows without a disposition are `remaining`. `cursor` is the last Film fully processed, so a stopped Film is always after it.

**Continuation.** Pass `cursor` as `after`, with the same allowlist and GO.

- A Film that stopped with mixed results is processed again **as a whole**: its `moved` rows are evaluated against the present state and are deleted only if they are now exactly the rows the allowlist digest names, and its `remaining` rows are processed.
- A Film in `uncertain` (a delete that may have committed, or a refused read, or an outcome that could not be settled) is **never replayed by apply**: recover it first (`recoverDimensionRetirement`, then `resumeDimensionRetirement` for a `not_applied` one). A continuation then finds its rows absent (reported `moved` with `row_absent`) or still present, and acts only on a fresh intent under the same fences. There is no blind retry.

Tests account for every entry across partial passes, mixed-row failures (a moved row beside a refused record, an uncertain intent, an unsettled outcome), a recovery followed by a continuation, and a counted budget.

## Recovery and resume

A recorded intent is never trusted on its own shape: its digest and request id can be computed by anyone. Both `recoverDimensionRetirement({intent, checkpoint})` and `resumeDimensionRetirement(...)` therefore require that the checkpoint **durably issued exactly this intent** (`checkpoint.lookup(requestId)` returns an intent equal to the supplied one, `retire_intent_unrecorded` otherwise).

- **Recovery** is read only and settles the recorded intent against the receipt and the stored rows: `applied` (the receipt is applied at exactly `postRevision` with the intent's digest: the intent is a valid restore token), `not_applied` (no applied receipt, and the Film is at the planned revision with every pre-image row stored), or `unknown` (a moved Film or any mismatch: never guessed, never written, for review).
- **Resume** `resumeDimensionRetirement({intent, allowlist, go, checkpoint:{lookup, settle}, coverage})` **never records a checkpoint**: it continues one that exists. It requires the approved allowlist and GO that bind the intent (`retire_intent_unbound`: the approval of the intent equals the GO, and every pre-image's row digest equals its allowlist entry), then recovery: an `applied` intent is returned and not written again, an `unknown` one is returned and not written. Only a `not_applied` intent proceeds, and only after its **deletion preconditions are proved again** against the present state: the planned revision, every stored row, the classification (stale copy, proof `complete`), every token and pin of the intent's proof, and the guards the supplier produces now. If anything moved, the result is `{state: 'moved', reason}`, the checkpoint is settled `not_applied` and nothing is written. Otherwise the **same** request id and digest write under the same fences, so a committed effect is never written twice, and the batch asserts the proof once more.

## Restore

The restore token is the apply intent. `restoreDimensionRetirement` validates and binds it **before any receipt is reserved**: a complete, self-consistent intent (rows in dimension order, complete pre-images, the approval and proof in their exact shapes, a digest and request id that recompute; a missing or fabricated field is `film_person_invalid`), its own apply receipt `applied` with the same request id, digest, target and revision (`retire_restore_unbound` otherwise), and the marker open. It then restores only what ADR 0218 allows:

- the Film must be **exactly at `postRevision`**; otherwise the result is `{state: 'refused', reason: 'film_moved'}`, every row is reported `retained_newer_state`, and nothing is written or reserved;
- a row is re-inserted only into an **empty** `(film_id, dimension)` slot; an occupied slot is reported `slot_occupied` and left as it is; if no slot is restorable the result is `nothing_to_restore`;
- a slot or the revision that moves between the plan and the batch refuses the batch whole (`retire_restore_moved`) and the racing writer's row is not overwritten.

A restore is itself a write: it bumps the revision, so a second restore of the same token is refused. The alternative to a restore is a forward correction by the writer that owns the dimension.

## Holdpoint of the separate operation

These are operation preconditions, proved from live evidence before the owner GO. They are not offline prerequisites of this code and this module cannot check them.

1. The stage-5 D1 reader switch is complete in production ([AIR-648](https://trello.com/c/zh0cfDWK)), with its own acceptance evidence, and **no D1 consumer remains** that depends on the rows being retired. Reuse that evidence; do not infer it from this code.
2. A fresh, bounded preflight: the dry run on the live marker, with a coverage supplier that proves fingerprint and prediction and supplies its guards, its counts per dimension, class, reason and proof, and the retained `unknown_legacy` and `control` counts.
3. The exact allowlist, its digest, any `maxFilms` or budget the operation wants, the checkpoint storage (with `lookup`) and the restore window, in one owner GO that names the allowlist digest. No widening beyond the allowlist, and no other dimension.
4. The L0–L3 authorization of [authorization and escalation](../process/authorization-and-escalation.md). No documentation change grants a production writer.

## Cost (measurement, not a threshold)

Measured on the SQLite stand-in with 30 Films carrying plain copies of all three dimensions, 27 November 2026: a dry run of the 30 Films, 61 D1 queries and at least 652 rows read, no write; applying 1 Film (3 rows), 44 counted queries including the authority read (at most 13 per Film), 2 batches and 23 changed rows; applying 29 Films, 436 counted queries in 58 batches. In both the meter equals the executions the stand-in received. The changed rows include the CAS and receipt rows, not only the deleted dimension rows. These are fixture measurements for planning the operation, not production figures and not GO or NO-GO thresholds; the provider limit is 1,000 queries per Worker invocation.

## Rollback of the code

The module only deletes rows, and its receipts are payload-free. By a read of the source (`src`, 26 November 2026) the Worker's SQL selects only `identity` and `localization` rows of `film_dimension`; the admin health dimensions for fingerprint and prediction are derived from the view index and the profile. That is a source observation, not the live consumer proof of the holdpoint above. A code rollback removes the unused module and **never restores a row**; a restore needs the token the operation recorded. Roll the code back only when `SELECT COUNT(*) FROM canonical_write_receipt WHERE operation='film_dimension_retire' AND state NOT IN ('applied','abandoned')` is 0 (read only); an open receipt of this kind has no operation in the previous registry (`operation_unregistered`, left `waiting`).

## Not done here

No production read or write, no retirement run, no live census, no GO. The importer ([AIR-661](https://trello.com/c/1Rv634jd)), the parity reader ([AIR-660](https://trello.com/c/daGePESx)), the projection writer ([AIR-662](https://trello.com/c/P8cCPv1V)) and the readiness predicates ([AIR-665](https://trello.com/c/EgOYnLRE)) are separate deliveries; this stage consumes the first two and changes none of their contracts beyond the additive `ids` option and `pins` result of the parity reader.
