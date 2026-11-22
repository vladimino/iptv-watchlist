# EPG Channel policy: real-feed offline dry run

**Date:** 22 Nov 2026 (UTC). **Verdict: PASS** on the real feed, the effective Channel policies, the published watchlist and the current catalog, in all three scan modes (`legacy`, `filtered`, `degraded`). The run is offline: it reads local files, calls no D1 writer (the declaration callback is a recording no-op), and started no EPG, Discovery or TMDB run, no Task and no flag change. This is the pre-activation dry run only; it is **not** an activation GO, and it did not measure the registration batch or any end-to-end latency.

## Inputs and provenance

| Input | What it is | Capture |
| --- | --- | --- |
| XMLTV feed | The owner's local copy of the provider feed from the 20 Nov 2026 audit (not today's). 210 543 990 bytes, SHA-256 `4b5227e64766524a76d0e7c9cb471c102d5fa8e191193c0a8e6029df25babce7`, complete (closing `</tv>`), 1 355 declared channels, 368 324 programmes, programmes from 17 Nov 15:34 UTC to 27 Nov 14:37 UTC | Copy taken about 20 Nov 2026 17:50 UTC (from the archive's own timestamp; the zone of that stamp was assumed to be Madrid). The scan's `now` is that instant, so the retention window is 17 Nov 17:50 UTC to 27 Nov 17:50 UTC and the feed's last programme is 164.8 h after `now`. No URL, header or credential is recorded |
| Effective Channel policies | Read by the repository's own `materializePolicies` (marker, categories, channels, marker again, retried once if it moved): **revision 1**, digest `46a2985464ccafa1ba875d868b620c87859497a914462453e2229e184af3fc2a` (recomputed and equal to the stated one), 2 103 channels: 1 262 `deny_all`, 841 `discover` (the same counts the coordinator's earlier preflight read) | 22 Nov 2026 06:31 UTC |
| Watchlist | The D1 published document of the programme run the published authority pins (`d1`/`open`); the pin was re-read and unchanged. 394 films, document updated 21 Nov 2026 16:01 UTC, watchlist generation 19. The independent Watchlist authority is still in mode `epg` | 22 Nov 2026 06:31 UTC |
| Catalog | The scan's own read, `DiscoveryAuthority.routeRead` of the discovered-films object (authority and transfer state, cap, per-row identity checks): 11 876 films | 22 Nov 2026 06:31 UTC |
| Combined known-Film input | As the Worker builds it: the watchlist plus the catalog films whose `tmdbId` the watchlist lacks, marked `catalogOnly`: 12 259 films (394 + 11 865) | |

How the D1 inputs were read: 22 `SELECT` statements through a REST shim that refuses everything but a single `SELECT` (the repository readers run unchanged over it), with the Cloudflare D1 API token the environment holds for the backfill operator, used for those reads only on the owner's decision. No statement wrote, and the repository's own write paths cannot run on the shim (it has no batch). One metadata-only `HEAD` of one R2 object checked that the read-only R2 credential works; no R2 object was downloaded. Inputs were kept outside the checkout and are not in the repository, a pull request or Trello.

The run was repeated on the same captured files after the review tightened the harness (the unconfirmed-only classifier, a required catalog input, a rejected mismatching policy digest): the verdict and every number are identical, so the 563 `known_only` losses are verified unconfirmed, not assumed.

**Limits of the inputs.** The feed (20 Nov) is older than the policies, watchlist and catalog (22 Nov); the watchlist is the published document of the last generation, not the exact `run.watchlist` of a past sync; the catalog is the current one, not the catalog as of the feed. These mismatches affect which films are known, not the policy logic under test.

## Result

