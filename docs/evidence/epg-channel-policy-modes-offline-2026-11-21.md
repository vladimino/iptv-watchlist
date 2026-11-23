# EPG Channel policy modes: offline evidence

**Date:** 21 Nov 2026 (UTC). **Scope:** repository change and offline tests only, for the accepted [ADR 0191](../adr/0191-epg-channel-policy-in-the-scan.md). No production database, bucket, Worker, EPG, Discovery or TMDB was read or written, no flag was set, and nothing was deployed. The earlier [first-delivery evidence](epg-channel-policy-offline-2026-11-21.md) is historical and is not reused here.

## What was verified offline

| Check | Result | Source |
| --- | --- | --- |
| `deny_all`, `known_only`, `discover` per slot; unknown channel `known_only`; the same Film on an allowed channel kept; slot conflicts in both orders and identical replays | Pass | `tests/epg-channel-policy.mjs` sections 1 and 2 |
| `degraded`: every channel `known_only`, a known Film from a previously denied channel admitted, no unknown candidate, catalog-confirmed Film kept, no revision or digest, no guessed channel ids, `legacy` and `filtered` mode labels | Pass | same, section 3b |
| Declaration boundary: one batch before the first programme for chunk sizes 0, 7 and 1; a declared channel without programmes offered; a country-prefixed label and an undeclared programme id not offered; a late declaration counted not offered; a throwing callback never fails the scan; the batch ran although the scan later failed; none in `degraded` or `legacy` | Pass | same, section 3c |
| Continuity: the minimum-broadcasts check holds against the same mode for all three modes and for a report without the field (legacy); it is skipped on every mode change; a revision change inside one mode never exempts it; raw programme count, channel coverage and horizon still fail on a mode change; no coefficient in the guard | Pass | same, section 4 |
| Worker loader: `legacy` reads nothing; empty, absent, incomplete, unavailable and a throwing reader each give `degraded`; the registrar records detected against registered and never throws; no "publication refused" path; the snapshot is read once before the scan; registration is the scan callback, not a publish step | Pass | same, section 6 |
| `epg` event: `filtered` carries mode, revision, digest and registered; `degraded` carries the warning and no revision or digest; a failed registration warns; a legacy scan adds nothing; the screen says the blacklist was not applied when degraded, escapes the reason and links only a same-origin path | Pass | same, sections 6 and 7 |
| XMLTV registration writer: idempotent, no duplicate ids, an M3U channel never re-created, classification and owner overrides preserved, a lost reply on more than 50 ids claimed only when every id is stored | Pass | same, section 5 |
| Each new behaviour was shown to fail with its fix reverted (mode-blind guard, late boundary, registration in `degraded`, refusing publication) | Pass | local mutation run, not committed |

## What was not done

- **No full XMLTV dry run on the real feed.** The provider feed is not available to this environment. `scripts/epg-channel-policy-dry-run.mjs` runs the scan without and with a policy over a local XMLTV file and a local policy map; it must be run by someone holding the feed before the owner sets the flag. The 20 Nov 2026 audit figures are a baseline for that run, not invariants. The actual declaration order of the real feed (all `<channel>` before the first `<programme>`) is unverified; the late-declaration counter reports a deviation.
- **No D1 capacity or timing measurement** of the snapshot read or the registration batch on Cloudflare D1; the test stand-in is sqlite.
- **No live observation** of a natural EPG sync with the policy. Acceptance after activation is: a `filtered` event whose revision matches the Channel page, zero current published `deny_all` shows, zero new unknown candidates from `known_only` channels, the XMLTV-only channels registered, and no fallback to `discover`. A `degraded` publication is allowed and proves nothing about the blacklist.
