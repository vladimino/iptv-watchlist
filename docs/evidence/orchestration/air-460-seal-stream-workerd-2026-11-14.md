# AIR-460: workerd and Node measurements of the seal OOM sites, 14 November 2026

Offline only: local Miniflare/workerd with local R2, synthetic data sized like the 13 Nov run (ledger 44.2 MiB / 36,999 items, payload 14.9 MiB). No production read or write, Workflow, flag, lease or EPG action. Tree: `origin/main` at `a3e1eb94`. **Operational authority: none.** A local workerd does not enforce the 128 MiB isolate limit and `process.memoryUsage()` returns zeros there, so workerd figures are host-process RSS of the workerd child (idle about 340 MiB with Miniflare) and only rank sites.

Reproduce: `npm ci && npm run build && node scripts/epg-seal-streams-workerd.mjs`.

## Context

The natural run of 14 Nov (see [AIR-462 correlation](air-462-epg-oom-natural-run-2026-11-14.md)) still had two OOMs after PR #595: `seal_ledger` (last marker 21,434 items) and `seal_publish_copy:enter`.

## Observed (workerd, real bundle functions, fresh process per scenario)

| Site | RSS increase over idle |
| --- | --- |
| `copyEpgGeneration` of the 44 MiB ledger (FixedLengthStream pipe) | +1.9 MiB |
| raw R2 body drain, no parsing, paced | +1.8 MiB |
| `readSealedItems` over the ledger (the `seal_ledger` read), 220 ms per 400 items | +76 MiB |
| same, no delay | +78 MiB |
| `sealPayload` of a 14.9 MiB payload | +58 MiB |

## Observed (Node, `forEachJsonArrayItems` alone, 36,999 items)

Heap grows from 47.6 to 191 MiB during the read, but returns to 47.7 MiB after GC (nothing retained). With `--max-old-space-size=90` (about 42 MiB headroom over the harness baseline) the read completes with a sampled peak of +27 MiB.

## Inferred, not proven

- Copying and the body stream do not buffer the object; the copy site is not memory-heavy by itself.
- The ledger parser churns about 3x its input as short-lived garbage, retains nothing, and its live peak is about +27 MiB. Pacing by D1 does not change it.
- Neither failing step is heavy alone, consistent with the 13 Nov offline RCA. A kill at these points therefore needs memory already resident from earlier work in the same isolate, or a platform accounting that includes uncollected garbage or external memory. Neither is established.

## Unknown

Whether workerd reuses one isolate across Workflow steps; what is resident at the kill; whether production counts uncollected garbage against the limit. No code change is justified by this evidence: a fix without a mechanism would repeat the PR #595 outcome.

## Candidate next steps (owner decision, nothing taken)

1. Reduce parser churn (ranged R2 reads of bounded windows, avoiding per-chunk string concatenation): low risk, effect on production unproven.
2. End the Workflow invocation between `epg_commit` and the seal (ADR, topology change).
3. Split the staged payload (persistent contract change, ADR).

Documentation impact: this evidence and its index entry; no runtime, contract or runbook change.
