# EPG Channel policy in the scan: offline evidence

**Date:** 21 Nov 2026 (UTC). **Scope:** repository change and offline tests only. No production database, bucket, Worker, EPG, Discovery or TMDB was read or written, no flag was set, and nothing was deployed.

## What was verified offline

| Check | Result | Source |
| --- | --- | --- |
| `deny_all` drops a programme before Film matching, even for a known Film; the same Film on an allowed channel is kept | Pass | `tests/epg-channel-policy.mjs` sections 2 |
| `known_only` keeps a single watchlist match or a catalog Film confirmed by a movie title, and creates no unknown candidate or uncertain entry | Pass | same, section 2 |
| An id the map does not hold, and a channel without category, are `known_only` (basis `unknown`, `unclassified`) | Pass | same, section 2 |
| `scanned` and channel coverage stay raw; policy counters are post-filter | Pass | same, section 2 |
| One in-memory lookup per programme, no database reachable from `scanEPG` | Pass | same, section 3 |
| Continuity: the expected shrinkage of a first filtered generation passes, a further collapse, a filtered-vs-filtered collapse and a raw-count collapse still fail | Pass | same, section 4 |
| An empty, absent or unavailable snapshot is refused; the reader is gated by `EPG_CHANNEL_POLICY=on` and read before the scan | Pass | same, sections 5 and 6 |
| XMLTV registration: origin `xmltv`, no category, `known_only`, no duplicate ids, an M3U channel is never re-created, a repeat is a no-op, existing classification and owner overrides preserved, a pinned map is unaffected | Pass | same, section 5 |
| The `epg` event carries the counters, revision and digest only when a policy was applied; an older event renders unchanged; only a same-origin link is rendered | Pass | same, sections 6 and 7 |
| No policy given: the scan result equals the earlier behaviour | Pass | same, section 1 |

## What was not done

- **No full XMLTV dry run on the real feed.** The provider feed is not available to this environment. `scripts/epg-channel-policy-dry-run.mjs` runs the scan without and with a policy over a local XMLTV file and a local policy map and reports the raw and post-filter counters, lost and gained show keys and the channels the map lacks. It must be run by someone holding the feed before the owner sets the flag. The 20 Nov 2026 audit figures (35 groups, 2 103 M3U ids, 1 355 XMLTV channels, 15 XMLTV-only) are a baseline for that run, not invariants.
- **No D1 capacity or timing measurement** of the snapshot read or the registration batch on Cloudflare D1; the test stand-in is sqlite.
- **No live observation** of a natural EPG sync with the policy. Acceptance after activation is: zero current published `deny_all` shows, zero new unknown candidates from `known_only` channels, the event counters and revision matching the Channel page, and no fallback to `discover`.
