# AIR-608 (A2): reviewable cutover operator, L3 plan proposal and dated L0 preflight (28 Nov 2026)

This page records the **offline** deliverable of card [AIR-608](https://trello.com/c/MSlOAAGR) and dated, side-effect-free L0 reads. It is **not** a production GO and records nothing executed against production except the reads below. Times are UTC (Europe/Madrid is UTC+1). It describes what was true when read; the present state is always read live. Revision 3 (after the second owner review of [PR #1082](https://github.com/vladimino/iptv-watchlist/pull/1082), residual cutover correctness) replaces revisions 1 and 2.

## Native prerequisites (all current links; C2 operational qualification)

[AIR-603 M1](https://trello.com/c/wc7pHJTB) (window applied, schema 55), [AIR-602 A1](https://trello.com/c/7W5kAMK9), [AIR-643 ADR 0217](https://trello.com/c/e1Q9H1bG), [AIR-672 common key](https://trello.com/c/ZRJlafiP) (Done), [AIR-679](https://trello.com/c/X880EsWK) (rejected, not in the plan), [AIR-555](https://trello.com/c/JPgjoBzK) and [AIR-275](https://trello.com/c/4x7hH0gI) (audit and stream), and C2 [AIR-607](https://trello.com/c/Daq02gYy): **operationally active** (control `active`, rated scope done, cutoff `2026-11-28T04:00:00.000Z`), its native item intentionally **incomplete** until natural A2 traffic. That does not block A2 preparation or an owner-approved A2; it does not replace the C2 gate the flip enforces (below). No LID-only or attach activation (H1 real capture NO-GO, `H1_RULES` empty).

## What is delivered

- `scripts/letterboxd-admission-cutover-production.mjs`: the owner-only operator. It wraps the delivered A1 mechanism ([`src/letterboxd-admission-documents-import.js`](../../../src/letterboxd-admission-documents-import.js), [ADR 0222](../../adr/0222-letterboxd-import-coordination-documents-in-d1.md)) and marker `letterboxd_admission_authority` (migration 0046) and adds the gates the accepted ADRs require that the importer does not own. Default is read-only `status`. Imported by no Worker module, run by no deploy or Task.
- `scripts/letterboxd-admission-freeze-audit.mjs`: the **original admission freeze gate** of ADR 0207 decision 1 (AIR-555 predicates).
- Small supporting changes: `scripts/r2-s3-store.mjs` gains `listPage` (one page per call, for a bounded listing); `src/letterboxd-admission-documents.js` gains the read-only export `validateStoredManifest` (the production reader's own manifest contract, used by the operator, no behaviour change at any marker).
- `tests/letterboxd-admission-cutover-operator.mjs` (core suite).

## Review blockers and how each is closed

| Review | What the operator does |
| --- | --- |
| **P1-A** original admission freeze | Reads `letterboxd/admissions/verified-films.json` (HEAD, GET, then the rows and facts, then a FINAL HEAD as the last step of the audit; the S3 `content-length` is compared with the bytes read) and the D1 admission rows, and checks AIR-555 P1 kind (an unknown non-absent identity is **refused**, never read as rated), P2 `verifiedAdmission`, P3 agree/R2-only/D1-only/mismatch, P4 link and P5 inferred mark (the facts are read in 40-key batches, not one request per record), P7 Film health. P6 is **not** required. The **admission pin** covers the ETag, the size, both fingerprints and a digest of everything the flip fences (below); it is required at `close`, `import` and `flip`. Before the flip the moved cohort and the admissions object/registry are re-pinned as the **last reads** before the batch. The object is never migrated. |
| **P1-B** Diary queue and receipts | Reads `letterboxd/facts/scans/diary-identity.json` (ADR 0221): link intents and unresolved `reservation` entries are a NO-GO; an absent document is an empty queue; malformed or unreadable state fails closed. The queue's **version (or its absence) is fenced in the flip batch**. Unresolved canonical receipts are `pending`, **`failed` and `unknown`** (migration 0019, ADR 0207/0039), the same predicate in status, import, flip and the batch. An expired source-check reservation inside the queue is counted separately from a canonical operation-key receipt. |
| **P1-C** C2 is activation | Unchanged and accepted: control **active**, exactly the rated scope enabled/activated with a done bootstrap, cutoff not later than the flip, pinned control and scope revisions asserted in the batch; Film/Person and Ratings open (an unrelated Ratings generation bump is allowed). |
| **P1-D** manifest, rollback, reopen, result | The stored manifest must equal the approved one and satisfy the production reader (`validateStoredManifest`); `--parity` reports that verdict and is an unambiguous go/no-go (exit 3 on any blocker, mismatch or manifest problem). Every batch of a helper (import, rollback) starts with the guard-row existence check and the marker assertion at the pinned generation. The **reopen batch asserts that no moved document exists**, so a competing import in the same closed generation refuses it. The irreversible flip reports its postconditions field by field: a failed or unproven one is an explicit **committed-but-unverified STOP** (`committed_unverified`: marker, generation, `activated_at`, per-field evidence, `retry: false`, no rollback). A D1 moved document that differs from the frozen R2 copy after the flip is natural D1 traffic and is reported as *not proven*; an R2 drift, a moved admissions object or registry is a *freeze violation*. |
| **P1-E** transport | Accepted: strict reads with `retries: 0`, one page per S3 listing call with fail-closed continuation checks, bytes pin, mocked REST/S3 transports. |

## What is fenced in the flip batch and what stays observational

**Fenced atomically in the one D1 batch** (a false predicate rolls the whole batch back): the guard row `ratings_domain_cas` exists; the marker is `closed` at the pinned generation; the exact admission rows (film id, movie id, source code, archive digest, receipt film key, receipt key, verification time, year) and their count; the P7 health of every row (Film, redirect state, tmdb external-id rows) as one count over the same predicate; the versions (ETag, or absence) of the link index, every fact record P4/P5 read and the Diary check queue; the exact set of moved documents under `letterboxd/imports/` (every key, ETag and part count, nothing more); no unresolved receipt (`pending`, `failed`, `unknown`); the C2 control (`active`, pinned revision) and the rated scope (exact, pinned revision, bootstrap done, pinned cutoff, the only scope); Film/Person and Ratings authorities open; and the marker update itself changing exactly one row. Unrelated metadata updates the audit does not read (a title, an untouched timestamp) are deliberately **not** fenced.

**Observational, not atomic** (R2 and D1 have no shared transaction): the R2 objects. The admissions object and the registry are re-read (HEAD, size) as the last reads before the batch, and the moved cohort is re-listed and re-digested; a change after those reads and before the batch is excluded only by the **proven drain** and by the marker guard every writer reads immediately before its R2 PUT. This is a residual risk the owner accepts at the flip gate; the operator does not claim an atomic R2/D1 snapshot.

## The operator commands

| Command | Writes | Pins | What it does |
| --- | --- | --- | --- |
| `--status` | none | none | bytes digest, schema, marker, authorities, the freeze audit (ETag, size, fingerprints, P1-P5, P7, **admission pin**), the Diary queue, C2 problems and revisions, pending facts, the frozen cohort (**manifest digest**), D1 copies, blockers |
| `--parity` | none | none | `status` plus `verifyParity` (R2 snapshot vs D1 byte for byte) and the exact stored-manifest verdict; exit 3 `no_go` with the report on any blocker, mismatch or manifest problem |
| `--close` | marker row | generation, admission pin, bytes | `r2 G -> closed G+1`; freeze clean and equal to the pin |
| `--import` | D1 documents + manifest (last) | generation, manifest, admission pin, bytes | NO-GO unless every blocker is clear; pinned batches; exact manifest and parity read back |
| `--flip` | marker row | generation, manifest, admission pin, bytes, control revision, scope revision | rechecks everything, then **one** fenced batch (guard row, closed at G, admission D1 side, document fence, no pending receipt, C2 control and scope, authorities open), `closed G -> d1 G+1` with `activated_at`. **Irreversible** |
| `--reopen` | marker row | generation, bytes | `closed G -> r2 G+1`, only with no D1 copy left, and the batch itself asserts the absence of every moved document |
| `--rollback-import` | D1 copies + manifest | generation, bytes | before the flip only; verified by what remains |

## L0 reads of 28 Nov 2026 (read-only)

Cloudflare D1 `SELECT`s and the IPTV MCP `feature_flags` at 10:20-10:24 UTC (revision 1), and the corrected reads at 11:2x UTC (revision 2):

| Fact | Read |
| --- | --- |
| Schema | `schema_contract.version` **55** |
| Admission marker | mode **`r2`**, generation **0**, `activated_at` NULL |
| Ratings authority | `d1`/`open`, generation 4756 |
| Film/Person authority | `d1`/`open`, generation 2 |
| **Admission rows (D1)** | **735** `film_rated_admission` rows, newest `updated_at` `2026-11-28T09:34:21.696Z`. Admissions are still being written naturally, which is why the freeze pin must be taken after the drain and rechecked at every holdpoint |
| **Diary check queue** (`letterboxd/facts/scans/diary-identity.json`) | one part, **127 bytes**; **no** `linking`, `link_failed`, `lid_only_intent` or `reservation` marker in it. The revision-1 observation of `letterboxd/diary/state.json` was the wrong document and is withdrawn |
| Open `rated_admission_retention` receipts | **0** (`pending`, `failed`, `unknown`); all 1,228 `rated_admission_retention` and 30 `letterboxd_claim` receipts are `applied` |
| Keyed history (common key `admission:lid:<lid>`, AIR-672) | **no** receipt carries an `operation_key` (all NULL) and none starts with `admission:`: no keyed or old-key reservation or history exists before the flip. The single key derivation is `admissionOperationKey` in `src/letterboxd-admission-d1.js` (`admission:lid:<lid>`), reserved before the first effect by the facts writer (`src/letterboxd-facts.js`) and written by `src/film-admission.js`; AIR-679 stays rejected and LID-only/attach is not activated |
| C2 | control `active` (generation 1, revision 2); rated scope enabled and activated, cutoff `2026-11-28T04:00:00.000Z`, bootstrap `done`, revision 1; that is the only scope |
| Moved documents already in D1 | **0** rows under `letterboxd/imports/` |
| Deployment | Worker `iptv`, one version `4a900de1-b4b1-466a-9dc2-345b1948cd65` at **100%** since 11:03:28 UTC (previous deployments 10:30:26 and 10:13:55, each 100%): no gradual split is in progress now |
| Feature flags | the 25 registered flags read; none relevant to admission is set |
| `H1_RULES` | empty in the code of this checkout |

(The control and scope revisions printed here are the values read in D1: control revision 2, scope revision 1. The values to pin come from `--status` immediately before the flip.)

**Not yet read** (each needs only the scoped approvals below): the R2 listing of `letterboxd/imports/`, the R2 admissions object ETag/size and fingerprints, invocation logs per version and the Letterboxd/Ratings/Workflow leases.

## Proposed scoped read approval (the broader R2 inventory stays separately scoped until approved)

One run of `--status` with the R2 read credential, which reads exactly: HEAD, GET, HEAD of `letterboxd/admissions/verified-films.json`; HEAD of `letterboxd/imports/registry.json`; one paged `list` of the prefix `letterboxd/imports/` and a `get` of the moved families only (rated-candidates, chunk intent/receipt/candidates). It performs no write, and prints counts, reasons, digests and ETags only. Plus, as standing read-only L0: D1 `SELECT`s of the operator's state reads, Workers deployment/version metadata, Workers invocation logs by version and the Workflow instance and lease state.

## Proposed authorization (two owner decisions, not three serial messages)

The moved-cohort manifest digest cannot be known before the drain (quiesce only exists under `closed`), but routine holdpoints do not need a message each if the owner approves one exact plan. The owner keeps the two decisions that are not routine: residual-risk acceptance and the irreversible flip.

1. **Plan approval (one L3 decision)** covering, on one pinned `main` commit and bytes digest: `close` (admission pin from a fresh `--status` after the drain evidence), the post-close read-only `--status`, and `import` **conditional on the automated stop conditions all being clear**: no blocker, the same manifest digest on two consecutive `--status` reads, exact stored manifest and equal parity after the import. Any other result is a NO-GO and a STOP (reopen under the plan if the owner so decides). The residual risk named above (the non-atomic R2/D1 gap) is accepted for a clean state only.
2. **Flip GO (the owner's separate irreversible decision)** with the pins read from `--parity` (manifest digest, admission pin, bytes digest) and from `--status` (C2 control and scope revisions), the generation, and the outcome of the plan stage. One fenced batch, an independent readback, then roll-forward only. After the flip: the evidence PR and Верификация until natural acceptance.

Drain evidence (before step 1, Coordinator/owner, not an elapsed timeout): the deployed version split (one version at 100% now), no older invocation still running, no in-flight owner archive/baseline/rated identity/enrichment/replay request (telemetry, else an owner attestation), no active Letterboxd/Ratings/Workflow lease.

**Rollback:** before the flip only: `--rollback-import` (verified by D1 contents) then `--reopen` (R2 never changed). After the flip: roll-forward on code that honours the marker; restoring R2 coordination needs its own owner-approved fenced procedure.

**Proposed wording.** Plan: «GO plan A2 (AIR-608) on `main` `<sha>`, bytes digest `<sha256>`: close at generation `<G>` with admission pin `<sha256>`, then import of the clean frozen cohort under the stop conditions above; stop and read back on any unexpected result, no retry, no repair; residual R2/D1 gap accepted for a clean state.» Flip: «GO flip A2 (AIR-608): `--flip` at generation `<G>` with manifest `<sha256>`, admission pin `<sha256>`, bytes `<sha256>`, control revision `<r>`, scope revision `<r>`.» Nothing here is approved.

## Known limits

- Offline proof only: the operator never ran against production. The REST and S3 transports are exercised by mocks of their response shapes, not against the real services.
- The bytes pin covers the 15 first-party files the operator executes; the Node runtime and `node:` built-ins are outside it, so the exact clean commit is part of the GO.
- The R2 side of the freeze is observational (see "What is fenced"): a PUT after the last R2 read and before the flip batch is excluded by the drain and, from the close onward, by the marker guard that every writer reads immediately before its R2 PUT (ADR 0207 decision 1). The D1 side is fenced inside the batch.
- Whether the live R2 cohort is clean is **unknown** until the scoped `--status` read. Admissions are written naturally (735 rows now versus 714 on 24 Nov), so a stale pin is expected and a new one is taken after the drain.
- Invocation logs and leases were not read here.
