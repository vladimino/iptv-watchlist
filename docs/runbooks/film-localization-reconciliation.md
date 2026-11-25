# Film localization reconciliation: the bounded reconciler (code) and its operation contract

Stage 4 of [ADR 0218](../adr/0218-film-lifecycle-dimensions-revision.md) decision 3 ([AIR-663](https://trello.com/c/UP10l6Js), code only). The production operation that runs it is a separate card ([AIR-664](https://trello.com/c/Og9XxXfy)) and needs its own operation-specific owner GO (an L2 contract or an L3 plan). **Delivering this code runs nothing and authorizes nothing.**

## What it does

A Film's effective `localization` row (`film_dimension`) is a stored projection of `owner_review_entry`, the applied reviewed row and `film_localization_source`. [AIR-662](https://trello.com/c/P8cCPv1V) keeps it current for every new source write. The reconciler fixes the rows that are stale **without a new source observation**: a Film written before the projection-aware writer (a historical applied source receipt), a source row with no effective row, a legacy provisional row that is no longer the resolver output, and an owner-only change (a decision removed or changed after the row was materialized). It writes the output of the existing `resolveLocalization`, never a new precedence: owner, then reviewed, then automatic (fixed source order, then the newer observation, then the source name), behind the `strong()` guard and its SQL `WHERE`.

| Part | Path | Role |
| --- | --- | --- |
| Reconciler | `src/film-localization-reconciler.js` | `dryRunLocalizationReconcile`, `applyLocalizationReconcile`, `recoverLocalizationReconcile`, `resumeLocalizationReconcile`, `restoreLocalizationReconcile`, the pure `planLocalizationReconcile`, the fenced writers and the registry spec |
| Shared logic | `src/film-localization-projection.js` | `projectionOf`, `legacyCandidate`, `PROJECTION_UPSERT`, `readOwnerReviewToken`, `ownerTokenStatements` (one implementation, exported, not copied) |
| Tests | `tests/film-localization-reconciler.mjs` | real SQLite fixtures built from every migration |

Since [AIR-683](https://trello.com/c/VJYgJuOW) the build bundles the module for ONE read-only entry, `diagnoseLocalizationCohort`, called only by the owner-only MCP tool `film_localization_diagnose` ([below](#read-only-cohort-diagnosis-air-683)). No route, Workflow, cron tick, script or MCP tool reaches `applyLocalizationReconcile`, `resumeLocalizationReconcile`, `recoverLocalizationReconcile` or `restoreLocalizationReconcile` (asserted by the test: the Worker references only the diagnosis). No flag, Scheduled Task, migration, table, index or column exists for it.

## Contract

- **Dry run is read only.** It opens no receipt, no batch and bumps no revision. It reports `examined`, `cursor`, `hasMore`, the `stale` Films with their pre-image row, the intended post-write row and the effective value, the `held` Films with a reason, `noop`, `absent` (a redirect or a missing Film), `unavailable` (with the error code) and `wouldWrite`. **A dry-run entry is a report, not a pre-image.**
- **Bounded, by raw Film ids.** A run reads one keyset page of raw Film ids (`id > after ORDER BY id LIMIT n`) and classifies each Film with the ancestry-aware reader, so the scan is bounded by the examined limit whatever the candidates are, and an owner value reachable only through a merged ancestor is found. At most 50 Films examined (default 20) and at most 25 written (default 10) per run; a larger or non-integer value is `film_person_invalid`. `hasMore` and `cursor` (the last examined id) continue the page. Each written Film is ONE fenced batch (at most 60 statements). No index or schema is needed.
- **Same two fences.** The Film revision CAS and the owner-review token (`owner_review_authority` generation, every consumed verified owner row, the redirect closure), re-proved inside the batch, plus the intent's own pre-image row. A moved resolver input, a lost owner token, a lost revision or a changed stored row (any column, not only resolver inputs) refuses the batch whole (`localization_inputs_moved`, `localization_owner_moved`, `film_person_revision_conflict`); the pass reports the Film as `moved` and the next run plans a NEW intent.
- **Gates.** Marker `d1`/`open` and the owner-review domain `d1` with writes `open` or `held` (otherwise `localization_owner_unavailable`; a dry run lists the Film as `unavailable`: owner evidence that cannot be proven is never read as a decision). A redirect is never a candidate and never repaired; a Film is never created. **A restore enforces the same gates** (see below).
- **Held, nothing written.** Two different owner values (`owner_conflict`), an owner or reviewed row of another value than the resolver output (`protected_row_differs`), an owner projection whose decision is gone with no automatic source to replace it (`owner_projection_without_input`), a legacy candidate that cannot be recorded losslessly (`legacy_candidate_not_preservable`). The reconciler never deletes a row to resolve a hold and never manufactures a review decision. A hold records no intent and opens no receipt.
- **No resolver input is lost.** A legacy provisional row of a source that has no source row is recorded as a source row in the same batch (`ON CONFLICT DO NOTHING`) before the row is replaced. No other source row is written or changed.
- **Own receipts.** Kind `film_localization_reconcile`, origin `localization_reconciler`, a fresh request id per run, Film, action and digest. The write and its applied receipt are ONE atomic batch. A historical `localization_source` or `film_localization_projection` receipt is never replayed, settled or reused (equal content proves no causality). A payload-free receipt cannot be re-planned: the registry spec abandons an unsettled one (`reconcile_intent_required`; with the atomic tail a non-applied receipt has no committed effect) and only the recorded intent settles it.

## Intent, checkpoint and recovery (the pre-image contract)

A receipt stores no payload and a dry-run report is not a pre-image, so **the exact immutable per-Film intent is the pre-image**: `{version, id, runId, requestId, digest, at, plannedRevision, postRevision, inputs, preImage, postImage}`. The digest binds the full pre-image (`null` when the row is absent, otherwise every column), the full post-write image, the normalized resolver inputs, the **stable write time `at`** (the one clock the plan reads; the committed `updated_at` is the intent's, never a later clock reading) and the planned revision. The writer re-checks all of it inside the batch; it never replans under an old digest.

`applyLocalizationReconcile` **requires a durable `checkpoint` port** from the operation (AIR-664 chooses the storage, cohort and window; this module owns the contract) and **fails closed**:

1. `checkpoint.record(intent)` must resolve BEFORE the write is permitted. A throw stops the pass with nothing written for that Film (`localization_checkpoint_failed`).
2. The write is one receipted, atomic, fenced batch under the intent's request id.
3. `checkpoint.settle(intent, {state})` records the outcome: `applied` (the receipt is applied at exactly `postRevision` with the intent's digest), `not_applied` (a definite replan refusal) or `unknown`.

The mutation primitives (the fenced write and the fenced restore) are **private**: no exported function commits a localization row without the checkpoint port and the receipt of its own request. `resumeLocalizationReconcile` needs the same port (the exact intent is recorded idempotently before the write is permitted, `localization_checkpoint_failed` writes nothing, the outcome is settled afterwards). A failed durable settlement is never completion: the pass stops, reports `localization_checkpoint_settle_failed`, and does not advance the cursor past that Film. Every exit of a pass returns what it did and never loses progress: `written` (intents), `uncertain` (intents whose write may have committed), `moved`, `held`, `noop`, `absent`, `cursor` (the last Film fully settled, the resume point), `stopped`, and `failedId`/`error` for the Film that stopped it. A stopped page always reports `hasMore: true` (the failed Film and the Films after it are unprocessed) and `examined` counts every Film that was read. A failure on a later Film (a read error, a refused checkpoint) never discards an earlier Film's intent.

**Recovery after an unknown outcome (a lost reply).** `recoverLocalizationReconcile({intent})` is read only and settles the recorded intent against the applied receipt and the revision: `applied` (the receipt of that request id is applied at `postRevision` with the intent's digest: the intent is a valid restore token), `not_applied` (no applied receipt, and the Film is still at the planned revision with the intent's pre-image row: safe to resume), or `unknown` (a moved Film or any mismatch: never guessed, never written, for review). `resumeLocalizationReconcile({intent, checkpoint})` re-issues the same request id and digest, so a committed effect is never written twice and a not-yet-written intent is written once; a lost reply during a resume is `unknown` and recoverable the same way.

## Restore

The restore token is the apply intent. `restoreLocalizationReconcile` validates and binds it **before any receipt is reserved**: a complete, self-consistent intent (an explicit `preImage` that is `null` or a complete image, a complete `postImage`, a digest and request id that recompute from the content; a missing or fabricated field is `film_person_invalid`), the marker open, the owner-review domain D1-authoritative (`localization_owner_unavailable` otherwise; the CURRENT owner-review token is read again and its predicates ride in the restore batch, so an owner move between the wrapper's read and the commit is `localization_owner_moved`; it need not equal the apply-time token), and **its own apply receipt**: it must exist, be `applied`, and carry the same request id, digest, target and applied revision (`localization_restore_unbound` otherwise). It is not a general mutation API and cannot put an arbitrary row back.

The write applies only while the Film is **still at exactly `postRevision`** and the stored row **still equals `postImage`**; otherwise it refuses with `localization_restore_moved` and writes nothing (another writer's work is never erased). A `null` pre-image deletes the row the reconciler created. A restore bumps the revision, so a second restore of the same token is refused. A restore does not remove the legacy source row the reconciler preserved (a source row is a durable resolver input). The alternative to a restore is a **forward correction**: another reconciler run, which writes the resolver output of the then-current inputs under a new receipt and a new intent.

## Rollback of the code

The reconciler writes only rows the previous code already reads with the same resolver. Applied rows and applied receipts stay valid after a code rollback. A receipt of this kind that is still `pending`, `failed` or `unknown` has no operation in the previous registry (`operation_unregistered`, left `waiting`): roll the code back only when `SELECT COUNT(*) FROM canonical_write_receipt WHERE operation='film_localization_reconcile' AND state NOT IN ('applied','abandoned')` is 0 (read only). A code rollback never repairs or removes a row.

## Read-only cohort diagnosis (AIR-683)

**Superseding plan: diagnosis first.** On 26 November 2026 the owner reviewed the operation plan below and decided to measure the real cohort before any wave, checkpoint transition or storage choice is designed. The plan below is kept as a **historical draft and deferred proposal**, not as the design of a future operator. The only mandatory next step for [AIR-664](https://trello.com/c/Og9XxXfy) is this diagnosis. The 50 and 25 of the code are technical parameters of the dormant reconciler, not D1 limits or acceptance criteria, and are not part of this contract.

**Why a capability was needed.** The effective value is the output of `resolveLocalization` with owner precedence and redirect ancestors, so it cannot be read by an SQL filter, and the reconciler had no callable entry. The authorized read-only D1 tools can list rows but cannot run the resolver; no private copy with a proven freshness exists. The one proven gap is the entry point.

**Tool.** `film_localization_diagnose` (owner-only IPTV MCP, see the [MCP reference](../reference/api/mcp.md)) runs `dryRunLocalizationReconcile` page by page inside one call, so every Film is classified by the AIR-663 planner itself, and returns aggregates only. It writes nothing, opens no receipt and calls no external service; it is registered in `tests/get-write-audit.mjs` and `tests/get-write-baseline.mjs` (no D1 or R2 effect in any scenario) and a test compares it with the summed dry-run pages of a 121-Film SQLite fixture (stale, reviewed-row hold, redirect, unavailable owner domain).

**Continuation (the real limit).** Every D1 statement is a subrequest of the Worker invocation (Paid: 10,000). The planner needs about 12 statements per Film (measured: 1,468 for 121 Films), so one call stops after 500 Films (about 6,100 statements, with headroom for Films with many owner entries) or after its 20 s wall-time budget and returns `cursor`. The caller passes it as `after` until `complete` is true and adds the counts. This is the minimum chunking the limit requires; it needs no per-page approval.

**Reading the answer.** `complete: true` means the table was walked to its end in that call. Zero eligible Films is claimed **only** when the whole walk (all calls) reached the end, `unavailable` is 0, `authorityStable` is true in every call and `stopped` is null; otherwise the cohort is **unknown**, never zero. The answer is a census of observations at the time each page was read, not a global snapshot: Films inserted behind the cursor or changed during the walk are outside it. Before the walk read the live marker, owner-review domain and schema pins (the answer repeats the pin it ran under). `staleIds` lists the Films the reconciler would repair; if the total of `stale` is above 0, the actual scale and the simplest safe operation go to the coordinator and the owner, and nothing is written. If it is 0 under the rule above, AIR-664 closes as an explicit no-op.

**Live result.** Recorded in [the dated evidence](../evidence/film-person/air-683-localization-cohort-diagnosis-2026-11-26.md) (counts, scope and time, pins, cost and duration; no payload).

## Production operation plan (AIR-664, HISTORICAL DRAFT, DEFERRED by the owner on 26 Nov 2026; authorizes nothing)

> **Superseded as the next step by the [diagnosis-first plan](#read-only-cohort-diagnosis-air-683).** Waves, checkpoint transitions and the R2 or D1 storage choice below are a deferred proposal that is revisited only if the measured cohort has eligible Films.


[AIR-664](https://trello.com/c/Og9XxXfy) is the Stage 4 **operation**. This section is a proposal. It grants no operation GO, accepts no storage choice and creates no card. The live cohort (Films, stale, held) is **unknown** until a read-only scan has run.

### 0. What is blocked, and by what

| Capability | Blocked by | Needs a checkpoint store? |
| --- | --- | --- |
| **Read-only dry run and wave planning** | Only the missing callable entry point: the module is dormant (asserted by the test), so no route, MCP tool, Workflow or script can call it. | **No.** It records nothing. |
| **Mutation** (apply, resume, restore) | The entry point, the approved durable checkpoint store, an owner-only operator that can recover after a lost response or process, and an exact-intent execution path (§2) the shipped API does not have. | **Yes** |

The two are separable: the read-only capability can be delivered and run first, and its live scan (L0 read, subject to the read side-effect gates) measures the real cohort before any storage decision is made.

### 1. Read-only preflight (L0, immediately before a scan or wave)

Read live, never from this page: Film/Person marker `d1`/`open` and its generation; owner-review domain `d1` with writes `open` or `held`; schema version; feature flags and executor modes; whether a Film-writing Workflow chain or lease is live; unfinished `film_localization_reconcile` receipts (the query in [Rollback of the code](#rollback-of-the-code)). A mismatch is a stop before any effect.

### 2. Bounded wave contract (what the shipped API can and cannot do)

Verified against the code: `dryRunLocalizationReconcile` returns a **report** (`stale` entries with images, no intent, no digest); `applyLocalizationReconcile` **replans** each raw Film id at a fresh `at`, accepts no approved set and may write a Film that became stale after the scan; the intent digest binds `at`, the planned revision and both full images, so two independently regenerated plans never compare equal. `resumeLocalizationReconcile` already executes one **exact, verified intent** through the checkpointed, receipted path. The operation is therefore built from three bounded steps and never runs a fresh unconstrained apply pass:

1. **Discover (read only, one page per call).** A keyset page of at most 50 raw Film ids from a continuation cursor. The operation scope is the whole Film table, walked page by page; no call scans the catalog or computes a global digest. Each page reports `complete` (every Film classified, `unavailable` empty) or `incomplete`. A page with zero `stale` Films is a normal, complete page. **Zero eligible overall** is claimed only when the scan reached `hasMore: false` with every page complete, no `unavailable`, no stopped page and the pinned authority generations unchanged; any other ending is `unknown`, never "none". A completed scan is a scan of **observations** at the times each page was read, **not** a globally consistent point-in-time census: authority generations pin neither every Film revision nor Films inserted behind the cursor. No global snapshot is required, and no claim of absence goes beyond the scanned scope and time.
2. **Derive a wave (read only, new capability).** For one page and a write cap of at most 25, the server picks a stable write time `at` and derives the **exact immutable set of intents** (same code path as `intentOf`, one clock reading). The wave **selection** is the first `writeCap` stale Films in id order inside the page (a pilot uses a smaller cap). It answers: `at`, the selection parameters (`after`, `limit`, `writeCap`), a stable wave identity, the `end` cursor, the authority pins, the intent count, and a digest over the sorted `id:intentDigest` lines of **that wave only**. `end` is the id of the **last selected intent**, not the end of the page: every Film up to `end` is fully classified (written, `noop`, `held` or `absent`), and a page with more stale Films than the cap keeps its remainder for the next derive, which starts `after` that `end`. If nothing is selected, `end` is the last classified Film of the page. The cursor advances only over fully classified and settled work. Intent bodies stay server side. Request identities are server-generated; the caller supplies no Film id, key or SQL.
3. **Execute exactly that wave (write).** The caller passes the wave identity (`after`, `limit`, `writeCap`, `at`, wave id, `end`, pins, count, digest); the selection parameters are part of what is compared. The server **rederives** the wave with the same `at` and compares count, digest, pins and page boundaries **before any effect**. A mismatch is a **preflight refusal: `writes: 0`, nothing recorded**. **The approved Film/Person generation and the other authority pins are enforced at reservation and inside each per-Film fenced batch** (an assertion in the batch, as the claim backfill pins its approved generations); the existing receipted writer reads only the *current* marker, so the operator must add this guard and may not rely on its first re-read. `at` is accepted only if it is a valid past time inside a short freshness window (provisional); the digest binds it, so a forged value cannot change the content. On a match, for each intent in id order: `checkpoint.record` (fail closed), then the exact-intent resume path (one fenced receipted batch), then `settle`. No new Film is added to the wave.

**Race after the preflight.** There is no all-or-nothing promise across Films (each Film is its own atomic batch). Before starting the **next** Film the wave stops on a `moved`, `unknown`, `held` or checkpoint outcome. The answer lists, separately: Films already committed (intents), the stopping Film and its outcome, intents **not attempted**, and intents with an **unknown** outcome. A stopped or `unknown` intent must be recovered **and durably settled** before a fresh derive may pass it; until then `plan_wave` returns that unfinished intent and does not advance. Remaining candidates are **replanned by a new derive** from the last fully settled `end`; a `moved` Film gets a NEW intent, never a replay of the old one. A Film that turned `held` between derive and execute either fails the digest check (before effects) or stops the wave (after).

**Tuning is delegated engineering** inside the approved safety envelope (code maxima 50 examined and 25 written; the stop conditions below; the freshness window; a pilot wave first). Page size, wave size and pacing are not an owner prompt per wave.

### 3. Operator surface (owner-only, bounded, no caller-supplied identities)

Mutation is not usable with `dry_run`/`apply` alone: a lost response or process leaves intents that must be found again. Proposed modes of one owner-only tool, all addressing recorded intents by **server-derived** identity (run id and request id from the store), never a caller-supplied intent body:

| Mode | Writes | Purpose |
| --- | --- | --- |
| `discover` | no | one page, §2 step 1; store-free |
| `plan_wave` | no | §2 step 2; store-free (with a store present it also refuses to pass an unfinished intent) |
| `apply_wave` | yes | §2 step 3; records the wave manifest before the first intent, so an unfinished wave is discoverable before its first mutation |
| `status` | no | store-backed: list unfinished and recent waves and intents with their current checkpoint state |
| `recover` | no | **read-only classification** (`applied`, `not_applied`, `unknown`) of a recorded intent against its receipt and revision. It settles nothing by itself. |
| `settle` / `resume` | yes | record the classification as a durable checkpoint transition, or re-issue the same recorded intent (same request id and digest) |
| `restore` | yes | restore of a recorded applied intent under the existing exact-revision rule |

### 4. Checkpoint store: decision brief (both options PROPOSED; nothing accepted or rejected)

The owner decision is the **material storage and operational architecture**, not whether checkpoint safety is implemented: it is required by the shipped contract either way. Required properties for either option: durable record **before** the write; conditional create that cannot overwrite a pre-image; full-intent identity and readback; idempotent recovery; transition history instead of an overwritten state (`unknown` can become `applied`, and `not_applied` can be followed by a new attempt); discoverability of unfinished intents; an explicit retention rule; the same owner-only authorization.

| Property | R2 (immutable objects) | New D1 tables |
| --- | --- | --- |
| Conditional create | A real conditional `put` (`onlyIf` does-not-exist), not GET then unconditional PUT. A precondition failure reads the object and compares the **full canonical intent**: equal is an idempotent success, different is `checkpoint_conflict` and a stop. A timeout or error reads back by the same rule; if it still cannot be read, the intent counts as **not recorded** and nothing is written. | Insert with a primary key on the request id; conflict compared the same way. |
| Transitions | Immutable **event objects with ONE key per sequence number** (`…/<requestId>/<seq>.json`, the state in the body, never in the key), each created with the same conditional `put`, so two writers cannot both create sequence N. The event identity is a hash of request id, sequence, state and payload; before creating N+1 the writer validates that N holds the expected prior state (and, for `applied`, the receipt). An existing object is compared in full: equal is an idempotent success, different is a sequence conflict. An ambiguous or unreadable result, or a conflicting sequence, **fails closed** (no write, stop). The intent object is never rewritten. | Append-only event table with primary key `(request_id, seq)`; the insert carries the prior-state check in the same statement; the intent row is immutable (trigger or constraint). Same idempotent-identity and fail-closed rules. |
| Discoverability | Listing by run prefix in bounded pages plus a wave manifest object; list consistency is proven by the implementation tests. | A SQL query on a state view. |
| Migration | None. | A migration with its own owner-gated apply, a schema-contract version change and D1 `rows_written` (a measurement, not a threshold). |
| Atomicity with the domain write | Not atomic (the contract needs record-before and settle-after only). | Same: record and write are separate statements. |
| Retention | An explicit policy: intents are kept until the cohort is accepted and the restore window is closed; **this operation never deletes**; cleanup is a separately approved action. Contents are catalogue localization values: private bucket, never GitHub or Trello. | Same policy; deletion is a separately approved action. |

### 5. Stop conditions

`localization_checkpoint_failed`; `localization_checkpoint_settle_failed`; `checkpoint_conflict`; any `unknown` outcome (classify with `recover`, settle, never retry blind); a preflight mismatch (no effect); a `held` reason or `unavailable` Film not present in the approved scan; a readback mismatch; an authority pin that moved. A stop leaves the cursor at the last Film fully settled.

### 6. Effects and readback

**Allowed effects:** the `localization` row of the wave Films; the legacy `film_localization_source` rows named by their intents; the **`canonical_revision` increment** of each Film on every applied write or restore; `canonical_write_receipt` rows of kind `film_localization_reconcile`; the checkpoint records. Nothing else.

- **Track by identity, not by count.** Per intent: request id, digest, planned and applied revision, and its checkpoint transitions. Report **attempted, applied, not_applied, failed, unknown and recovered** separately. A pending, failed or abandoned receipt can exist **without** a localization write, and a replay may add no receipt, so "receipt delta = writes" is not a check.
- **Per written Film:** the stored row equals the intent `postImage`, the revision is `postRevision`, the applied receipt carries the intent request id and digest.
- **Protected versus derived.** Independent `reviewed` or `owner` control rows and every `owner_review_entry` are protected and must be unchanged. A **marked derived owner projection** whose decision was revoked or changed is exactly what the reconciler is meant to update or replace, so it is an expected delta, not collateral.
- **Scoped readsets, not global digests.** Compare pre and post reads of the wave Films and of their linked authority rows, with attribution: a change to any other row is attributed through its receipt origin and revision. Unrelated concurrent producers are legitimate and are not "collateral writes"; there is no requirement that a table or the catalog is globally unchanged.
- **Idempotence:** a repeated scan of the wave Films lists none as `stale` unless a newer input moved.

### 7. Restore and rollback

The restore token is the recorded apply intent, valid only while the Film is still at exactly `postRevision` with the row equal to `postImage`; otherwise a **separately approved forward correction** (a new derive and wave). A restore increments the revision and does not remove a preserved legacy source row. Code rollback follows [Rollback of the code](#rollback-of-the-code).

### 8. One L3 approval with holdpoints, and delivery cards (proposed, not created)

**Proposed prerequisite cards (draft, in this order, none created or activated):**
1. *Read-only operator*: `discover`, `plan_wave` and the exact-intent derivation. **Store-free**; it does not depend on the later cards. Unblocks the live scan; checks `tests/get-write-audit.mjs` and [read side effects](../reference/api/read-side-effects.md) because the dry run must stay write free.
2. *Checkpoint store and ADR.* **Either** option needs the ADR decision and matching documentation (a Proposed ADR cannot merge before the owner decision).
3. *Write operator*: store-backed `status`, `apply_wave`, `recover`, `settle`, `resume`, `restore` over exact recorded intents, with the per-Film pin guard of §2. Implementation fixtures: more stale candidates in one page than the write cap, a smaller pilot, a replayed or lost response, and an authority generation change after the preflight.

**Dependency plan.** Card 1 is an independent prerequisite. Cards 2 and 3 are **conditional**: they are needed only if the complete live scan (holdpoint H1) shows eligible Films. A complete scan with zero eligible Films closes AIR-664 as an explicit no-op with **no store and no write operator implemented**.

**One L3 plan, one approval,** with these holdpoints and no other per-section decision: H1 after the read-only scan evidence shows the real cohort; H2 after the pilot wave readback; H3 on any stop condition and at completion. The final plan states: the live gates (§1), the actor (the owner-only IPTV MCP identity), the envelope (≤25 per wave, freshness window, pilot first), the stop conditions (§5), the allowed effects (§6) and the restore and rollback scope (§7). Revocation: the owner says stop and the tool is not called again. Evidence is sanitized and dated under `docs/evidence/film-person/`: Film ids, counts, digests, generations and outcomes; **no localization payloads and no intent bodies**.

**Affected documents when code exists:** this runbook, the [MCP reference](../reference/api/mcp.md), the persistence diagram and the ADR for the chosen store (R2 or D1), the [deployment runbook](deployment.md). Offline evidence of this step: [AIR-664 operation plan](../evidence/film-person/air-664-localization-reconcile-operation-plan-2026-11-25.md).

## Not authorized here

Running the reconciler against production, choosing a cohort, a cap or a window, storing tokens, any manual sync, model, TMDB or Discovery call, flag, Scheduled Task, Access change, migration, R2/D1 write, retry or lease reset. [AIR-664](https://trello.com/c/Og9XxXfy) prepares the exact dry run, cohort, stop conditions and rollback plan and asks for the operation-specific GO.
