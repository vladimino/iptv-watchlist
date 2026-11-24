# ADR 0207: Letterboxd Film admissions are coordinated in D1 only; `verified-films.json` is frozen as historical evidence

**Status:** Proposed. The owner's disposition of 2026-11-24 kept B, 1C, 2B and 3C and asked for 4-7 to be reworked; this revision awaits a new, explicit, ADR-specific Product Owner decision. It is not Accepted.  
**Original decision date:** not decided  
**Recorded at:** 2026-11-24. Revised the same day after two design reviews, after the [owner disposition](https://github.com/vladimino/iptv-watchlist/pull/975#issuecomment-7131137347), after the [review of the revised package](https://github.com/vladimino/iptv-watchlist/pull/975#pullrequestreview-6039232220), after its [re-review](https://github.com/vladimino/iptv-watchlist/pull/975#pullrequestreview-6040005516) and after the [second re-review](https://github.com/vladimino/iptv-watchlist/pull/975#pullrequestreview-6040703398).  
**Approval source:** not decided. The record was requested in the owner's handoff on [PR #972](https://github.com/vladimino/iptv-watchlist/pull/972#issuecomment-7127786410). The [owner disposition](https://github.com/vladimino/iptv-watchlist/pull/975#issuecomment-7131137347) chose directions; it accepts no design and grants no implementation or activation GO.  
**Related work:**
- [AIR-555](https://trello.com/c/JPgjoBzK) (audit and decision), under [AIR-546](https://trello.com/c/1dRSJEbp) and [AIR-275](https://trello.com/c/4x7hH0gI); related [AIR-559](https://trello.com/c/733sRAxu) and [AIR-547](https://trello.com/c/99faXisC).
- The read-only audit [`air-555-verified-films-admission-audit-2026-11-24.md`](../evidence/d1-migration/air-555-verified-films-admission-audit-2026-11-24.md) ([PR #972](https://github.com/vladimino/iptv-watchlist/pull/972), merged at `b9616ff3`). This record uses the audit's call-site labels (W1-W6, R1-R7) and gaps (G1-G4).
- **Companion records, both Proposed:**
  - [ADR 0213](0213-film-identity-evidence-ledger.md), the source-aware identity evidence ledger (disposition 5C);
  - [ADR 0211](0211-catalog-enrichment-producer.md), the catalog-enrichment producer (disposition 6C).

  This record depends on both: decisions 2, 5 and 6 below.

**Supersedes (only on acceptance):**
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

## Decision (proposed)

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

  An unavailable D1, a partial schema, a missing row at or above the migration's version, or an invalid mode fails closed (`letterboxd_admission_unavailable`). None of them ever defaults to `r2`. This covers the F1 deployment, which runs before the migration exists.
- **The full chain is enforced by a trigger.** `r2 → closed`, `closed → r2` (reopen, only before an activation) and `closed → d1` are the only transitions. `r2` cannot skip `closed`, `d1` is terminal, the row is never deleted, and every change of mode raises the generation.
- **Guard at the write.** Every `put` or `delete` of `letterboxd/admissions/verified-films.json` is wrapped once per request or Workflow step:
  - Before each one it reads the marker **fresh**, never from the request scope, so a request that read `r2` or "not installed" at its start still refuses at its own write.
  - It refuses unless the marker proves `r2` or proves the migration absent.
  - The guard is the last awaited step before the PUT.
- **Fence on the legacy D1 batch.** The legacy path's `admitRatedFilm` batch asserts the same proof (mode `r2`, or migration absent) inside its fenced batch, so a legacy admission cannot land under `closed` or `d1`. Retention units (`film_retention`) are not fenced by this marker and keep running.
- **Residual risk.** A PUT that passed its guard before the close cannot be recalled. F2 handles it as ADR 0196 does: compare the object's identity (ETag and size) and full row parity at the close, after the drain, and **immediately before the flip**. Any difference refuses the flip, and a late write is handled by reopening and draining again, never by a delta. Any residual risk that cannot be excluded is either accepted by the owner before the flip or makes the activation No-GO.

**The sequence.** Each step from 2 onward is a separate owner-authorized operation under an L3 plan; this ADR authorizes none of them.
1. **Dormant delivery (F1).** F1 merges and auto-deploys with the marker at `r2`, so the deploy is safe whatever is in flight.
2. **Drain of old code.** Before `closed`, prove with evidence that all invocations of versions older than F1, and their outstanding effects, have finished. An elapsed interval alone is not assumed to be a bound. The evidence covers:
   - the F1 version serving 100% of traffic;
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

**Correlation: how a retry finds every earlier attempt of the same item.** This is the owner choice 0207-U1:

| Option | What is stored | Finds earlier attempts after | Cost |
| --- | --- | --- | --- |
| **K1 pointer** | the `requestId` (the receipt row carries its target) in the writer's own record: one field in the Diary `linking` intent and in the `admitting` row; the inferred commit has no mutable per-item record, so it needs one more store | the record survives. It fails when the record is lost or evicted, and a second attempt overwrites the pointer to the first unless a list is kept | three writer records change; the inferred commit gains a store |
| **K2 operation key (recommended)** | an additive, nullable column `operation_key` on `canonical_write_receipt`, set to `admission:<kind>:<code>` (kind `inferred_import`, `lid` or `short_code`). It comes with a **partial unique index** on `(origin, operation_key) WHERE state IN ('pending','failed','unknown')`: at most one unresolved attempt per key, enforced by the database | any loss of the writer record (the key derives from the code the source presents again), a redirect (the key has no target), a changed digest (same key, new request) and concurrent attempts (all rows share the key) | one additive column and index on the shared receipt table (an ADR 0119 amendment). Other origins leave it null |

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

With K1 the same protocol runs over the pointer: the pointer plus an attempt counter is the history fingerprint, and step 5 becomes a compare-and-swap of it in the writer's record. The inferred commit, which has no mutable per-item record, needs one more store for it. That is part of K1's cost.

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
| Source missing or not reacquirable now | the owner cannot re-send the chunk: the intent stays without a receipt, and nothing is synthesized | pending `source_unavailable`, the existing backoff and six-attempt cap; then visible, no admission | stays `admitting`, retried; `needs_review` at the cap |
| `admission_identity_held`, redirect (classified by `planAdmission` / `resolveAdmissionFilm`) | **non-terminal**: the chunk stops before its receipt; resume after the owner resolves | pending `admission_held`, retried | stays `admitting`, retried |
| Unavailable, `skipped`, `closed`, generation moved, `failed`, `unknown`, `deferred`, refused preflight, in-flight receipt | **non-terminal**: the chunk stops before its receipt; resume repeats the same identity | pending `deferred`, retried | stays `admitting`, retried |

- **Recording.** A terminal outcome is recorded per item in the chunk receipt (`admission: admitted | present | present_other_code | conflict | refused_after_link`) or in the writer's pending state.
- **Ambiguous results.** A non-terminal result is never settled terminally.
- **Replay.** A replay offers the admission again only for items recorded as `admitted` or `present`. Nothing is offered for an item merely because its receipt entry is not a conflict.
- **Refused items.** They write no fact, no claim and no `asserts` evidence row (ADR 0213).
- **Durable state retention.** The writer's existing record (the `linking` intent, the `admitting` row, the chunk intent) stays until the item is terminally settled. The Diary cap never evicts a `linking` or `link_failed` entry: if the cap would need one, the step starts no new source check.

### 4. Reacquire the source; keep only what already exists (4A)

There are **no proof snapshots and no journals**. A retry follows decision 3: it first determines from durable state whether the earlier operation committed, then reacquires only when nothing committed and nothing is in flight.

| Writer | Source kind | Reacquisition | What makes a reacquired input "the same request" |
| --- | --- | --- | --- |
| Inferred commit | **Immutable archive input**: the owner's export and plan, re-sent in the request | the owner re-sends the chunk; the Worker never fetches | the chunk intent's `itemsHash` (a different item is `chunk_conflict`); the digest is then identical |
| Diary and Watchlist check | **Live page fetch**: `boxd.it/<lid>`, the film page, the TMDB movie | a new bounded check (ADR 0166 limits) | the same movie id as the `linking` intent, **and** the same deterministic evidence digest. Same movie with a new digest (a title edit on the page): a new request with a new digest; every earlier receipt of the key is first settled by decision 3 step 3 |
| Rated step | Immutable archive rows (code, name, year in the candidate document) plus a **live page fetch** and the TMDB movie | a new bounded check (ADR 0087, 0090 limits) | the same movie id and path as the `admitting` row; the digest rule as for the Diary |

**What cannot be silently treated as the same request:**
- a changed source (another movie) becomes `source_changed`;
- a missing source becomes `source_unavailable`, and nothing is synthesized;
- a changed digest for the same movie becomes a new request, while the old unapplied receipt is abandoned visibly;
- a changed target after a merge or redirect is found through the admission row by code and the receipt's readback, which follows the redirect;
- an ambiguous receipt (in flight) is non-terminal.

**The minimal durable correlation 3C needs** is K2's operation key, or K1's pointer, plus the writer's existing record of code and intended movie and the receipt table. No proof payload is stored.

**4A with K2: failure cases.**
- **Writer record lost or evicted:** the key derives from the code when the source presents it again. Earlier attempts are found and settled first.
- **Lost response, then a redirect:** the applied receipt is found by key (its target is the old Film), and the readback follows the redirect.
- **Concurrent different code for the same movie:** separate keys. The batch answers `other_code_on_film` for the loser (decision 3 table).
- **Changed digest:** the old receipt is abandoned at step 3 before the new request.
- **`unknown` or expired `pending`:** abandoned at step 3, unless it is applied.

**4A without K1 or K2 does not meet 3C.** Concrete failure:
1. A Diary attempt verifies lid → movie A. Its admission batch is in flight when the invocation is cut.
2. The page changes to movie B.
3. A retry sees no row and no receipt inside its window. It reacquires, gets B, compares with the `linking` intent (A) and records `source_changed`: no admission, owner review.
4. The first batch then lands A. Its tail does not check the window, and the Film revision it planned is still current, so the revision fence does not stop it.
5. The next retry finds the row (code → A) and links A, contradicting both the newer source and the review it reported.

The outcome depends on timing. (The revision fence does prevent two admissions of the same Film; it does not prevent this.) With K1 or K2, step 3 first abandons the old receipt, so A can never land, and the outcome is deterministically `source_changed`. K1 or K2 is therefore required, and the choice between them belongs to the owner. Neither stores a proof payload.

**Pre-activation chunks.** A chunk committed before activation gets no admission on replay; its admissions are legacy and were proven present at the parity pin. Facts and claims only.

### 4b. Both callers of the Diary check: fences, attempts and the Watchlist ledger

The Diary admission check (W3) has two automatic callers:
- **the Ratings Diary phase** (`letterboxd-ratings.js:374`, with the Sync's fenced env from `letterboxd-sync-ratings.js`);
- **the Letterboxd Sync Watchlist admission step** (`letterboxd-sync-admission.js:50`, through `LetterboxdSync.fencedEnv`). It has its own ledger `watchlist_admission_pending`, with attempt and age caps and a `NOT_NOW` set of reasons that do not consume an attempt.

Both read and write the one shared Diary document, so a `linking` intent left by one is served by whichever runs next.

**Fence.** On the new path the admission batch and its receipt transitions bind the Letterboxd producer fence (`bindProducerFence`: kind `letterboxd`, the Sync epoch) whenever the call arrives through the Sync's fenced env, so a stale Sync epoch cannot admit. Today they do not: `admitRatedFilm` and the receipt writes use only the Film/Person marker. This contradicts `letterboxd-sync.js:53-54` and is a pre-existing defect (card D0).

**Route.** `resolve` receives its caller's route (`ratings_diary` or `watchlist_admission`) explicitly.
- The evidence row (ADR 0213) records the route of the caller whose step performed the page check that the batch used.
- A shared intent resumed by the other caller is re-verified by that caller (4A), so it carries the resumer's route.
- A repair that only re-projects an already admitted pair performs no check and writes no evidence.

**Outcome mapping in both stores:**

| Reason | Diary document | Watchlist ledger |
| --- | --- | --- |
| `admission_closed` (marker `closed`) | defer: no attempt, entry unchanged, due again | in `NOT_NOW`: no attempt |
| `admission_unavailable` (marker unreadable, partial schema, missing row) | defer: no attempt | in `NOT_NOW` |
| `in_flight` (a `pending` receipt of the key inside its window) | defer: no attempt | in `NOT_NOW` |
| `source_unavailable`, transport (403, 429, challenge, timeout) | attempt + 1, transport backoff, as today | in `NOT_NOW`, as today |
| `source_unavailable`, gone (404 page or movie) | attempt + 1, review backoff | consumes an attempt |
| `source_changed` | attempt + 1, review backoff; owner review at the cap | consumes an attempt; terminal at the cap |
| `admission_conflict`, `other_code` | as today | consumes an attempt |

- **Attempts are charged only for real checks.** `resolve` returns an explicit per-id outcome `{checked: true|false, reason}`. The ledger charges an attempt only when `checked` is true **and** the reason is not in `NOT_NOW`, so transport reasons stay free, as today. It does not infer the check from the stored entry or from timestamps.
- **No ageing under `closed`.** The marker row keeps a monotonic **closed clock**: the total closed milliseconds so far, plus the start of the current closure if it is `closed` now. Each ledger row records the closed clock's value at its birth, in an additive column of the A1 migration. A row's age is its elapsed time minus `(closed clock now − closed clock at birth)`. That is exact across any number of closures, including for rows born between closures, so a closure neither ages a row out while it lasts nor makes it age out at once afterwards.
- **No eviction of link intents.** The Diary cap never evicts a `linking` or `link_failed` entry. Today it can (`letterboxd-facts.js:674-684`); this is a pre-existing defect (card D0).

**Drain and parity (decision 1 steps 2-4) cover both callers:**
- no Ratings run and no Letterboxd Sync slot in flight;
- 0 non-terminal admission receipts under any `admission:` key;
- 0 `linking` or `link_failed` entries in the Diary document.

Watchlist ledger rows may stay `pending`: they hold no intent.

**Tests on the real caller paths:**
- the Ratings Diary phase through `letterboxd-ratings.js` with the Sync env;
- the Watchlist admission through `letterboxd-sync-admission.js` with `fencedEnv`;
- an intent written by one caller and resumed by the other;
- a closure that consumes no attempt and ages no row;
- a stale Sync epoch refused at the admission batch.

### 5. Readers and the proof contract

- **R1 to R5** read the writer's durable record and D1, not the object.
- **R6**, the local stand-in catalog reader (ADR 0162), may keep reading a local object. It is unreachable in production.
- **R7** (`compareAdmissions`, unused) is removed.
- **ADR 0170 inventory.**
  - The exact archive-and-code proof is kept; it is not weakened.
  - Keep-first can leave a candidate of a later archive `verified` while the D1 row names the first archive. That candidate stays `needs_owner_review` / `admission_unconfirmed`.
  - ADR 0213 decision 6 offers an evidence-based join as a separate owner choice.
- **No positive proof from an inferred admission.** It is never positive Letterboxd identity proof. It carries a `negative` evidence row (ADR 0213), and the Ratings marks stay authoritative for ADR 0184.

### 6. Rated enrichment (G3): retired from R2, replaced by the canonical producer (6C)

- At mode `d1` the rated identity step ends at the verified admission and the tmdb-only rating. W5 and W6 no longer write the R2 entry. At `r2` they run as today.
- Admitted Films are enriched by the canonical catalog-enrichment producer of [ADR 0211](0211-catalog-enrichment-producer.md), independent of EPG airing.
- **Whether a thin interval is allowed between the A2 flip and the ADR 0211 activation is the owner choice 0207-U5** (decision 7). Today the R2 enrichment is idle, no entry carries enrichment, and all 714 admitted Films are already thin. An interval therefore loses nothing that exists, but newly admitted rated Films would stay thin until ADR 0211 is active.

### 7. Delivery graph (7C)

Each card is one atomic outcome. **Dormant** means that merging, and the automatic deploy, activate nothing. Approval levels are kept apart:
- **architecture:** the owner's ADR decision;
- **implementation GO:** the approved card scope, then an ordinary merge after review;
- **production GO:** an owner L2 or L3 operation.

| Card | Outcome | Depends on | Boundary | Gate | AIR-275 closure | A2 activation |
| --- | --- | --- | --- | --- | --- | --- |
| **D0** | Fix the pre-existing defects of decision 4b in today's code: Letterboxd producer fence on the admission batch and receipt writes; ledger attempts charged only for explicit checks; no eviction of link intents | — (**independent of accepting this ADR**: it corrects current production behaviour) | active fix of today's paths; no new path | its own implementation GO, which can be authorized on its own (or folded into A1 if the owner prefers) | required | required |
| **R1** | **Only if 0207-U1 = K2:** receipt `operation_key` with its partial unique index (an additive migration file), writer support, lookup and the reconcile-and-reserve protocol of decision 3; unused until A1. With K1 the pointer work moves into A1 and R1 does not exist | ADR 0207 accepted | dormant | implementation GO | required if K2 | required if K2 |
| **E1** | ADR 0213 initial slice: table, triggers, `identity_evidence` operation, writer helper | ADR 0213 accepted | dormant (no writer calls it) | implementation GO | required | required |
| **A1** | Admission coordination behind the marker (decisions 1-6), using R1 and E1 at `d1` | D0, R1, E1 | dormant (`r2` legacy byte-identical; migrations absent is safe) | implementation GO | required | required |
| **M1** | Apply the R1, E1 and A1 migrations; marker at `r2` | A1 merged and deployed | no behaviour change at `r2` | production GO (owner L2/L3) | required | required |
| **A2** | Activation: decision 1 steps 2-5, then natural acceptance in `Верификация` | M1; plus C2 if 0207-U5 = (a) | **irreversibility boundary** at the flip | production GO (owner L3); residual risk accepted or No-GO | required | — |
| **C1** | ADR 0211 producer, dormant: writer contract, parts, lease, deadline, outcome and Monitor reader, offline cost harness | ADR 0211 accepted; R1 | dormant (no activation state) | implementation GO | per 0207-U5 | per 0207-U5 |
| **CM** | Apply whichever additive schema C1 actually requires (its part-state table, its outcome outbox, the activation state if a table, the shared `upstream_backoff` only if 0211-5 = (b)); not needed if C1 requires none. C2 refuses to activate unless every required table is present (fail closed) | C1 merged and deployed | no behaviour change | production GO | per 0207-U5 | per 0207-U5 |
| **C2** | Activate enrichment for Films admitted after the cutoff, at the measured bound. With 0207-U5 = (a) the cutoff is no later than the A2 flip: new admissions are **eligible from day one**, and are enriched at the next ticks, not instantly | CM | durable activation, pause stops new work | production GO | per 0207-U5 | per 0207-U5 |
| **C3a** | Widen enrichment to the 714 existing admitted Films | C2 results reviewed | eligibility change | owner decision + production GO | no | no |
| **C3b** | Widen enrichment to Watchlist members (the pinned-run gap) | C2; its own decision | changes the Watchlist metadata path | owner decision (possibly its own ADR) + production GO | no | no |
| **E2a** | Evidence from Discovery admission (`candidate_for`, `tmdb_detail_check`) | E1, M1 | dormant until its own activation | implementation GO, then production GO | no | no |
| **E2b** | Evidence from the ADR 0184 claim unit | E1, M1 | as above | as above | no | no |
| **E2c** | Evidence from owner identity actions, including the claim side of a revoke | E1, M1 | as above | as above | no | no |
| **E2d** | Evidence from TMDB retirement | E1, M1 | as above | as above | no | no |
| **E3** | Legacy evidence backfill of the 714 admissions (0213-3) | E1, M1, A2 | one fenced, receipted import with a dry run | owner decision + production GO (L3) | no | no |
| **E4a** | ADR 0170 inventory reads per-archive evidence | E1 writers active; its own decision | reader switch | owner decision (ADR amendment) | no | no |
| **E4b** | ADR 0184 planner also reads `restricts` rows | as above | reader switch | owner decision (ADR amendment) | no | no |
| **E5** | Retire the unused 0001 assertion tables | — | schema cleanup | owner decision | no | no |

- **Mandatory for AIR-275:** D0, R1 (if K2), E1, A1, M1 and A2; after A2's acceptance no mutable R2 authority remains for admissions. C1, CM and C2 are added if 0207-U5 = (a).
- **R1 and C1.** R1 is also a prerequisite of C1, **whatever 0207-U1 decides** (ADR 0211 decision 3).
- **Mandatory before the A2 flip:** D0, R1 (if K2), E1, A1 and M1, and C2 if 0207-U5 = (a). A2 also verifies that every migration it depends on is applied.
- **Longer-term catalog work, each card its own decision:** C3a, C3b, E2a-d, E3, E4a-b and E5.
- **No dual writer at any point.** R2 coordination ends only at the A2 flip; the D1 writer was already canonical; every C and E card adds a writer under existing authorities.

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
- the both-callers tests of decision 4b;
- the legacy byte-identity at `r2` and the refusals at `closed`;
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
- the Diary cap never evicting a `linking` or `link_failed` entry;
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
- **No correlation (the previous revision's "admission row plus attempt window").** Rejected: it does not meet 3C (decision 3, the failure example). The pointer K1 and the key K2 are both kept as owner options.
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
  - The Diary no-eviction rule for `linking` and `link_failed`.
  - Evidence rows of ADR 0213 for new admissions.
- **Behaviour changes.**
  - Under `closed`, admissions pause: Diary and Watchlist ids defer, and archive and baseline admit steps answer 409.
  - After activation, rated-only Films get no metadata from the rated route until ADR 0211 is active.
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
  - the marker, with its closed clock, and the ledger's closed-clock column (A1);
  - the evidence table (E1);
  - the receipt `operation_key` with its partial unique index (R1, only with K2).
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
- The [re-review](https://github.com/vladimino/iptv-watchlist/pull/975#pullrequestreview-6040005516): the matching scope and atomic reservation of decision 3, the explicit check outcome and closed-time accounting of decision 4b, and the conditional R1 and CM cards.
- Code checks of 24 Nov 2026 (`main` `26cfd115`): the receipt tail, the lookup by request id only, the missing Letterboxd producer fence on the admission batch, the Watchlist ledger attempt rule and the Diary cap.
- Production L0 read, 24 Nov 2026 12:21 UTC: Watchlist marker `d1` generation 3; 714 of 714 admitted Films without `film_metadata`.

## Owner choices in this record (each separate; the companion records list their own)

| # | Choice | Options | Recommended |
| --- | --- | --- | --- |
| 0207-U1 | Correlation of attempts (decision 3) | K1 pointer in the writer records; K2 receipt `operation_key` | K2 |
| 0207-U2 | Digest without clocks (`verified_at` = first admitting batch) and the outcomes `source_changed` and `source_unavailable` | accept; or keep the clock in the digest (incompatible with 4A) | accept |
| 0207-U3 | Both-callers contract (decision 4b): fence, mapping, attempt charging, no ageing under `closed`, no eviction of link intents | accept; or a different mapping per reason | accept |
| 0207-U4 | Fix the pre-existing defects as D0 ahead of A1, or inside A1 | D0 first; or inside A1 | D0 first (they affect production today) |
| 0207-U5 | Canonical enrichment relative to the flip, **for newly admitted Films only** (the 714 legacy Films are scope C3a, decided separately) | (a) C1, CM and C2 before A2, so no thin interval for new admissions and a longer AIR-275; (b) in parallel, A2 may flip first with an explicit thin interval for new admissions | (a), following the owner's 6C remark that a longer migration is acceptable |

Decisions B, 1C, 2B and 3C were made by the owner on 2026-11-24 and are not reopened. 4A, 5C, 6C and 7C are the owner's directions. This record proposes how to meet them, and each choice above can be decided on its own.

## Follow-ups

**On acceptance.**
- Create the cards of decision 7 that the owner's choices select, and only those.
- Link the AIR-275-mandatory cards as bare URLs in AIR-275's native Prerequisites checklist.
- Mark ADR 0087, 0105 and 0166 "Superseded in part by ADR 0207", and update the registry rows.
- Accepting this record is an architecture decision only. Each card keeps its implementation GO and each operation its production GO.

**On rejection.** The record is kept as `Rejected` (docs-only), and the owner chooses A or C.
