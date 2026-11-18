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
| Unreadable store (review of PR #734) | With an active intent and a saved retry record (attempts 1, future `retryAt`), a D1 fault on the intent store makes `readOverlay` throw, the forced reconcile and `batch/start` refuse, and the queue rows are byte-identical; after recovery `attempts` and `retryAt` are unchanged. A partial table set throws `recovery_schema_partial`, refuses the rebuild without a write and answers 503 on preview. With the old catch-all restored, the test fails at "the forced rebuild refuses" |
| Identity race (review of PR #734) | A redirect, a conflicting claim, a moved claim, a second claim of the frozen id, or the Film/Person marker held, each injected after the server's last preview and before the batch: `409 recovery_cas`, no cohort, no intent, revision 0. Without the identity guard the redirect case confirms (test fails) |
| Second review of PR #734 | A partial schema missing only `prediction_recovery_cohort` (and, separately, only the intent or only the revision table), with an active intent and a saved retry record: `recovery_schema_partial`, reconcile and `batch/start` refuse with the queue rows byte-identical, the retry record survives, preview 503; a malformed intent row is `recovery_unavailable`. With the cohort join removed the cohort-only case reads as `read` (test fails). The same key with the old scope hash but other films, mode or TTL is `idempotency_conflict` (without the request digest it replayed: test fails). A retry change between preview and confirm is `stale_scope`; a runner heartbeat between them keeps the scope |
| Correction of 18 Nov 2026 (P1, `writes` predicate) | The whole suite now runs at the production marker `mode=d1`, `writes=held` (the AIR-478 read-only preflight read that state). Before the fix the suite fails at the first preview (`confirmable` false, refusal `prediction_writes_held`); with only the code fixed and the `0024` triggers still requiring `writes='open'` it fails at the first confirm (`409 recovery_not_open`). After the fix: preview, confirm, ordinary rebuild, batch v2, satisfied, cancel, replay, retry and identity cases all pass at d1/held. New refusals: `r2/open` and `r2/held` (preview, module and trigger), a d1 to r2 move and a deleted marker row inside the confirm batch (`409`, no cohort, no intent, revision 0), an unreadable marker before the preview (`503`). Corrected `0024`: 8731 bytes, SHA-256 `9429baba022f69ab7c675d56c56512588fcd59f3534d261c7bd69988361729fe` |
| Read side effects | `tests/get-write-audit.mjs` holds the three new GET samples to "no effect" in all eight scenarios |

**Limitations:** no production timing of the preview on the real catalog. The queue diagram in `docs/architecture/prediction-pipeline.md` gained the intent store as a read-only input after review; its rendered check is recorded on the pull request.
