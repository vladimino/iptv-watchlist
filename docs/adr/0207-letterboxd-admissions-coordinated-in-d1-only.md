# ADR 0207: Letterboxd Film admissions are coordinated in D1 only; `verified-films.json` is frozen as historical evidence

**Status:** Proposed (no owner decision on this record; the recommended option and every sub-choice below await review and an explicit, ADR-specific Product Owner decision)  
**Original decision date:** not decided  
**Recorded at:** 2026-11-24 (revised the same day after the [design review](https://github.com/vladimino/iptv-watchlist/pull/975#pullrequestreview-6037101145))  
**Approval source:** not decided. This record was requested in the owner's handoff comment on [PR #972](https://github.com/vladimino/iptv-watchlist/pull/972#issuecomment-7127786410). That request asks for a Proposed ADR; it does not approve any option.  
**Related work:**
- [AIR-555](https://trello.com/c/JPgjoBzK) (audit and decision), under [AIR-546](https://trello.com/c/1dRSJEbp) and [AIR-275](https://trello.com/c/4x7hH0gI); related [AIR-559](https://trello.com/c/733sRAxu) and [AIR-547](https://trello.com/c/99faXisC).
- The read-only audit [`air-555-verified-films-admission-audit-2026-11-24.md`](../evidence/d1-migration/air-555-verified-films-admission-audit-2026-11-24.md) ([PR #972](https://github.com/vladimino/iptv-watchlist/pull/972)). That relative link resolves only once #972 has merged. This record uses the audit's call-site labels (W1-W6, R1-R7) and gaps (G1-G4).

**Supersedes (only on acceptance):**
- In part [ADR 0087](0087-rated-archive-film-admission.md): decision 4, the admissions object as the entry point of a verified movie, and its later metadata.
- In part [ADR 0105](0105-live-catalog-input-and-tmdb-search-admission.md): decision 5, the admission written to that object before the link.
- In part [ADR 0166](0166-diary-rated-only-identity-bridge.md): its "immutable receipt entry" step.

**Superseded by:** None

## Context

### Current architecture (main `6ca5c24`, Film/Person `d1`/`open`)

- **D1 holds the canonical admission.** `film_rated_admission` (one row per Film) is written by `admitRatedFilm` through the `rated_admission_retention` producer (`applyRatedAdmissionRetention`). Its readers are:
  - the catalog (title and year fill);
  - the identity-work inventory (ADR 0170: `admissionProof` needs an exact archive and code match);
  - the external-id producer.
- **The R2 object is a writers' coordination step.** `letterboxd/admissions/verified-films.json` is one JSON document compare-and-swapped by three writers before they call the D1 writer:
  - the inferred baseline import commit (W1 add, W2 delete of its own new entry);
  - the automatic Diary identity step inside the Ratings run (W3);
  - the owner-only rated-archive identity step (W4) and its enrichment (W5 metadata, W6 localization).

  The writers read the object back (R1-R5) and pass the **stored** entry to D1. No serving path reads it at `open`.
- **What the R2 step guarantees today.**
  - **Code-to-movie uniqueness before any link.** It is enforced with rules that differ per writer.
  - **First-admission pinning.** An existing entry is kept, so D1 always receives the first archive, title, year and `verifiedAt`. D1 alone would overwrite archive, title and year for the same code and movie given another archive (`film-admission.js:90,104`; G4).
  - **A durable proof payload between the writer's check and the D1 write.** The Diary link intent stores only the movie id. The rated `admitting` candidate stores only `intendedTmdb` and `filmPath`.
  - **A replay index** for the inferred commit. It has a defect: a replay offers an orphaned entry despite the receipt's conflict mark (G1).
- **Producer request ids are not stable today.** The request id derives from an event string that differs between the first commit (`inferred:<sha>:<lid>`) and a replay (`inferred:<sha>:<chunk>:<slice>` plus `:admission:<key>`). The content digest includes `receiptKey`, which is the R2 key constant (`canonical-rated-admission-producer.js:83`).
- **Inferred provenance.** The inferred and verified distinction lives on the Ratings fact records (`identity` or `inferredPairs`; 703 of 703 inferred admissions at the audit). ADR 0184's claim planner reads it there.
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
  - the Diary step defers the id (`reason: deferred`, no source request, no write); the rating facts are unaffected;
  - the baseline commit answers `409 admission_closed` for a chunk with any `admit` item, before its intent;
  - the rated identity and enrichment steps answer `409 admission_closed`.

  Reads are unchanged. `closed → r2` (reopen) is allowed.
- `d1`: the new path of decisions 2-6. A trigger refuses `d1 → r2`, `d1 → closed`, deleting the row and a lower generation. Every new-path batch asserts mode `d1` and the generation inside its own fenced batch.

**The sequence.** Each step from 2 onward is a separate owner-authorized operation under an L3 plan; this ADR authorizes none of them.
1. **Dormant delivery (F1).** F1 merges and auto-deploys with the marker at `r2`, so the deploy is safe whatever is in flight.
2. **Drain of old code.** Before `closed`, verify (L0) that:
   - the F1 version has served 100% of traffic for longer than the longest request and Workflow step bound;
   - no Letterboxd Sync or Ratings Workflow instance started on an older version is still running.

   From then on, every running writer reads the marker.
3. **Close.** Set `closed`, then wait for the step bound.
4. **Parity pin, under `closed`.**
   - Full row fingerprints of the R2 entries and the D1 rows, and the audit predicates P1-P7.
   - 0 open `rated_admission_retention` receipts.
   - 0 pending writer state: no chunk intent without a receipt, no `linking`/`link_failed` Diary entry, no `admitting` candidate.
   - The object's ETag is pinned.

   Any pending legacy state is either reopened and drained under `r2`, or reconciled into the new payload from the frozen object, as a documented read-only input.
5. **Activation.** Flip `closed → d1` in one fenced statement. This is the **irreversibility boundary**. It is durable and monotonic, and it precedes every incompatible effect, because at `r2` and `closed` the new code writes nothing the legacy code would not write.
6. **Natural acceptance.** The first natural Diary admission (or an owner-run archive step) produces a D1 row and no R2 change.

**Abort and rollback.**
- **Before the flip.** Abort is `closed → r2` (reopen), and a code revert is an ordinary rollback. Reopen first: code that does not read the marker would otherwise reopen the legacy writers silently.
- **After the flip.** A revert to any version that does not honour the marker is **prohibited**. Recovery is roll-forward on code that honours the marker. Restoring R2 coordination needs its own owner-approved reconciliation plan, never an implicit rebuild.
- **The row marker is not the boundary.** The `d1:` marker of decision 2 is provenance and diagnostics only. The boundary is the marker flip.

### 2. One admission record, with first admission pinned in D1

- `film_rated_admission` stays the only admission record. No new admission table (option C) and no identity column (option B′).
- **Keep-first, at mode `d1`.** For an existing row with the same movie id and code, `admitRatedFilm` and `planAdmission` answer **no-op** whatever the archive, title, year or `verifiedAt` of the new input. The `ON CONFLICT … DO UPDATE` of those columns no longer applies on the new path. This closes G4 inside the fenced batch.
- **Typed conflicts.** A row with another code for the same Film, or a code held by another Film, stays `admission_conflict`. The error carries `other_code_on_film` or `code_on_other_film`.
- **Provenance marker.** New-path rows store `receipt_key = 'd1:<kind>'`, where `<kind>` is `inferred_import`, `diary_page` or `rated_archive`. Migration 0021 allows any non-empty value, and `receipt_film_key` stays `tmdb_<n>`. Rows written before activation keep `letterboxd/admissions/verified-films.json`. The content digest uses the same value, so a new receipt is never replayable by legacy code, which never runs after the flip anyway.
- **Every consumer of `receipt_key` and the digest is reviewed in F1:**
  - `film-admission.js`: the no-op check is replaced by keep-first;
  - `canonical-rated-admission-producer.js`: `admissionContent` and the digest;
  - `canonical-catalog-reader.js`: exposed as an opaque provenance string;
  - the external-id provenance JSON written by `admitRatedFilm`: it carries the same marker;
  - `canonical-producers.js`: the shape of `receiptFilmKey` is unchanged.

### 3. Deterministic per-item outcome, from durable state

**Stable request id.** Every unit's event is `admission:<kind>:<archive or evidence digest>:<code>`, the same at the first commit, any resume and any replay. With the stable payload of decision 4, the request id is stable too. A lost response is answered by the receipt's own reconcile or readback (`applied`), never by a new request id.

**Outcome rule.** The outcome of an item is a function of durable state: the monotonic keep-first admission rows, plus whether this item's Ratings link is already committed. The same pair always ends the same way after a crash:

| D1 state seen by the preflight or the fenced batch | Inferred commit (W1) | Diary step (W3) | Rated step (W4) |
| --- | --- | --- | --- |
| No row; batch applied, or a lost response reconciled to applied | `admitted`; facts proceed | `admitted`; link proceeds | `admitted`; rating proceeds |
| Same movie and code (any archive) | `present`; facts proceed | `present`; link proceeds | `present`; rating proceeds |
| `other_code_on_film`, **whether seen before the link or only by the batch after it** | `present_other_code`: no admission, link and facts proceed (today's behaviour, now also for the concurrent case) | pending `other_code`, no link | `needs_review` `duplicate_tmdb` |
| `code_on_other_film` seen before the link | `conflict`: no link, no fact | pending `admission_conflict`, no link | `needs_review` `historical_alias_conflict` |
| `code_on_other_film` seen only by the batch after the link | `refused_after_link`: terminal; **no fact and no claim**; the inferred-marked link stays (never a claim proof, ADR 0184); an `admission_conflict` entry for owner repair | not reachable (admits before linking) | not reachable (admits before rating) |
| `admission_identity_held`, redirect (classified by `planAdmission` / `resolveAdmissionFilm`, not by a row read) | **non-terminal**: the chunk stops before its receipt; resume after the owner resolves | pending `admission_held`, retried | stays `admitting`, retried |
| Unavailable, `skipped`, `closed`, generation moved, `failed`, `unknown`, `deferred`, refused preflight | **non-terminal**: the chunk stops before its receipt; resume repeats the same request id | pending `deferred`, retried | stays `admitting`, retried |

- **Recording.** A terminal outcome is recorded per item in the chunk receipt (`admission: admitted | present | present_other_code | conflict | refused_after_link`) or in the writer's pending state.
- **Ambiguous results.** A non-terminal result is never settled terminally.
- **Replay.** A replay offers the admission again only for items recorded as `admitted` or `present`. Nothing is offered for an item merely because its receipt entry is not a conflict.
- **Refused items.** They write no fact and no claim.

### 4. Each writer persists its exact proof payload before its first effect

Each writer persists the payload `{movie id, code, archive or evidence digest, title, year, verifiedAt}` once, at mode `d1`, before its first non-atomic effect. Every retry reuses it: no new source fetch and no fresh timestamp.

| Writer | Where the payload survives | `verifiedAt` | Revalidation and abandon |
| --- | --- | --- | --- |
| Inferred commit | the create-only chunk intent, extended with the per-item payload; the request item must match it, or `chunk_conflict` | the intent's `openedAt` | none needed: the intent is immutable. A chunk committed **before activation** gets no admission on replay (its admissions are legacy and were proven present at the parity pin): facts and claims only |
| Diary step | the `linking` intent in the D1-owned `letterboxd/facts/scans/diary-identity.json`, extended with title, year, path, evidence digest and `verifiedAt` | the check time, written once | **Never evicted** by the 200-entry cap: if the cap would need it, the step starts no new source check. Abandoned without admission when the id's Ratings link names another movie or the record is gone. After six attempts it stays visible (`link_interrupted`) |
| Rated step | the `admitting` candidate row of `rated-candidates.json` (R2 archive work, ADR 0170), extended with title, year and `verifiedAt` | the time of `pending` → `admitting`, written once | Abandoned without admission when the row leaves `admitting` (removed, `needs_review`) or names another movie or path |

A source change after persistence does not change the payload: it is admitted as persisted, or refused by D1. If F1 shows that one of these documents cannot hold its payload within its contract, the design comes back to the owner as a revision of this record.

### 5. Readers and the proof contract

- **R1 to R5** read the payload of decision 4 or D1, not the object.
- **R6**, the local stand-in catalog reader (ADR 0162), may keep reading a local object. It is unreachable in production.
- **R7** (`compareAdmissions`, unused) is removed.
- **ADR 0170 inventory.**
  - The exact archive-and-code proof is kept; it is not weakened.
  - Keep-first can leave a candidate of a later archive `verified` while the D1 row names the first archive. That candidate stays `needs_owner_review` / `admission_unconfirmed`, an explicit review state. The corner case exists today too.
  - An admission is **never** proof when the row is `d1:inferred_import`, or when the Ratings record marks the pair inferred. An inferred admission is not positive Letterboxd identity proof.

### 6. Rated enrichment (G3): retired at activation, accepting thin metadata

- At mode `d1` the rated identity step ends at the verified admission and the tmdb-only rating. The enrichment continuation (W5, W6) and its candidate state are retired: nothing is written to R2 or D1. At `r2` it runs as today.
- A rated-only Film that never airs may **never** be observed by a canonical metadata producer. Retirement therefore explicitly accepts possibly indefinite thin metadata (title and year only) for such Films. At the audit no entry carried enrichment and no rated archive was in progress, so nothing is lost now.
- Routing the phase through the canonical metadata writer (G3-b) is not chosen. It needs its own ADR if wanted later.

### 7. Delivery sequencing

- **F1 is the dormant implementation (one card, one code PR).** Its merge auto-deploys, which is safe only because everything new is behind mode `d1`. It contains:
  - the marker migration file and its writers' marker checks;
  - decisions 2-6 behind mode `d1`, including the G3 retirement, which is therefore not a separate card;
  - the legacy byte-identity tests at `r2`, the refusal tests at `closed`, and regression tests for G1, G4, every row of decision 3's table, lost responses, payload persistence and eviction, abandon rules, historical replay (an old R2 `verifiedAt` versus the intent's `openedAt`, another archive, another code, an existing row and receipt digest) and the inventory proof rule;
  - source comments, maintained docs and diagrams.

  Applying the migration is part of F2, not F1.
- **F2 is the activation (one card, owner-authorized L3 plan).** It covers applying the marker migration and steps 2-5 of decision 1, with abort `closed → r2` before the flip. Natural acceptance (step 6) is its `Верификация`.

No step is authorized by this record. Each production step keeps its own gate.

## Alternatives considered

- **A. Retain the object as live R2 coordination.** Keep W1-W6, fix G1 (replay offers only items recorded as admitted), decide G3, and accept the object as an explicit mutable R2 exception in the AIR-546 ledger.
  - For: least code and no activation.
  - Against: two admission authorities in sequence, cross-store partial commits (G2) and per-writer rules. AIR-275 keeps a mutable R2 authority for admissions.
- **B′. B plus an `identity_kind` column** on `film_rated_admission`, backfilled from the frozen object.
  - For: the kind becomes queryable on every row, including the old ones.
  - Against: a second schema change and an L3 backfill for a field no reader needs. The claim planner uses the Ratings marks, and the `d1:<kind>` marker covers new rows.
- **C. A new normalized D1 table** for every R2 field.
  - For: highest fidelity.
  - Against: highest cost, most columns without a consumer, and a second admission record beside `film_rated_admission`.
- **Sub-choices inside B.**
  - **Detection-only handover** (deploy, then watch the ETag): rejected. It does not stop an old writer from coordinating in R2 while the new path admits in D1.
  - **The first `d1:` row as the rollback boundary:** rejected. New payloads, refused-after-link receipts, pending canonical receipts and the retired enrichment state can all exist before that row.
  - **Keep-first in a writer preflight instead of the batch:** rejected, because a preflight is not a transaction.
  - **Settling a concurrent `other_code_on_film` as a conflict:** rejected. The outcome would depend on timing.
  - **G3-b:** not chosen (decision 6).

## Consequences

- **One admission authority after activation.** G1, G2 and G4 are closed by the design, and G3 by decision 6. R2 keeps only historical evidence, which needs no writer.
- **New durable contracts.**
  - The one-way marker, with a small additive migration.
  - Keep-first and typed conflicts in the D1 writer at mode `d1`.
  - The `d1:<kind>` provenance in `receipt_key` and the digest.
  - Stable request ids.
  - Per-item admission outcomes in the chunk receipt.
  - Payload fields and the no-eviction rule in the Diary document.
  - Payload fields in the rated candidate row.
- **Behaviour change.**
  - Under `closed`, admissions pause: Diary ids defer, and archive and baseline admit steps answer 409.
  - After activation, rated-only Films get no metadata from the rated route.
- **Compatibility.**
  - ADR 0184: claims unchanged; the inferred negative proof is kept.
  - ADR 0170: proof rule kept; the inventory row for the object reads "historical evidence, no writer".
  - ADR 0192: no view-index dependency.
  - ADR 0162: no R2 fallback at `open`.
  - ADR 0068: chunk intents and receipts keep their create-only semantics and gain fields.
  - ADR 0194 and 0196: the marker pattern is reused, not changed.
- **Risk.** The drain verification, the eviction rule and the classification of non-terminal results are the new moving parts. All are tested in F1 and observed in F2.

## Recovery and migration boundary

- No data migration: the existing 714 rows are already the canonical admissions, and the object is frozen as read.
- One additive marker migration.
- The irreversibility boundary is the `closed → d1` flip. Before it, recovery is reopen plus an ordinary revert. After it, recovery is roll-forward only, or a separately approved reconciliation plan.
- Retention of the frozen object is indefinite. Deleting it is a later, separate owner decision.
- This ADR, even when Accepted, authorizes no deploy of an active writer, no migration apply, marker change, write, import, repair, flag, Task or cleanup.

## Evidence

- The audit ledger: [`air-555-verified-films-admission-audit-2026-11-24.md`](../evidence/d1-migration/air-555-verified-films-admission-audit-2026-11-24.md). It resolves once #972 has merged. It contains the call-path inventory, the field and transition ownership, the per-writer outcome table, G1-G4 and the runnable G1 fixture.
- The review of the audit: [PR #972 review](https://github.com/vladimino/iptv-watchlist/pull/972#pullrequestreview-6037101145).
- The design review of this record: [PR #975 review](https://github.com/vladimino/iptv-watchlist/pull/975#pullrequestreview-6037101145). Its P1 findings are what decisions 1 and 3 resolve.

## Follow-ups

**On acceptance.** Create two atomic cards and link them as bare URLs in the native Prerequisites checklist of AIR-275:
- F1, the dormant implementation, which includes the G3 retirement;
- F2, the activation, with natural acceptance as its `Верификация`.

ADR 0087, 0105 and 0166 then get "Superseded in part by ADR 0207", and the registry rows are updated.

**On rejection.** The record is kept as `Rejected` (docs-only), and the owner chooses A, B′ or C.
