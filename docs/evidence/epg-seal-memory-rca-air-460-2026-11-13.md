# EPG seal steps memory: offline RCA, AIR-460 (13 Nov 2026)

[AIR-460](https://trello.com/c/ZXySuCJk). Offline only: no production read or write, no Workflow, flag, lease, EPG, Discovery or TMDB action. Parent incident AIR-420; step metrics in [M3 part B](d1-migration/air-374-m3-epg-step-metrics-2026-11-13.md).

**Captured:** 2026-11-13 (UTC), Node v22.23.4, tree `origin/main` at `2582b924` plus this PR. **Evidence lifecycle:** dated measurement. **Operational authority:** none. Node heap and RSS are not the workerd 128 MiB isolate limit; the figures rank allocations and show what a step retains.

## Observed, inferred, unknown

**Observed (production, from AIR-420/AIR-444 and M3 part B, not re-read here).** Two `exceededMemory` outcomes inside the EPG Workflow on 13 Nov: the step entering `seal_ledger` (28 s in) and the step entering `seal_publish` (4 s in). The `seal_stage` step before them (archive about 58.4 MB, emit about 45.8 MB, 36,999 observations) completed.

**Observed (this PR, offline).** `scripts/epg-seal-memory-profile.mjs` (exits nonzero unless the ledger seals every row with the transfer committed and the publish moves the pointer to the new run) replays the real `sealLedgerStep` and `sealPublishStep` of the Worker sources against the sqlite D1 stand-in with all migrations, an in-memory bucket and synthetic bodies sized like the run (36,999 items, 46.9 MB ledger document, 16.5 MB staged payload with a 12.7 MB catalog, 2.2 MB programme, 1.5 MB watchlist).

| Step | Setting | Result |
| --- | --- | --- |
| `seal_ledger` (one 20 s step at 220 ms per D1 round trip, 36,999 rows sealed) | GC at every sample | heap peak 10.3 MB, 14.5 MB above the baseline: the ledger is streamed |
| `seal_ledger` | no forced GC | heap peak 15.1 MB |
| `seal_publish`, before the fix | GC at every sample | live 44.5 MB (heap 33.4, external 32.8 including the harness) |
| `seal_publish`, before the fix | no forced GC | live 70-85 MB (three runs, noisy) |
| `seal_publish`, after the fix | GC at every sample | live **31.9 MB** (heap 20.8), identical in three runs |
| `seal_publish`, after the fix | no forced GC | live 70-88 MB (three runs, noisy, not distinguishable) |

Reproduce: `npm ci && node --expose-gc scripts/epg-seal-memory-profile.mjs --scenario publish --gc batch` (and `--scenario ledger --gc batch --d1-latency-ms 220 --step-ms 30000`).

**Result: the OOM was NOT reproduced.** These isolated, sampled runs did not reach a memory level near 128 MiB in either step. That does not exclude per-step transient pressure: the harness samples at D1 calls and bucket puts only, so the synchronous `JSON.parse` of the 16.5 MB payload (text and parsed objects alive together) and `JSON.stringify` peaks are not captured; forced GC changes the allocation pattern; subtracting the in-process bucket bytes is only a proxy for R2; and Node memory accounting is not the workerd isolate limit. Memory carried over from the earlier `epg_commit` step in the same invocation or isolate remains plausible, and is not proven or excluded by this experiment.

**Sequential comparison with `seal_stage`: NOT DONE.** The `both` scenario starts from prepared stage outputs and runs ledger then publish, so it cannot show whether scan, archive and emit allocations persist into the seal steps. Owner-ready follow-up: a bounded successful replay that runs the real `epgSync` through `seal_stage` and then the seal steps in one process and one workerd isolate, compared with the isolated runs (option 4 below).

**Unknown.** Which earlier allocation is still resident at the two deaths; whether workerd reuses one isolate across the Workflow's steps; the real size of the catalog and payload on 13 Nov (the 12.7 MB catalog is the 3 Nov synthetic figure); peak heap and external memory in production (the logs carry none).

## Local fix in this PR

`sealPayload` parsed the staged payload including the whole catalog and kept it alive for the publish, finalize and queue units, none of which read it (`seal_catalog` reads the object itself). It now drops `payload.catalog` right after the parse. The reproducible effect is a 12.6 MB lower post-GC retained set in `seal_publish` (44.5 to 31.9 MB, deterministic over three runs); the no-GC peak is noisy and unchanged within noise, and any effect on the production peak is unproven. The parse itself still holds the text and the parsed payload at once (about 16.5 MB text plus objects): that peak is unchanged. No persistent contract, lease, fence, pointer, archive or D1/R2 shape changes; `seal_catalog` is untouched. Test: `tests/discovery-seal-publish.mjs`.

## What this does and does not establish

It does not prove that the production `exceededMemory` is fixed, and it must not be reported as such. It removes one measured, avoidable retention and shows that the two failing steps are not memory-heavy by themselves. The mechanism of the two deaths stays a hypothesis until the carried-over allocation is identified.

## Options for the owner (no decision taken here)

1. **Phase markers (small PR, no side effects).** Add `process.memoryUsage()`-free sanitized markers: step index, invocation correlation id, phase, payload and document byte counts. The Workers runtime exposes no heap figure, so markers can only bound the allocation by size.
2. **Isolate the heavy step.** Run `epg_commit` (scan, archive, emit) in an invocation that ends before `seal_ledger` starts, for example by ending the Workflow step with a durable checkpoint and starting the seal in a new instance. This changes the execution topology and needs an ADR and an owner decision; rollback is a code revert, with no data effect.
3. **Split the payload object** (report, watchlist and catalog as separate R2 objects) so no step parses what it does not read. This is a persistent contract change (staging object layout) and needs an ADR.
4. **Controlled replay with the seal_stage step first** in a workerd harness. workerd locally does not enforce the 128 MiB limit, so this ranks, it does not reproduce.

Documentation impact: this evidence file and its index entry. No change to architecture diagrams, reference or runbooks: runtime topology, persistent data flow and the failure contract are unchanged.
