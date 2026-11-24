# ADR 0206: Letterboxd Film admissions are coordinated in D1 only; `verified-films.json` is frozen as historical evidence

**Status:** Proposed (no owner decision on this record; the recommended option and every sub-choice below await review and an explicit, ADR-specific Product Owner decision)  
**Original decision date:** not decided  
**Recorded at:** 2026-11-24  
**Approval source:** not decided. This record was requested in the owner's handoff comment on [PR #972](https://github.com/vladimino/iptv-watchlist/pull/972#issuecomment-7127786410). That request asks for a Proposed ADR; it does not approve any option.  
**Related work:**
- [AIR-555](https://trello.com/c/JPgjoBzK) (audit and decision), under [AIR-546](https://trello.com/c/1dRSJEbp) and [AIR-275](https://trello.com/c/4x7hH0gI); related [AIR-559](https://trello.com/c/733sRAxu) and [AIR-547](https://trello.com/c/99faXisC).
- The read-only audit [`air-555-verified-films-admission-audit-2026-11-24.md`](../evidence/d1-migration/air-555-verified-films-admission-audit-2026-11-24.md) ([PR #972](https://github.com/vladimino/iptv-watchlist/pull/972)). This record refers to its call-site labels (W1-W6, R1-R7) and gaps (G1-G4).

**Supersedes (only on acceptance):**
- In part [ADR 0087](0087-rated-archive-film-admission.md): decision 4, the admissions object as the entry point of a verified movie, and its later metadata.
- In part [ADR 0105](0105-live-catalog-input-and-tmdb-search-admission.md): decision 5, the admission written to that object before the link.
- In part [ADR 0166](0166-diary-rated-only-identity-bridge.md): its "immutable receipt entry" step.

**Superseded by:** None

## Context

### Current architecture (main `6ca5c24`, Film/Person `d1`/`open`)

- **D1 is the canonical record.** `film_rated_admission` (one row per Film) is written by `admitRatedFilm`, called through the `rated_admission_retention` producer (`applyRatedAdmissionRetention`). It is read by:
  - the catalog (title and year fill);
  - the identity-work inventory (ADR 0170);
  - the external-id producer.
- **The R2 object is a writers' coordination step.** `letterboxd/admissions/verified-films.json` is one JSON document compare-and-swapped by three writers before they call the D1 writer:
  - the inferred baseline import commit (W1 add, W2 delete of its own new entry);
  - the automatic Diary identity step (W3);
  - the owner-only rated-archive identity step (W4) and its enrichment (W5 metadata, W6 localization).

  The writers read the object back (R1-R5) and pass the **stored** entry to D1. No serving path reads it at `open`.
- **What the R2 step guarantees today.**
  - **Code-to-movie uniqueness before any link.** It is enforced with rules that differ per writer.
  - **First-admission pinning.** An existing entry is kept, so D1 always receives the first archive, title, year and `verifiedAt`. D1 alone would overwrite archive, title and year for the same code and movie given another archive (`film-admission.js:90,104`; G4).
  - **A durable proof payload between the writer's check and the D1 write.** The Diary link intent stores only the movie id. The rated `admitting` candidate stores only `intendedTmdb` and `filmPath`.
  - **A replay index** for the inferred commit. It has a defect: a replay offers an orphaned entry despite the receipt's conflict mark (G1).
- **Inferred provenance.** The inferred and verified distinction lives on the Ratings fact records (`identity` or `inferredPairs`; 703 of 703 inferred admissions at the audit). ADR 0184's claim planner reads it there. The R2 `identity` field is no longer the only witness.
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

**Option B: D1 is the only admission coordinator.** The R2 object is frozen and retained read-only as historical evidence. No writer writes it after the switch. No serving or writer path reads it, except the explicit local stand-in reader of ADR 0162 and a documented, read-only reconciliation input during the handover (decision 7).

The target below is not implemented. Nothing here is delivered, deployed or activated.

### 1. One admission record, with first admission pinned in D1

- `film_rated_admission` stays the only admission record. No new table (option C) and no schema migration (option B′ is not chosen).
- **Keep-first.** For an existing row with the same movie id and code, `admitRatedFilm` and `planAdmission` answer **no-op** whatever the archive, title, year or `verifiedAt` of the new input. The `ON CONFLICT … DO UPDATE` of archive, title and year is removed. This closes G4 inside the fenced batch, not in a writer preflight.
- A row with another code for the same Film, or a code held by another Film, stays `admission_conflict`. The error carries which of the two it was (`code_on_other_film`, `other_code_on_film`), so writers can map it.
- **Provenance marker on new rows.** A row written after the switch stores `receipt_key = 'd1:<kind>'`, where `<kind>` is `inferred_import`, `diary_page` or `rated_archive`. Rows written before the switch keep `letterboxd/admissions/verified-films.json`. Effects:
  - The point of no return (decision 7) is observable: `SELECT COUNT(*) FROM film_rated_admission WHERE receipt_key LIKE 'd1:%'`.
  - New rows carry their admission kind without a schema change.
  - It is provenance only, never identity proof. The claim planner keeps reading the Ratings marks (ADR 0184).
  - `receipt_film_key` stays `tmdb_<n>`.

### 2. Per-writer outcomes are preserved

| Existing state | Inferred commit (W1) | Diary step (W3) | Rated step (W4) |
| --- | --- | --- | --- |
| Code held by another Film | Refused **before the Ratings link**; item recorded as conflict, no link, no fact (as today) | Pending `admission_conflict`, no link (as today) | `needs_review` `historical_alias_conflict` (as today) |
| Same movie, another code | **No admission; link and facts proceed** (as today) | Pending `other_code`, no link (as today) | `needs_review` `duplicate_tmdb` (as today) |
| Same movie and code, any archive | No-op; link and facts proceed | No-op; link proceeds | No-op; rating proceeds |
| No row | Admit (see 3) | Admit, then link | Admit, then rating |

- **The preflight read.** Each writer classifies the existing state with one D1 read of `film_rated_admission` (by movie id and by code) before its first effect. The read replaces the R2 checks R4 and W1-W4.
- **The fenced batch decides.** The preflight is not a reservation. The batch of decision 1 re-asserts the state, so the final answer comes from the batch.

### 3. A conflict after the Ratings link is settled durably, fail closed

Only the inferred commit links before it admits (the Diary and rated steps admit first and link or rate afterwards, as today). Its order becomes:
1. Preflight (decision 2).
2. Mark the inferred pair.
3. Link.
4. Admit in D1.
5. Facts.
6. Receipt.

There is no pre-link write, so nothing has to be withdrawn: W2 and G1 disappear. If the D1 admission is refused after the link committed (a concurrent writer, or a `held` identity):
- **First attempt.** The chunk stops before its receipt, as today. Nothing is retried blindly.
- **Re-commit.** The preflight now reports the conflict for an already-linked pair. The item is recorded in the receipt as `conflict: true` with `admission: refused` and the error class, and the chunk completes. The Ratings link stays. It is marked inferred, so it is never a claim proof (ADR 0184 negative proof). An `admission_conflict` entry is noted in the Ratings conflict list for owner review.
- **Correction.** Nothing unlinks or deletes a Film automatically. Correction stays the existing case-by-case owner repair (ADR 0192).

### 4. Each writer persists its exact proof payload before its first effect

The D1 content digest covers movie id, code, archive or evidence digest, title, year and `verifiedAt`. Each writer persists that payload once, before its first non-atomic effect. Every retry reuses it: no new source fetch and no fresh timestamp.

| Writer | Where the payload survives | `verifiedAt` |
| --- | --- | --- |
| Inferred commit | the request item (movie id, code, `admit` title and year, fixed by `itemsHash`) and the origin archive; replay uses the receipt entry | the create-only chunk intent's `openedAt`; for a receipt without an intent object, the receipt's `committedAt` |
| Diary step | the `linking` intent in the D1-owned `letterboxd/facts/scans/diary-identity.json`, extended with title, year, path, evidence digest and `verifiedAt` | the check time, written into the intent once |
| Rated step | the `admitting` candidate row of `rated-candidates.json` (R2 archive work, ADR 0170), extended with title, year and `verifiedAt` | the time of the `pending` → `admitting` transition, written once |

Rules:
- **No eviction of an unconfirmed payload.** A Diary entry that holds one (`linking`, `link_failed`) is never evicted by the 200-entry cap. If the cap would need it, the step starts no new source check instead.
- **A source change after persistence does not change the payload.** The payload is admitted as persisted, or refused by D1.
- **Lost responses.** A lost response is answered by replaying the same payload; the digest is identical, so the receipted write deduplicates.
- **Replay.** A replay of a committed inferred chunk offers only receipt entries that are not conflicts, with the payload above.
- **Fallback.** If F1 shows that one of these documents cannot hold its payload within its existing contract, that writer falls back to a schema change, which comes back to the owner as a revision of this record.

### 5. Rated enrichment (G3): retired, not redirected

- The rated identity step ends at the verified admission and the tmdb-only rating. The enrichment continuation (W5, W6) and its `enrichment` candidate state are retired in the same change. It writes nothing to R2 and nothing to D1.
- Metadata and localization of a rated-only Film come from the existing canonical metadata producers, when a producer observes the Film.
- At the audit no entry carried enrichment and no rated archive was in progress, so nothing is lost.
- Routing the phase through the canonical metadata writer (G3-b) is not chosen. It needs its own ADR if wanted later.

### 6. Readers

- R1 to R5 read the payload of decision 4 or D1, not the object.
- R6, the local stand-in catalog reader (ADR 0162), may keep reading a local object. It is unreachable in production.
- R7 (`compareAdmissions`, unused) is removed with F1.

### 7. Handover fence and rollback boundary

1. **Parity gate before the deploy (F2).** Under a quiet window (no Letterboxd Sync or Ratings run in flight and no owner archive step, verified from run state), an L0 readback compares:
   - the full row fingerprints of the R2 entries and the D1 rows;
   - the audit predicates P1-P7;
   - 0 open `rated_admission_retention` receipts;
   - 0 pending writer state (chunk intent without receipt, `linking` or `link_failed` Diary entry, `admitting` candidate).

   Any old-code pending state is either drained first or reconciled from the frozen object, as a documented read-only input, into the new payload.
2. **Deploy and ETag pin.** Deploy F1 inside that window and pin the object's ETag.
3. **Late-write detection.** An already running old-code request or Workflow step may still CAS the object after the deploy. The object is re-read after the longest step bound and after the next natural Sync slot. A changed ETag stops the handover, and the late entry is reconciled through the new writer path (roll-forward), with an owner report.
4. **Rollback before the point of no return.** The point of no return is the first row with `receipt_key LIKE 'd1:%'`. Before it, a code revert is an ordinary rollback: the object is still complete. Verify the ETag before reverting.
5. **Recovery after it is roll-forward only.**
   - A routine code revert is **prohibited**. The frozen object lacks the new admission, so the old writers would consult an incomplete uniqueness, replay and enrichment index.
   - Restoring R2 coordination needs its own owner-approved reconciliation plan (rebuild the R2 entries from D1 under a fence). It is never an implicit rebuild.

### 8. Sequencing

- **F1 is offline: code, tests, docs and this ADR's acceptance.**
  - Decisions 1-6, with regression tests for G1 and G4, the outcome table, the settlement of decision 3, the payload and eviction rules, and historical replay:
    - an old R2 `verifiedAt` versus the intent's `openedAt`;
    - another archive;
    - another code;
    - an existing row and receipt digest.
  - Plus source comments, maintained docs and diagrams.
- **F2 is the handover of decision 7.** It is the `Верификация` stage of F1, or a separate card.
- **F3, the retirement of decision 5,** lands in F1 itself, not after it.

No step is authorized by this record. Each production step keeps its own gate.

## Alternatives considered

- **A. Retain the object as live R2 coordination.** Keep W1-W6, fix G1 (replay offers only non-conflict receipt entries), decide G3, and accept the object as an explicit mutable R2 exception in the AIR-546 ledger.
  - For: least code. Pinning keeps working where it works today.
  - Against: two admission authorities in sequence, cross-store partial commits (G2), per-writer rules, and AIR-275 keeps a mutable R2 authority for admissions.
- **B′. B plus an additive `identity_kind` column** on `film_rated_admission`, backfilled from the frozen object.
  - For: the kind becomes queryable on every row, including the 714 old ones.
  - Against: a schema migration and an L3 backfill for a field no reader needs. The claim planner uses the Ratings marks, and decision 1's `receipt_key` marker covers new rows.
- **C. A new normalized D1 table** for every R2 field (kind, path, evidence, enrichment).
  - For: highest fidelity.
  - Against: highest cost, most columns without a consumer, and a second admission record beside `film_rated_admission`.
- **Sub-choices inside B.**
  - Keep-first in a writer preflight instead of the batch: rejected, because a preflight is not a transaction.
  - No `receipt_key` marker: rejected, because the point of no return would not be observable.
  - G3-b, enrichment through the canonical metadata writer: not chosen here; see decision 5.

## Consequences

- One admission authority. G1, G2 and G4 are closed by the design and G3 by decision 5. R2 keeps only historical evidence, which needs no writer.
- **D1 contract changes.** `admitRatedFilm` and `planAdmission` become keep-first: archive, title and year of an admitted pair never change. `receipt_key` gains the `d1:<kind>` values. Readers of `receipt_key` (the catalog reader exposes it) treat it as an opaque provenance string.
- **Document contract changes.** The Diary pending document and the rated candidate document gain payload fields. Their bounds and the eviction rule change as stated in decision 4.
- **Behaviour change in rated-only Films.** A rated-only Film no longer gets synopsis and credits from the rated identity route. They arrive only through the canonical producers.
- **Compatibility.**
  - ADR 0184: claims unchanged; the inferred negative proof is kept (decision 3).
  - ADR 0170: candidate and registry documents stay R2 archive work; the inventory row for the object reads "historical evidence, no writer".
  - ADR 0192: no view-index dependency.
  - ADR 0162: no R2 fallback at `open`.
  - ADR 0068: chunk intents and receipts unchanged; the receipt entry gains the `admission` outcome.
- **Risk.** The handover window and the eviction rule are the new moving parts. Both are tested in F1 and observed in F2.

## Recovery and migration boundary

- No data migration: the existing 714 rows are already the canonical admissions, and the object is frozen as read.
- Rollback is the boundary of decision 7: an ordinary revert before the first `d1:` row; after it, roll-forward only, or a separately approved reconciliation plan.
- Retention of the frozen object is indefinite. Deleting it is a later, separate owner decision.
- This ADR, even when Accepted, authorizes no deploy, write, import, repair, flag, Task, migration or cleanup.

## Evidence

- The audit ledger: [`air-555-verified-films-admission-audit-2026-11-24.md`](../evidence/d1-migration/air-555-verified-films-admission-audit-2026-11-24.md). It contains the call-path inventory, the field and transition ownership, the per-writer outcome table, G1-G4, and the runnable G1 fixture.
- The independent review of that audit: [PR #972 review](https://github.com/vladimino/iptv-watchlist/pull/972#pullrequestreview-6036874290). Its P1 findings are what decisions 2-4 and 7 resolve.

## Follow-ups

On acceptance: F1, F2 and F3 as atomic cards, linked as bare URLs in the native Prerequisites checklist of AIR-275. ADR 0087, 0105 and 0166 get "Superseded in part by ADR 0206", and the registry rows are updated. On rejection: the record is kept as `Rejected` (docs-only), and the owner chooses A, B′ or C.
