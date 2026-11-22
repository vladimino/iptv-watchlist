# ADR 0191: The EPG scan applies one pinned Channel policy snapshot in three modes behind an owner flag, degrades instead of blocking, and registers declared XMLTV channels at the declaration boundary

**Status:** Accepted; decision 1 (the flag) and the production `legacy` mode are superseded by [ADR 0198](0198-retire-epg-channel-policy-flag.md); decisions 2-7 stand  
**Original decision date:** 2026-11-21  
**Recorded at:** 2026-11-21  
**Approval source:** [Owner decision comment on the AIR-564 card](https://trello.com/c/omIQl2Lh#comment-6b01fc7850556794cccf1892) (21 Nov 2026, Europe/Madrid): options A1, B2, C1, D1 and the clarified E3+ ("да, пожалуй E3+ выглядит самым разумным решением. одобряю"). The accepted combination replaces the first proposal of this ADR (refuse publication on a bad snapshot, publish-phase registration, a dynamic broadcast-floor coefficient).  
**Related work:** [AIR-564](https://trello.com/c/omIQl2Lh); builds on [ADR 0187](0187-epg-channel-authority.md), [ADR 0142](0142-epg-owned-generation-addressed-discovery-slots.md) and [ADR 0158](0158-epg-title-alias-provenance.md)  
**Supersedes:** None  
**Superseded by:** [ADR 0198](0198-retire-epg-channel-policy-flag.md) (in part: the activation flag only)

## Context

[ADR 0187](0187-epg-channel-authority.md) stores a Channel snapshot (categories, owner decisions, per-category policy) and leaves to a later change the scan semantics, the metrics, the activation gate and what happens to XMLTV channels the snapshot lacks. Without a policy every channel feeds Film matching and Discovery alike. The owner policy is: M3U categories 3-8 `discover`, every other group `deny_all`, an absent or unclassified channel `known_only`. The first delivery (a dormant implementation behind the flag) refused to publish on a bad snapshot, registered channels after the scan and scaled the continuity floor dynamically. The owner replaced those three choices.

## Decision

1. **A1: activation is a Worker flag, default off.** `EPG_CHANNEL_POLICY=on` makes each EPG sync read the policy; any other value, including absent, is the `legacy` mode: the scan, the `epg` event and the continuity guard are unchanged. A deploy therefore changes nothing; the first effect is the next natural EPG sync after the owner sets the flag. The flag is not a data authority marker and ADR 0187's "no marker" choice stands.
2. **One pinned snapshot per sync.** The sync reads one snapshot before the feed is fetched, materializes `Map<channelId, {policy, basis}>` once, and passes it to `scanEPG`, which does one lookup per in-window programme by `channel_id` (never by name), before Film matching. A running scan never sees another revision and never reloads the map.
3. **Semantics.** `deny_all` ignores the programme even for a known Film. `known_only` keeps only a reliable single Film identity (watchlist match, or a catalog Film confirmed by a movie title under ADRs 0142 and 0158) and creates no unknown candidate, uncertain entry or TMDB request. `discover` is the unchanged pipeline. A channel absent from the map is `known_only`. A skipped record still claims its slot for the owner the discover path would use, so ADR 0142's one-owner-per-slot conflict holds whatever the policy admits. The same Film on another allowed channel is unaffected.
4. **B2: degrade, never block, never silently discover.** An unavailable, absent, empty (revision 0) or torn snapshot puts the scan in `degraded` mode: every channel is `known_only`, no unknown candidate is created, the event carries a warning and **no** revision or digest, and nothing is registered. The EPG is published; a Channel authority failure does not block it, and other mandatory failures keep their earlier behaviour. The owner accepts that a known Film from a previously denied channel is then admitted, and that a degraded generation does not prove the blacklist. `filtered` is the mode with an available, non-empty, consistent snapshot.
5. **C1/D1: registration of declared XMLTV channels.** In `filtered` mode, in the single streaming pass, the valid `<channel>` ids the feed declares and the pinned snapshot lacks are registered by one bounded, idempotent, best-effort batch at the boundary before the first `<programme>`, with no second download or parse. Rows are origin `xmltv`, no provider id, no category (so `known_only`), `ON CONFLICT DO NOTHING`, one new revision by compare-and-swap with a bounded retry; the full readback of every new id and the marker count decides an ambiguous reply. It is not tied to the publication: rows written stay even if the EPG later fails. A failure never fails the scan and never changes the pinned policy; the event reports detected against registered and a warning, and the next natural sync retries. A declaration after the first programme is counted, not registered; a programme id without a declaration is classified `known_only`, counted as `undeclared`, never registered. `degraded` registers nothing, since there is no reliable snapshot to compare against.
6. **Metrics.** The immutable `epg` event keeps its fields (now post-filter) and adds `channels`, `programmes` and `policy` (mode, link to the owner Channel page, and in `filtered` mode the revision and digest of the applied map) and a `warning` when degraded or when registration failed. Raw input counters (`scanned`, channel coverage) stay raw. A `legacy` scan adds nothing. Old events are never recomputed.
7. **E3+: the continuity guard compares like with like.** The mode (`legacy`, `filtered`, `degraded`) is stored in the published generation's metadata (`stats.policyMode`; a report without it is `legacy`). The minimum-broadcasts check compares only generations of the same mode and is skipped on a change of mode; every raw programme, channel coverage, horizon and publication check runs in every mode. A change of revision, category or override inside one mode never exempts the check. The baseline is the last successfully published generation, never a failed attempt. There is no dynamic coefficient, new table, marker or manual baseline reset.

Not decided: any production activation, a change of the owner policy, Discovery ledger cleanup, and long-term retention of channels.

## Alternatives considered

The owner chose among these on the AIR-564 card (A1, B2, C1, D1, E3+); the earlier delivery implemented the first proposal of each.

- **B (snapshot failure).** Refuse publication (the first proposal): rejected, the owner prefers graceful degradation with known Films over a missing EPG. Treat an empty snapshot as an all-`known_only` filtered scan: rejected, it would claim a revision that was never applied. Chosen: the explicit `degraded` mode.
- **C/D (registration).** After the scan or at publication (the first proposal): rejected, discovering a channel is independent and safe, so it happens at the declaration boundary and is not coupled to publication. A second download or a second parse: rejected, one streaming pass.
- **E (continuity).** A dynamic coefficient from the share of programmes the policy let through (the first proposal): rejected, replaced by same-mode comparison. Exempting the check for any policy change: rejected, a revision or override change inside one mode stays guarded.
- **A marker in D1 as the gate.** Rejected by ADR 0187 (no marker without a reader); a Worker flag is the lighter reversible switch.

## Consequences

The scan stays one pass with no per-programme I/O, and an unreadable Channel authority degrades instead of stopping the EPG. A degraded generation can show known Films from denied channels and must not be mistaken for an applied blacklist; the event and the Events screen say so. The mode in the published metadata is one more field the guard reads. Declared channels are discovered at the next sync after they appear. Events written with the policy are larger by a few counters and warnings.

## Recovery and migration boundary

Code rollback is a revert with no storage mutation; it does not undo a filtered generation already published, and the next natural EPG sync publishes the corrected one. Setting the flag back to `off` returns the scan to `legacy` on the next sync. Registered channels stay (an import never deletes a channel). Setting the flag is a separate owner operation; this ADR authorizes none and starts no EPG, Discovery or TMDB run.

## Evidence

- **Original decision:** the [owner decision comment](https://trello.com/c/omIQl2Lh#comment-6b01fc7850556794cccf1892).
- **Implementation:** the corrective pull request of this decision (`tests/epg-channel-policy.mjs`, `tests/epg-channel-d1.mjs`, `tests/feature-flags.mjs`); the dormant first delivery is [#858](https://github.com/vladimino/iptv-watchlist/pull/858) and its results are historical.
- **Dated verification:** [offline evidence](../evidence/epg-channel-policy-modes-offline-2026-11-21.md); no production observation.
- **Uncertainty:** no run on the real XMLTV feed, no Cloudflare D1 timing of the snapshot read or the registration batch.

## Follow-ups

[AIR-565](https://trello.com/c/mSdBSd9j), [AIR-566](https://trello.com/c/8RVlrvkk), [AIR-567](https://trello.com/c/gDgSn2M7).
