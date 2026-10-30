# EPG commit with the Diary stage: memory-limit end and offline phase profile, 30 October 2026

[AIR-263](https://trello.com/c/uNoGwtid) · read-only incident reading, R2 size listing and offline replay. Follows [AIR-211](epg-memory-pressure-2026-10-27.md) and [AIR-287](https://trello.com/c/kOZlT8UE) ([ADR 0054](../adr/0054-diary-first-epg-ratings.md)).

**Captured at:** 2026-10-30, 17:20–18:20 UTC.

**Sources:**
- Workers Observability events of Worker `iptv`, read through the Cloudflare API, for 16:03–16:06 UTC.
- A read-only R2 list-objects size listing (key, size, last-modified; no body read).
- An offline replay of the built Worker at `main` `afbca26` plus this PR's markers, with `scripts/epg-memory-profile.mjs`, on synthetic objects of the measured sizes.

**Evidence lifecycle:** dated measurement. **Operational authority:** none. No R2 or D1 write, deployment, flag, Task, Access change, sync, Diary or Letterboxd request.

## Incident (production, read-only)

One `POST /mcp` request ran the whole daily EPG commit and its tail (request `1db10a5b…`; wall 79.9 s, CPU 15.4 s):

| UTC | Line |
| --- | --- |
| 16:03:42.936 | `epg_continuation` `entered` (the `epg_sync_step` call) |
| 16:04:44.497 | `epg_ratings_phase` `post_commit`: the EPG scan and the generation publish took 61.6 s |
| 16:05:00.213 | `epg_ratings_phase` `diary`: `finishSync` and the prediction queue took 15.7 s |
| 16:05:02.158 | `exceededMemory`, "Worker exceeded memory limit." |

- **No overlap.** No other request of the Worker was open between 16:03:43 and 16:05:02, so overlapping invocations do not explain this end.
- **Where it died.** Afterwards `GET /api/letterboxd/diary` showed `state: null` and `entries: 0`. The request ended before the first diary history commit, that is, during the state load, the page request, its body read, the parse or the merge.

## Object sizes (production, metadata only)

| Object | Bytes | Last modified (UTC) |
| --- | ---: | --- |
| `epg/discovery-latest.json` | 36,072,532 | 30 Oct 16:04:34 |
| `enrichment/view-index.json` | 6,422,128 | 30 Oct 16:38:42 |
| `epg/discovered-films.json` | 6,222,569 | 30 Oct 16:14:07 |
| `programme.json` | 2,242,013 | 30 Oct 16:04:39 |
| `epg/discovery-resolution.json` | 1,552,986 | 30 Oct 16:14:11 |
| `watchlist.json` | 1,477,694 | 30 Oct 16:04:43 |
| `metadata.json` | 1,164,689 | 30 Oct 16:03:39 |
| `letterboxd/facts/links.json` | 24,700 | 30 Oct 16:04:47 |

## Offline phase profile

`node --expose-gc scripts/epg-memory-profile.mjs [--full] [--gc-at-markers] [--concurrency 2]`.

**Setup.**
- Synthetic records are padded to the sizes above, in `frozen` ledger mode with no archive, as in production.
- `--full` runs the whole commit from a 40,000-programme synthetic XMLTV stream. Without it, the resume path of a committed run runs (generation copy, then the tail).
- One diary page has 50 rows (136 KB).

**Reading the numbers.** Heap is V8 `heapUsed` in MB. "Peak" is sampled every millisecond in the phase; "enter" and "exit" are at the markers. With `--gc-at-markers` a full GC runs at every marker, so "enter" and "exit" are retained data and "peak" is the transient within the phase. Node is not workerd: these figures rank phases, they do not reproduce the 128 MB isolate limit.

| Phase | Full, GC at markers: enter → exit (peak) | Full, no forced GC: enter → exit (peak) | Resume, GC at markers: enter → exit (peak) | Full, two at once, GC at markers: peak |
| --- | --- | --- | --- | --- |
| Baseline | 29 | 29 | 12 | 30 |
| `epg_input_scan` | 29 → 50 (58) | 34 → 57 (65) | — | 86 |
| `generation_publish` | 52 → 52 (**254**) | 65 → 112 (**254**) | — | **380** |
| `generation_copy` | — | — | 13 → 13 (94) | — |
| `finish_sync` | 31 → 31 (75) | 112 → **169** (169) | 13 → 13 (57) | 117 |
| `queue_refresh` | 32 → 32 (32) | 145 → 169 (169) | 14 → 14 (14) | 33 |
| `diary_state_load` | 31 → 31 | **169** → 169 | 13 → 13 | 41 |
| `diary_page_fetch` | 30 → 30 (31) | 67 → 67 (217) | 14 → 14 (14) | 67 |
| `diary_page_parse` | 30 → 30 (32) | 67 → 68 (217) | 14 → 14 (14) | 67 |
| `diary_history_merge` | 30 → 30 (32) | 68 → 68 (217) | 14 → 14 (14) | 67 |
| `diary_facts_apply` | 30 → 30 (**81**) | 68 → 84 (218) | 14 → 14 (**63**) | 90 |
| `diary_state_save`, `removal` | 30 | 84 | 14 | 32 |

## Hypotheses

| Hypothesis | Evidence | Verdict |
| --- | --- | --- |
| A. EPG scan, report or ledger objects stay alive into the Diary stage | With GC at markers, retained heap at `diary_state_load` (31 MB) equals the baseline plus the run (29 MB). The scan result (+21 MB) is released after the publish | **Not supported** offline |
| A′. Unreclaimed garbage from the commit is still on the heap when the Diary stage starts | Without forced GC the heap is 169 MB at `diary_state_load` and falls to 67 MB once GC runs during the page request. In production the request died 2 s into `diary`, before any diary write | **Most consistent** with the incident; not proven (no production heap reading exists) |
| B. Page 1 request, body read or parse | One 136 KB page costs under 1 MB of heap (`diary_page_fetch`, `diary_page_parse` with GC at markers) | **Refuted** as the allocator |
| C. Large R2 objects read, parsed and written by the commit | The publish (36 MB ledger read, merge and two writes) peaks at 254 MB, about 7× its body; the resume copy peaks at 94 MB; `finish_sync` at 75 MB | **Confirmed** as the largest allocation, before the Diary stage |
| D. `applyDiaryEvidence` (view index, records, projection) | +50 MB transient (`diary_facts_apply`), from reading the 6.4 MB view index and projecting it again. In production the request never reached it | **Confirmed** as a second, smaller peak; not this incident's cause |
| E. Overlapping invocations in one isolate | No overlapping request in the incident window. Two commits at once offline peak at 380 MB | **Not supported** for this incident; a real risk if two runs overlap |

## Minimal fix and expected gain

- **Fix.** Run the post-commit ratings (Diary stage and removal lookup) in their own step, the next `epg_sync_step` on the completed run, instead of the commit's request. Checkpoint it with the existing `ratingPending` and `ratingAttempt`.
- **Expected gain.** The Diary stage then starts from about 13–30 MB of live heap (resume and full replays) instead of after a 254 MB publish peak with up to 169 MB not yet collected. Its own peak is the 50 MB facts projection.
- **Separate card.** The fix needs its own card, and an owner gate for the change in the Scheduled Task's step sequence.
- **Further reduction.** The ledger publish itself, 7× a 36 MB body, stays the commit's largest risk. It is the subject of the bounded ledger work ([AIR-222](https://trello.com/c/9Y4G9DG6), [ADR 0034](../adr/0034-bounded-discovery-ledger.md)).

## Not established

- **Heap at the moment of the kill.** The production heap when the request died is unknown; Workers Observability has no heap reading. The new `epg_phase` markers name the last phase, not its memory.
- **Synthetic sizes.** The EPG XMLTV size in production is not measured; the synthetic stream has 40,000 programmes.
- **workerd accounting.** How workerd counts uncollected garbage against the 128 MB limit is not measured here.
