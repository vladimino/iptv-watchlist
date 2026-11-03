# AIR-317 production prediction-domain cutover, 3 November 2026

This dated evidence records independently approved operational steps and later normal scheduled behavior. It authorizes no additional migration, owner flag, Scheduled Task change or production write.

## Migration and activation

The [AIR-317 Trello history](https://trello.com/c/jj45y0JW) documents several failed or partial imports. The final operator `--activate` completed at **2026-11-03 00:25 UTC** (01:25 Madrid), exit 0, `writeState=committed`. The operator's 00:30 UTC D1 readback: `prediction_domain_authority.mode=d1`, `writes=held`, `generation=1388`, `queueGeneration=0`, `profileGeneration=0`, 2,996 Film rows, 3,012 fingerprints and pointers, 288 history rows, and **0 outstanding intents**. `held` is the migration/revert hold, not a prohibition on ordinary D1-mode prediction commits. These are operator-reported aggregate D1 reads, not a second direct SQL query by the coordinator.

At 00:44 UTC the operator restored `D1_ENRICHMENT_WRITE=on`, subsequently confirmed independently through owner-only `feature_flags`. GitHub main `170f76c4fa5efbf1f55e83cadddc9bf197c6fb28` passed [both post-merge CI/CD jobs](https://github.com/vladimino/iptv-watchlist/actions/runs/41552486153). The external hourly ChatGPT prediction task is enabled.

## Natural post-cutover functional verification

An ordinary scheduled prediction run `e4aaf0c2-9fa3-4c3c-a90b-d4e0c776440c` ran from **2026-11-03 05:28:05 to 05:35:21 UTC**. Read-only owner MCP `enrichment_queue` showed `stage=complete`, 3 predictions added, 0 updated, 0 failed, and 0 remaining hot/cold work. The task's stored result independently reported `queue_empty`. It ran after the D1 marker switch. No manual `prediction_start`, model run or retry was issued for acceptance.

A subsequent natural run `2328a2a4-2c8f-46df-92ca-138754e634c6` started at 06:26:48 UTC. As of 06:36:38 UTC it was still running: 4 predictions added, 0 failed; its terminal outcome was not yet confirmed. `prediction_queue_overview` and `enrichment_queue` showed consistent programme/profile snapshots, profile version 2, one eligible film pending after the ongoing batch, and 3,010/3,011 predictions current (99.9%). One newly queued film does not disprove a completed prior batch.

## Proof and limits

[ADR 0078](../../adr/0078-d1-authoritative-prediction-domain.md), [PR #312](https://github.com/vladimino/iptv-watchlist/pull/312) and subsequent reviewed fixes cover generation fencing, CAS/leases, immutable body verification, fail-closed D1 reads and no stale R2 fallback. The activation operator included source parity checking. The coordinator did **not** independently download/hash every immutable R2 body or query all rows of D1 history and did not intentionally trigger an outage. Natural producer success, read-only queue/profile checks and operator D1 authority confirmation are distinct evidence.

Published EPG [AIR-319](https://trello.com/c/pQL8NUTC) (`0008`), owner reviews [AIR-314](https://trello.com/c/RBxi5Pcf) (`0009`), and Discovery [AIR-320](https://trello.com/c/4cA5GlJn) are separate, action-specific authority cutovers.
