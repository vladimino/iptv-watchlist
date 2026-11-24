# ADR 0207: Letterboxd Film admissions are coordinated in D1 only; `verified-films.json` is frozen as historical evidence

**Status:** Proposed. The owner's disposition of 2026-11-24 kept B, 1C, 2B and 3C and asked for 4-7 to be reworked; this revision awaits a new, explicit, ADR-specific Product Owner decision. It is not Accepted.  
**Original decision date:** not decided  
**Recorded at:** 2026-11-24. Revised the same day after two design reviews and after the [owner disposition](https://github.com/vladimino/iptv-watchlist/pull/975#issuecomment-7131137347).  
**Approval source:** not decided. The record was requested in the owner's handoff on [PR #972](https://github.com/vladimino/iptv-watchlist/pull/972#issuecomment-7127786410). The [owner disposition](https://github.com/vladimino/iptv-watchlist/pull/975#issuecomment-7131137347) chose directions; it accepts no design and grants no implementation or activation GO.  
**Related work:**
- [AIR-555](https://trello.com/c/JPgjoBzK) (audit and decision), under [AIR-546](https://trello.com/c/1dRSJEbp) and [AIR-275](https://trello.com/c/4x7hH0gI); related [AIR-559](https://trello.com/c/733sRAxu) and [AIR-547](https://trello.com/c/99faXisC).
- The read-only audit [`air-555-verified-films-admission-audit-2026-11-24.md`](../evidence/d1-migration/air-555-verified-films-admission-audit-2026-11-24.md) ([PR #972](https://github.com/vladimino/iptv-watchlist/pull/972)). That relative link resolves only once #972 has merged. This record uses the audit's call-site labels (W1-W6, R1-R7) and gaps (G1-G4).
- **Companion records, both Proposed:**
  - [ADR 0210](0210-film-identity-evidence-ledger.md), the source-aware identity evidence ledger (disposition 5C);
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
| 5 | **5C**, separate evidence model: "источник источнику рознь…" | reworked: companion [ADR 0210](0210-film-identity-evidence-ledger.md) |
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
- `r2`: the delivered code behaves **exactly as today**. Every writer uses the R2 step, writes no evidence row, no `d1` receipt key and no new receipt shape. The legacy enrichment runs. Tests prove byte-identical writer behaviour against the legacy code.
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

  An unavailable D1, a partial schema, a missing row at or above the migration's version, or an invalid mode fails closed (`letterboxd_admission_unavailable`). None of them ever defaults to `r2`. This covers the A1 deployment, which runs before the migration exists.
- **The full chain is enforced by a trigger.** `r2 → closed`, `closed → r2` (reopen, only before an activation) and `closed → d1` are the only transitions. `r2` cannot skip `closed`, `d1` is terminal, the row is never deleted, and every change of mode raises the generation.
- **Guard at the write.** Every `put` or `delete` of `letterboxd/admissions/verified-films.json` is wrapped once per request or Workflow step:
  - Before each one it reads the marker **fresh**, never from the request scope, so a request that read `r2` or "not installed" at its start still refuses at its own write.
  - It refuses unless the marker proves `r2` or proves the migration absent.
  - The guard is the last awaited step before the PUT.
- **Fence on the legacy D1 batch.** The legacy path's `admitRatedFilm` batch asserts the same proof (mode `r2`, or migration absent) inside its fenced batch, so a legacy admission cannot land under `closed` or `d1`. Retention units (`film_retention`) are not fenced by this marker and keep running.
- **Residual risk.** A PUT that passed its guard before the close cannot be recalled. A2 handles it as ADR 0196 does: compare the object's identity (ETag and size) and full row parity at the close, after the drain, and **immediately before the flip**. Any difference refuses the flip, and a late write is handled by reopening and draining again, never by a delta. Any residual risk that cannot be excluded is either accepted by the owner before the flip or makes the activation No-GO.

**The sequence.** Each step from 2 onward is a separate owner-authorized operation under an L3 plan; this ADR authorizes none of them.
1. **Dormant delivery (A1).** A1 merges and auto-deploys with the marker at `r2`, so the deploy is safe whatever is in flight.
2. **Drain of old code.** Before `closed`, prove with evidence that all invocations of versions older than A1, and their outstanding effects, have finished. An elapsed interval alone is not assumed to be a bound. The evidence covers:
   - the A1 version serving 100% of traffic;
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
6. **Natural acceptance.** The first natural Diary or Watchlist admission (or an owner-run archive step) produces a D1 row with its evidence row (ADR 0210) and no R2 change.

**Abort and rollback.**
- **Before the flip.** Abort is `closed → r2` (reopen), and a code revert is an ordinary rollback. Reopen first: code that does not read the marker would otherwise reopen the legacy writers silently.
- **After the flip.** A revert to any version that does not honour the marker is **prohibited**. Recovery is roll-forward on code that honours the marker. Restoring R2 coordination needs its own owner-approved reconciliation plan, never an implicit rebuild.
- **The evidence rows are not the boundary.** The evidence rows of decision 2 (ADR 0210) are provenance and diagnostics only. The boundary is the marker flip.


### 2. One admission record, with first admission pinned in D1 (2B)

- `film_rated_admission` stays the only admission record. No new admission table (option C) and no identity column (option B′).
- **Keep-first, at mode `d1`.** For an existing row with the same movie id and code, `admitRatedFilm` and `planAdmission` answer **no-op** whatever the archive, title or year of the new input. The `ON CONFLICT … DO UPDATE` of those columns no longer applies on the new path. This closes G4 inside the fenced batch. `verified_at` is the time of the first admitting batch.
- **Typed conflicts.** A row with another code for the same Film, or a code held by another Film, stays `admission_conflict`. The error carries `other_code_on_film` or `code_on_other_film`.
- **Provenance through the evidence ledger, not a second marker.**
  - Each new-path admission writes its evidence row (ADR 0210 decision 3) in the same batch:
    - `inferred_link`/`negative` for the inferred import;
    - `page_verified` with a `ratings_lid` or `watchlist_lid` candidate for the Diary and Watchlist check;
    - `page_verified` with an `archive_short_code` candidate for the rated archive.
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
- The event is `admission:<kind>:<code>`.
- The Diary and Watchlist evidence digest is already deterministic: `sha256(lid, slug, path, tmdb, title, year, source)`. So the same source content always gives the same digest and, for the same target, the same request id.

**First determine whether an earlier operation committed (before any reacquisition).** From durable state only: the writer's existing record of code and intended movie (Context), the admission row by code, and the receipt table.
- **A row for this code and this movie:** committed, through this request or another. The retry records `present`; only the attempt whose own batch applied records `admitted`. Both outcomes are terminal and equivalent for every later stage, replay included. It proceeds to the writer's next stage **without** reacquiring the source.
- **A row for this code and another movie:** `code_on_other_film`, decided by the table below.
- **No row, but a `pending` receipt of this origin for the target inside its attempt window:** in flight. The result is non-terminal; retry later.
- **No row and no in-flight receipt:** nothing committed (receipts are atomic). Reacquiring is safe.

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
- **Refused items.** They write no fact, no claim and no evidence row of strength above `candidate`.
- **Durable state retention.** The writer's existing record (the `linking` intent, the `admitting` row, the chunk intent) stays until the item is terminally settled. The Diary cap never evicts a `linking` or `link_failed` entry: if the cap would need one, the step starts no new source check.

### 4. Reacquire the source; keep only what already exists (4A)

There are **no proof snapshots and no journals**. A retry follows decision 3: it first determines from durable state whether the earlier operation committed, then reacquires only when nothing committed and nothing is in flight.

| Writer | Source kind | Reacquisition | What makes a reacquired input "the same request" |
| --- | --- | --- | --- |
| Inferred commit | **Immutable archive input**: the owner's export and plan, re-sent in the request | the owner re-sends the chunk; the Worker never fetches | the chunk intent's `itemsHash` (a different item is `chunk_conflict`); the digest is then identical |
| Diary and Watchlist check | **Live page fetch**: `boxd.it/<lid>`, the film page, the TMDB movie | a new bounded check (ADR 0166 limits) | the same movie id as the `linking` intent, **and** the same deterministic evidence digest. Same movie with a new digest (a title edit on the page): a new request with a new digest; the earlier unapplied receipt is abandoned as `producer_source_changed` by its readback |
| Rated step | Immutable archive rows (code, name, year in the candidate document) plus a **live page fetch** and the TMDB movie | a new bounded check (ADR 0087, 0090 limits) | the same movie id and path as the `admitting` row; the digest rule as for the Diary |

**What cannot be silently treated as the same request:**
- a changed source (another movie) becomes `source_changed`;
- a missing source becomes `source_unavailable`, and nothing is synthesized;
- a changed digest for the same movie becomes a new request, while the old unapplied receipt is abandoned visibly;
- a changed target after a merge or redirect is found through the admission row by code and the receipt's readback, which follows the redirect;
- an ambiguous receipt (in flight) is non-terminal.

**The minimal information 3C needs** is the code and the intended movie id, which every writer already stores before its first effect (Context), plus the admission row and the receipt table. If the writer's record itself is lost:
- the admission row by code still proves a commit;
- with no row, nothing is admitted, and the id is checked again only if its source presents it again (a Diary page, a Watchlist snapshot, a re-sent chunk).

**4A coexists with 3C under the current contracts.** The conditions are atomic receipts, a deterministic evidence digest and a digest without clocks. If the admission card finds a writer whose source digest is not deterministic, it stops and returns that case to the owner with its failure example. It does not fall back to persisting payloads (4B).

**Pre-activation chunks.** A chunk committed before activation gets no admission on replay; its admissions are legacy and were proven present at the parity pin. Facts and claims only.

### 5. Readers and the proof contract

- **R1 to R5** read the writer's durable record and D1, not the object.
- **R6**, the local stand-in catalog reader (ADR 0162), may keep reading a local object. It is unreachable in production.
- **R7** (`compareAdmissions`, unused) is removed.
- **ADR 0170 inventory.**
  - The exact archive-and-code proof is kept; it is not weakened.
  - Keep-first can leave a candidate of a later archive `verified` while the D1 row names the first archive. That candidate stays `needs_owner_review` / `admission_unconfirmed`.
  - ADR 0210 decision 6 offers an evidence-based join as a separate owner choice.
- **No positive proof from an inferred admission.** It is never positive Letterboxd identity proof. It carries a `negative` evidence row (ADR 0210), and the Ratings marks stay authoritative for ADR 0184.

### 6. Rated enrichment (G3): retired from R2, replaced by the canonical producer (6C)

- At mode `d1` the rated identity step ends at the verified admission and the tmdb-only rating. W5 and W6 no longer write the R2 entry. At `r2` they run as today.
- Admitted Films are enriched by the canonical catalog-enrichment producer of [ADR 0211](0211-catalog-enrichment-producer.md). It writes through the existing writer and precedence and is independent of EPG airing.
- That record carries the trigger, the bounds, retries, provenance and the scope and backfill choices.
- **Thin metadata is not accepted as permanent.** Between this activation and the activation of ADR 0211, newly admitted Films stay thin. All 714 existing admissions are already thin today.

### 7. Delivery graph (7C)

The cards are atomic outcomes, not commands. "Dormant" means that merging auto-deploys no active effect.

| Card | Scope | Depends on | Dormant or active boundary | GO gate | For AIR-275 |
| --- | --- | --- | --- | --- | --- |
| **E1** Evidence ledger core | ADR 0210: the migration file (table, append-only triggers, indexes), the writer helper used inside fenced batches, and pure strength rules with tests. Admission-route kinds only | ADR 0210 accepted | dormant: no writer calls the helper; the migration is not applied | merge: ordinary review | **mandatory** |
| **A1** Admission coordination, dormant | decisions 1-5 behind the marker: the marker migration file, the legacy path byte-identical at `r2`, refusals at `closed`, keep-first and typed conflicts, outcome recording, the 4A retry, evidence rows at `d1` (using E1), the W5/W6 retirement at `d1`, and every test listed under "Tests" below | E1 | dormant: everything new is behind mode `d1`; the auto-deploy is safe at `r2` and with the migration absent | merge: ordinary review | **mandatory** |
| **M1** Schema apply | apply the E1 and A1 migrations to production; marker at `r2` | A1 merged and deployed | applying changes no behaviour (`r2`) | owner L2/L3 GO | **mandatory** |
| **A2** Activation | decision 1 steps 2-5: evidence-based drain, `closed`, parity pin, re-pin, flip. Natural acceptance in `Верификация` | M1 | **irreversibility boundary** at the flip | owner L3 GO; residual risk accepted or No-GO | **mandatory** |
| **C1** Catalog enrichment, dormant | ADR 0211: origin, eligibility, sources, bounds, retries, evidence of the fetch provenance; activation constant `false` | ADR 0211 accepted; independent of A1 and A2 | dormant constant | merge: ordinary review | owner choice U5 |
| **C2** Catalog enrichment activation | flip the constant for Films admitted after activation | C1 | active: reversible by reverting the constant; written metadata stays | owner GO | owner choice U5 |
| **C3** Catalog enrichment scope widening | the existing 714 thin admitted Films; optionally Watchlist members | C2 reviewed | eligibility widening | owner GO | no (longer-term) |
| **E2** Evidence for the other routes | Discovery admission, the ADR 0184 claim unit, owner identity actions, retirement and merge (ADR 0210 decision 3) | E1, M1 | each writer dormant until its own constant | merge, then owner GO per writer | no (longer-term) |
| **E3** Legacy evidence backfill | 714 admissions from the frozen object and the Ratings marks (ADR 0210 decision 5 ii) | E1, M1, A2 | one fenced, receipted import with a dry run | owner L3 GO | no (optional) |
| **E4** Reader amendments | an ADR 0170 evidence join, and the ADR 0184 reading of `negative` rows (ADR 0210 decision 6) | E2 (and E3 for full history) | reader switch | owner decision per amendment | no (longer-term) |

- **AIR-275.** Its mandatory chain is **E1 → A1 → M1 → A2**. After A2's acceptance no mutable R2 authority remains for admissions.
- **Catalog work.** C1-C3 and E2-E4 prepare the global catalog. C1 can start in parallel with E1, since it reads `film_rated_admission`, which exists today.
- **Safety.** There is no dual writer at any point: R2 coordination ends only at the A2 flip, and the D1 writer was already the canonical one.

**Tests (A1 acceptance):**
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
- evidence rows written in the admission batch and never without it.

## Alternatives considered

- **A. Retain the object as live R2 coordination.** Keep W1-W6, fix G1, and accept the object as an explicit mutable R2 exception.
  - For: least code and no activation.
  - Against: two admission authorities in sequence, cross-store partial commits (G2), per-writer rules; AIR-275 keeps a mutable R2 authority.
- **B′. B plus an `identity_kind` column** on `film_rated_admission`. Superseded by ADR 0210: the kind of every identity route belongs in one evidence model, not in a column of one route's table.
- **C. A new normalized D1 table** for every R2 field. Highest cost, and a second admission record.
- **4B. Persist the exact proof payload before the first effect.** This was the previous revision.
  - For: replay never needs the source.
  - Against: new fields in three documents, an eviction exemption for payloads, and payload revalidation rules, for a guarantee that atomic receipts and deterministic digests already give. Not chosen (owner 4A: "Не надо усложнять").
- **4A-pointer. Persist only the earlier request id.**
  - For: a direct receipt lookup.
  - Against: the admission row by code and the receipt's target and digest already find the same receipt, so it adds state without adding a guarantee.
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
  - Evidence rows of ADR 0210 for new admissions.
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
- Two additive migrations, the marker (A1) and the evidence table (E1). Both are applied together in M1.
- The irreversibility boundary is the `closed → d1` flip. Before it, recovery is reopen plus an ordinary revert. After it, recovery is roll-forward only, or a separately approved reconciliation plan.
- Retention of the frozen object is indefinite. Deleting it is a later, separate owner decision.
- This ADR, even when Accepted, authorizes no deploy of an active writer, no migration apply, marker change, write, import, backfill, flag, Task or cleanup.

## Evidence

- The audit ledger: [`air-555-verified-films-admission-audit-2026-11-24.md`](../evidence/d1-migration/air-555-verified-films-admission-audit-2026-11-24.md). It resolves once #972 has merged.
- The review of the audit: [PR #972 review](https://github.com/vladimino/iptv-watchlist/pull/972#pullrequestreview-6036874290).
- The design reviews of this record:
  - [first](https://github.com/vladimino/iptv-watchlist/pull/975#pullrequestreview-6037101145);
  - [second](https://github.com/vladimino/iptv-watchlist/pull/975#pullrequestreview-6037183852);
  - [design review passed](https://github.com/vladimino/iptv-watchlist/pull/975#pullrequestreview-6037247874).
- The [owner disposition](https://github.com/vladimino/iptv-watchlist/pull/975#issuecomment-7131137347).
- Production L0 read, 24 Nov 2026 12:21 UTC: Watchlist marker `d1` generation 3; 714 of 714 admitted Films without `film_metadata`.

## Unresolved owner choices

- **U1 (decision 3/4).** Accept the admission digest without clocks (`verified_at` = first admitting batch) and the new review outcomes `source_changed` and `source_unavailable`.
- **U2 (ADR 0210).** Accept the evidence ledger, its strength vocabulary and the admission-route kinds as part of the AIR-275 chain (E1).
- **U3 (ADR 0210 decision 5).** Legacy evidence backfill: none (recommended for AIR-275), or a bounded backfill of the 714 admissions as E3.
- **U4 (ADR 0211).** The dedicated `catalog_enrichment` origin, on the hourly tick with its bound, and TMDB as the primary source.
- **U5 (decision 7).** Make C1 and C2 prerequisites of AIR-275 (the owner's "even if the migration takes longer"), or deliver them in parallel as longer-term catalog work.
- **U6 (ADR 0211 decision 6).** Scope widening: the existing 714 thin Films and, optionally, Watchlist members (C3).

## Follow-ups

**On acceptance.** Create the cards of decision 7 that the owner's answers to U2-U6 select. Link those required for AIR-275 as bare URLs in its native Prerequisites checklist. Then mark ADR 0087, 0105 and 0166 "Superseded in part by ADR 0207" and update the registry rows.

**On rejection.** The record is kept as `Rejected` (docs-only), and the owner chooses A or C.
