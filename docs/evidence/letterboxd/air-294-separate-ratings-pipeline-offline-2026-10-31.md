# AIR-294: separate Letterboxd ratings pipeline, offline verification (2026-10-31)

**Card:** [AIR-294](https://trello.com/c/IzWiVABa). **Decision:** [ADR 0060](../../adr/0060-independent-letterboxd-ratings-pipeline.md). **Contract:** [separate ratings pipeline](../../reference/integrations/letterboxd-ratings.md#separate-ratings-pipeline).
**Code:** branch `cursor/air-294-ratings-pipeline-6979`, started over `main` `0dfcfe8` and merged with `main` `6640735`, measured 2026-10-31 UTC, Node v22.23.4.
**Scope:** offline only. Synthetic data in an in-memory R2 fake and a fake network. No production read or write, no Letterboxd request, no flag, Task, Access, R2 or D1 change, no `ratings_storage_migrate` (not even `dry_run`), no `ratings_sync_start` or `ratings_sync_step`. Nothing here is a production payload.

## Test harness

`tests/ratings-harness.mjs` loads the Worker modules into a `vm` context, like the other tests. Its R2 fake keeps ETags and honours `onlyIf` (`etagMatches`, `etagDoesNotMatch: '*'`), so compare-and-swap conflicts are real. Hooks before each `get` and `put` inject a concurrent writer or end the request at an exact point (kill points). A fake clock drives the lease and the 6-hour gap. A fake network serves Diary pages, member pages, the watchlist, film pages and EPG, and records every request.

| Test file | What it shows |
| --- | --- |
| `tests/ratings-queue-v2.mjs` | Queue identity: one reference per (film, removal event), replays add nothing, a new reference reopens a finished entry, 20-reference cap with `droppedRefs`, legacy entries, claim tokens refusing a late outcome, settlement resolving a reference only when its event lists the film with a confirmed rating (`event_missing`, `film_not_in_event` kept unresolved), retention never deleting an unresolved reference, writers that read version 1 following version 2 after a migration lands mid-retry |
| `tests/ratings-cursor-merge.mjs` | Property tests over random cursor states: the merge is commutative, associative and idempotent with canonical bytes; progress never moves back; diagnostics are one deterministic record; interleavings of inline and separate writers and late per-page joins |
| `tests/ratings-run.mjs` | Run lifecycle: `disabled` and `not_migrated` write nothing; 3 pages per step and 9 per run with checkpoints and overlap resume; Diary `blocked`, `rate_limited`, `failed`, `partial`; 5 lookups per step with a 403 pause and lookup off, and twelve due films over three steps; settlement over steps (150 references in two steps); 150 references to unwritten events followed by a valid one, which the same run reaches, and an abandoned run after which the next run settles the unvisited valid reference first; racing starts; a live lease (`busy`); lost responses; `run_mismatch`; `interrupted` and `abandoned` closed as `unknown`; isolation after two identical interruptions and its manual clearing; `lease_lost` keeping merged progress; the scheduled gap; the EPG enqueue racing a run |
| `tests/ratings-migration.mjs` | Migration matrix over every starting queue and cursor: `dry_run` writes nothing; `apply` converts both, records the witness, and a second `apply` changes nothing; the version 1 hand-over in `sync.json`; kill points (cursor write failing after the queue, death between the queue write and its witness); the witness reporting `regressed` for an object written back at version 1, with the pipeline inert again; refusal while a run is live; inline writers racing the migration losing nothing; malformed requests writing nothing |
| `tests/ratings-epg.mjs` | Inline parity: a golden fixture of stored bytes, replies and requests, recorded from `main` source, matched byte for byte with the switch unset, `inline`, malformed (`Separate`) and `separate` before migration. Under active `separate`: removed films enqueued before publication, no Diary or member-page request, no ratings markers; kill and replay of the hand-over; a blocked or hanging ratings run never blocks an EPG commit; footer health from the run record |
| `tests/ratings-api.mjs` | HTTP routes and MCP tools: `disabled` under `inline`; malformed bodies refused before any read; a foreign Origin refused; `run_mismatch` and the scheduled gap; status free of side effects with a stale run; `dry_run` writing nothing; MCP tools with closed schemas and annotations, only with a valid signed Access JWT |

The existing suites were updated for the new switch (`tests/feature-flags.mjs`), the tool list (`tests/mcp.mjs`) and the module list (`tests/get-side-effects.mjs`).

**Golden method.** `tests/fixtures/ratings-inline-parity.json` was recorded by running `node tests/ratings-epg.mjs --golden <dir>` against the `src/` of `main` `0dfcfe8` extracted with `git archive`, on the same synthetic scenario. After merging `main` `6640735` into the branch it was recorded again from that `main`: the bytes were identical. It holds synthetic data only.

## Memory and CPU profile

`node --expose-gc scripts/profile-ratings-step.mjs`, synthetic data. Stored history 5,000 entries (1.39 MB), queue at its retention limits (92.5 KB). Heap is measured above a base taken after a forced GC.

| Step | Elapsed | CPU | Heap peak above base | Largest read / write | R2 reads / writes |
| --- | --- | --- | --- | --- | --- |
| Diary: 3 pages of 50 rows | 174 ms | 193 ms | 27.5 MB | 1,405 / 1,429 KB | 330 / 169 |
| Removal: 100 settlements | 166 ms | 175 ms | 16.0 MB | 94 / 94 KB | 305 / 202 |
| Removal: retention, 5 lookups with 20 event writes each | 207 ms | 225 ms | 16.7 MB | 102 / 101 KB | 453 / 238 |

With `HISTORY_ENTRIES=20000` (history 5.57 MB) the Diary step took 638 ms elapsed, 855 ms CPU and peaked 99.3 MB above base; the removal steps did not change. Measured after the review fixes (per-step lookups, fair settlement).

## Limits

- The numbers include harness overhead: the measuring hooks serialize every object read and written. They bound the step's work, not the Worker's exact usage, and say nothing about Workers runtime limits.
- The Diary step's memory grows with the single `letterboxd/diary/history.json` object, which every page reads and rewrites. The inline EPG stage has the same cost. At 20,000 entries a step comes close to the 128 MB Worker limit. This is tracked as a gate before the first separate writer in the [runbook](../../runbooks/letterboxd-diary-history.md#cutover-owner): a Workers-like (workerd) measurement at the exported history size, or a history guard or sharding decision under a new ADR. Neither is part of this card.
- Parity is shown for the synthetic scenarios in the fixture, not for production data.
- Nothing here shows Letterboxd's behaviour on the Worker (page 2 and later, block rates) or that the migration matches production objects. That needs the owner-approved export and `dry_run` of the [runbook](../../runbooks/letterboxd-diary-history.md#separate-ratings-pipeline).
