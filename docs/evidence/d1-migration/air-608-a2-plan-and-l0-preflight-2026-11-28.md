# AIR-608 (A2): reviewable cutover operator, L3 plan proposal and dated L0 preflight (28 Nov 2026)

This page records the **offline** deliverable of card [AIR-608](https://trello.com/c/MSlOAAGR) and dated, side-effect-free L0 reads. It is **not** a production GO and records nothing executed against production except the reads below. Times are UTC (Europe/Madrid is UTC+1). It describes what was true when read; the present state is always read live. Revision 2 (after the owner review of [PR #1082](https://github.com/vladimino/iptv-watchlist/pull/1082), five correctness blockers) replaces revision 1.

## Native prerequisites (all current links; C2 operational qualification)

[AIR-603 M1](https://trello.com/c/wc7pHJTB) (window applied, schema 55), [AIR-602 A1](https://trello.com/c/7W5kAMK9), [AIR-643 ADR 0217](https://trello.com/c/e1Q9H1bG), [AIR-672 common key](https://trello.com/c/ZRJlafiP) (Done), [AIR-679](https://trello.com/c/X880EsWK) (rejected, not in the plan), [AIR-555](https://trello.com/c/JPgjoBzK) and [AIR-275](https://trello.com/c/4x7hH0gI) (audit and stream), and C2 [AIR-607](https://trello.com/c/Daq02gYy): **operationally active** (control `active`, rated scope done, cutoff `2026-11-28T04:00:00.000Z`), its native item intentionally **incomplete** until natural A2 traffic. That does not block A2 preparation or an owner-approved A2; it does not replace the C2 gate the flip enforces (below). No LID-only or attach activation (H1 real capture NO-GO, `H1_RULES` empty).

## What is delivered

- `scripts/letterboxd-admission-cutover-production.mjs`: the owner-only operator. It wraps the delivered A1 mechanism ([`src/letterboxd-admission-documents-import.js`](../../../src/letterboxd-admission-documents-import.js), [ADR 0222](../../adr/0222-letterboxd-import-coordination-documents-in-d1.md)) and marker `letterboxd_admission_authority` (migration 0046) and adds the gates the accepted ADRs require that the importer does not own. Default is read-only `status`. Imported by no Worker module, run by no deploy or Task.
- `scripts/letterboxd-admission-freeze-audit.mjs`: the **original admission freeze gate** of ADR 0207 decision 1 (AIR-555 predicates).
- Small supporting changes: `scripts/r2-s3-store.mjs` gains `listPage` (one page per call, for a bounded listing); `src/letterboxd-admission-documents.js` gains the read-only export `validateStoredManifest` (the production reader's own manifest contract, used by the operator, no behaviour change at any marker).
- `tests/letterboxd-admission-cutover-operator.mjs` (core suite).

## Review blockers and how each is closed

| Review | What the operator now does |
| --- | --- |
| **P1-A** original admission freeze | Reads `letterboxd/admissions/verified-films.json` (HEAD, GET, HEAD: ETag and byte size, stable across the read) and the D1 admission rows, and checks AIR-555 P1 kind, P2 `verifiedAdmission`, P3 agree/R2-only/D1-only/mismatch (code, archive, receipt film key, receipt key, verification time, year), P4 link and P5 inferred mark (link index and fact records), P7 Film health. P6 enrichment is **not** required. The **admission pin** (ETag, size, both row fingerprints, row count, newest `updated_at`) is independent of the moved-cohort manifest pin. It is required and re-verified at `close`, `import` and `flip` (and once more as the last read before the flip batch); its D1 side (row count, nothing newer) is asserted inside the close and flip batches. The registry projection's ETag/absence is recorded and compared after the flip. The object is never migrated. |
| **P1-B** wrong Diary document | Reads the authoritative shared check queue `letterboxd/facts/scans/diary-identity.json` (ADR 0221): `films` and `backlog`; any `linking`, `link_failed`, `lid_only_intent` entry or unresolved `reservation` is a NO-GO. Absent document is an empty queue (positive absence); malformed or unreadable state **fails closed**. The viewing cursor `letterboxd/diary/state.json` is not read. Both callers (Ratings Diary phase, Watchlist admission step) share this one queue. |
| **P1-C** C2 is activation | `c2Problems` reuses `activeConfigurationReasons` and `cutoffProblems` of `src/catalog-enrichment-activation.js`: control **active**, exactly the rated scope enabled and activated, bootstrap **done**, cutoff not later than the flip time; Film/Person and Ratings open (an unrelated Ratings generation bump is allowed, a lost authority is not). The control and scope **revisions are pinned** and asserted in the flip batch together with the scope identity. |
| **P1-D** manifest/readback fence | After import the stored manifest must equal the approved canonical manifest **and** satisfy the production reader (`requireManifest` via `validateStoredManifest`). The flip batch fences the exact moved-document set (every key, etag and part count, nothing more) and asserts the guard row `ratings_domain_cas` **exists** (an `INSERT` that trips the CHECK when it is absent). The closure generation is **pinned through import and rollback** (every helper batch carries the marker assertion at the pinned generation, so close/reopen/close cannot be adopted). `reopen` is refused while any D1 copy remains; `rollback-import` is judged by what remains in D1, never by the marker. The one-way marker is unchanged. |
| **P1-E** transport | Production reads use the **strict** adapter pattern of the C2 operator (a response without a result array is an error, never an empty result) with `retries: 0`; writes are never retried. The R2 listing is one page per call through `listPage`, so the importer's `MAX_LIST_PAGES` guard applies and a truncated page without or with a repeated continuation token is a STOP. Mocked REST and S3 transports in the test (no live request). Operator and module bytes are pinned (`--expect-bytes-sha256`, 15 files, see Known limits). The readback includes `activated_at` and the verified effect (manifest exact, parity equal, admissions object and registry unchanged). |

## The operator commands

| Command | Writes | Pins | What it does |
| --- | --- | --- | --- |
| `--status` | none | none | bytes digest, schema, marker, authorities, the freeze audit (ETag, size, fingerprints, P1-P5, P7, **admission pin**), the Diary queue, C2 problems and revisions, pending facts, the frozen cohort (**manifest digest**), D1 copies, blockers |
| `--parity` | none | none | `status` plus `verifyParity` (R2 snapshot vs D1 byte for byte) |
| `--close` | marker row | generation, admission pin, bytes | `r2 G -> closed G+1`; freeze clean and equal to the pin |
| `--import` | D1 documents + manifest (last) | generation, manifest, admission pin, bytes | NO-GO unless every blocker is clear; pinned batches; exact manifest and parity read back |
| `--flip` | marker row | generation, manifest, admission pin, bytes, control revision, scope revision | rechecks everything, then **one** fenced batch (guard row, closed at G, admission D1 side, document fence, no pending receipt, C2 control and scope, authorities open), `closed G -> d1 G+1` with `activated_at`. **Irreversible** |
| `--reopen` | marker row | generation, bytes | `closed G -> r2 G+1`, only with no D1 copy left |
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
| Open `rated_admission_retention` receipts | **0** (`pending`, `failed`, `unknown`) |
| C2 | control `active` (generation 1, revision 2); rated scope enabled and activated, cutoff `2026-11-28T04:00:00.000Z`, bootstrap `done`, revision 1; that is the only scope |
| Moved documents already in D1 | **0** rows under `letterboxd/imports/` |
| Deployment | Worker `iptv`, one version `4a900de1-b4b1-466a-9dc2-345b1948cd65` at **100%** since 11:03:28 UTC (previous deployments 10:30:26 and 10:13:55, each 100%): no gradual split is in progress now |
| Feature flags | the 25 registered flags read; none relevant to admission is set |
| `H1_RULES` | empty in the code of this checkout |

(The control and scope revisions printed here are the values read in D1: control revision 2, scope revision 1. The values to pin come from `--status` immediately before the flip.)

**Not yet read** (each needs only the scoped approvals below): the R2 listing of `letterboxd/imports/`, the R2 admissions object ETag/size and fingerprints, invocation logs per version and the Letterboxd/Ratings/Workflow leases.

## Proposed scoped read approval (the broader R2 inventory stays separately scoped until approved)

One run of `--status` with the R2 read credential, which reads exactly: HEAD, GET, HEAD of `letterboxd/admissions/verified-films.json`; HEAD of `letterboxd/imports/registry.json`; one paged `list` of the prefix `letterboxd/imports/` and a `get` of the moved families only (rated-candidates, chunk intent/receipt/candidates). It performs no write, and prints counts, reasons, digests and ETags only. Plus, as standing read-only L0: D1 `SELECT`s of the operator's state reads, Workers deployment/version metadata, Workers invocation logs by version and the Workflow instance and lease state.

## Staged close (the proposed GO sequence; no digest is guessed)

The moved-cohort manifest digest cannot be known before the drain, because quiesce only exists under `closed`. The staged sequence therefore makes each GO executable without spending the closed window:

1. **GO-1 (close).** Pins: marker generation, the **admission pin** from a fresh `--status` after the drain evidence (H-A), the bytes digest. Effect: `close` only. Stop after readback. **Holdpoint H-B.**
2. **Post-close review (no write).** `--status` under `closed` gives the **manifest digest**, ETags and every blocker. NO-GO on any pending, unknown or drifting state; nothing is repaired under `closed` (recovery: reopen under the approved plan). **Holdpoint H-C: the owner reviews the printed manifest digest and accepts the residual risk.**
3. **GO-2 (import).** Pins: generation, the reviewed manifest digest, the admission pin, bytes. Effect: import and its exact manifest/parity readback. **Holdpoint H-D.**
4. **GO-3 (flip).** Pins: generation, manifest digest, admission pin, bytes, control revision, scope revision. One fenced batch, independent readback, then roll-forward only. After the flip the evidence PR and Верификация until natural acceptance.

Drain evidence (H-A, before GO-1) is Coordinator/owner evidence, not an elapsed timeout: deployed version split (above), no older invocation still running, no in-flight owner archive/baseline/rated identity/enrichment/replay request (telemetry, else an owner attestation), no active Letterboxd/Ratings/Workflow lease.

**Rollback:** before the flip only: `--rollback-import` (verified by D1 contents) then `--reopen` (R2 never changed). After the flip: roll-forward on code that honours the marker; restoring R2 coordination needs its own owner-approved fenced procedure.

**Proposed GO wording (per step):** «GO-n A2 (AIR-608): execute <command> on `main` `<sha>`, bytes digest `<sha256>`, marker generation `<G>`, admission pin `<sha256>`, [manifest digest `<sha256>`, control revision `<r>`, scope revision `<r>`], stop and read back on any unexpected result, without retry or repair. Residual risk accepted at H-C.» Nothing here is approved.

## Known limits

- Offline proof only: the operator never ran against production. The REST and S3 transports are exercised by mocks of their response shapes, not against the real services.
- The bytes pin covers the 15 first-party files the operator executes; the Node runtime and `node:` built-ins are outside it, so the exact clean commit is part of the GO.
- The pin of the admission object is its ETag and size plus the fingerprints; a PUT after the last read but before the flip batch is excluded by the drain and, from the close onward, by the marker guard that every writer reads immediately before its R2 PUT (ADR 0207 decision 1); the D1 side is asserted inside the batch.
- Whether the live R2 cohort is clean is **unknown** until the scoped `--status` read. Admissions are written naturally (735 rows now versus 714 on 24 Nov), so a stale pin is expected and a new one is taken after the drain.
- Invocation logs and leases were not read here.
