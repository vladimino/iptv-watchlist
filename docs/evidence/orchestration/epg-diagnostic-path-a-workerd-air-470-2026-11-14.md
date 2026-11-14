# AIR-470 Path A in local workerd: full-size `stageSealedGeneration`

Date: 2026-11-14 (UTC). Memory verdict: **INCONCLUSIVE**. Count invariants verified; no key-level parity claim.

## Scope

The harness measures the real, unchanged `stageSealedGeneration` (archive planning with CAS plus ledger emit) at full size. It does **not** exercise baseline `materialize`, `sealLedgerStep` (the D1 ledger advance) or the later seal steps; `stageSealedGeneration` itself ends by setting `run.stage='seal'`. This is a staged-phase memory result, not an end-to-end seal.

## Method

`scripts/epg-path-a-workerd.mjs measure` copies `dist/server/index.js`, adds one harness route and runs it in Miniflare (workerd) against the sanitized baseline from `scripts/epg-path-a-feasibility.mjs build`. The route materializes the active scan as an array (Path A), applies 2 000 departures and 200 returns, and calls `stageSealedGeneration` on local D1 and R2. No production or diagnostic resource is touched and `src/worker.js` is unchanged. After the runtime stops, the persisted local R2 is read by an unconstrained process.

The build requested 42 156 raw active observations and 40 213 archived; the canonical baseline normalizes the raw observations to **42 026 active keys** (`baseline.json` `activeItems`), and that is the count measured here.

## Results (three runs, same baseline)

| Run | stage wall (ms) | workerd RSS idle (MiB) | sampled peak (MiB) | peak minus idle (MiB) | count invariants |
| --- | --- | --- | --- | --- | --- |
| 1 | 11 505 | 1 051.9 | 1 241.0 | 189.1 | hold |
| 2 | 11 544 | 1 008.4 | 1 253.8 | 245.4 | hold |
| 3 | 11 531 | 994.8 | 1 233.0 | 238.1 | hold |

Verified counts: scan items 40 226 = 42 026 - 2 000 + 200; ledger items after 40 226; archive `upsertedKeys` 2 000; `sealError` null. Not verified: key-level membership, ordering, return identities, digest integrity, D1 seal completion.

## Memory interpretation

Local workerd does not enforce the 128 MB isolate limit and `process.memoryUsage()` returns zeros there. The idle RSS of about 1 GiB and the sampled growth belong to the whole local workerd/Miniflare host, including D1 and R2 emulation and seeded data. The growth is a sampled host-level observation, not a bound on peak isolate usage. It supports neither GO nor NO-GO. The Node heap-capped runs in the earlier report remain the only cap-enforced data. More local RSS repetitions are unlikely to help.

## Conclusion

INCONCLUSIVE against ADR 0139's "substantial margin" criterion. Resolving it needs a real Cloudflare isolate with sanitized data and independently approved isolated resources, under a separate operation-specific owner GO. Nothing here authorizes that, Path B or a `src/worker.js` change.

The CLI now fails closed: a request error, missing answer, `sealError`, no sampled workerd process or unverified invariants set a nonzero exit status and a `failed` list in the JSON; `tests/epg-path-a-workerd.mjs` covers it.
