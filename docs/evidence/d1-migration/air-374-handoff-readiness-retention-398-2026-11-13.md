# AIR-374: `handoffReadiness` retention expectation 401 to 398 (offline), 13 Nov 2026 (UTC)

Offline code and documentation change; no production read or write, no Trello, no Scheduled Task.

**Decision (owner, 12 Nov 2026 snapshot; carried out here):** the H1 set is 708 / 398 / 4 ([PR #580](https://github.com/vladimino/iptv-watchlist/pull/580), loader `EXPECTED` in `scripts/film-person-prepared-loader.mjs`). `EMPTY_CLASSES` in `src/canonical-producers.js` still pinned retention 401, so `handoffReadiness` would have refused 398 loaded rows. It now pins 398.

| | Before | After |
|---|---|---|
| `EMPTY_CLASSES` retention `expected` | 401 | 398 |
| modelled blocker `empty_class_not_loaded:retention` | `0/401` | `0/398` |
| data_load blockers of the classification evidence (29 blockers, 3 data_load) | 0/708, 0/401, 0/4 | 0/708, 0/398, 0/4 |

- Single source: `src/` must not import `scripts/`, so `src/canonical-producers.js` keeps its own constant (with a comment) and `tests/canonical-handoff-readiness.mjs` asserts it equals the loader's exported `EXPECTED`, so the two cannot drift. Any retention count other than 398 (including the superseded 401) is still a blocker; the existing too-many and off-by-expectation cases cover it.
- Not changed: `ACCEPTED_DISCREPANCIES.caps` in `src/film-person-cutover-accepted.js` (retention 401 stays the historical cutover record; the cutover digest and the baseline reference `cutover_accepted/v2:732b9768...` depend on it), the baseline code and tests, and the dated evidence files.
- Worker bundle: `src/canonical-producers.js` is not part of `build.mjs`; only the unbundled offline readiness helper and its tests change. Production impact: none.
