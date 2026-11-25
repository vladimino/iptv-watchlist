# ADR 0207: Letterboxd Film admissions are coordinated in D1 only; `verified-films.json` is frozen as historical evidence

**Status:** Accepted  
**Partially superseded by:** [ADR 0221](0221-shared-letterboxd-check-state-in-one-document.md) (owner decision of 25 Nov 2026): only the storage layout of the «Refused ids stay recoverable» clause of decision 4b (the second `diary-identity-backlog` document; the backlog is now part of `diary-identity.json`) and the atomic-transition and token wording that presumes two documents. The rest of this record, including the rest of 4b, is unchanged and Accepted.  
**Original decision date:** 2026-11-24. That day the owner made the disposition of B, 1C, 2B and 3C, then the [consolidated owner choices](https://github.com/vladimino/iptv-watchlist/pull/975#issuecomment-7140090124), then the [final disposition](https://github.com/vladimino/iptv-watchlist/pull/975#issuecomment-7141800326) accepting this record.  
**Recorded at:** 2026-11-24. Revised the same day after two design reviews, after the [owner disposition](https://github.com/vladimino/iptv-watchlist/pull/975#issuecomment-7131137347), after the [review of the revised package](https://github.com/vladimino/iptv-watchlist/pull/975#pullrequestreview-6039232220), after its [re-review](https://github.com/vladimino/iptv-watchlist/pull/975#pullrequestreview-6040005516) after the [second re-review](https://github.com/vladimino/iptv-watchlist/pull/975#pullrequestreview-6040703398) and after the [consolidated owner choices](https://github.com/vladimino/iptv-watchlist/pull/975#issuecomment-7140090124).  
**Approval source:** [Product Owner final disposition of 24 Nov 2026](https://github.com/vladimino/iptv-watchlist/pull/975#issuecomment-7141800326). The owner wrote «принимаю!», accepting this record as reviewed at `d1a5c2bf` in the [final technical review](https://github.com/vladimino/iptv-watchlist/pull/975#pullrequestreview-6045607308) (byte-identical at `d3e42960`). The selections are B, 1C, 2B and 3C, the directions 4A, 5C, 6C and 7C, U1 = K2, U2 = accept, U3 = B, U4 = A and U5 = A. This is an architecture acceptance only. It grants no implementation GO and no production GO; each card and operation keeps its own gate.  
**Related work:**
- [AIR-555](https://trello.com/c/JPgjoBzK) (audit and decision), under [AIR-546](https://trello.com/c/1dRSJEbp) and [AIR-275](https://trello.com/c/4x7hH0gI); related [AIR-559](https://trello.com/c/733sRAxu) and [AIR-547](https://trello.com/c/99faXisC).
- The read-only audit [`air-555-verified-films-admission-audit-2026-11-24.md`](../evidence/d1-migration/air-555-verified-films-admission-audit-2026-11-24.md) ([PR #972](https://github.com/vladimino/iptv-watchlist/pull/972), merged at `b9616ff3`). This record uses the audit's call-site labels (W1-W6, R1-R7) and gaps (G1-G4).
- **Companion records, both Accepted the same day:**
  - [ADR 0213](0213-film-identity-evidence-ledger.md), the source-aware identity evidence ledger (disposition 5C);
  - [ADR 0211](0211-catalog-enrichment-producer.md), the catalog-enrichment producer (disposition 6C).

  This record depends on both: decisions 2, 5 and 6 below.

**Supersedes:**
- In part [ADR 0087](0087-rated-archive-film-admission.md): decision 4, the admissions object as the entry point of a verified movie. Its later metadata is superseded through ADR 0211.
- In part [ADR 0105](0105-live-catalog-input-and-tmdb-search-admission.md): decision 5, the admission written to that object before the link.
- In part [ADR 0166](0166-diary-rated-only-identity-bridge.md): its "immutable receipt entry" step.

**Superseded by:** None

## Owner disposition of 2026-11-24 (on HEAD `189ae8b`)

| Choice | Owner decision | In this revision |
| --- | --- | --- |
| Option | **B**, use the existing D1 admission table | kept |
| 1 | **1C**, `r2 → closed → d1` | kept (decision 1, unchanged invariants) |
| 2 | **2B**, keep-first | kept (decision 2) |
| 3 | **3C**, deterministic recovery, fail closed | kept (decision 3) |
| 4 | **4A**, reacquire source data: "Не надо усложнять" | reworked (decision 4): no proof snapshots |
| 5 | **5C**, separate evidence model: "источник источнику рознь…" | reworked: companion [ADR 0213](0213-film-identity-evidence-ledger.md) |
| 6 | **6C**, redirect rated enrichment to the canonical D1 writer: "…начать подготовку к глобальному каталогу…" | reworked: companion [ADR 0211](0211-catalog-enrichment-producer.md) |
| 7 | **7C**, more atomic cards | reworked (decision 7): a delivery graph |

## Owner choices of 2026-11-24 (on HEAD `b4807c68`)

Recorded in the [consolidated owner choices](https://github.com/vladimino/iptv-watchlist/pull/975#issuecomment-7140090124). They were confirmed by the owner's [final disposition](https://github.com/vladimino/iptv-watchlist/pull/975#issuecomment-7141800326) of the same day, which accepted this record.

| Choice | Owner selection | In this revision |
| --- | --- | --- |
| 0207-U1 | **K2**, a shared receipt `operation_key` | decision 3 uses K2 only; R1 is a mandatory shared foundation (decision 7) |
| 0207-U2 | **Accept** the deterministic digest without clocks and the outcomes `source_changed` and `source_unavailable` | decisions 3 and 4 |
| 0207-U3 | **B**, one retry policy for both callers: "временные транспортные ошибки не считаются попытками, нужен автоматический retry через сохранение места в очереди. если страница фильма выдает 404, это считаем" | decision 4b |
| 0207-U4 | **A**, D0 on its own ahead of A1, including the unified retry policy on today's paths, tested through both callers | decision 7, card D0 |
| 0207-U5 | **A**, enrichment active before A2; new admissions are eligible from day one, not instantly enriched | decision 7 |
| ADR 0211-5 | **C**, shared upstream coordination across all relevant producers in one delivery scope | decision 7, cards UC1-UC3 |

## Context

### Current architecture (main `6ca5c24`, Film/Person `d1`/`open`)

- **D1 holds the canonical admission.** `film_rated_admission` (one row per Film) is written by `admitRatedFilm` through the `rated_admission_retention` producer (`applyRatedAdmissionRetention`). Its readers are:
  - the catalog (title and year fill);
  - the identity-work inventory (ADR 0170: `admissionProof` needs an exact archive and code match);
  - the external-id producer.
- **The R2 object is a writers' coordination step.** `letterboxd/admissions/verified-films.json` is one JSON document compare-and-swapped by its writers before they call the D1 writer:
  - the inferred baseline import commit (W1 add, W2 delete of its own new entry);
  - the automatic Diary identity check (W3), reached from **two** callers: the Ratings Diary phase, and the Letterboxd Sync Watchlist admission step (ADR 0186 decision 5);
  - the owner-only rated-archive identity step (W4) and its enrichment (W5 metadata, W6 localization).

  The writers read the object back (R1-R5) and pass the **stored** entry to D1. No serving path reads it at `open`.
- **What the R2 step guarantees today.**
  - **Code-to-movie uniqueness before any link.** It is enforced with rules that differ per writer.
  - **First-admission pinning.** An existing entry is kept, so D1 always receives the first archive, title, year and `verifiedAt`. D1 alone would overwrite archive, title and year for the same code and movie given another archive (`film-admission.js:90,104`; G4).
  - **A replay index** for the inferred commit. It has a defect: a replay offers an orphaned entry despite the receipt's conflict mark (G1).
- **What each writer already stores durably before its first effect** (no change needed for decision 4):
  - the inferred commit: its request items (movie id, code, admitted title and year), fixed by the create-only chunk intent's `itemsHash`, and the origin archive;
  - the Diary and Watchlist check: a `linking` intent with the code and the verified movie id, in the D1-owned `diary-identity.json`;
  - the rated step: the `admitting` candidate row with the code, `intendedTmdb` and `filmPath`.
- **Receipts prove commits.** Admission writes are **atomic** receipted writes: the receipt row is marked `applied` inside the same fenced batch as the admission (ADR 0119). So "the admission row exists" and "the receipt is applied" are each proof that the batch committed. A receipt that is not `applied` and is past its attempt window was not committed.
  - The receipt row keeps `content_digest` and `target`.
  - A readback whose re-planned input has another digest abandons the receipt as `producer_source_changed` (ADR 0123).
- **Producer request ids are not stable today.**
  - The request id derives from an event string that differs between the first commit (`inferred:<sha>:<lid>`) and a replay (`inferred:<sha>:<chunk>:<slice>` plus `:admission:<key>`).
  - The content digest includes `verifiedAt`, a clock, and `receiptKey`, the R2 key constant (`canonical-rated-admission-producer.js:83`).
- **Inferred provenance.** The inferred and verified distinction lives on the Ratings fact records (`identity` or `inferredPairs`; 703 of 703 inferred admissions at the audit). ADR 0184's claim planner reads it there.
- **Metadata.** 714 of 714 admitted Films have no `film_metadata` row and no `film_sync_state.metadata_at` (L0 read, 24 Nov 2026 12:21 UTC). No canonical producer covers Films outside the EPG generation. The Watchlist marker is `d1` (generation 3), so a pinned EPG run fetches no metadata for Watchlist members either (ADR 0211 Context).
- **Observed state, 24 Nov 2026 (bounded observed parity, not a cross-store snapshot).**
  - 714 R2 entries agree with 714 D1 rows.
  - 0 open admission receipts.
  - `letterboxd/imports/` is empty.
  - The Diary pending document is empty.
  - 0 entries carry enrichment.
- **The cost of keeping it.** A second, R2-side admission authority in front of the D1 writer, with:
  - cross-store partial commits (G2);
  - per-writer rules;
  - an enrichment output that no serving reader consumes at `open` (G3);
  - the replay defect (G1).

AIR-275 cannot report "no mutable R2 authority" for admissions while it stays.

## Decision

**Option B: D1 is the only admission coordinator.** It is activated through its own one-way marker, after a dormant delivery. The R2 object is then frozen and retained read-only as historical evidence. The target below is not implemented. Nothing here is delivered, deployed or activated.

### 1. Activation marker, handover and the irreversibility boundary

The handover reuses the one-way marker pattern of ADR 0194 and ADR 0196.

**The marker.** A new single-row D1 marker, `letterboxd_admission_authority`, is added by an additive migration (one table, its row and a one-way trigger; no data migration). It has three modes and a generation:
- `r2`: the delivered code behaves **exactly as today**. Every writer uses the R2 step, writes no new payload field, no `d1:` marker and no new receipt shape. The legacy enrichment runs. Tests prove byte-identical writer behaviour against the legacy code.
- `closed`: every admission writer refuses **before its first effect**:
  - the Diary identity check defers the id (`reason: deferred`, no source request, no write). This holds for both of its callers, the Ratings Diary phase and the Letterboxd Sync Watchlist admission step. The rating facts and the Watchlist snapshot are unaffected;
  - the baseline commit answers `409 admission_closed` for a chunk with any `admit` item, before its intent;
  - the rated identity and enrichment steps answer `409 admission_closed`.

  Reads are unchanged. `closed → r2` (reopen) is allowed.
- `d1`: the new path of decisions 2-6. A trigger refuses `d1 → r2`, `d1 → closed`, deleting the row and a lower generation. Every new-path batch asserts mode `d1` and the generation inside its own fenced batch.

**Safety invariants (adopted from ADR 0196).** These are part of the contract, not only the state names:
- **Legacy routing needs positive proof.** A writer may take the legacy path only when one of two things is true:
  - a **fresh** read proves that the marker migration is not installed (schema version below it and table absent);
  - the installed marker row proves `r2`.

  An unavailable D1, a partial schema, a missing row at or above the migration's version, or an invalid mode fails closed (`letterboxd_admission_unavailable`). None of them ever defaults to `r2`. This covers the deployment of card A1, which runs before the migration exists.
- **The full chain is enforced by a trigger.** `r2 → closed`, `closed → r2` (reopen, only before an activation) and `closed → d1` are the only transitions. `r2` cannot skip `closed`, `d1` is terminal, the row is never deleted, and every change of mode raises the generation.
- **Guard at the write.** Every `put` or `delete` of `letterboxd/admissions/verified-films.json` is wrapped once per request or Workflow step:
  - Before each one it reads the marker **fresh**, never from the request scope, so a request that read `r2` or "not installed" at its start still refuses at its own write.
  - It refuses unless the marker proves `r2` or proves the migration absent.
  - The guard is the last awaited step before the PUT.
- **Fence on the legacy D1 batch.** The legacy path's `admitRatedFilm` batch asserts the same proof (mode `r2`, or migration absent) inside its fenced batch, so a legacy admission cannot land under `closed` or `d1`. Retention units (`film_retention`) are not fenced by this marker and keep running.
- **Residual risk.** A PUT that passed its guard before the close cannot be recalled. The A2 activation handles it as ADR 0196 does: compare the object's identity (ETag and size) and full row parity at the close, after the drain, and **immediately before the flip**. Any difference refuses the flip, and a late write is handled by reopening and draining again, never by a delta. Any residual risk that cannot be excluded is either accepted by the owner before the flip or makes the activation No-GO.

**The sequence.** Each step from 2 onward is a separate owner-authorized operation under an L3 plan; this ADR authorizes none of them.
1. **Dormant delivery (card A1).** A1 merges and auto-deploys with the marker at `r2`, so the deploy is safe whatever is in flight.
2. **Drain of old code.** Before `closed`, prove with evidence that all invocations of versions older than A1, and their outstanding effects, have finished. An elapsed interval alone is not assumed to be a bound. The evidence covers:
   - the A1 version (or later) serving 100% of traffic;
   - no Letterboxd Sync or Ratings Workflow instance or step of an older version still running;
   - no owner HTTP request to the baseline or archive routes in flight.

   It comes from Worker version and invocation logs and the Workflow instance listing. From then on, every running writer reads the marker.
3. **Close.** Set `closed`, then wait for the step bound.
4. **Parity pin, under `closed`.**
   - Full row fingerprints of the R2 entries and the D1 rows, and the audit predicates P1-P7.
   - 0 open `rated_admission_retention` receipts.
   - 0 pending writer state: no chunk intent without a receipt, no `linking`/`link_failed` Diary entry, no `admitting` candidate.
   - The object's ETag is pinned.

   Pending legacy state found under `closed` is a **No-GO**; `closed` never permits a write to finish it. The activation waits until that state is either drained (reopen to `r2`, let the legacy writer finish, close again, pin again), or separately reconciled under its own owner-approved plan and verified.
5. **Activation.** Re-pin the ETag and the full parity **immediately before** the flip, and abort (no flip; stay `closed` or reopen) on any change. Then flip `closed → d1` in one fenced statement that asserts the closure generation. This is the **irreversibility boundary**. It is durable and monotonic, and it precedes every incompatible effect, because at `r2` and `closed` the new code writes nothing the legacy code would not write.
6. **Natural acceptance.** The first natural Diary or Watchlist admission (or an owner-run archive step) produces a D1 row with its evidence row (ADR 0213) and no R2 change.

**Abort and rollback.**
- **Before the flip.** Abort is `closed → r2` (reopen), and a code revert is an ordinary rollback. Reopen first: code that does not read the marker would otherwise reopen the legacy writers silently.
- **After the flip.** A revert to any version that does not honour the marker is **prohibited**. Recovery is roll-forward on code that honours the marker. Restoring R2 coordination needs its own owner-approved reconciliation plan, never an implicit rebuild.
- **The evidence rows are not the boundary.** The evidence rows of decision 2 (ADR 0213) are provenance and diagnostics only. The boundary is the marker flip.


### 2. One admission record, with first admission pinned in D1 (2B)

- `film_rated_admission` stays the only admission record. No new admission table (option C) and no identity column (option B′).
- **Keep-first, at mode `d1`.** For an existing row with the same movie id and code, `admitRatedFilm` and `planAdmission` answer **no-op** whatever the archive, title or year of the new input. The `ON CONFLICT … DO UPDATE` of those columns no longer applies on the new path. This closes G4 inside the fenced batch. `verified_at` is the time of the first admitting batch.
- **Typed conflicts.** A row with another code for the same Film, or a code held by another Film, stays `admission_conflict`. The error carries `other_code_on_film` or `code_on_other_film`.
- **Provenance through the evidence ledger, not a second marker.**
  - Each new-path admission writes its evidence row (ADR 0213 decision 3) in the same batch:
    - `restricts same_work` (method `title_year_search`) for the inferred import;
    - `asserts same_work` (method `page_check`, route `ratings_diary` or `watchlist_admission`) for the Diary and Watchlist check;
    - `asserts same_work` (method `page_check`, route `letterboxd_rated_archive`) for the rated archive.
  - New rows store the fixed `receipt_key = 'd1'`, which says only "not the R2 receipt". Migration 0021 allows any non-empty value.
  - The `d1:<kind>` marker of the previous revision is withdrawn, so the kind lives in one model.
- **Every consumer of `receipt_key` and the digest is reviewed in the admission card:**
  - `film-admission.js`: the no-op check becomes keep-first;
  - `canonical-rated-admission-producer.js`: `admissionContent` and the digest, see decision 3;
  - `canonical-catalog-reader.js`: it exposes `receipt_key` as an opaque string;
  - the external-id provenance JSON written by `admitRatedFilm`;
  - `canonical-producers.js`: the shape of `receiptFilmKey` is unchanged.

### 3. Deterministic per-item outcome, from durable state (3C)

**Stable request identity, with no clock in it.**
- On the new path the admission content digest covers `{kind, movie id, code, archive or evidence digest, title, year}`. It has **no** `verifiedAt` and no `receiptKey`.
- The Diary and Watchlist evidence digest is already deterministic: `sha256(lid, slug, path, tmdb, title, year, source)`. The same source content always gives the same digest.

**Why the admission row and the attempt window are not enough.** These facts were checked on `main` `26cfd115`:
- The atomic tail that marks a receipt `applied` (`canonical-mutations.js:32`) matches `state='pending'`, the attempt number, the planned revision and the marker generation. It does **not** match `next_attempt_at`. A `pending` receipt past its window can therefore still be landed by its original in-flight batch, until some transition changes its state or attempt number.
- Receipts can be found by `request_id` only. The request id hides the target and the digest inside a hash, and no API lists receipts by target. The origin `rated_admission_retention` also carries retention receipts.
- No readback of these operations returns evidence, so `applied` is reached only through the atomic tail.

"No admission row" and "no pending receipt inside its window" therefore do **not** prove that no earlier attempt can still land. A same-pair row proves that the pair is admitted, not that this writer verified it or that its earlier receipt settled.

**Correlation: how a retry finds every earlier attempt of the same item (0207-U1 = K2).** An additive, nullable column `operation_key` on `canonical_write_receipt` is set to `admission:<kind>:<code>`, where `kind` is `inferred_import`, `lid` or `short_code`.
- It comes with a **partial unique index** on `(origin, operation_key) WHERE state IN ('pending','failed','unknown')`. At most one unresolved attempt per key is allowed, and the database enforces it.
- It finds earlier attempts after:
  - any loss of the writer record, because the key derives from the code that the source presents again;
  - a redirect, because the key has no target;
  - a changed digest: same key, new request;
  - concurrent attempts, because all of their rows share the key.
- Cost: one additive column and index on the shared receipt table, an ADR 0119 amendment. Other origins leave it null. It is delivered by card R1, which ADR 0211 uses too.

- **Uniqueness of K2.** A code is unique per admission (D1 `film_rated_admission.source_code` is unique), and `kind` separates Letterboxd ids from short codes.
- **Different codes for the same target** have different keys; the fenced batch decides between them (decision 3 table).
- **Retention receipts** use no key, or their own `retention:` namespace, so the admission lookup never sees them.

**Matching scope: which earlier attempts belong to this work.** The key identifies the **item** (a code). The **logical work** of one attempt is narrower: the key, the intended movie (from the writer's durable record), and the source scope of this check (an archive digest, or the page-check evidence root). Three sets follow:
- **Unresolved across the key** (`pending`, `failed`, `unknown`): every one of them is settled before anything else, whatever its movie or source. Any of them could still land and change the admission.
- **Applied, same key and the same intended movie:** the admission is settled (`present`, or `admitted` when it is this work's own receipt). The writer proceeds **without reacquiring for the admission**. If this work is a new verification of another source scope (a second archive, a later page check), the writer still performs its own check, and records it through the evidence-only operation (ADR 0213 decision 4).
- **Applied, another movie, or applied before an identity correction:** historical. The writer never links or admits on the strength of an applied receipt alone. It validates current state first: the admission row by code, the trusted claims, redirect and retirement. Then it follows the decision 3 table (`code_on_other_film` → conflict).

**Reconcile, then reserve.**
1. **Read** every receipt of the key, and record the key's **history fingerprint**: the number of receipts of the key and the number of them in `applied`. Receipts are append-only and never deleted (ADR 0119), so the fingerprint changes whenever any caller reserves, applies or adds an attempt under the key.
2. **Settle the unresolved set:**
   - a `pending` receipt inside its window: **wait**, non-terminal (a live attempt is never stolen);
   - otherwise: move it to `abandoned` (`superseded_by_retry`) in a fenced update matched on `request_id`, `state` and `attempts`. Its tail can then never match, and `abandoned` is terminal, so the receipt-transition triggers forbid any invocation from reopening it. If the update matches nothing, re-read the receipt.
3. **Validate the applied set** against current state, as above.
4. **Reacquire the source** (decision 4) only if this work still needs a check.
5. **Reserve, or finalize, atomically against the observed history.**
   - **Reserve.** The new receipt is inserted `pending` under the key only if, in the same statement or batch, the key's history fingerprint still equals the one read at step 1 **and** no unresolved receipt exists (the partial unique index).
   - **Finalize a terminal outcome that reserves nothing** (`source_changed`, `source_unavailable`, `admission_conflict`, `other_code`). The writer's terminal write asserts the same fingerprint:
     - for the Watchlist ledger, through `settleAdmission`'s existing `guards`;
     - for the Diary document, through the ratings-fence statements that its batches already carry (`epochFence`, `ratings-d1.js:196`). They take one caller guard today and are extended to carry the fingerprint assertion beside the Sync epoch guard.
   - **A failed assertion** means another caller reserved or settled meanwhile. This attempt is the **loser**: it writes nothing and restarts at step 1 with the new history. It does not report an outcome computed from the old history.
   - The fingerprint assertion is the per-item fence. The column and the index alone would not be.
   - **Race closed.** A reads an empty history, fetches movie B, and meanwhile another caller reserves and commits an admission of movie A. A's `source_changed` write then fails its fingerprint assertion, and A replans.
   - **Genuinely new checks are not suppressed.** A different route with the same `source_root`, or another `source_scope` (ADR 0213 scenario 4, a second archive), performs its own check and records its evidence row through the evidence-only operation. A recovery that finds a settled admission and fetches nothing still writes nothing.

**The evidence-only operation (ADR 0213) follows the same protocol** under its own key `evidence:<evidence_key>`. A lost response is answered by reading that key: an `applied` receipt means the row exists, and the unique `evidence_key` makes a replay a no-op.

**Outcome rule (unchanged from the reviewed revision).** The outcome of an item is a function of durable state: the monotonic keep-first admission rows, plus whether this item's Ratings link is already committed. The same pair always ends the same way after a crash:

| D1 state seen by the check or the fenced batch | Inferred commit (W1) | Diary and Watchlist check (W3) | Rated step (W4) |
| --- | --- | --- | --- |
| No row; batch applied in this attempt | `admitted`; facts proceed | `admitted`; link proceeds | `admitted`; rating proceeds |
| Same movie and code (any archive), including a lost response of an applied batch | `present`; facts proceed | `present`; link proceeds | `present`; rating proceeds |
| `other_code_on_film`, **whether seen before the link or only by the batch after it** | `present_other_code`: no admission, link and facts proceed (today's behaviour, now also for the concurrent case) | pending `other_code`, no link | `needs_review` `duplicate_tmdb` |
| `code_on_other_film` seen before the link | `conflict`: no link, no fact | pending `admission_conflict`, no link | `needs_review` `historical_alias_conflict` |
| `code_on_other_film` seen only by the batch after the link | `refused_after_link`: terminal; **no fact and no claim**; the inferred-marked link stays (never a claim proof, ADR 0184); an `admission_conflict` entry for owner repair | not reachable (admits before linking) | not reachable (admits before rating) |
| Reacquired source names another movie than the writer's durable record | the request item cannot change: not reachable | pending `source_changed`, no admission, no link; owner review | `needs_review` `source_changed` |
| Source missing or not reacquirable now | the owner cannot re-send the chunk: the intent stays without a receipt, and nothing is synthesized | pending `source_unavailable`: a transport failure keeps its place and costs no attempt, a 404 costs one (decision 4b); at the six-attempt cap visible, no admission | stays `admitting`, retried; `needs_review` at the cap |
| `admission_identity_held`, redirect (classified by `planAdmission` / `resolveAdmissionFilm`) | **non-terminal**: the chunk stops before its receipt; resume after the owner resolves | pending `admission_held`, retried | stays `admitting`, retried |
| Unavailable, `skipped`, `closed`, generation moved, `failed`, `unknown`, `deferred`, refused preflight, in-flight receipt | **non-terminal**: the chunk stops before its receipt; resume repeats the same identity | pending `deferred`, retried | stays `admitting`, retried |

- **Recording.** A terminal outcome is recorded per item in the chunk receipt (`admission: admitted | present | present_other_code | conflict | refused_after_link`) or in the writer's pending state.
- **Ambiguous results.** A non-terminal result is never settled terminally.
- **Replay.** A replay offers the admission again only for items recorded as `admitted` or `present`. Nothing is offered for an item merely because its receipt entry is not a conflict.
- **Refused items.** They write no fact, no claim and no `asserts` evidence row (ADR 0213).
- **Durable state retention.** The writer's existing record (the `linking` intent, the `admitting` row, the chunk intent) stays until the item is terminally settled. The Diary cap never evicts a non-terminal entry (decision 4b): if the cap would need one, the step starts no new source check.

### 4. Reacquire the source; keep only what already exists (4A)

There are **no proof snapshots and no journals**. A retry follows decision 3: it first determines from durable state whether the earlier operation committed, then reacquires only when nothing committed and nothing is in flight.

| Writer | Source kind | Reacquisition | What makes a reacquired input "the same request" |
| --- | --- | --- | --- |
| Inferred commit | **Immutable archive input**: the owner's export and plan, re-sent in the request | the owner re-sends the chunk; the Worker never fetches | the chunk intent's `itemsHash` (a different item is `chunk_conflict`); the digest is then identical |
| Diary and Watchlist check | **Live page fetch**: `boxd.it/<lid>`, the film page, the TMDB movie | a new bounded check (ADR 0166 limits) | the same movie id as the `linking` intent, **and** the same deterministic evidence digest. Same movie with a new digest (a title edit on the page): a new request with a new digest; every earlier receipt of the key is first settled by step 2 of the decision 3 protocol |
| Rated step | Immutable archive rows (code, name, year in the candidate document) plus a **live page fetch** and the TMDB movie | a new bounded check (ADR 0087, 0090 limits) | the same movie id and path as the `admitting` row; the digest rule as for the Diary |

**What cannot be silently treated as the same request:**
- a changed source (another movie) becomes `source_changed`;
- a missing source becomes `source_unavailable`, and nothing is synthesized;
- a changed digest for the same movie becomes a new request, while the old unapplied receipt is abandoned visibly;
- a changed target after a merge or redirect is found through the admission row by code and the receipt's readback, which follows the redirect;
- an ambiguous receipt (in flight) is non-terminal.

**The minimal durable correlation 3C needs** is K2's operation key, plus the writer's existing record of code and intended movie and the receipt table. No proof payload is stored.

**4A with K2: failure cases.**
- **Writer record lost or evicted:** the key derives from the code when the source presents it again. Earlier attempts are found and settled first.
- **Lost response, then a redirect:** the applied receipt is found by key (its target is the old Film), and the readback follows the redirect.
- **Concurrent different code for the same movie:** separate keys. The batch answers `other_code_on_film` for the loser (decision 3 table).
- **Changed digest:** the old receipt is abandoned at step 2 of the protocol before the new request.
- **`unknown` or expired `pending`:** abandoned at step 2 of the protocol, unless it is applied.

**4A without a correlation key does not meet 3C.** Concrete failure:
1. A Diary attempt verifies lid → movie A. Its admission batch is in flight when the invocation is cut.
2. The page changes to movie B.
3. A retry sees no row and no receipt inside its window. It reacquires, gets B, compares with the `linking` intent (A) and records `source_changed`: no admission, owner review.
4. The first batch then lands A. Its tail does not check the window, and the Film revision it planned is still current, so the revision fence does not stop it.
5. The next retry finds the row (code → A) and links A, contradicting both the newer source and the review it reported.

The outcome depends on timing. (The revision fence does prevent two admissions of the same Film; it does not prevent this.) With K2, step 2 of the protocol first abandons the old receipt, so A can never land, and the outcome is deterministically `source_changed`. That is why the owner chose K2 (0207-U1). It stores no proof payload.

**Pre-activation chunks.** A chunk committed before activation gets no admission on replay; its admissions are legacy and were proven present at the parity pin. Facts and claims only.

### 4b. Both callers of the Diary check: one retry policy, fences and visibility (0207-U3 = B)

The Diary admission check (W3) has two automatic callers. Both go through `LetterboxdDiaryIdentity.resolve` and share one per-id document, `diary-identity.json`, so a `linking` intent left by one caller is served by whichever runs next.
- **The Ratings Diary phase** (`letterboxd-ratings.js:371-376`, with the Sync's fenced env from `letterboxd-sync-ratings.js`). It runs for Diary page 1, once per run, with at most 3 fetches per step.
- **The Letterboxd Sync Watchlist admission step** (`letterboxd-sync-admission.js`, through `LetterboxdSync.fencedEnv`). It keeps its own D1 ledger `watchlist_admission_pending` and takes at most 3 due rows per slot.

**What the code does today (main `c5ecc1bd`), and why the owner chose one policy.**
- **Transport failures are charged in the Diary.** A 403, a challenge, a 429 or a timeout counts `attempts + 1` there (`letterboxd-diary-identity.js:216`), and after 6 the id is never checked again. The Watchlist treats the same failures as `NOT_NOW`.
- **A 404, a 5xx and a network error share one code**, `fetch_failed` (`letterboxd-rated-candidates.js:208`). So the Watchlist never charges a 404, and a 5xx does not stop the step.
- **Stale entries cause phantom charges.** The Watchlist charges from the shared entry (`max(row + 1, entry.attempts)`), so an old reason can be charged again. An entry spent by Diary transport attempts can also block a ledger row for good.
- **Rows age out during outages.** The Watchlist ages rows out after 14 days of wall-clock time from first sighting, even while scans fail on 403 or 429.
- **The Diary cap evicts link intents.** Above 200 entries it evicts the oldest first, including `linking`, `link_failed` and `claim_pending` entries (`letterboxd-facts.js:681`).

The owner's rule (0207-U3 = B): "временные транспортные ошибки не считаются попытками, нужен автоматический retry через сохранение места в очереди. если страница фильма выдает 404, это считаем".

**One classifier for both callers.** `resolve` returns an explicit per-id outcome `{checked, class, reason, retryAt}` for every id it was asked about. Both callers charge only from that outcome, never from the stored entry or from timestamps. Reasons are split, so `fetch_failed` no longer mixes a 404 with a 5xx.

| Class | Reasons | Attempt | Retry |
| --- | --- | --- | --- |
| **transport** | `forbidden` (403), `challenge`, `rate_limited` (429), `timeout`, `network_error`, `upstream_5xx` (Letterboxd or TMDB), `tmdb_unavailable` (no token), `upstream_cooldown` (ADR 0211 decision 5) | **none** | the item is **kept in place**; `transport_streak + 1`, kept in the shared Diary entry (so neither caller needs a new column); `retryAt = max(15 min · 2^min(streak − 1, 5), active cooldown)`, so at most 8 h; the step stops for that source after the first transport stop, as today |
| **not now** | `deferred` (step cap, lease, budget), `unavailable` (read gate), `admission_closed`, `admission_unavailable`, `in_flight`, `admission_skipped`, `admission_held` | **none** | due again at the next run, or when the hold is resolved; the place is kept |
| **gone** | `not_found`: a 404 or 410 of `boxd.it/<lid>`, of the film page, or of the TMDB movie | **+1** | review backoff, 12 h · 2^(n − 1), capped at 48 h |
| **definite** | a 200 that disagrees (`slug_mismatch`, `tmdb_*`, `detail_*`, …), `unparsable_page`, `not_film_page`, `blocked_redirect`, `too_many_hops`, `oversized`, `check_failed`, `source_changed`, `admission_conflict`, `other_code` | **+1** | review backoff; owner review at the cap |
| **settled** | `verified` then `admitted` / `present`, or a terminal outcome of decision 3 | — | done |

**Cap semantics.**
- **The attempt cap is 6 and counts only `gone` and `definite` outcomes.** At the cap an entry or row is **terminal and visible** (`needs_owner_review`). It is never dropped silently.
- **Transport and not-now outcomes have no cap.** A long transport streak is visible instead (below).
- **A real check resets the streak.** Any `gone`, `definite` or settled outcome sets `transport_streak` back to 0.
- **One check budget for both callers.** The attempt count lives only in the shared Diary entry.
  - `resolve` charges it once per real check, in the same write that records that check's outcome, together with a fresh `check_id`.
  - The Watchlist ledger **copies** the entry's `attempts` and `nextAttemptAt` from the outcome. It never adds to them.
  - Both callers apply the cap to the entry's count, so changing callers neither charges a check twice nor bypasses the cap.
  - Copying is idempotent, so a restart between the check and the ledger settle changes nothing. The no-slug case is charged on the entry too, once.

**Retention: nothing defeats a retained item.**
- **The Watchlist age bound no longer ends a row.** `age_exceeded` is removed as a terminal reason. A row ends only in one of three ways:
  - it is resolved;
  - it is superseded, because the id left the Watchlist;
  - it reaches the attempt cap.

  A row pending longer than 14 days is **reported** (visibility below), not terminated. The closed-time accounting of the previous revision is therefore unnecessary and is withdrawn: no extra clock and no extra column.
- **The Diary cap evicts only settled entries.** Its bound stays 200. Eviction removes settled entries only, oldest `lastAttemptAt` first.
  - It never evicts `linking`, `link_failed` or `claim_pending` entries.
  - It never evicts transport-retained, not-now or below-cap entries.
  - It never evicts an entry at the attempt cap: that entry stays in the `diary_identity` lane until the owner resolves it.
- **Refused ids stay recoverable.** If the cap is full of entries it may not evict, the step starts **no new check** for an id without an entry. It records the id (lid, slug and `queued_at` only) in a second bounded document, `diary-identity-backlog`. That document sits in the same Ratings document store, so it needs no migration, and it holds at most 2,000 ids.
  - When capacity returns, backlog ids enter the main document before new page ids, oldest first, so an id that has left Diary page 1 is not lost.
  - A full backlog reports `backlog_full`. The ids are then still recoverable from the durable Ratings fact records of the Diary rows: a bounded, read-only owner report lists Diary facts without a verified link and without an entry, so they can be requeued.
  - Each refusal is counted as `cap_refused` and reported.
  - **The Watchlist caller at the cap.** The ledger holds up to 500 rows, but the shared budget needs a Diary entry. When the Watchlist caller needs an entry that the full document cannot hold, the id is `not now`, with reason `diary_cap`: no attempt, and its ledger row keeps its place. The id also goes to the backlog, so it gets its entry as soon as capacity returns.
  - *Forward reference (25 Nov 2026): superseded in part by [ADR 0221](0221-shared-letterboxd-check-state-in-one-document.md). The backlog is stored in the same document as the entries, not in a second one; the text above is kept as originally accepted.*
- **The Watchlist ledger cap is unchanged.** Above 500 rows, the promotion is refused with `admission_ledger_full`. That is already visible, and nothing is evicted.

**Fairness and queue order.** Both callers take due ids in one stable order:
1. link repairs and `claim_pending` first, as today;
2. then due entries by their **queue position**: the time they first entered the queue (`queued_at` in the Diary entry, `first_seen_version` in the ledger), oldest first.

A transport retry keeps its queue position, so when it is due again it runs ahead of newer ids, and a stream of new Diary page ids cannot starve older retained ones. Today, page ids always run first and off-page entries go by `nextAttemptAt`. Both are replaced by this order.

**Visibility.**
- **Run records.** The Diary run record and the Watchlist slot record carry per-class counts: checked, transport-retained, not now, gone, definite, at the cap and `cap_refused`. Today the slot record drops the admission result (`letterboxd-sync.js:163-181`).
- **Admin.** The identity-work lane `watchlist_admission` shows each row's class, streak and next retry. A new `diary_identity` lane lists the Diary entries and the backlog, which no surface shows today.
- **Owner actions on both lanes.** One authenticated owner route performs both actions:
  - `requeue` resets an entry's `attempts` and `transport_streak` to 0, keeps its `queued_at`, and records who requeued it, when and why on the shared entry. It sets a ledger row back to `pending` with `last_reason = owner_requeued`, using existing columns only. It applies to entries and rows at the cap, to `age_exceeded` rows still on the Watchlist, and to backlog ids;
  - `dismiss` settles an entry as `owner_dismissed`, which makes it evictable.

  Each request names one id, or at most 50 listed ids, together with the compare-and-swap token it saw: the Diary document's stored version for an entry or a backlog id, and the ledger row's `state`, `attempts` and `updated_at` for a ledger row. It answers with a readback.
  - `requeue` also accepts an id from the read-only owner report that has neither an entry nor a backlog record. It creates a backlog record for that id.
  - The route verifies the Access JWT **in the Worker** (signature, issuer, audience and expiry, through the verifier `/mcp` uses, `mcpVerifyAccess`) and an owner subject. It also checks the Worker's own `Origin`, the action header and a JSON content type.
- **Monitor.** One fact reader reports three conditions:
  - no successful check by either caller for 24 h while due ids exist;
  - a ledger row pending for more than 14 days;
  - any `cap_refused` or `backlog_full`.

**Legacy entries from the old rules.** Entries that the old rules exhausted or aged out stay as they are. There is no blind reset.
- **D0 ships a read-only report**, recorded as dated evidence from an L0 production read. It lists:
  - Diary entries at the attempt cap, by last reason;
  - ledger rows that are terminal as `age_exceeded`;
  - ledger rows exhausted with a transport last reason.

  The stored state keeps only the last reason, not each attempt's, so the report says which rows **may** have been exhausted by transport. It does not claim to know.
- **Recovery is bounded and owner-approved.** It requeues only:
  - `age_exceeded` rows whose id is still on the Watchlist;
  - entries and rows whose last reason is transport.

  It uses the owner `requeue` action in batches of at most 50, under an L2 contract that names the listed ids. Every other legacy entry stays for owner review, one at a time.

**Fence.** The admission batch and its receipt transitions bind the Letterboxd producer fence (`bindProducerFence`: kind `letterboxd`, the Sync epoch) whenever the call arrives through the Sync's fenced env, so a stale Sync epoch cannot admit. Today they do not: `admitRatedFilm` and the receipt writes use only the Film/Person marker. This contradicts `letterboxd-sync.js:53-54` and is a pre-existing defect (card D0).

**Route.** `resolve` receives its caller's route (`ratings_diary` or `watchlist_admission`) explicitly.
- The evidence row (ADR 0213) records the route of the caller whose step performed the page check that the batch used.
- A shared intent resumed by the other caller is re-verified by that caller (4A), so it carries the resumer's route.
- A repair that only re-projects an already admitted pair performs no check and writes no evidence.

**Under `closed`** (decision 1), both callers defer with `admission_closed`. That is not-now: no attempt and no ageing, because age no longer ends a row.

**Drain and parity (decision 1 steps 2-4) cover both callers:**
- no Ratings run and no Letterboxd Sync slot in flight;
- 0 non-terminal admission receipts under any `admission:` key;
- 0 `linking` or `link_failed` entries in the Diary document.

Watchlist ledger rows may stay `pending`: they hold no intent.

**Where it is delivered (0207-U4 = A).**
- **D0 delivers the unified policy on today's paths**, ahead of A1 and on its own. It has no migration:
  - the classifier split and the explicit per-id outcome;
  - the no-charge transport rule in both callers;
  - the stable queue order;
  - the removal of the age termination;
  - the Diary eviction rule and `cap_refused`;
  - the transport streak stored in the shared Diary entry (no migration);
  - the counts, the admin lanes, the backlog and the Monitor reader;
  - the shared check budget;
  - the owner `requeue` and `dismiss` route;
  - the legacy report;
  - the producer fence on the admission batch.
- **A1 keeps the policy.** The reasons that exist only on the new path come with A1:
  - `admission_closed`, `admission_unavailable` and `in_flight` are not now;
  - `source_changed` is definite;
  - `source_unavailable` is transport when its cause is a transport failure, and gone when it is a 404.

  D0 classifies today's reasons only.

**Tests on the real caller paths (D0, then again in A1):**
- the Ratings Diary phase through `letterboxd-ratings.js` with the Sync env;
- the Watchlist admission through `letterboxd-sync-admission.js` with `fencedEnv`;
- per caller:
  - a 403, a challenge, a 429, a timeout and a 5xx consume no attempt, keep the queue position and are retried after the backoff;
  - a 404 consumes one;
  - six 404s give a visible terminal entry;
- a stale shared entry is never charged again;
- an intent written by one caller is resumed by the other;
- a row older than 14 days under a transport outage is not terminated, and is reported;
- the Diary cap at 200 evicts no `linking`, `link_failed`, `claim_pending` or retained entry, and reports `cap_refused`;
- new page ids do not overtake an older retained id;
- a stale Sync epoch is refused at the admission batch;
- one real check charged once, whichever caller runs it, and the cap applied to the shared count;
- a restart between the check and the ledger settle charges nothing twice;
- a legacy entry with old transport charges keeps its count until the owner requeues it;
- a full cap sends new ids to the backlog, which drains first when capacity returns;
- the Watchlist caller at a full cap gets `diary_cap`, consumes no attempt, and its row keeps its place;
- `requeue` of a reported id creates its backlog record;
- `requeue` and `dismiss`, with a stale revision refused;
- under `closed`: no attempt and no termination.

### 5. Readers and the proof contract

- **R1 to R5** read the writer's durable record and D1, not the object.
- **R6**, the local stand-in catalog reader (ADR 0162), may keep reading a local object. It is unreachable in production.
- **R7** (`compareAdmissions`, unused) is removed.
- **ADR 0170 inventory.**
  - The exact archive-and-code proof is kept; it is not weakened.
  - Keep-first can leave a candidate of a later archive `verified` while the D1 row names the first archive. That candidate stays `needs_owner_review` / `admission_unconfirmed`.
  - ADR 0213 decision 8 lists an evidence-based join as a separate, later decision (card E4a).
- **No positive proof from an inferred admission.** It is never positive Letterboxd identity proof. It carries a `restricts` evidence row (ADR 0213), and the Ratings marks stay authoritative for ADR 0184.

### 6. Rated enrichment (G3): retired from R2, replaced by the canonical producer (6C)

- At mode `d1` the rated identity step ends at the verified admission and the tmdb-only rating. W5 and W6 no longer write the R2 entry. At `r2` they run as today.
- Admitted Films are enriched by the canonical catalog-enrichment producer of [ADR 0211](0211-catalog-enrichment-producer.md), independent of EPG airing.
- **The owner chose no thin interval for new admissions (0207-U5 = A).** The enrichment producer is active (card C2) before the A2 flip, with its cutoff no later than the flip. New admissions are therefore **eligible from day one**, and they are enriched at the following ticks, not instantly. The 714 legacy Films stay scope C3a, a separate decision.

### 7. Delivery graph (7C)

Each card is one atomic outcome. **Dormant** means that merging, and the automatic deploy, activate nothing. Approval levels are kept apart:
- **architecture:** the owner's ADR decision;
- **implementation GO:** the approved card scope, then an ordinary merge after review;
- **production GO:** an owner L2 or L3 operation.

| Card | Outcome | Depends on | Boundary | Gate | AIR-275 closure | A2 activation |
| --- | --- | --- | --- | --- | --- | --- |
| **D0** | Today's paths, per decision 4b: the unified retry policy in both callers (classifier split, explicit per-id outcome, no-charge transport, one shared check budget, stable queue order, no age termination, the Diary eviction rule with its backlog, counts, admin lanes with the owner `requeue` and `dismiss` route, Monitor reader, the read-only legacy report) and the Letterboxd producer fence on the admission batch | — (**independent of accepting this ADR**: it corrects current production behaviour, 0207-U4 = A) | active change of today's paths; no migration | its own implementation GO | required | required |
| **DR** | Bounded recovery of legacy entries that the old rules exhausted or aged out: an owner `requeue` of the listed ids only (decision 4b) | D0 and its legacy report reviewed | L2 operation naming the listed ids; batches of at most 50 | owner L2 contract | — | — |
| **R1** | Receipt `operation_key` with its partial unique index (an additive migration file), writer support, lookup and the reconcile-and-reserve protocol of decision 3. A **mandatory shared foundation** of A1 and C1 (0207-U1 = K2) | ADR 0207 accepted | dormant | implementation GO | required | required |
| **E1** | ADR 0213 initial slice: table (with its nullable reconstruction columns), triggers, `identity_evidence` operation, writer helper | ADR 0213 accepted | dormant (no writer calls it) | implementation GO | required | required |
| **A1** | Admission coordination behind the marker (decisions 1-6), using R1 and E1 at `d1` | D0, R1, E1 | dormant (`r2` legacy byte-identical; migrations absent is safe) | implementation GO | required | required |
| **M1** | Apply the R1, E1 and A1 migrations; marker at `r2` | A1 merged and deployed | no behaviour change at `r2` | production GO (owner L2/L3) | required | required |
| **A2** | Activation: decision 1 steps 2-5, then natural acceptance in `Верификация` | M1, C2 | **irreversibility boundary** at the flip | production GO (owner L3); residual risk accepted or No-GO | required | — |
| **UC1** | Shared upstream coordination (ADR 0211 decision 5), **one scope for all relevant producers**: the `upstream_cooldown` and `upstream_coordination` migration files, one shared client, and its adoption by every TMDB, Letterboxd and Wikidata caller of the inventory, with each skip mapped to its caller's not-now path | ADR 0211 accepted; D0 (its no-charge classifier) | dormant (mode `off` = today's behaviour; absent tables = today's behaviour) | implementation GO | required (C1 uses it) | required |
| **C1** | ADR 0211 producer, dormant: writer contract, anchors and precedence (Letterboxd, TMDB, Wikidata), state, units, lease, deadline, outbox, Monitor reader, the control function and its authenticated `/api/admin/settings` routes, the offline cost harness, and the Letterboxd-only test path | ADR 0211 accepted; R1; UC1 | dormant (no control row) | implementation GO | required | required |
| **CM** | Apply the C1 and UC1 tables (state, tick outbox, control, `upstream_cooldown`, `upstream_coordination` at `off`). C2 refuses to activate unless every required table is present (fail closed) | C1 and UC1 merged and deployed; M1 | no behaviour change (mode `off`, no control row) | production GO | required | required |
| **C2** | Activate enrichment for Films admitted after the cutoff, at the measured bound. The cutoff is no later than the A2 flip, so new admissions are **eligible from day one** and enriched at the following ticks, not instantly (0207-U5 = A) | CM; M1 (R1's `operation_key` applied) | durable control; pause stops new work | production GO | required | required |
| **UC2** | Upstream mode `off → observe`, then a dated report of would-be skips per scope and caller | CM | writes cooldowns, skips nothing | production GO | required | — |
| **UC3** | Upstream mode `observe → enforce` after the UC2 report; rollback is `off` | UC2 report reviewed | callers skip during a cooldown | production GO | required | — |
| **CU** | `/admin/settings` page: the enrichment checkbox on the same control, effective state, drain display, cooldowns; independent visual QA | C1 (control contract) | UI only; no new control | implementation GO; owner visual check | required | — |
| **C3a** | Widen enrichment to the 714 existing admitted Films | C2 results reviewed | scope change | owner decision + production GO | no | no |
| **C3b** | Widen enrichment to Watchlist members (the pinned-run gap), including Letterboxd-only Films | C2; its own decision | changes the Watchlist metadata path | owner decision (possibly its own ADR) + production GO | no | no |
| **PF** | Plan per-field provenance and a safe refresh and overwrite rule for `film_metadata` (ADR 0211 choice 1 = B), as its own record | ADR 0211 accepted | planning; then its own cards | owner decision | no | no |
| **EP** | Plan the full evidence model (ADR 0213 option C): unbound observations before a Film exists, the future writers, the historical reconstruction mapping, readers | ADR 0213 accepted | planning roadmap card | owner decision | no | no |
| **E2a** | Evidence from Discovery admission (`candidate_for`, `tmdb_detail_check`) | E1, M1, EP | dormant until its own activation | implementation GO, then production GO | no | no |
| **E2b** | Evidence from the ADR 0184 claim unit | E1, M1, EP | as above | as above | no | no |
| **E2c** | Evidence from owner identity actions, including the claim side of a revoke | E1, M1, EP | as above | as above | no | no |
| **E2d** | Evidence from TMDB retirement | E1, M1, EP | as above | as above | no | no |
| **E3a** | Historical reconstruction, family (a): the 714 legacy admissions (ADR 0213 decision 6). A dry run with a dated coverage report, then a separate import | E1, M1, A2 | dry run writes nothing; the import is one fenced, receipted, idempotent operation | dry run: production read approval; import: owner decision + production GO (L3) | no | no |
| **E3b** | Historical reconstruction, families (b) Discovery and (c) claim history, by the EP mapping; dry run, report, then import | E1, M1, EP, and the matching E2 writer | as E3a | as E3a | no | no |
| **E4a** | ADR 0170 inventory reads per-archive evidence | E1 writers active; its own decision | reader switch | owner decision (ADR amendment) | no | no |
| **E4b** | ADR 0184 planner also reads `restricts` rows | as above | reader switch | owner decision (ADR amendment) | no | no |
| **E5** | Retire the unused 0001 assertion tables | — | schema cleanup | owner decision | no | no |

- **Mandatory for AIR-275 closure:** D0, R1, E1, A1, M1, UC1, C1, CM, C2 and A2, and also UC2, UC3 and CU. After A2's acceptance no mutable R2 authority remains for admissions, and new admissions are enriched from the start. AIR-275 closes only when the selected upstream switch reaches `enforce` (UC3) and the `/admin/settings` control is accepted (CU), so these outcomes are tracked to completion, not left as optional future scope.
- **Mandatory before the A2 flip:** D0, R1, E1, A1, M1, UC1, C1, CM and C2. A2 also verifies that every migration it depends on is applied and that the enrichment control is `active`.
- **A2 readiness is narrower than AIR-275 closure.** UC2, UC3 and CU are **mandatory outcomes of the selected design**, but they are not prerequisites of the A2 flip. Enrichment runs safely at upstream mode `off` with its local transport rule, and the durable control is usable without the page. So the A2 flip may come before them, and AIR-275 then stays open until they are done.
- **One coherent upstream scope (ADR 0211 choice 5 = C).** UC1 adopts the shared cooldown in every relevant producer at once. UC2 and UC3 move the single mode for all of them. There are no per-producer adoption cards.
- **Migration apply order.** D1 applies every pending migration file in number order, so an apply operation cannot skip a lower-numbered file.
  - Files are numbered in merge order. Each apply card states the exact files it applies.
  - If C1's or UC1's files merge before A1's, they are lower-numbered, and M1 applies them too. That is safe, because every table is inert until its writer is activated (dormant code, mode `off`, no control row), and C2 checks every table it needs.
  - CM depends on M1, so it never applies the R1, E1 or A1 files out of order, and then applies whatever remains. M1 and CM may also be a single apply operation.
  - C2 always follows both, because it needs R1's `operation_key` (M1) and its own tables (CM).
- **Planned follow-ups, each with its own decision:** DR, PF, EP, C3a, C3b, E2a-d, E3a-b, E4a-b and E5.
- **No dual writer at any point.** R2 coordination ends only at the A2 flip. The D1 writer was already canonical. Every C and E card adds a writer under existing authorities. UC1 changes only when callers wait, never what they write.

**Tests (A1 acceptance):**
- the reconcile protocol of decision 3:
  - an applied receipt found by key after a redirect;
  - a `pending` receipt inside its window waits;
  - an expired `pending` or `unknown` receipt is abandoned before reacquiring, and its original tail then cannot land;
  - the source-changed race of decision 4 ends deterministically as `source_changed`;
  - two concurrent digests under one key (one reservation wins, the other is `in_flight`);
  - a second archive verifying an admitted pair (no new admission, one evidence-only row);
  - an identity correction after an applied receipt (the stale receipt is not used to link);
  - a lost response followed by a redirect;
  - a lost response of the evidence-only operation;
- the both-callers tests of decision 4b, on the new path;
- the legacy byte-identity at `r2` (after D0) and the refusals at `closed`;
- the marker invariants:
  - a request paused between its guard and its PUT;
  - a request that read "migration absent", paused across the apply and the close;
  - an unreadable marker, a partial schema and a missing row;
  - every illegal transition;
  - the legacy D1 batch refused under `closed` while retention runs;
- the absent-schema legacy batch fence on real D1-compatible SQL;
- G1, G4 and every row of the outcome table, including `source_changed` and `source_unavailable`;
- a lost response followed by a merge or redirect, a same-pair row won by another request, and a retry after a terminal writer-state change;
- determinism: the same source gives the same digest and request id; a title edit gives a new request and abandons the old one visibly;
- historical replay of a pre-activation chunk (no admission offered);
- the inventory proof rule;
- evidence rows written in the admission batch or through the evidence-only operation, never without an actual check;
- the reconcile-to-finalize race: a reservation or a terminal outcome whose history fingerprint moved is refused, and the loser replans;

## Alternatives considered

- **A. Retain the object as live R2 coordination.** Keep W1-W6, fix G1, and accept the object as an explicit mutable R2 exception.
  - For: least code and no activation.
  - Against: two admission authorities in sequence, cross-store partial commits (G2), per-writer rules; AIR-275 keeps a mutable R2 authority.
- **B′. B plus an `identity_kind` column** on `film_rated_admission`. Superseded by ADR 0213: the kind of every identity route belongs in one evidence model, not in a column of one route's table.
- **C. A new normalized D1 table** for every R2 field. Highest cost, and a second admission record.
- **4B. Persist the exact proof payload before the first effect.** This was the previous revision.
  - For: replay never needs the source.
  - Against: new fields in three documents, an eviction exemption for payloads, and payload revalidation rules, for a guarantee that atomic receipts and deterministic digests already give. Not chosen (owner 4A: "Не надо усложнять").
- **No correlation (the previous revision's "admission row plus attempt window").** Rejected: it does not meet 3C (decision 3, the failure example).
- **K1, a pointer in each writer record.** Not chosen (0207-U1 = K2). It fails when the record is lost or evicted, a second attempt overwrites the pointer to the first unless a list is kept, and the inferred commit would need one more store.
- **G3 retirement accepting thin metadata.** The previous revision; rejected by owner 6C, and replaced by ADR 0211.
- **Sub-choices kept from the reviewed revision:**
  - detection-only handover: rejected;
  - the first new row as the rollback boundary: rejected;
  - keep-first in a writer preflight instead of the batch: rejected;
  - settling a concurrent `other_code_on_film` as a conflict: rejected.

## Consequences

- **One admission authority after activation.** G1, G2 and G4 are closed by the design. G3 is closed once ADR 0211 is active (decision 6).
- **New durable contracts.**
  - The one-way marker (an additive migration).
  - Keep-first and typed conflicts at mode `d1`.
  - A digest without clocks and stable events.
  - Per-item admission outcomes in the chunk receipt.
  - One retry policy for both Diary check callers (decision 4b).
  - Evidence rows of ADR 0213 for new admissions.
- **Behaviour changes.**
  - Under `closed`, admissions pause: Diary and Watchlist ids defer, and archive and baseline admit steps answer 409.
  - From D0 on, transport failures never consume a Diary or Watchlist attempt, a 404 does, and no row ends by age.
  - After activation, rated-only Films get no metadata from the rated route; ADR 0211 is already active by then (0207-U5 = A).
  - A retry may fetch the source again (bounded by the existing step limits) instead of reading a stored payload.
- **Compatibility.**
  - ADR 0184: claims unchanged; the negative proof is kept.
  - ADR 0170: proof rule kept.
  - ADR 0192: no view-index dependency.
  - ADR 0162: no R2 fallback at `open`.
  - ADR 0068: chunk intents and receipts keep their semantics; receipts gain the outcome field.
  - ADR 0186: the Watchlist admission step keeps its ledger; only the admission behind it changes.
  - ADR 0194 and 0196: the marker pattern is reused.

## Recovery and migration boundary

- No data migration: the existing 714 rows are already the canonical admissions, and the object is frozen as read.
- Additive migrations, all applied together in M1:
  - the marker (A1);
  - the evidence table (E1);
  - the receipt `operation_key` with its partial unique index (R1).

  The ADR 0211 tables, including the shared upstream tables, are applied separately in CM.
- The irreversibility boundary is the `closed → d1` flip. Before it, recovery is reopen plus an ordinary revert. After it, recovery is roll-forward only, or a separately approved reconciliation plan.
- Retention of the frozen object is indefinite. Deleting it is a later, separate owner decision.
- This ADR, even when Accepted, authorizes no deploy of an active writer, no migration apply, marker change, write, import, backfill, flag, Task or cleanup.

## Evidence

- The audit ledger: [`air-555-verified-films-admission-audit-2026-11-24.md`](../evidence/d1-migration/air-555-verified-films-admission-audit-2026-11-24.md).
- The review of the audit: [PR #972 review](https://github.com/vladimino/iptv-watchlist/pull/972#pullrequestreview-6036874290).
- The design reviews of this record:
  - [first](https://github.com/vladimino/iptv-watchlist/pull/975#pullrequestreview-6037101145);
  - [second](https://github.com/vladimino/iptv-watchlist/pull/975#pullrequestreview-6037183852);
  - [design review passed](https://github.com/vladimino/iptv-watchlist/pull/975#pullrequestreview-6037247874).
- The [owner disposition](https://github.com/vladimino/iptv-watchlist/pull/975#issuecomment-7131137347).
- The [review of the revised package](https://github.com/vladimino/iptv-watchlist/pull/975#pullrequestreview-6039232220), whose findings decisions 3, 4, 4b and 7 address.
- The [re-review](https://github.com/vladimino/iptv-watchlist/pull/975#pullrequestreview-6040005516): the matching scope and atomic reservation of decision 3, and the explicit check outcome of decision 4b.
- The [consolidated owner choices](https://github.com/vladimino/iptv-watchlist/pull/975#issuecomment-7140090124): K2, the unified retry policy, D0 on its own, enrichment before A2, the shared upstream scope.
- Code checks of 24 Nov 2026 (`main` `c5ecc1bd`): the classifier and charging rules of both callers, the Watchlist age bound, the Diary cap eviction, and the upstream caller inventory (ADR 0211 Context).
- Code checks of 24 Nov 2026 (`main` `26cfd115`): the receipt tail, the lookup by request id only, the missing Letterboxd producer fence on the admission batch, the Watchlist ledger attempt rule and the Diary cap.
- Production L0 read, 24 Nov 2026 12:21 UTC: Watchlist marker `d1` generation 3; 714 of 714 admitted Films without `film_metadata`.

## Owner choices in this record

The owner's selections of 2026-11-24 are listed at the top of this record ("Owner choices of 2026-11-24"). Decisions B, 1C, 2B and 3C, the directions 4A, 5C, 6C and 7C, and U1 to U5 are accepted ([final owner disposition](https://github.com/vladimino/iptv-watchlist/pull/975#issuecomment-7141800326)). No choice remains open.

## Follow-ups

**On acceptance.**
- Create the cards of decision 7, including the planned follow-ups (DR, PF, EP, C3a, C3b, E2a-d, E3a-b, E4a-b, E5) as roadmap cards, each with its own decision.
- Link the AIR-275-mandatory cards as bare URLs in AIR-275's native Prerequisites checklist.
- ADR 0087, 0105 and 0166 are marked "Superseded in part by ADR 0207" in their headers and registry rows (done with this record).
- Accepting this record is an architecture decision only. Each card keeps its implementation GO and each operation its production GO.


**Observed, not changed here.** The admin write routes other than the new settings control check only that the Access header is present, not its signature or the owner identity (ADR 0211 Context). Hardening them is outside this record.

**Candidate follow-up, not selected.** Other producers' own transport rules still consume finite budgets: the removal queue, the poster cron and the orchestration quarantine caps (ADR 0211 decision 5). Changing them would be a separate decision.
