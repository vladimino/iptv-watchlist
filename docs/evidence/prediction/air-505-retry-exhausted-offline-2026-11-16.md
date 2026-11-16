# AIR-505 prediction retry budget, offline

**Capture:** 16 November 2026, Worker code on the AIR-505 branch, sqlite D1 stand-in and in-memory R2. No production read or write, no Scheduled Task, no catalog exclusion.

**Method:** `tests/prediction-retry-exhausted.mjs` and the diagnostics fixtures in `tests/prediction-diagnostics.mjs`.

**Result (offline):**

- The ninth saved per-film `insufficient_evidence` leaves the film in the hot lane with backoff; the tenth removes it from pending lanes, keeps `retries[filmId].attempts === 10`, and the next `batch_start` selects neighbours only.
- Identical submit replay does not raise `attempts`. A queue rebuild keeps the exhausted record and does not re-queue it.
- A stored `attempts >= 10` record is held on the first rebuild without an eleventh selection.
- Five caller `insufficient_evidence` items in one submit do not set `format_error_storm`; five caller `json_unparseable` claims do not; five worker schema failures still do.
- `boundRetryRecords` keeps an exhausted catalog identity when more than 500 newer historical exhausted records exist, and keeps at most 500 historical exhausted identities.
- Systemic `storage_error` / run-scoped merge does not increment the per-film budget. Cold proceeds when every remaining hot film is exhausted.

**Verdict:** Offline PASS for the selection gate. Natural production runs after deploy are required to observe live `retryExhausted` counts.

**Limits:** No production D1 queue was rewritten. Owner review of exhausted candidates and any retry reset remain later cards.
