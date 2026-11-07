# AIR-362: seal busy answer with the holder's lease expiry

**Captured:** 2026-11-07 (UTC). **Method:** offline test `tests/discovery-seal-busy.mjs` on the sqlite D1 stand-in with a fake clock; no Cloudflare, TMDB or production access, no write.

## Starting point

On 6 November the Daily run `307a3e1d…` stopped at `seal/catalog` after one cancelled request. The cancelled step kept its 90 s discovery lease; later `epg_sync_step` calls answered `busy`/`wait` with `nextCatchUpAt: null`, and the Task ended before the lease expired.

## Result of the offline test

| Case | Answer |
| --- | --- |
| Lease held, calls at +1 s, +30 s, +85 s | `busy`, `lease_held`, `nextCatchUpAt` = `expires_at` + 3 s, `retryAfterSec` counts down; phase unchanged |
| Three simultaneous callers | One identical `nextCatchUpAt`; the holder row is untouched |
| Holder expiry far in the future | Capped at now + 90 s + 3 s |
| Past or missing expiry | At least 1 s |
| Row expired between the failed take and the read | `lost_race`, 5 s |
| Bounded client loop | The lease is taken within 3 calls and within 93 s |
| Different programme (authority programme set, other requested) | `generation_mismatch`; through `sealStep` the answer is `stop`, `nextCatchUpAt: null`, never `wait` |
| Unknown, zero or invalid holder expiry | Treated as `lost_race`, 5 s; no lease-based promise |
| Cancelled `seal_catalog` end to end (`tests/discovery-seal-publish.mjs`) | Two calls before expiry wait for `expires_at` + 3 s and move nothing; the holder row is untouched; after expiry the run goes through publish, finalize and queue to `complete` |

Removing the Worker change makes the test fail. No production step was run; the wall behaviour on a real cancelled request is not measured.
