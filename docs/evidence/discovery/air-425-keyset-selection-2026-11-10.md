# AIR-425: D1 paged chunk keyset selection (10 November 2026)

**Capture:** 2026-11-10, Europe/Madrid. Read-only MCP `epg_pipeline_status`, `enrichment_status`, `epg_status`. No discovery chunk, TMDB call, lease reset or flag change.

**Production snapshot (pipeline status):**

| Field | Value |
| --- | --- |
| `programmeRunId` | `6d9e3c36-bba2-4e4a-a92d-b2984abdc810` |
| Active ledger | 47,059 |
| Unresolved / ready | 11,949 / 4,900 |
| Last chunk | `stage=partial`, `error=wall_budget`, `checked=0`, `added=0`, `tmdbCalls=0` |
| Timings | `preChunkMs=8675`, `walkMs=8044`, `pages=95`, `cheapMs=0`, `tmdbMs=0`, `writeMaxMs=0`, `preCommitMs=34485` |
| Workflow | `phase=waiting`, `waitingReason=backoff`, `stalled=false`, chunks=10, remainingChunks=12 |
| EPG | `stage=complete`, published same run id |

`pages: 95` is `walkObservationPages` start-list length (`ceil(47059/500)`), not proof the walk finished. `cheapMs: 0` means the cheap pass did not run, so `complete` was false. The chunk still loaded `epg/discovery-resolution.json` (the full decision map) before the walk. Combined with ~8 s of page loads that exceeded the 30 s walk deadline.

Two earlier owner-reported chunks (19:41 and 19:47 Madrid) had the same shape (`pages=95`, `checked=0`, `preCommitMs` ~34–35 s).

**Not established:** Cloudflare Workers log lines for those hops; a monitor issue key for the Integrations health warning; Events Log absence (AIR-410, out of scope).

**Offline:** `tests/discovery-chunk-budget.mjs` — keyset wrap, held fence, no `ROW_NUMBER` from the chunk, `selectAfter` advances, existing cheap-pass / TMDB / lease tests.

**Verdict:** implement query-side keyset selection in the paged chunk. Do not close the card on tests alone; production acceptance is later natural chunks with non-zero work while `readyNow>0`.
