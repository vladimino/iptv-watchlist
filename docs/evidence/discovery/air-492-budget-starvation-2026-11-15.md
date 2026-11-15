# AIR-492: budget-induced Discovery starvation — RCA and offline fix

15 November 2026. Code and tests on the AIR-492 branch against `main` at `6579cf53`. No production chunk, TMDB, lease reset or Workflow create.

## Historical production (read-only, from the AIR-492 card)

Source named on the card: Cloudflare `iptv-discovery` Workflow instance history, 11–15 November 2026, compared with `src/discovery.js` at `a3018952` (slice around 13 November). This file does not re-query production.

- 13 November 2026, 06:00–17:00 Europe/Madrid (05:00–16:00 UTC): 11 hours, **25 checked, 166 TMDB calls, 3 added**, queue ~7,000. Some hours: 10 chunks in error and **0 checked**. Repeated `partial` / `error=unknown` / `checked=0` / `tmdbCalls=1` / `retryAt` ≈ +5 min, Workflow `wait(reason=backoff)`.
- Instance `discovery_f0ec731d41314e2d8bf40aac3ce9e727_47`, chunks 13 November **05:33:35, 05:39:27, 05:45:18 UTC**: each `checked=0`, `tmdbCalls=1`, `error=unknown`; `preChunkMs` ≈ 8–9 s, `walkMs` ≈ 3–4 s, `pages=2`, `cheapMs` ≈ 4.5 s, `tmdbMs` ≈ 21–23 s, `totalMs` ≈ 41–44 s, `retryAt` ≈ 5 min; generation not emptied. Similar: `…_48`, `…_51`, `…_82`.
- Contrast: 13 November 18:00–19:00 Europe/Madrid processed **946** observations. 15 November 18:00 Europe/Madrid: **62 checked, 106 TMDB, 2 added, remaining=9487** — low throughput, not proof the 13 November loop still runs. Post-merge PR #655 first reduced backlog; that does not retire the defect.

**Observability gap:** historical code folded some thrown names into `unknown`. The primary exception and a stored `wall_budget` string on those instances are **not** proven. `wall_budget` is the leading hypothesis, not a log quote.

Out of scope (do not reopen): AIR-425 full-ledger walk (`pages: 95`, `tmdbCalls=0`); AIR-483 `programme_changed` → `intent_uncertain`; AIR-480 `discovery_conflict`.

## Mechanism on current main (before the fix)

`resolvePagedDiscoveryChunk` hot-sorts the selected page, then TMDB. `query()` increments `tmdbCalls` and may throw `BudgetExhaustedError` (time left under 2 s, or a timeout while left < 12 s). `saveCandidate` returns `late` past `persistLimit`. Both leave `checked===0`. `selectAfter` is a handled prefix in **key** order; an unfinished pending key stays at the cursor. `error: wall_budget` plus status `retryAt` five minutes ahead makes `continuationAfterChunk` `reason: backoff`. The next hop returns `stage: backoff` until `retryAt`. The same hot candidate is selected again.

That matches `tmdbCalls=1`, `checked=0`, five-minute waits, and a queue that barely moves. It is distinct from selection-only `wall_budget` (`tmdbCalls=0`, walk incomplete).

## Offline reproduction and fix

`tests/discovery-chunk-budget.mjs` (sqlite D1 stand-in, fake clock, no network):

| Case | Result |
| --- | --- |
| Clock already past 40 s before the chunk | `tmdbCalls=0`, `error=wall_budget`, series `retryAt` (unchanged) |
| 5 s virtual D1 writes, no TMDB started | same series backoff (unchanged) |
| `onFetch` jumps the clock 30 s on the first search, extra eligible rows | `checked=0`, `deferred=1`, `error=null`, no series `retryAt`; continuation not `backoff`; one `retry_at` / `deferReason=wall_budget` row; **next chunk stores a different key** |
| TMDB 429 | series `retryAt`, `deferred=0`, continuation `backoff` |
| Fast empty search of the hot fixture | `checked` equals the five hot keys, `deferred=0` |
| 16th TMDB call on a candidate that cannot finish | that key is deferred; 15 checked identities; no series `retryAt` |
| TMDB cap with no extra call on the next candidate | no defer (cap throw before `tmdbCalls++`) |
| Sole remaining candidate deferred | `remaining=0`, `waitingRetry>=1`, `stage=partial`, series `retryAt`; continuation is `paused`/`backoff`, not `complete`; after `retry_at` is due the same generation checks that key |
| Two consecutive +36 s TMDB hops with extra eligible rows | each hop stores a pre-request `wall_budget` fence, checkpoints inside 40 s, `error=null`; the second hop fences a **different** key |
| TMDB `TimeoutError` after a call | `deferred=1`, `error=null` |
| Owner CAS during fetch | owner payload kept, no `wall_budget` defer, cursor not treated as handled |

The 40 s wall and 16-call cap are unchanged. Deferred rows are not `verified` and do not increment `attempts`.

## Mermaid visual QA (15 November 2026, 20:05 Europe/Madrid)

Source: `docs/architecture/discovery-and-resolution.md` at `2f6b8f0c` (labels unchanged by the ADR status commit). GitHub blob: https://github.com/vladimino/iptv-watchlist/blob/2f6b8f0c551af5943c340833684be68e85d06225/docs/architecture/discovery-and-resolution.md

GitHub draws Mermaid in the browser. A mermaid.ink flowchart-v2 SVG of **that exact fence** (no parse error, viewBox ~2192×4225) was inspected:

- `eligible --yes--> defer --fence written--> search`
- `search --TMDB evidence available--> scorer` (not a durable Film/decision)
- `search --late or timeout; fence stands--> eligible` (back-edge)
- `search --HTTP 429; series backoff--> unresolved`
- `defer --no write window--> unresolved`
- `writer --durable outcome replaces fence--> ledger`

No post-TMDB diamond that writes a new defer. The page is tall because hydration/index subgraphs sit below (pre-existing). No screenshots stored. Independent review should still open the GitHub-rendered blob.

## Verdict

**Offline GO for the fairness fix.** Production acceptance remains natural Workflow observation on AIR-492: no long streak of `0 checked / 1 TMDB / 5 min backoff` while SQL remaining stays large. One fast hour is not acceptance.

## Limits

No live D1 latency, no production TMDB, no Workflow instance bodies in this repository. Historical `unknown` is not re-derived from logs in this session.