| Check | Result |
| --- | --- |
| `legacy_unchanged` | PASS: no policy fields, no registrar call |
| `filtered_no_deny_all_shows` | PASS: **0** surviving film or candidate slots on a `deny_all` channel (catalog-confirmed ones included) |
| `filtered_no_unknown_candidates_from_known_only` | PASS: **0** unconfirmed candidate slots on a non-`discover` channel |
| `filtered_slot_differences_explained` | PASS: 44 343 slots in `legacy`, 29 765 in `filtered`; **0 gained**; lost 14 578 = 14 015 on `deny_all` channels + 563 candidates that are **unconfirmed** on `known_only` channels (the classifier counts a lost candidate as explained only when `!confirmed`; a catalog-confirmed slot lost on `known_only` is unexplained); **0 unexplained** |
| `declaration_boundary` | PASS: one batch; **15** declared channels absent from the snapshot offered before the first programme, all 15 valid ids, 0 malformed; **`lateDeclared` 0**; 0 undeclared programme channels; the pinned map unchanged |
| `degraded_all_known_only` | PASS: 1 322 channels all `known_only`, 0 unconfirmed candidate slots, 0 registrar calls, no revision or digest; 14 known-film slots on `deny_all` channels are admitted (the accepted trade-off) |
| `raw_counters_equal_across_modes` | PASS: 368 324 programmes read, 1 306 channels with programmes, the same feed window in all three modes |
| `continuity_guard` | PASS: the real stats pass the guard for `legacy`, `filtered` and `degraded` against themselves and for all 6 mode changes; the raw programme-count and the horizon checks still fire on a mode change |

| Mode | Retained | Films with shows | Film shows | Candidates | Candidate shows | Uncertain | Duplicate-slot conflicts |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `legacy` | 194 075 | 304 | 2 013 | 21 365 | 42 330 | 22 615 | 1 |
| `filtered` | 125 675 | 304 | 1 999 | 14 488 | 27 766 | 21 465 | 0 |
| `degraded` | 20 791 | 304 | 2 013 | 9 339 | 18 679 | 18 686 | 1 |

`filtered` policy counters: 358 807 in-window programmes, 130 784 dropped as `deny_all`, 1 732 skipped as `known_only`, 223 634 under `discover`, 4 389 on channels without a category; of 1 322 channels the feed schedules or declares, 841 `discover`, 466 `deny_all`, 15 `known_only` (the 15 new, unclassified channels).

## Reading the numbers

- The 15 XMLTV-only channels of the 20 Nov audit are present and would be offered for registration in one batch with no late or undeclared declaration; the real feed declares every channel before its first programme. The audit's figures are a baseline, not invariants; here they agree.
- `filtered` keeps 14 of the 2 013 known-film shows out (they sit on `deny_all` channels; `degraded` counts the same number, 14, of known-film slots on such channels) and retains about 35 % fewer records than `legacy`, in line with the audit's expected reduction. Candidates drop from 21 365 to 14 488.
- The one duplicate-slot conflict present in `legacy` and `degraded` is absent in `filtered`; that is consistent with it sitting on a denied channel, but it was not inspected individually.
- `degraded` retains the fewest records because every channel is `known_only`: only known films and slots confirmed by a catalog movie title pass.

## What this does not establish

- The registration batch's runtime and outcome on Cloudflare D1 (the harness never writes). The 22 `SELECT` reads were not timed as latency. Both are checked on the first natural run after a separately agreed activation.
- That a later feed or later policies behave the same: this is one feed, one policy revision.
- Anything about the deployed interface; visual acceptance stays with the owner.

## The harness

`scripts/epg-channel-policy-dry-run.mjs` runs the same feed, film input and `now` through the three modes and prints numbers and booleans only (no title, slot key, channel id, URL or path); exit 0 PASS, 1 FAIL, 2 BLOCKED (a missing or unusable input is named, never substituted: the catalog is required, an explicitly supplied empty one is accepted, and a stated policy digest that does not match the recomputed one, or that has no revision to check, is BLOCKED). `tests/epg-channel-policy-dry-run.mjs` proves the harness on a small synthetic feed (the input contract including the required catalog and the digest check, the three modes, the declaration boundary including late and interleaved late declarations, the guard matrix and its controls, a verdict that fails on doctored results including a lost catalog-confirmed `known_only` slot, numbers-only output); those tests are not evidence about the real feed. Reverting the `deny_all` skip, the `known_only` skip or the declaration boundary in the scanner turns that test red.

## Readiness

The pre-activation dry-run gate is **met on this evidence**: PASS, `lateDeclared` 0, 0 surviving `deny_all` slots, 0 unknown candidates from `known_only` channels, explained slot differences, the guard behaving in every mode. Activation still needs the owner's separate operation-specific GO, and acceptance after it is the next natural `filtered` EPG sync read back read-only.
