# AIR-477 scoped prediction recovery intent, offline verification (17 Nov 2026)

**Scope:** [AIR-477](https://trello.com/c/WhwaXRRl), [ADR 0165](../../adr/0165-scoped-prediction-recovery-intent.md) (Proposed). Synthetic only: the real Worker code over the sqlite3-CLI D1 stand-in (full migration chain including the unapplied `0024`) and an in-memory R2. No production read or write, no Cloudflare, TMDB or model call, no Scheduled Task.

**Test:** `tests/prediction-recovery-intent.mjs` (core suite).

| Area | Result |
| --- | --- |
| Pure rules | Tokens, request parsing (set, bound 50, mode, TTL 1–168 h), every per-film outcome and reason, scope hash stability and sensitivity |
| Preview writes nothing | Zero D1 write batches; the prediction domain tables and every R2 object are byte-identical before and after; identical scope hash for a reordered allowlist |
| Confirm | Owner headers required; a wrong scope hash writes nothing; one fenced batch writes only the eligible films' intents and the revision; pointers, lineage, the queue document and R2 are unchanged |
| Partial outcome | A retired-identity film in the same request is skipped and named in the receipt |
| Replay / conflict | Same key and scope returns the stored receipt and writes nothing; same key, other scope is `idempotency_conflict`; a pending film is `active_intent` |
| Ordinary path | The next batch v2 start fails the gate (`recovery_changed`), rebuilds, and its manifest holds exactly the cohort (off-cohort re-scored: 0); submit records `recalculated`, not `already_current`; the cohort turns `satisfied`; replaced versions stay in `prediction_lineage` and R2; the next rebuild is empty (no loop) |
| `fingerprint_and_prediction` | The stored fingerprint is not offered for reuse; a never-predicted film keeps priority over the recovered one (same lane and rank) |
| Stale pointer / CAS | A pointer moved after preview gives `stale_scope`; a moved token, a stale revision or held writes fail the whole D1 batch with nothing written |
| Crash | A failure before the batch lands leaves no row; the same key then confirms |
| Live run | Confirm while a v2 run holds the lease leaves its manifest unchanged; the run's own settlement queues the cohort for the next manifest |
| Cancel | Pending intents close; nothing is re-scored afterwards; a second cancel is `already_cancelled`; unknown cohort is 404 |
| Expiry / identity / budget | An expired intent denies nothing; the overlay never matches another or an unnamed film; an exhausted retry budget keeps the film out of the queue |
| Dormant schema | Without the `0024` tables the overlay is empty, the queue carries no stamp, preview says `schema.ready: false`, confirm refuses `recovery_schema_not_ready` |
| Read side effects | `tests/get-write-audit.mjs` holds the three new GET samples to "no effect" in all eight scenarios |

**Limitations:** no production timing of the preview on the real catalog; no rendered Mermaid change (the queue writer diagram is unchanged because the intent is not a queue writer).
