# AIR-460: ledger stream parser allocation churn, 14 November 2026

Offline only: Node v22 and local Miniflare/workerd with local R2, synthetic data sized like the 13 Nov run (ledger 44.2 MiB, 36,999 items). No production read or write, Workflow, flag, lease or EPG action. **Operational authority: none.** Follows [the PR #626 measurements](air-460-seal-stream-workerd-2026-11-14.md), where the `seal_ledger` read cost about +76 MiB of workerd host RSS although the body stream itself cost +2 MiB.

## Cause found

`forEachJsonArrayItems` (`src/sources.js`) called `await need(1)` for every character of every string and nested value. `need` was an `async` helper, so each call allocated a promise and a microtask even when the buffer already held the byte. For a 44 MiB document that is about 17.5 GiB of short-lived allocation and about 3 s of CPU in Node. The fix replaces the awaited helper with an inline `buf.length-pos<n&&await pull(n)` check: it awaits only when more input is really needed. Parsing logic, error behaviour, chunk handling and `readSealedItems` offsets are unchanged.

## Observed

Node, `scripts/json-array-stream-benchmark.mjs` (3 repetitions each, identical across repetitions; the visit also does the `encode(JSON.stringify(item))` of `readSealedItems`):

| | allocated (proxy) | CPU | retained after GC |
| --- | --- | --- | --- |
| `origin/main` | 17,504-17,508 MiB | 3.06-3.15 s | about 0 |
| this change | 446 MiB | 0.50-0.55 s | 0 |

workerd, `scripts/epg-seal-streams-workerd.mjs`, workerd host RSS increase over idle:

| Site | before | after |
| --- | --- | --- |
| `seal_ledger` read, 220 ms per 400 items | +76.1 MiB | +41.8 MiB |
| same, no delay (wall time) | +77.5 MiB (1.40 s) | +42.4 MiB (0.60 s) |
| `copyEpgGeneration`, raw drain | +1.9, +1.8 MiB | +1.8, +1.1 MiB |
| `sealPayload` parse of 14.9 MiB | +57.6 MiB | +58.3 MiB (unchanged, not touched) |

Parity: `tests/json-array-stream-parity.mjs` (same results as `JSON.parse` for chunk sizes 1 to the whole document, non-ASCII, escapes, whitespace; fail-closed on truncated, malformed, duplicate-field and trailing input) passes on both the old and the new function. `npm test`: 418 of 418 files.

## Limits

- Node `heapUsed` steps are an allocation proxy; workerd RSS is the host process with Miniflare, not the Cloudflare isolate, and local workerd does not enforce 128 MiB.
- This removes allocation churn and CPU in the ledger read. It does **not** prove that the production `exceededMemory` is fixed: the live peak of the parser was already modest, the `seal_publish` payload parse is unchanged, and the carried-over memory hypothesis is still unproven. Acceptance is only by natural EPG runs without OOM.
- Not changed here: R2 range windows, `readSealedItems` cursor semantics, the staged payload, the Workflow boundary.

Reproduce: `npm ci && npm run build && node --expose-gc --min-semi-space-size=256 --max-semi-space-size=256 scripts/json-array-stream-benchmark.mjs --ref origin/main` and `node scripts/epg-seal-streams-workerd.mjs`.

Documentation impact: this evidence and its index entry; no runtime contract, topology or runbook change.
