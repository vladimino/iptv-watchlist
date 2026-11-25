# Identity evidence writer activation and break recording (ADR 0215 decision 4; operator contract of card EC, AIR-637)

**Status:** the operator code and the migration are delivered **dormant**. Migration `0042_identity_evidence_writer_control.sql` is **not applied** (card ECM is a separate production GO) and no writer exists yet (cards E2a-E2c). Nothing here authorizes a production operation: **every step below is an owner-approved production operation with its own GO and readback** (L2/L3 of [authorization](../process/authorization-and-escalation.md)). Read the present state live; this page is a contract, not a status.

## What the control is

One durable row per writer in `identity_evidence_writer` (`discovery_decision`, `discovery_owner`, `claim_alias_bridge`, `tmdb_retirement_decision`, `tmdb_retirement_application`), plus the append-only `identity_evidence_writer_change`. **No row means `off`**, and so does a schema without the table. A writer inserts evidence only while its row is `pending` or `on`. Fields and triggers: [D1 schema](../reference/data/d1-schema.md#identity-evidence-writer-control-schema-v42-adr-0215-accepted-not-applied).

A row alone is not coverage: a version that predates the writer commits the same domain step with no insert, whatever the row says. Coverage is claimed only for a **drained, unbroken** `on` interval, and only as ADR 0215 decision 4 states it (per key: "no qualifying evidence recorded", never "not checked").

## Operator: `changeWriter` (`src/identity-evidence-writer.js`)

One call is **one statement**: the change row, whose trigger applies the transition to the control row (history and control are inseparable; the control row is never written directly). It takes `writer`, `kind`, `expectedGeneration` (the generation just read, 0 for an absent row), `reason`, `deployedVersion`, `evidenceLink` (a Trello or PR comment, or an evidence file) and, per kind, `drainEvidence` or `breakFrom`. A stale `expectedGeneration`, or a second operator racing from the same generation, writes nothing and fails with `identity_evidence_writer_stale`.

| Step | `kind` | Transition | Precondition |
| --- | --- | --- | --- |
| 1 | `activate` | `off` or absent to `pending` | the writer's code is deployed; **no coverage is claimed**; a repeat while `pending` is a no-op |
| 2 | (evidence, no call) | drain | only versions containing the writer can commit the step: one deployment at 100% built from a commit that contains it, no Discovery Workflow instance and no other Workflow or request of an older version still running ([ADR 0207](../adr/0207-letterboxd-admissions-coordinated-in-d1-only.md) decision 1 drain, [ADR 0189](../adr/0189-h0-checks-compatible-deployment-not-version-equality.md) H0 proof). **An elapsed interval alone is not evidence.** |
| 3 | `drain_complete` | `pending` to `on` | `drainEvidence` names that proof; `coverage_from` is the time of this flip, not of step 1 |
| end | `deactivate` | `pending` or `on` to `off` | records the end of coverage (also recovers a `pending` left by an interrupted activation); a later activation restarts at step 1 |
| break | `break` | `pending` or `on` to `off` | a rollback to a version without the writer happened: `breakFrom` is the deployment time of that version, taken from the deployment history |

## Coordination with M1 and ECM (holdpoint, no production operation here)

D1 applies pending migration files in number order. EC may merge ahead of A1 and of M1 (the apply of 0041), so M1 cannot skip its lower-numbered file's successor: a plain apply of 0041 with 0042 pending applies **both**. The M1 and ECM GOs must therefore be planned together, or each must name its exact files and the execution path that applies only them; neither apply activates a writer. Do not apply 0042 before 0041, and read the live schema version first.

## Before the first activation: batches prepared before ECM

A domain batch prepared while the control tables were absent carries a commit-time guard (`domainEvidenceStatements` returns one assertion that the tables are still absent), so it fails whole if it commits after 0042 is applied and replans. The drain proof of step 2 therefore needs no extra pre-ECM interval, but **every E2 integration must call the helper and pass its domain assertion builder**; a batch built without the helper is outside this guarantee.

## Writer `claim_alias_bridge` (card E2b, AIR-618; code delivered dormant)

The row is written by the ADR 0184 claim unit inside the claim's own canonical batch, and only for a write whose Diary or Watchlist caller handed over the page-check digest of the check it had just performed (every other path is rootless and writes no row, by design). Merged code inserts nothing until the control row is `pending` or `on` (no row = `off`); the decision is taken at commit time inside the batch.

- **Drain evidence for `pending -> on`** must show that only versions containing the bridge writer can commit a claim: one deployment at 100% built from a commit that contains AIR-618, and no Diary or Watchlist step, Ratings import chunk or owner backfill of an older version still running. An elapsed interval alone is not evidence.
- **Coverage is about eligible commits only:** a rooted claim write committed while the writer was `on` has its row (or the same key already present); a rootless write, a backfill, a replay or a claim that was applied by an attempt whose hand-over was lost is outside coverage and never counts as a gap or a refutation. A missing row for a key means no eligible commit for it in an unbroken `on` interval, never "not checked".
- **Rollback:** switch the writer `off` first (`deactivate`); rows written stay as history. The activation is one part of the shared package with the ADR 0215 writers, after the ECM apply, and needs its own owner GO; it is not part of the code card.

## Rules

- **A code rollback to a version without the writer is prohibited while it is `pending` or `on`.** Switch it `off` first (`deactivate`).
- If it happened anyway, record a `break` from the deployment history and set the writer `off`; the interval is broken from `breakFrom`. History is kept; a later activation starts again at step 1.
- A rollback of the code does not revert D1 rows or the control table. Before the first activation, undoing 0042 is a forward migration; after activation, the writer goes `off` with a recorded break and the ledger history stays.
- An authority hold of the domain needs no step: a held Discovery batch commits nothing, so nothing is missed.
- Imports (card ER) refuse to start while the matching live writer is `pending`.
- No operation here creates a Scheduled Task, flips a flag, applies a migration or runs a production writer outside its GO.

## Readback after each transition

`readWriter` (state, generation, `coverage_from`) and `readWriterChanges` (the change row with reason, version and evidence link), through an authorized read path. Record them with the GO's evidence in [evidence](../evidence/README.md).

## Offline proof

`tests/identity-evidence-claim-bridge.mjs` (the `claim_alias_bridge` rows on the real claim path: rooted and rootless first commits, retries, re-add, collision rollback, commit-time flip, schema without the control tables, receipt parity, statement budget), `tests/identity-evidence-writer.mjs` (migration replay, absent/off/pending/on, compare-and-swap race, duplicate and mismatching rows, old-version commit during `pending`, recovery from an interrupted activation, break recording).
