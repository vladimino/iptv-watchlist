# ADR 0198: The Channel policy applies to every EPG scan and the `EPG_CHANNEL_POLICY` switch is retired

**Status:** Accepted  
**Original decision date:** 2026-11-22  
**Recorded at:** 2026-11-22  
**Approval source:** [Owner decision comment on the AIR-565 card](https://trello.com/c/mSdBSd9j) (22 Nov 2026, Europe/Madrid): "retire, я не предвижу отката к старой нефильтрованной системе"; scope confirmed in the handoff comment of the same day.  
**Related work:** [AIR-565](https://trello.com/c/mSdBSd9j); follows the accepted natural filtered EPG of [AIR-564](https://trello.com/c/omIQl2Lh)  
**Supersedes:** [ADR 0191](0191-epg-channel-policy-in-the-scan.md) decision 1 (the activation flag) and the production `legacy` scan mode, in part  
**Superseded by:** None

## Context

[ADR 0191](0191-epg-channel-policy-in-the-scan.md) activated the Channel policy through the Worker variable `EPG_CHANNEL_POLICY` (`on`, default off). The first natural filtered EPG (programme run `bf89ba90-07eb-46ac-9723-15d309517830`, generation 517) was accepted, and the owner does not foresee a return to the unfiltered system. A switch that can restore an unfiltered scan is a standing way to re-admit denied channels into Discovery.

## Decision

1. **Unconditional policy.** `loadEpgChannelPolicy` always reads one pinned snapshot. The mode is `filtered` with an available, non-empty, consistent snapshot and `degraded` otherwise (every channel `known_only`, no unknown candidate, a warning, no revision or digest claimed, EPG still published). An absent, `off`, `on` or invalid binding changes nothing; the Worker no longer reads it.
2. **Kept unchanged.** The snapshot pin, early best-effort channel registration, compare-and-swap and readback, every raw, coverage and horizon guard, and the E3+ continuity rule (minimum broadcasts compared only within the same mode, skipped on a mode change; filtered to degraded and back included).
3. **History stays readable.** Generations and events published without a mode still read as `legacy`; history is never recomputed. The `legacy` branch of the pure `scanEPG` function is kept only as the offline and test harness (no `options.policies`); no production path calls it without a policy. One exception is recorded openly: the `full`-ledger-mode route `POST /api/enrichment/discovery/scan` still calls `scanEPG` without a policy, but it answers 409 whenever the ledger is `bounded`, which is production's mode; it is not changed here.
4. **Admin and registry.** The Channel admin API reports `activation.state` as `active` unconditionally and the page drops the staged wording. The `feature_flags` registry lists `EPG_CHANNEL_POLICY` as retired and inert.
5. **Binding removal is separate.** Deploying does not remove the Cloudflare binding. The owner (or a separate specific permission) removes only that binding after the deploy; the readback to prove it is `state=absent` and `retired=true`. Until then a stale binding is inert.

Not decided: any change of the owner policy, Discovery ledger cleanup, Catalog corrections ([AIR-567](https://trello.com/c/gDgSn2M7)).

## Alternatives considered

- **Keep the flag for a stabilization period.** Rejected by the owner: no rollback to the unfiltered system is foreseen.
- **Keep `off` as an emergency fallback to `degraded`.** Rejected: `degraded` already is the safe fallback and needs no variable.
- **Delete the `legacy` branch of `scanEPG`.** Rejected for now: the pure function serves historical comparison tests; the bypass is closed at the single production caller.

## Consequences

An unfiltered scan cannot be selected by configuration. Exceptional rollback to code that still reads the flag must first restore `EPG_CHANNEL_POLICY=on` under a separate permission, otherwise that old code would run `legacy`.

## Recovery and migration boundary

Code rollback is a revert with no storage mutation; it undoes no published generation, registered channel or Discovery state. The deploy starts no EPG, Discovery or TMDB run and writes no D1 or R2 data.

## Evidence

- **Implementation:** the AIR-565 retirement pull request (`tests/epg-channel-policy.mjs`, `tests/epg-channel-d1.mjs`, `tests/feature-flags.mjs`, `tests/admin-channels-api.mjs`, `tests/admin-channels-page.mjs`).
- **Uncertainty:** binding removal and its readback are not yet done.

## Follow-ups

Owner removal of the binding and `feature_flags` readback; AIR-565 ledger audit; [AIR-567](https://trello.com/c/gDgSn2M7).
