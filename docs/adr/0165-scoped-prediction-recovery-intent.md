# ADR 0165: Owner-confirmed scoped prediction recovery intent as a denied-version overlay on the freshness rule

**Status:** Accepted  
**Original decision date:** 2026-11-17  
**Recorded at:** 2026-11-17  
**Accepted at:** 2026-11-18  
**Approval source:** Explicit owner acceptance on 18 Nov 2026 recorded in [AIR-477](https://trello.com/c/WhwaXRRl), following independent technical PASS in [PR #734](https://github.com/vladimino/iptv-watchlist/pull/734#pullrequestreview-5953827742). Approval covers the ADR's code-only architecture; migration `0024` activation, cohort confirmation, canary/bulk operations, and Scheduled Task changes remain separately gated.  
**Related work:** [AIR-477](https://trello.com/c/WhwaXRRl), [AIR-478](https://trello.com/c/IbsSCRce) (production activation), [AIR-281](https://trello.com/c/bjKa4hRj) (read-only recovery assessment), [AIR-451](https://trello.com/c/NN3N6kRp) (batch v2 runner)  
**Supersedes:** None  
**Superseded by:** None

## Context

The prediction queue is a derived projection. Every rebuild (`buildPredictionQueue`) computes membership from the programme, the admitted catalog, the view index and the taste profile: a film is outstanding when the freshness rule (`predictionTransitionCompatibility`, ADR 0031 / ADR 0035) does not accept its stored prediction as current. Retry records survive only for outstanding films, the hot/cold order is the rebuild's own, and the runner lease fences the batch v2 runner (ADR 0122). AIR-281 therefore delivered only a read-only per-film assessment and stated `targetedAction.available=false` and `writer.exists=false`: a per-film queue write would be overwritten by the next rebuild and could bypass retry and backoff.

There is still a real need to re-score an exact, owner-chosen set of films whose stored prediction the ordinary rule accepts as current (the 288-film cohort of AIR-478). That needs a durable, owner-confirmed, bounded statement that the ordinary rule must honour, and nothing that bypasses the queue, the lease, the retry policy or the validated runner.

## Decision

1. **The intent is a denied version, not a queue entry.** An intent row (D1, migration `0024`) names one stored film id, its verified canonical identity (Film id plus the one trusted typed TMDB or Letterboxd claim), a mode, and the exact stored version it denies:
   - `prediction_token` = `generatedAt|fingerprintHash|tasteProfileHash` of the current prediction (the D1 pointer's `display_json`);
   - in mode `fingerprint_and_prediction` also `fingerprint_token` = `fingerprintHash|generatedAt` of the stored fingerprint.
   The fingerprint hash is a content hash that includes the film id, so a token cannot describe another film's version; the overlay additionally requires the caller's film id to equal the intent's.
2. **The ordinary freshness rule reads the overlay.** `predictionFreshness` (and the queue rebuild's own judge) reads the active, unexpired intents (one D1 batch of two SELECTs per call) and treats a denied version as not current, and a denied fingerprint as not reusable, **only when the caller names the film**. The queue rebuild then admits the film as an ordinary outstanding film (`work.reason = recovery_intent`), with the ordinary priority, lane, retry record and retry budget. Batch selection, batch submit, the dry-run submit, held/staged items and the diagnostics pass the film id, so they agree with the rebuild. A consumer that does not name a film sees the ordinary rule unchanged. Only the absent migration (none of the three tables) reads as no intents. The one read batch joins each intent to its active cohort, so it touches all three tables and a missing one of any of them is detected; a malformed row is unreadable, not empty. An installed store that cannot be read, or a partial table set, throws (`recovery_unavailable`, `recovery_schema_partial`) and fails the caller closed: no rebuild, no queue write and no retry record is dropped on such an answer, so the retry budget of a recovery film survives a D1 fault.
3. **The intent ends itself.** The first new version the ordinary runner commits has another `generatedAt` (and, in mode `fingerprint_and_prediction`, another fingerprint `generatedAt`), so the tokens no longer match and the film is current again: the intent is `satisfied` without any further write and can never re-score the film twice. An intent also stops applying at its expiry (1–168 hours, default 72). A later confirmation for the same film settles a satisfied or expired intent in its own batch.
4. **The queue sees the intent through its ordinary rebuild.** The rebuild stamps `queue.recoveryRevision`; the advance gate of the runner start and the batch v2 preflight answers `recovery_changed` when the stored revision differs from the current one, so the next start rebuilds the queue the ordinary way. No code path writes `hotPending`, `coldPending`, `retries`, a lease, a pointer, `prediction_lineage` or an R2 body on behalf of an intent. A run already holding the lease keeps its manifest; its own queue settlement may rebuild the queue and so queue the cohort for the next manifest.
5. **Owner-only preview and confirm.** `GET /api/admin/prediction-recovery-intent/preview` classifies a frozen, duplicate-free allowlist of at most 50 stored film ids per film as `eligible`, `unchanged` (the ordinary rule already queues it), `blocked` or `conflict`, with the authority markers, runner lease, queue, retry state, budget and a `scopeHash` over every input it rests on. It reads R2 through a get-only bucket and D1 through SELECTs only. `POST …/confirm` (Access assertion, same origin, `X-IPTV-Admin-Action: prediction_recovery_intent`) re-runs the preview on the server, requires the exact `scopeHash` and an idempotency key, and writes **one** D1 batch: the revision moves forward from the previewed value, the cohort row is born `active`, and each eligible film's intent is inserted only while D1 still holds the previewed pointer (and fingerprint) token, each insert followed by the `prediction_domain_cas` fence. The same batch asserts the preview's identity decision again: the Film/Person marker is still `d1`/`open` at the previewed generation (part of the scope hash), and the canonical Film still holds exactly the frozen trusted claim (no other or untrusted claim of the frozen TMDB or Letterboxd id, no untrusted, conflicting or second claim of either scheme, no redirect, the frozen TMDB and Letterboxd values). Any moved token, a changed identity or marker, a concurrent confirmation, a closed prediction marker, an active-intent duplicate or the global cap of 300 active intents fails the whole batch. A replay of the same key returns the stored receipt only when both the scope hash and the normalized request (sorted films, mode, TTL; `request_digest` on the cohort row) are the stored ones; anything else under that key is `idempotency_conflict`. The scope hash covers every requested film's outcome, identity, denied tokens, queue lane and retry record (attempts, `retryAt`, exhausted), the mode, TTL, recovery revision, prediction authority mode/writes and Film/Person state/generation. It deliberately omits the queue generation, the prediction authority generation and the runner lease/run/epoch, which move on every runner step and heartbeat: confirming during a live v2 run is intended and the intent changes none of them. `POST …/cancel` closes the still-active intents of one cohort; already committed predictions stay.
6. **Fail closed on identity and scope (owner decisions of 17 Nov 2026).** A film outside the queue's admission (watchlist, programme or admitted catalog) is `blocked/not_admitted` in v1: a retained Film outside admission is not re-scored through this capability. Identity comes only from the canonical Film bridge (`catalogFilmIdentityBridge`): absent, retired (redirected), conflicting or unavailable identity, or a typed id that is not the Film's trusted claim, refuses. There is no title/year matching. An exhausted retry budget is never reset (`blocked/retry_exhausted`).
7. **Dormant without the schema.** Migration `0024` is delivered but not applied. Without it the overlay is empty, the queue carries no revision stamp, preview answers `schema.ready: false` and confirm refuses `recovery_schema_not_ready`. Triggers refuse every write unless the prediction domain marker is `d1` with writes `open`; no row is ever deleted.
8. **The read-only assessment stays truthful.** `GET /api/admin/prediction-recovery` keeps `targetedAction.available=false` and `writer.exists=false`: it still offers no per-film write. The new capability lives on its own route and version.

Not decided here: which films form the AIR-478 cohort, when `0024` is applied, any canary or bulk confirmation, scoring-policy changes (AIR-476), and the retirement of the v5 runner (AIR-452).

## Alternatives considered

- **Explicit include list consumed by the rebuild** (an intent says "include film X"; a separate write marks it consumed after a successful prediction). Rejected by the owner on 17 Nov 2026: more states and a second writer path; a lost consume write re-scores the film again.
- **Direct per-film queue write** (AIR-281 analysis). Rejected: overwritten by the next rebuild, bypasses retry/backoff and the queue's own CAS ownership.
- **Include retained Films outside admission now** through a canonical Film reader in `readFilmsById` and the rebuild. Deferred by the owner: larger scope and risk; v1 fails closed.
- **Grant a fresh retry budget per intent.** Rejected by the owner: changes the backoff policy.

## Consequences

- Re-scoring an exact cohort needs no new runner, no queue writer and no lease change; the ordinary batch v2 runner and validation apply unchanged.
- One extra D1 read batch (two SELECTs) per freshness evaluation and per advance-gate check; with the tables absent the read only adds the failed lookup and a table-list query.
- The admin preview is relatively heavy (it reads the same snapshot as the film diagnostics, plus one identity bridge read per film); it is bounded to 50 films.
- Coverage, health and diagnostics report a film with a pending intent as not current, which is the truth the queue acts on.

## Recovery and migration boundary

- Applying `0024` to production D1 is a separate owner GO (AIR-478). The file refuses anything but a complete schema version 23 and only moves the version forward.
- A code rollback leaves intent rows in D1; an older Worker ignores them (it never reads the tables), so the intent stops applying until the code returns. Cancel stops pending intents; it never undoes a prediction the runner already committed. Immutable prediction versions, `prediction_lineage` and R2 bodies are never touched.
- This ADR authorizes no production write, no confirmation, no migration apply and no Scheduled Task change.

## Evidence

- **Original decision:** [AIR-477](https://trello.com/c/WhwaXRRl) owner choices of 17 Nov 2026.
- **Implementation:** the AIR-477 pull request (code, migration `0024`, `tests/prediction-recovery-intent.mjs`).
- **Dated verification:** not recorded (synthetic D1/SQLite and in-memory R2 tests only; no production read or write).
- **Uncertainty:** production volumes of active intents per request and the preview's wall time on the real catalog are not measured.

## Follow-ups

- [AIR-478](https://trello.com/c/IbsSCRce): cohort freeze, migration apply, canary and bulk confirmation, each with its own owner GO.
- A later card may extend v1 to retained Films outside admission (decision 6).
