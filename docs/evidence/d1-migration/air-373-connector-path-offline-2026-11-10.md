# AIR-373: the connector path and the `cutover_accepted` gate, offline tests

**Captured:** 2026-11-10, local runs of `node tests/film-person-cutover-accepted.mjs`, `node tests/film-person-connector.mjs` and `node tests/film-person-connector-mutation.mjs`, then the full `npm test` and `npm run build`. **Method:** hand-built gate fixtures; a sqlite file that plays production D1 (the migrated schema built once); a fake connector, which is a `cloudflare.request` function over that file that runs the function texts the plan emits; a fake read-only S3 server on loopback. **No production access of any kind:** no R2 request, no D1 statement, no Cloudflare API or connector call, no IPTV MCP call, no flag, cron, Task, migration, marker or baseline write.

**Result:** the gate ([`src/film-person-cutover-accepted.js`](../../../src/film-person-cutover-accepted.js)), its recording path in `recordBaselineVerified` and the connector tool ([`scripts/film-person-connector-run.mjs`](../../../scripts/film-person-connector-run.mjs), inactive and not bundled) pass their tests, and each of 109 mutants (64 of the gate, 6 of the recorder, 39 of the tool; one guard removed or inverted, written outside the repository tree) is killed. An unmutated copy moved the same way passes, and a mutant that does not parse or load fails the check. This is evidence about the code, not about production. Inputs: the owner decisions of 10 Nov 2026 recorded in [ADR 0110](../../adr/0110-film-person-operator-copy-and-accepted-discrepancies.md), now **Accepted** following the [independent code re-review](https://github.com/vladimino/iptv-watchlist/pull/501#pullrequestreview-5850223602) (production recording still requires separate owner GO), including the [owner decision on PR #501](https://github.com/vladimino/iptv-watchlist/pull/501#issuecomment-6780196358) that fixes the caps at the exact measured counts; the runbook section is [Connector path](../../runbooks/film-person-baseline.md#connector-path-offline-code-nothing-executed).

Wall time on the development container (4 CPUs, Node 22), each file run alone: gate test 0.9 s, connector test 2.2 s, mutation check 28.7 s. Inside the parallel suite the three took 3.8 s, 5.6 s and 54.1 s; the whole suite (311 files) took 162 s unsharded. On the GitHub runners the first revision of the change (103 mutants) took 77 s and 78 s in the `Run tests` step of the two shards. The CI gate is the `Run tests` step of each shard on the GitHub runners, which this file does not measure.

## What the tests prove

| Property | Test case |
| --- | --- |
| The two permissions are pinned | `ACCEPTED_DISCREPANCIES` and `OPERATOR_COPY_PERMISSION` are frozen and equal their literal text; `caps` equals `measured` per class (no headroom); the caps sum to 1,600 |
| Caps | the measured counts pass (they are the caps); one unexplained row more fails with `over_cap:<class>` as the only reason, for each of the 15 classes |
| A differing value never passes | one differing value in any class fails (`differs:<class>`, `differs_total`), also when an owner exception explains it |
| An unlisted class fails | a ledger with one more compared class: `class_not_listed` |
| Tampering | a lowered count (`digest_mismatch`, then `totals_mismatch` and `discrepancies_mismatch` with every digest recomputed); another cap, decision text, approver or version in the acceptance (`acceptance_not_permitted`); a section changed without its digest (`accepted_digest_mismatch`) |
| Another attestation text creates no permission | a permission with another decision text, approver or an extra field gives `verified:false` and `source_permission_not_permitted`, also with `source.verified` set by hand and every digest recomputed |
| `verified:true` only with complete evidence | the complete facts give no reason; each of these gives `verified:false` with its reason: production differs at T0, T1 or T2; a statement or a read is missing; the copy differs at T1; the Discovery generation moved inside the resync or is not the run's; a Discovery table differs; the lease is absent, another holder's, expired or not released; a changed ETag; an incomplete probe; an inconsistent read; reads out of order |
| The statement set is required, not taken from the evidence | `requiredStatementIds()` is the 20 witness ids, the 10 gate ids and one count per table of `COPY_TABLES` (69); a count absent from T0, T1, T2 and the copy is `check_missing:count:<table>`, for each of the 39 tables; absent from one read it is `check_missing`, absent from the copy comparison `copy_missing`; a ledger built without one count in every snapshot, with the verdict set by hand and every digest recomputed, fails the gate with that one reason and the recorder refuses it before any database read; a statement outside the set is refused (`check_unknown:<id>`), not ignored |
| One table list | the tool re-exports the gate module's `COPY_TABLES` (the same object) and the plan's statement ids equal `requiredStatementIds()` |
| The verdict is derived twice | the builder ignores a caller's `verified` for an operator copy; the gate derives it again from the carried facts, so a hand-set verdict fails |
| The strict and v1 paths are unchanged | both still refuse the accepted ledger (`unexplained:1600`, `unexplained_total`); the accepted path refuses a v1 ledger; the existing tests and mutation checks of both pass unmodified |
| Recording | recorded as `cutover_accepted/v1:<acceptedDigest>`, replay is a no-op, the marker is not moved; a failing gate, another generation or another path object writes nothing |
| Plan generated from the reviewed code | gate SQL equals `GATE_STATEMENTS`; witness SQL equals what `readWitness` sends; the lease SQL occurs character for character in `src/film-person-baseline.js`; every function text carries the plan digest, the database id and the request shape |
| The lease functions | on the stand-in: acquired when free, not taken from a live holder, renewed by its holder, released only by its holder |
| Load | a corrupted file, a file of another plan, a trigger in the DDL, a second DDL, a file loaded twice, a chunk out of order, rows out of `rowid` order, a wrong row count, other columns, a non-scalar cell and a table outside the plan are refused and load nothing; the copy has no trigger and journal mode `delete`; the large table arrives in more than one page and in several calls |
| An uncopied table fails closed | a `SELECT` naming a table whose copy is not complete, a view over one, or a table outside the plan is refused (`connector_table_not_copied`); existence checks see the whole schema; any write but the three lease statements is refused |
| Verify | the copy answers all 69 statements as production; one changed aggregate is found and named; a Discovery statement may differ; another lease holder may not |
| Resync | a generation that moved inside the request applies nothing; rows that do not bring the copy to production's aggregates are recorded as unequal and do not open the run |
| Run | the merged `captureProjectorInputs` and `runParity` run against the copy with all three routes in D1; the connector is never called; R2 sees only `GET` and `HEAD`; the production lease row is untouched; an ETag that changes after the cut refuses the run |
| The table list | the tables named by the traced statements of the run, plus the reviewed `factsSql`, equal `COPY_TABLES` (39) |
| The ledger is the measured state | `seal` refuses class entries whose parity ledger digest is not `runParity`'s; per class, the counts and digests equal a direct `runCutoverMinimum` on the stand-in |
| Report | counts and digests only: no id, title, name or lease id; the private ledger keeps every key |
| SQL | the emitted statements equal, text for text, the batches `recordBaselineVerified` and `transitionAuthority` send to a migrated stand-in with its triggers; sent as one request each they give the announced read-back; `r2` to `prepared` is refused without the verified baseline; nothing is emitted for a failing ledger; emitting changes nothing, not even the copy |
| Inactive | no `src/` file names the tool; `build.mjs`, `package.json` and the Wrangler configuration name neither file; the CLI refuses a private path inside the repository |

## Not proved

- The tool has never run against the real connector or production. The result shape of the connector's `execute` tool, its size limit and the atomicity of a multi-statement D1 request sent through it are assumed, not observed.
- Speed at production size (about 540,000 rows) was not measured; the copy is read through the `sqlite3` command line, one process per statement.
- The fixture has two Films. It does not reproduce the 1,600 measured differences; the caps are tested on built ledgers.
- The caps have no margin: whether a second production measurement stays within the counts of 10 Nov 2026 is unknown.
- Operator-copy evidence is attestation. These tests build such evidence with a fake connector, which is exactly what the checks cannot tell from a real run.

## What this does not authorize

No measuring run, no lease on production, no baseline record, no `r2` to `prepared`, no repair. Each needs its own owner GO.

Card: [AIR-373](https://trello.com/c/ugu3sQmp).
