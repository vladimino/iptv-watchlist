# ADR 0189: The EPG scan applies one pinned Channel policy snapshot behind an owner flag, fail-closed, and registers XMLTV-only channels after the scan

**Status:** Proposed  
**Original decision date:** 2026-11-21  
**Recorded at:** 2026-11-21  
**Approval source:** The scope and the owner policy are on the [AIR-564 card](https://trello.com/c/omIQl2Lh) (owner comments of 21 Nov 2026, Europe/Madrid: in-memory materialization and automatic XMLTV-only registration). The concrete choices below (flag, empty-snapshot refusal, registration timing, `known_only` semantics, guard scaling) are this ADR's proposal and are **not yet accepted by the owner**.  
**Related work:** [AIR-564](https://trello.com/c/omIQl2Lh); builds on [ADR 0187](0187-epg-channel-authority.md), [ADR 0142](0142-epg-owned-generation-addressed-discovery-slots.md) and [ADR 0158](0158-epg-title-alias-provenance.md)  
**Supersedes:** None  
**Superseded by:** None

## Context

[ADR 0187](0187-epg-channel-authority.md) stores a Channel snapshot (categories, owner decisions, per-category policy) and leaves to a later change the exact scan semantics, the metrics, the activation gate and what happens to XMLTV channels the snapshot lacks. Today every channel feeds Film matching and Discovery alike. The owner policy is: M3U categories 3-8 `discover`, every other group `deny_all`, an absent or unclassified channel `known_only`.

## Decision

1. **Activation is a Worker flag, default off.** `EPG_CHANNEL_POLICY=on` makes each EPG sync read the policy; any other value, including absent, leaves the scan, the `epg` event and the continuity guard unchanged. A deploy therefore changes nothing; the first effect is the next natural EPG sync after the owner sets the flag. The flag is not a data authority marker and ADR 0187's "no marker" choice stands.
2. **One pinned snapshot per sync.** The sync reads one snapshot before the feed is fetched, materializes `Map<channelId, {policy, basis}>` once, and passes it to `scanEPG`, which does one lookup per in-window programme by `channel_id` (never by name), before Film matching. A running scan never sees another revision.
3. **Semantics.** `deny_all` ignores the programme even for a known Film. `known_only` keeps only a reliable single Film identity (watchlist match, or a catalog Film confirmed by a movie title under ADRs 0142 and 0158) and creates no unknown candidate, uncertain entry or TMDB request. A skipped record still claims its slot for the owner the discover path would use, so ADR 0142's one-owner-per-slot conflict holds whatever the policy admits. `discover` is the unchanged pipeline. A channel absent from the map is `known_only`. The same Film on another allowed channel is unaffected because policy is per channel.
4. **Fail closed, by refusing to publish.** An unavailable, absent, incomplete or **empty** (revision 0) snapshot makes the sync fail; the previous generation stays current. It never falls back to `discover` or to an unfiltered scan, because that would silently widen what Discovery admits.
5. **Registration of XMLTV-only channels** is one bounded, idempotent writer in the publish phase, after the scan and the continuity guards. Its input is the set of `<channel>` ids the feed declares (not only channels with programmes); a programme id without a declaration is classified `known_only`, counted as `undeclared` and never registered: origin `xmltv`, no provider id, no category (so `known_only`), `ON CONFLICT DO NOTHING`, one new revision by compare-and-swap with a bounded retry, no policy change; an ambiguous reply is success only when every new id and the marker count are verified. Its failure never fails the scan and is retried by the next one. It runs before the generation is committed, so a failed publish can leave harmless unclassified rows; the run records the outcome and `registered` is claimed only on success.
6. **Metrics.** The immutable `epg` event keeps its fields (now post-filter) and adds `channels`, `programmes` and `policy` (revision, digest of the applied map, link to the owner Channel page) only when a policy was applied. Raw input counters (`scanned`, channel coverage) stay raw. Old events are never recomputed.
7. **Continuity guard.** Raw counters are compared raw to raw. The broadcast floor is scaled by the share of in-window programmes the policy let through relative to the last good update's share (1 without a policy), so the expected first-generation shrinkage is not a feed fault while a further collapse still is.

Not decided: any production activation, a change of the owner policy, Discovery ledger cleanup, and long-term retention of channels.

## Alternatives considered

- **Refuse only on an unavailable snapshot, treat empty as all-`known_only`.** Rejected here: an empty snapshot after activation means the import is missing, and publishing it would silently drop Discovery input. Not discussed with the owner; open for review.
- **Register channels before the scan, so the scan sees them.** Rejected: the scan pins one revision by decision 2, and a registration before the scan would add a pre-publish write to every failed run.
- **Register only after the generation is committed.** Cleaner claim, but the sealed publish path commits in a later step; hooking there changes the publication flow. Registration is idempotent and policy-neutral, so the earlier point is accepted. Open for review.
- **A D1 authority marker as the gate.** Rejected by ADR 0187 (no marker without a reader); a Worker flag is the lighter reversible switch.

## Consequences

The scan stays one pass with no per-programme I/O. A bad or missing import blocks publication until the owner fixes it, which is intentional. `known_only` channels still surface already-confirmed catalog Films but no new candidates. The continuity guard gains a policy-relative term to maintain. Events written with the policy are larger by a few counters.

## Recovery and migration boundary

Code rollback is a revert with no storage mutation; it does not undo a filtered generation already published, and the next natural EPG sync publishes the corrected one. Setting the flag back to `off` returns the scan to its earlier behaviour on the next sync. Registered channels stay (an import never deletes a channel). Setting the flag is a separate owner operation; this ADR authorizes none and starts no EPG, Discovery or TMDB run.

## Evidence

- **Original decision:** [AIR-564](https://trello.com/c/omIQl2Lh).
- **Implementation:** the pull request of this change (`tests/epg-channel-policy.mjs`, `tests/feature-flags.mjs`, `tests/epg-channel-d1.mjs`).
- **Dated verification:** [offline evidence](../evidence/epg-channel-policy-offline-2026-11-21.md); no production observation.
- **Uncertainty:** no run on the real XMLTV feed, no Cloudflare D1 timing of the snapshot read or the registration batch.

## Follow-ups

[AIR-565](https://trello.com/c/mSdBSd9j), [AIR-566](https://trello.com/c/8RVlrvkk), [AIR-567](https://trello.com/c/gDgSn2M7).
