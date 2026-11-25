# ADR 0222: The mutable Letterboxd import coordination documents (rated candidates, inferred chunk intent and receipts) move into the D1 Ratings document store, so a terminal disposition commits atomically with the operation-history assertion

**Status:** Accepted  
**Original decision date:** 2026-11-26 (Europe/Madrid)  
**Recorded at:** 2026-11-26  
**Approval source:** [Product Owner decision of 26 Nov 2026 on PR #1018](https://github.com/vladimino/iptv-watchlist/pull/1018#issuecomment-7177238271): option B (move both R2 terminal-writer documents into D1) selected over option A (keyed D1 terminal-disposition receipt plus an idempotent R2 projection) and option C (repair on read). This is architecture approval only, not a review PASS, not a final technical acceptance and not a production GO.  
**Related work:** [AIR-602](https://trello.com/c/7W5kAMK9) (card A1), [PR #1018](https://github.com/vladimino/iptv-watchlist/pull/1018); delivery cards [AIR-603](https://trello.com/c/wc7pHJTB) (M1, the cumulative migration window) and [AIR-608](https://trello.com/c/MSlOAAGR) (A2, the first `d1` activation) of the [ADR 0207](0207-letterboxd-admissions-coordinated-in-d1-only.md) delivery graph  
**Supersedes:** None. It **amends** [ADR 0207](0207-letterboxd-admissions-coordinated-in-d1-only.md) decisions 1, 3, 4 and 7 (see «Decision» for the exact clauses) and the document-key list of the Ratings ownership contract in [ADR 0084](0084-d1-authoritative-ratings.md) decision 1, as extended by [ADR 0221](0221-shared-letterboxd-check-state-in-one-document.md). Historical text of those records is preserved.  
**Superseded by:** None

## Context

ADR 0207 makes D1 the only admission coordinator at marker `letterboxd_admission_authority = d1` and freezes `letterboxd/admissions/verified-films.json`. Its delivery graph (decision 7) assumed that the remaining mutable R2 state of the two callers was *derived* or *evidence*. The independent reviews of PR #1018 found two R2 documents that are neither:

| Document | Writers | Why it is coordination, not evidence |
| --- | --- | --- |
| `letterboxd/imports/<archiveSha256>/rated-candidates.json` | the rated identity step (`letterboxd-rated-candidates.js`: claim, `admitting`, `verified`, `needs_review`, checkpoint, replay), the archive apply (`registerCandidates`) | The `admitting`/`pendingEvidence` rows are the durable record of an in-flight admission, and `verified` is its terminal disposition. A rated candidate's recovery reads them. |
| `letterboxd/imports/<sha>/chunks/<chunk>.intent.json`, `.receipt.json` | the inferred baseline chunk (`commitBaselineChunk`, `letterboxd-facts.js`), the owner archive apply | `intent` is the durable plan of a chunk, `receipt` its terminal result; replay decides from them. |

An R2 write cannot carry an assertion on a D1 table, so with these documents in R2 the terminal disposition and the operation-history assertion (ADR 0207 decision 3, ADR 0217) cannot commit together. PR #1018 re-checks the history guard immediately before the R2 write, which leaves a window. Options A (a D1 terminal receipt with an R2 projection) and C (repair on read) keep a mutable R2 authority or a second record. The owner chose to move the data now, as part of migrating everything that belongs in D1.

## Decision

1. **After the cutover there is one authority for these documents: the D1 Ratings document store** (`ratings_document`, ADR 0084 decision 1, the same store and the same compare-and-swap that ADR 0221 already uses for the shared check state). No R2 projection, no R2 read as authority and no R2 fallback after activation. The documents are moved, not duplicated.
2. **Families moved** (the exact inventory; the reference documents carry the full table):
   - `letterboxd/imports/<archiveSha256>/rated-candidates.json` (one document per archive);
   - `letterboxd/imports/<archiveSha256>/chunks/<chunk>.intent.json` and `.receipt.json` (inferred baseline chunk);
   - `letterboxd/imports/<archiveSha256>/chunks/<chunk>.candidates.json` (the write-once terminal result of an archive-apply candidates chunk: it is read by replay to decide, so it is a durable terminal result, not raw evidence).
3. **Not moved.** Raw archive evidence stays in R2 and is not coordination state: the ZIP bytes, the HTML snapshots, the archive receipts of the import and the Preview objects. The owner-action issuance records under `admin/actions/letterboxd_archive_apply/v1/` and `admin/actions/letterboxd_identity_retry/v1/` are the owner-action idempotency ledger of the admin API, not admission coordination, and stay as they are. **`letterboxd/imports/registry.json` is a droppable projection** of the candidate documents (ADR 0170). At the cutover it is neither written nor read as authority: its readers (the identity-work inventory, the archive status) list and read the D1 documents instead. It is retained, frozen, as historical evidence.
4. **Atomic terminal disposition.** At marker `d1`, a document write that is a terminal disposition (a candidate `verified` or `needs_review` row, a chunk `receipt`, a `candidates` chunk result) is one fenced D1 batch that also carries (a) the operation-history assertion of the key it settles (ADR 0207 decision 3, ADR 0217 key `admission:lid:<lid>`), (b) the `letterboxd_admission_authority` assertion at `d1` and (c) the document's compare-and-swap on its etag (the `extra` statements of `casOwned`). A stale or moved history refuses the batch with the data; the writer replans from the reconciled state (ADR 0207 decision 3). The batch is the only commit; there is no re-check followed by a separate write.
5. **Preceding irreversible effects stay fenced by the accepted outcome table** (ADR 0207 decision 4): a link or fact effect that precedes the terminal document write is reserved, guarded and reconciled exactly as before; only the terminal record moves.
6. **Preserved unchanged:** the source intent and evidence obligations (`evidenceDue`, `pendingEvidence`), the history-key semantics of ADR 0217, exact replay, no false admission and no proof snapshot. The earlier decisions about proof snapshots and evidence readers (ADR 0213 decision 8, ADR 0215) are not changed.
7. **Dormancy.** At marker `r2` or with no marker the code is byte-identical to today: the documents stay in R2 and the routing is chosen only by the marker read at the write. The document keys are **not** added to the general `ratingsMutableKey` list; they are reachable only through an explicit admission-document option that is honoured only at marker `d1`, so no existing Ratings reader or writer changes its route.
8. **Import and cutover are offline and owner-gated.** The delivery adds an offline-tested import/parity/cutover mechanism (idempotent import of the inventoried keys, missing versus empty state, a manifest the `d1` reader requires so that an absent or partial import fails closed, bounded snapshot consistency, safe rollback before the flip and roll-forward after it). No additional table is needed (`ratings_document` exists), so M1 ([AIR-603](https://trello.com/c/wc7pHJTB)) gains no file unless review proves otherwise. The data copy, quiescence, parity, the authority change and the drain of the old writers are added to A2 ([AIR-608](https://trello.com/c/MSlOAAGR)) before the first `d1` activation. This record does not create a separate projection or cutover card.

### Exact prior clauses affected

| Prior record | Clause | Effect |
| --- | --- | --- |
| [ADR 0207](0207-letterboxd-admissions-coordinated-in-d1-only.md) decision 1 | Handover and the irreversibility boundary: «R2 coordination ends only at the A2 flip» | The R2 coordination that ends at the flip now includes these documents; their import, parity pin and old-writer drain join the parity steps 3-5. |
| ADR 0207 decision 3 | The operation-key protocol: «Reserve, or finalize, atomically against the observed history» | For the two callers the terminal document write is itself the atomic finalize (decision 4 above). |
| ADR 0207 decision 4 | Reacquire the source; the outcome table | The table is unchanged; only where the terminal record lives changes. |
| ADR 0207 decision 7 | Delivery graph: «A1 … dormant», «No dual writer at any point» | A1 delivers the adapters and the offline mechanism dormant; A2 performs the data movement. No dual writer is introduced. |
| [ADR 0084](0084-d1-authoritative-ratings.md) decision 1 (and ADR 0221) | The list of mutable documents the Ratings store owns | Gains the three families above, only under marker `d1` of `letterboxd_admission_authority`. |

## Alternatives considered

- **A. A keyed D1 terminal-disposition receipt plus an idempotent R2 projection.** Not selected by the owner: it keeps a live R2 projection and a second record of the same disposition.
- **C. Repair on read** (an ADR amendment). Not selected: it accepts a window and moves the repair to every reader.
- **Keep the history re-check before the R2 write (PR #1018 as reviewed).** Rejected as incomplete: it leaves a window the owner did not accept.

## Consequences

One authority and real atomicity for the terminal disposition; the registry projection stops being a live writer at the cutover. Cost: the document adapters, a bounded size check (a document that no longer fits the Ratings document bytes budget fails closed), an import mechanism with parity, readers changed to D1, and larger A2 and tests. Compatibility: nothing changes at `r2`.

## Recovery and migration boundary

Nothing here authorizes a production copy, an apply, a marker flip, a source fetch, a Scheduled Task, a flag or an Access change. Before the flip the import is repeatable and the R2 objects stay authoritative (rollback = discard the D1 copies). After the flip recovery is roll-forward on code that honours the marker; restoring R2 coordination needs its own owner-approved fenced procedure.

## Evidence

- **Original decision:** [owner decision on PR #1018](https://github.com/vladimino/iptv-watchlist/pull/1018#issuecomment-7177238271).
- **Implementation:** [PR #1018](https://github.com/vladimino/iptv-watchlist/pull/1018).
- **Dated verification:** not recorded.
- **Uncertainty:** the exact byte bounds of the rated-candidates document in the Ratings store, and any additional reader found during implementation, are settled in the implementation and recorded in the reference documents.

## Follow-ups

[AIR-603](https://trello.com/c/wc7pHJTB) (M1) and [AIR-608](https://trello.com/c/MSlOAAGR) (A2) carry the schema window and the data movement.
