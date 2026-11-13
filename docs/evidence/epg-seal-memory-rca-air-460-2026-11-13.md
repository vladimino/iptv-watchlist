# EPG seal steps memory: offline RCA, AIR-460 (13 Nov 2026)

[AIR-460](https://trello.com/c/ZXySuCJk). Offline only: no production read or write, no Workflow, flag, lease, EPG, Discovery or TMDB action. Parent incident AIR-420; step metrics in [M3 part B](d1-migration/air-374-m3-epg-step-metrics-2026-11-13.md).

**Captured:** 2026-11-13 (UTC), Node v22.23.4, tree `origin/main` at `2582b924` plus this PR. **Evidence lifecycle:** dated measurement. **Operational authority:** none. Node heap and RSS are not the workerd 128 MiB isolate limit; the figures rank allocations and show what a step retains.

## Observed, inferred, unknown

**Observed (production, from AIR-420/AIR-444 and M3 part B, not re-read here).** Two `exceededMemory` outcomes inside the EPG Workflow on 13 Nov: the step entering `seal_ledger` (28 s in) and the step entering `seal_publish` (4 s in). The `seal_stage` step before them (archive about 58.4 MB, emit about 45.8 MB, 36,999 observations) completed.

**Observed (this PR, offline).** `scripts/epg-seal-memory-profile.mjs` replays the real `sealLedgerStep` and `sealPublishStep` of the Worker sources against the sqlite D1 stand-in with all migrations, an in-memory bucket and synthetic bodies sized like the run (36,999 items, 46.9 MB ledger document, 16.5 MB staged payload with a 12.7 MB catalog, 2.2 MB programme, 1.5 MB watchlist).

| Step | Setting | Result |
| --- | --- | --- |
| `seal_ledger` (one 20 s step at 220 ms per D1 round trip, 36,999 rows sealed) | GC at every sample | heap peak 10.3 MB, 14.5 MB above the baseline: the ledger is streamed |
| `seal_ledger` | no forced GC | heap peak 15.1 MB |
| `seal_publish`, before the fix | GC at every sample | live 44.5 MB (heap 33.4, external 32.8 including the harness) |
| `seal_publish`, before the fix | no forced GC | live 70-85 MB (three runs, noisy) |
| `seal_publish`, after the fix | GC at every sample | live **31.9 MB** (heap 20.8), identical in three runs |
| `seal_publish`, after the fix | no forced GC | live 70-88 MB (three runs, noisy, not distinguishable) |

Reproduce: `npm ci && node --expose-gc scripts/epg-seal-memory-profile.mjs --scenario publish --gc batch` (and `--scenario ledger --gc batch --d1-latency-ms 220 --step-ms 30000`).

**Inferred.** Each step alone stays far under 128 MiB (ledger about 15 MB above baseline, publish about 32-45 MB retained, 70-88 MB without GC pressure). Reaching the limit in the first seconds of `seal_publish` or after 28 s of a streamed ledger therefore needs tens of MB already resident from earlier work of the same Workflow invocation or isolate. That is consistent with the cumulative-memory hypothesis of the card. It is not proven: the harness does not run the preceding `epg_commit` step (scan, `seal_stage` archive and emit) in the same isolate, and Node has no 128 MiB isolate limit.

**Unknown.** Which earlier allocation is still resident at the two deaths; whether workerd reuses one isolate across the Workflow's steps; the real size of the catalog and payload on 13 Nov (the 12.7 MB catalog is the 3 Nov synthetic figure); peak heap and external memory in production (the logs carry none).

## Local fix in this PR

`sealPayload` parsed the staged payload including the whole catalog and kept it alive for the publish, finalize and queue units, none of which read it (`seal_catalog` reads the object itself). It now drops `payload.catalog` right after the parse. Retained live memory in `seal_publish` falls by 12.6 MB (44.5 to 31.9 MB, deterministic with GC). The parse itself still holds the text and the parsed payload at once (about 16.5 MB text plus objects): that peak is unchanged. No persistent contract, lease, fence, pointer, archive or D1/R2 shape changes; `seal_catalog` is untouched. Test: `tests/discovery-seal-publish.mjs`.

## What this does and does not establish

It does not prove that the production `exceededMemory` is fixed, and it must not be reported as such. It removes one measured, avoidable retention and shows that the two failing steps are not memory-heavy by themselves. The mechanism of the two deaths stays a hypothesis until the carried-over allocation is identified.

## Options for the owner (no decision taken here)

1. **Phase markers (small PR, no side effects).** Add `process.memoryUsage()`-free sanitized markers: step index, invocation correlation id, phase, payload and document byte counts. The Workers runtime exposes no heap figure, so markers can only bound the allocation by size.
2. **Isolate the heavy step.** Run `epg_commit` (scan, archive, emit) in an invocation that ends before `seal_ledger` starts, for example by ending the Workflow step with a durable checkpoint and starting the seal in a new instance. This changes the execution topology and needs an ADR and an owner decision; rollback is a code revert, with no data effect.
3. **Split the payload object** (report, watchlist and catalog as separate R2 objects) so no step parses what it does not read. This is a persistent contract change (staging object layout) and needs an ADR.
4. **Controlled replay with the seal_stage step first** in a workerd harness. workerd locally does not enforce the 128 MiB limit, so this ranks, it does not reproduce.

Documentation impact: this evidence file and its index entry. No change to architecture diagrams, reference or runbooks: runtime topology, persistent data flow and the failure contract are unchanged.
