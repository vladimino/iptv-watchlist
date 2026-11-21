# EPG Channel policy: real-feed dry run, status and harness

**Date:** 21 Nov 2026 (UTC). **Status: BLOCKED.** The real-feed offline dry run required before the owner sets `EPG_CHANNEL_POLICY=on` has **not** been run, because its real inputs are not available to the session that tried. Nothing here is a PASS, and nothing here is evidence of the real feed. No production database, bucket, Worker, EPG, Discovery or TMDB was read or written in this session, and no flag was set.

## What was missing, and how each input is obtained safely

| Input | State in the session | Safe way to supply it |
| --- | --- | --- |
| **The real XMLTV feed** (a local file, plain or gzip) | **Missing.** The provider URL is the Worker secret `EPG_XML_URL`; it is not set in the session. No XMLTV or playlist file exists on its disk. The raw EPG dumps were absent from R2 at the 16 Nov 2026 check ([evidence](discovery/air-502-xmltv-categories-rca-2026-11-16.md)); that was not re-checked, since it needs `R2_SNAPSHOT_ACCOUNT_ID`, which is also not set. | The owner or the coordinator places a local copy in the session (the 20 Nov audit file if it is still usable, or a fresh copy the owner takes from the provider), and states when it was taken (UTC). Or the harness is run where the feed already is, and only its numbers-only output is returned. A URL or token is never written into the repository, a PR or Trello. |
| **Effective Channel policies** with revision and digest | Not read. | The five read-only `SELECT` statements of `readSnapshot` (the table check, the marker, the categories, the channels, the marker again), run through the read-only D1 path the coordinator already used. Give their rows to `--snapshot-rows`; the repository's own reader derives each channel's policy. State the revision before and after. |
| **Combined known-Film input** (watchlist plus catalog) | Not read. | `--watchlist`: the watchlist films array; `--catalog`: the discovered-films cache. Both are read-only copies of the published objects (the compatibility mirrors in R2 through the read-only snapshot export, which needs `R2_SNAPSHOT_ACCOUNT_ID` set alongside the key already present, or the equivalent D1 reads). State their capture time: they are not the exact `run.watchlist` of a past sync, and that limit goes in the report. The harness combines them as the Worker does (`catalogOnly`, no `tmdbId` overlap) and refuses an empty watchlist. |

The 15 XMLTV-only channels and the roughly 37 % raw reduction of the 20 Nov audit are a baseline to compare against, not invariants the harness enforces.

## The harness

`scripts/epg-channel-policy-dry-run.mjs` now runs the **same feed, film input and `now`** through `legacy`, `filtered` and `degraded`, with a recording no-op as the declaration callback (no D1 writer) and prints **numbers and booleans only**: no title, slot key, channel id, URL or path. Exit 0 PASS, 1 FAIL, 2 BLOCKED (a missing or unusable input is named, never substituted). It judges:

| Check | Passes when |
| --- | --- |
| `legacy_unchanged` | no policy fields, no registrar call |
| `filtered_no_deny_all_shows` | zero surviving film or candidate slots on a `deny_all` channel (catalog-confirmed ones included) |
| `filtered_no_unknown_candidates_from_known_only` | zero unconfirmed candidate slots on a non-`discover` channel |
| `filtered_slot_differences_explained` | no gained slot, and every lost slot is a `deny_all` slot or an unconfirmed `known_only` candidate |
| `declaration_boundary` | exactly one batch; the declared ids absent from the snapshot are offered before the first programme; `lateDeclared` is 0; the batch equals `channels.new`; undeclared ids are not offered; the pinned map is unchanged. The numbers include how many offered ids are malformed |
| `degraded_all_known_only` | every channel `known_only`, no unknown candidate, no registration, no revision or digest; known Films on `deny_all` channels are allowed and counted |
| `raw_counters_equal_across_modes` | `scanned`, coverage and the feed window are identical in all three modes |
| `continuity_guard` | the real stats pass the guard for every same-mode and mode-change pair, and the controls still fire on a change of mode (the raw programme count, when the feed has over 10 000 programmes, and the horizon) |

If `lateDeclared` is above 0 the harness fails with the number: a late declaration is not registered by an unchanged next feed, so the fix is named and narrow, not assumed away. The inputs section records the feed size and SHA-256, the capture time, the policy revision and digest, and the film counts.

## What the harness tests prove, and what they do not

`tests/epg-channel-policy-dry-run.mjs` runs the harness on a small **synthetic** feed to prove the harness itself: the input contract (BLOCKED on each missing input), the three modes over one feed, the declaration boundary including a late and an interleaved late declaration, the guard matrix and its controls, the verdict failing on doctored results, the snapshot-row conversion through the repository's reader, and numbers-only output. Reverting the `deny_all` skip, the `known_only` skip or the declaration boundary in the scanner turns the harness test red. This is **not** a dry run on the real feed.

## Already measured, with its limit

The coordinator's read-only preflight read the Channel snapshot with five `SELECT` statements: revision and import revision 1, 35 categories, 2 103 channels, counts exact, 1 262 `deny_all` and 841 `discover`, 10.6711 ms of summed SQL duration, no write. That is not end-to-end Worker latency and not the registration batch, whose runtime and outcome are checked on the first natural run after a separately agreed activation.

## Readiness

**Not ready for activation on this evidence.** The pre-activation gate stays open until the harness has been run on the real inputs above and returned PASS with `lateDeclared` 0, and the owner has given the separate operation-specific GO.
