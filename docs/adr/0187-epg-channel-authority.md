# ADR 0187: Channel, provider category and per-category policy become their own D1 entity, with the effective policy derived as owner override > category policy > `known_only`

**Status:** Proposed  
**Original decision date:** 2026-11-21 (proposal; the contested details below are not yet approved)  
**Recorded at:** 2026-11-21  
**Approval source:** The programme and the owner policy (categories 3-8 `discover`, the other 29 groups `deny_all`, unknown or unclassified `known_only`, an explicit owner override above the category policy) were agreed by the Product Owner on 2026-11-20/21 in the project conversation and recorded on the [Trello card](https://trello.com/c/K98arHAG). This ADR stays **Proposed** until the owner approves the architectural details listed under "Not decided".  
**Related work:** [AIR-561](https://trello.com/c/K98arHAG) (this decision and the dormant schema and repository); successors [AIR-562](https://trello.com/c/EGDxTW8m) (admin, M3U import, overrides), [AIR-563](https://trello.com/c/TzDy1d4b) (production migration and first import), [AIR-564](https://trello.com/c/omIQl2Lh) (scan policies and metrics), [AIR-565](https://trello.com/c/mSdBSd9j) (Discovery ledger cleanup)  
**Supersedes:** None  
**Superseded by:** None

## Context

Confirmed from the offline audit of 20 Nov 2026 (a baseline for dry runs, not an invariant): the provider M3U `playlist.m3u8` carries 35 `#EXTGRP` groups and 2 103 channel ids, the XMLTV source 1 355 channels, 1 340 ids match and 15 are not classified.

Today a channel is only a string. `published_epg_show.channel_id` and `discovery_observation_show.channel_id` carry the XMLTV id, and `channel` the display name. Nothing says which channels may feed Discovery, so every channel's shows are scanned the same way. The owner policy needs a place to live that is independent of the shows, can be changed without rewriting history and is read once per scan.

## Decision

1. **Channel is a D1 entity.** Three tables hold it (schema v31): `epg_channel_category` (provider category with its policy), `epg_channel` (one row per XMLTV channel id, with the provider id, an optional category and an optional owner override) and `epg_channel_revision` (the one snapshot revision, the source digest and row counts), plus the batch fence `epg_channel_cas`. There is **no mode marker**: nothing reads the tables until a later, separately approved change does.
2. **Three things stay apart.** The *provider category* is `epg_channel.category_key`. The *policy* is `epg_channel_category.policy` or `epg_channel.override_policy`, each limited to `deny_all`, `discover` or `known_only`. The *provenance* is `epg_channel_revision.source_sha256` for the classification and `override_at` / `override_note` for an override. The **effective policy is never stored**; it is derived, in one place, as `owner_override > category.policy > known_only`.
3. **Single source of truth.** Classification and policy live only in these rows. A snapshot is one revision: every committed write adds one, a write names the revision it read (compare-and-swap in one fenced batch), and the row counts in the revision row let a reader prove it read every row. A read takes the revision, the categories, the channels and the revision again, and retries once when it moved.
4. **Fail safe, never `discover`.** An unknown channel id, a channel without a category and an empty snapshot are `known_only`. An unavailable database, absent tables, a torn or incomplete snapshot are reported explicitly (`ok:false` with a reason) and their lookup answers `known_only` with `degraded:true`. A missing authority never widens what Discovery may admit.
5. **One read per scan.** A consumer reads one snapshot (four statements for any number of channels) and looks policies up in memory. There is no per-channel D1 read and no slot-database lookup in a scan loop.
6. **Identity is the provider id, never the name.** `tvg_<n>` normalizes to the XMLTV id `ch<n>` with at least three digits (`tvg_1259` is `ch1259`, `tvg_1` is `ch001`). A malformed id, a leading-zero spelling, a duplicate normalized id or a group nobody declared is a **source error** that refuses the whole import. A channel is never matched to another by its display name.
7. **Film–Show–Channel boundary.** Shows keep their own keys and are never rewritten for this entity. There is **no foreign key** from `epg_channel` to `published_epg_show` or `discovery_observation_show`: a historical show may name a channel with no row, and a channel row may have no show.
8. **Imports keep owner decisions.** An import replaces classification and category policy from one source digest, keeps every override (a channel the import no longer lists keeps its override and loses its category), removes unlisted channels that have no override, and writes nothing when the same digest is already stored at the current revision.

## Not decided

- Whether a later activation needs a mode marker and a `held` state like the other domains; this ADR deliberately adds none because nothing reads the tables.
- The exact scan semantics of `deny_all`, `discover` and `known_only` and their metrics (a later change).
- The admin surface, the M3U fetching and the first production import, and any change to the active Discovery ledger.
- Whether an owner override may create a channel the import never listed (this schema refuses it).

## Alternatives considered

Not documented beyond the owner policy: storing the effective policy per channel (rejected here because it can drift from the category and the override), and a foreign key to the show tables (rejected because it would constrain historical rows).

## Consequences

The scan can apply one consistent policy snapshot without changing any show key. A new revision row is a single point of contention for writers, which is acceptable for an owner-controlled, low-frequency import and override surface. The module and tables are dormant; consumers must be added behind a separate approval.

## Recovery and migration boundary

The migration `0031_epg_channel_authority.sql` is **not applied by a deploy**; it follows a complete version 30 and refuses anything else before a table is created. Rollback of the code is a revert with no storage mutation. Applying the migration, importing and activating a reader are separate owner-approved steps; this ADR authorizes none of them.

## Evidence

- **Original decision:** the owner policy on the [Trello card](https://trello.com/c/K98arHAG).
- **Implementation:** the pull request of this change (offline tests in `tests/epg-channel-d1.mjs`).
- **Dated verification:** offline only; no production observation.
- **Uncertainty:** production sizes and the effect of D1's per-invocation statement budget on a full import are not measured; the test stand-in is sqlite.

## Follow-ups

[AIR-562](https://trello.com/c/EGDxTW8m), [AIR-563](https://trello.com/c/TzDy1d4b), [AIR-564](https://trello.com/c/omIQl2Lh), [AIR-565](https://trello.com/c/mSdBSd9j).
