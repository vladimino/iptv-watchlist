# EPG diagnostic canary: the replay dataset does not fit its budget, owner decision to observe natural runs (AIR-456 H2a, 12 November 2026)

Scope: [ADR 0121](../../adr/0121-epg-diagnostic-rehearsal-design.md), [ADR 0124](../../adr/0124-epg-diagnostic-canary-run-contract.md), step H2a of AIR-456 (read-only build of a replay dataset from the published production generation, owner GO in chat). All times UTC. No payload, key or token value is recorded here.

## Result

**NO-GO for the current full-size replay dataset.** `dataset-build` (operator `scripts/epg-diagnostic-provision.mjs`, main `90f5e84`, read-only production key) failed closed with `size_budget_exceeded`. Nothing was written to production or to the diagnostic resources and no local file was created.

| Measure (metadata and counts only) | Value |
|---|---|
| Published generation | `f0ec731d-4131-4e2d-8bf4-0aac3ce9e727` (pointer phase `published`) |
| `discovery-latest.json` | 49.97 MiB, 42 156 active items |
| Current archive manifest `7833ba26-5835-4a18-8e53-613b871ea02b` | 64 segments, 40 213 archived items, about 50.15 MiB |
| Baseline total | about 100 MiB, 82 369 items |
| Dataset hard limits | 96 MiB and 120 000 items: the item count fits, the size does not |
| Archive prefix in total | 197 objects, 203.20 MiB (older manifests' segments included; a dataset takes only the current manifest's) |

Why the limit is not raised: `EpgReplay.loadDataset` reads the whole object into Worker memory (`text()`, `JSON.parse`), and `verifyDataset`, canonicalisation, planning and `replayScan` add further copies, against a 128 MB Worker limit. Peak memory was **not measured**; this is a reasoned risk from the code and the sizes, not a benchmark. The production seal avoids it by streaming the document.

## Owner decision (12 November 2026, in chat, recorded on the card)

Accept the NO-GO for the current construction and observe **natural production EPG runs** instead of redesigning the canary now (option 4 of the H2a report):

- H2b `dataset-put`, H2c `prepare-domain` and H3 (canary run) are not run; no owner GO was given for them. No streaming-dataset design, ADR or implementation, and no reduced non-equivalent dataset, is started.
- Natural-run evidence with `DISCOVERY_LEDGER_MODE=bounded` unchanged: [AIR-420](https://trello.com/c/J0dit94i) (due to published, target 15 minutes, 32 min 20 s on 12 November) and [AIR-444](https://trello.com/c/lSSrrJdE) (`seal_stage_plan`, archive and emit phases, R2/D1 wall, lease renewals, heap and `exceededMemory`, backlog drain, conservation, integrity, fence). The next natural run is 13 November. First question: is the existing telemetry enough for RCA and acceptance.
- Revisit a streaming or indexed dataset only if natural-run evidence leaves a concrete question about the seal that telemetry cannot answer and a streaming canary would. That needs its own architecture decision, an offline peak-memory benchmark and new authorization. Even then the replay stays `fidelity=reduced` and the diagnostic R2 (EEUR) differs from production (WEUR).

## State after H2a

The diagnostic bindings are deployed ([PR #558](https://github.com/vladimino/iptv-watchlist/pull/558), merge `97ff6bc`) and the owner-only preflight read `ready:true`, `datasetChecked:false`; the operator commands are merged ([PR #567](https://github.com/vladimino/iptv-watchlist/pull/567), `90f5e84`). The diagnostic D1 `iptv-epg-diagnostic` and the EU R2 bucket `iptv-epg-diagnostic` hold the H1 schema and identity only: no dataset, no receipts, no baseline, no Workflow instance. Production pointers, ledger, mirrors, leases and flags were not touched by H2a.

## Open items for the owner (not decided here)

- **Retention and cleanup** of the diagnostic D1 and R2: keep unchanged until a separate retention decision; deletion is its own authorized operation.
- **Credentials**: the short-lived D1 token (account-scoped D1 Write) and the diagnostic R2 key used in H1, and the read-only production key used in H2a, are revoked by the owner in the Cloudflare dashboard; a session cannot do it.
- **Acceptance of AIR-456** against the alternative Done criterion (documented NO-GO with evidence and safe recovery), by the owner.
