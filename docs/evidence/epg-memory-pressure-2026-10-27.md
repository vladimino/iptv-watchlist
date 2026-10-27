# EPG commit and discovery chunk memory pressure, 27 October 2026

[AIR-211](https://trello.com/c/UHYcomzg) · read-only measurement and offline replay. Follows [AIR-199](epg-commit-interrupted-2026-10-27.md).

**Captured at:** 2026-10-27, ~19:40–20:40 UTC. **Sources:**
- A read-only size listing of production R2 bucket `iptv` (Cloudflare R2 list-objects metadata). Only key, byte size and last-modified were returned; no object body was read. The owner approved this separately for these keys only.
- An offline replay of the Worker code at `main` `1f956dd` against synthetic objects of the measured sizes.

**Scope:** the objects the EPG commit, the commit retry (resume path) and the discovery chunk load. **Evidence lifecycle:** dated measurement. The sizes grow daily, so the margins below move with them. **Operational authority:** none. No R2 or D1 write, Worker deployment, flag, Task, Access change, lease reset or retry was made. **Code change:** none. A prototype is kept for reference in commit `8fe26dd` (reverted on the same branch, not merged).

## Object sizes (production, read-only metadata)

| Object | Bytes | Last modified (UTC) |
| --- | ---: | --- |
| `epg/discovery-latest.json` (shared copy of the discovery ledger) | 63,369,360 | 27 Oct 16:06:16 |
| `epg/generations/b2699929…/discovery-latest.json` | 63,369,360 | 27 Oct 16:05:34 |
| `epg/generations/23570366…/discovery-latest.json` (previous generation) | 60,288,362 | 26 Oct 15:57:28 |
| `epg/discovered-films.json` (catalog; generation copy has the same size) | 5,955,495 | 27 Oct 16:06:19 |
| `enrichment/view-index.json` | 4,553,890 | 27 Oct 16:06:31 |
| `programme.json` (generation copy has the same size) | 2,236,877 | 27 Oct 16:06:22 |
| `epg/discovery-resolution.json` | 1,417,876 | 27 Oct 00:02:38 |
| `sync.json` | 845 | 27 Oct 16:06:39 |
| `enrichment/prediction-queue.json` | 960 | 27 Oct 19:18:04 |

The ledger is about ten times larger than every other object. It grew by 3.08 MB (5.1 %) from the 26 October to the 27 October generation. The AIR-86 census counted 49,715 ledger items on 23 October.

**Why it grows.** `mergeDiscoveryCandidates` (`src/sources.js`) folds the previous ledger into each new generation. A candidate that is no longer in the EPG is kept with `shows: []` and `seenInLatestSnapshot: false`, and is never removed. The ledger therefore accumulates every candidate ever seen.

**Who loads it whole.**
- The EPG commit (`epgSync`): previous ledger, merge, publish.
- `copyEpgGeneration` on both the commit and the commit retry: parse and re-serialize.
- Every discovery chunk (`resolveDiscoveryChunk`): together with the catalog and the decisions. Its AIR-94 non-film screening loop iterates all items, including candidates that are no longer on air.
- The pipeline and enrichment status reads.

`Body.json()` decodes the whole body into one string before parsing. Most titles are Cyrillic, so that string is UTF-16 at about twice the byte size.

## Offline replay

**Method.**
- The real Worker sources run in a `vm` context, as the repository tests do.
- R2 is simulated by a disk-backed store: object bytes stay off the JS heap, and `json()` decodes through `TextDecoder` into an on-heap string, like `Body.json()`.
- The synthetic objects have the measured sizes and a realistic shape. The ledger has 62,182 items (~1 KB each, Cyrillic titles and descriptions, 22,000 with two shows) and is 61.9 MB. The catalog has 3,926 films (5.96 MB), the view index 1,681 entries (4.57 MB), the programme 1,475 watchlist films (2.22 MB), and there are 8,800 decisions.
- For each scenario, a binary search finds the smallest `node --max-old-space-size` (with `--max-semi-space-size=1`) at which the scenario completes.

**Scenarios.**
- **resume:** the 27 October commit retry. `sync=epg` with events, the new generation already published, then `copyEpgGeneration`, `finishSync` and `refreshPredictionQueue`, until `queueDiscovery`.
- **chunk:** one discovery step with `sync=complete` and a `paused/epg_committed` record. TMDB is stubbed to fail.
- **commit tail:** the full commit after the EPG scan. Load the previous ledger, `mergeDiscoveryCandidates` with 22,000 current candidates, `replaceCatalogAvailability`, `publishEpgGeneration` (including `copyEpgGeneration`). The EPG XML scan itself is not replayed.

| Ledger size | resume | chunk | commit tail |
| ---: | ---: | ---: | ---: |
| 20 MB | 79 MB | 94 MB | 165 MB |
| 40 MB | 130 MB | 130 MB | 260 MB |
| 63 MB | 189 MB | 189 MB | 358 MB |

All rows are `main` `1f956dd`. As in `epgSync`, the previous ledger stays referenced until the publish ends.

The needed heap grows linearly with the ledger, and the paths keep the same order: the full commit is by far the heaviest, the chunk and the retry are lighter and close to each other. Production fits the same order, as far as it was logged. From 21 to 24 October there was one daily `exceededMemory` in the daily task's commit window. The route was not logged then, so this is consistent with the full commit, not proven. On 26 October the first commit call and several discovery chunks failed, and the retry succeeded. On 27 October the retry failed too (AIR-199). The absolute crossing points do not transfer: the replay puts the retry over 128 MB already at 40 MB, yet the 26 October retry succeeded with a 60 MB ledger.

**Limits of the replay.** `--max-old-space-size` approximates, but is not, the workerd isolate limit. Young-generation and external memory are accounted differently, so the numbers are relative, not absolute. The EPG XML scan (CPU 14.9–27.5 s in production) is not replayed. Its own memory adds to the full commit.

## Prototype (reference only, not merged)

Commit `8fe26dd`, reverted on the same branch, tried three changes that do not alter results:
- parse objects larger than 1 MiB from the byte stream, value by value below the second level, equal to `JSON.parse` (3,000 random documents and all fixtures);
- copy generation files byte for byte through a `FixedLengthStream`;
- release the previous ledger after the merge.

| Ledger 63 MB | `main` | prototype |
| --- | ---: | ---: |
| resume | 189 MB | 31 MB |
| chunk | 189 MB | 138 MB |
| commit tail | 358 MB | 193 MB |

The resume path would fit, so the 27 October retry would have queued discovery. The chunk and the full commit would still exceed 128 MB at today's size. At a growth of about 5 % per day, a constant-factor saving lasts days, not weeks.

A streaming writer was also tried and dropped. It gave no reliable gain in the replay, and its `FixedLengthStream` behaviour on workerd could not be verified offline. The byte copy above depends on the same API and is equally unverified without a production write.

## Conclusion

- **Confirmed:** the discovery ledger `epg/discovery-latest.json` is the dominant allocation. It is 63.4 MB, ten times any other object, and grows about 3 MB per day, because the merge never removes candidates that left the EPG. Every path that failed in production materializes it whole.
- **Supported by the replay, not measured in workerd:** memory need grows linearly with the ledger on every failing path. The paths rank full commit > chunk ≈ retry, which fits the logged production failures.
- **Not established:** the exact allocation that tips each production invocation over the limit. Neither the live isolate heap nor the real ledger's item composition (how many items are on air) was read.

## Fix candidates (separate cards; nothing implemented here)

- (a) Bound the ledger: keep candidates that left the EPG in an archive object that the commit, chunk and status paths do not load, or compact them to the fields the decisions need. This changes the stored data contract and the AIR-94 screening scope, so it needs an ADR and owner approval.
- (b) The constant-factor changes of the prototype, as an interim measure: streaming reads, byte copy, early release. The `FixedLengthStream` copy needs a verification plan before deploy.
- (c) AIR-199 candidates (a)/(b): make the stranded generation visible, and queue discovery before the commit tail. These still apply, independently of memory.

**Used by:** [AIR-211](https://trello.com/c/UHYcomzg). **Superseded by:** none recorded.
